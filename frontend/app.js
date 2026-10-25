(() => {
  "use strict";

  const API_BASE = ""; // served by the FastAPI backend on the same origin
  const REQUEST_TIMEOUT_MS = 150000; // research + voice analysis + writing
  const MAX_TWEET_CHARS = 280;

  // Mirrors backend/app/schemas.py TweetRequest limits.
  const LIMITS = {
    brand_name: { max: 100 },
    industry: { max: 100 },
    campaign_objective: { min: 3, max: 500, label: "Campaign objective" },
    description: { min: 10, max: 3000, label: "Description" },
    example_tweets: { min: 3, max: 5, maxChars: MAX_TWEET_CHARS }, // optional: 3-5 tweets, one per line
  };

  const exampleLines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  // Stages are paced to typical timings; the last one holds until the response arrives.
  const STAGES = [
    { at: 0, title: "Reading your brief…" },
    { at: 1500, title: "Creating your brand voice…" },
    { at: 12000, title: "Getting your content ready…" },
  ];

  const STYLE_TONES = {
    "bold hook": 0, "direct cta": 0,
    "question": 1, "humor": 1,
    "mini story": 2, "behind the scenes": 2,
    "practical tip": 3, "myth vs fact": 3,
    "product spotlight": 4, "thread opener": 4,
  };

  const RESEARCH_STATUS_LABELS = {
    completed: "Completed",
    partial: "Partially completed",
    skipped: "Skipped",
    failed: "Failed",
  };

  const Review = window.BrandVoiceReview; // review.js: review status, labels, copy text
  const $ = (sel) => document.querySelector(sel);
  const form = $("#brief-form");
  const output = $("#output");
  const generateBtn = $("#generate-btn");
  const toast = $("#toast");
  let inFlight = null;
  let stageTimers = [];
  let lastTweets = [];
  let voicePrefs = null; // the user's answers, only after the server asked for them (no usable brand posts)
  let retryTimer = null; // rate-limit countdown on "Try again" (see startRetryCountdown)
  let voiceSource = null; // where the shown voice came from (labels: evidence vs inference vs your brief/answers)

  // ---------- Status ----------

  async function checkHealth() {
    const pill = $("#status");
    const text = $("#status-text");
    try {
      const res = await fetch(`${API_BASE}/health`, { cache: "no-store" });
      const data = await res.json();
      if (data.groq_configured) {
        pill.dataset.state = "ready";
        text.textContent = "Engine ready";
      } else {
        pill.dataset.state = "warn";
        text.textContent = "Groq keys not set";
      }
    } catch {
      pill.dataset.state = "offline";
      text.textContent = "Backend offline";
    }
  }

  // ---------- Form ----------

  function updateCounter(field) {
    const counter = document.querySelector(`.counter[data-for="${field.id}"]`);
    if (!counter) return;
    if (field.id === "example_tweets") { // counts tweets (lines), not characters
      const n = exampleLines(field.value).length;
      counter.textContent = `${n} tweet${n === 1 ? "" : "s"} (${LIMITS.example_tweets.min}–${LIMITS.example_tweets.max})`;
      counter.classList.toggle("near", n > LIMITS.example_tweets.max);
      return;
    }
    const max = LIMITS[field.id].max;
    const len = field.value.length;
    counter.textContent = `${len} / ${max}`;
    counter.classList.toggle("near", len > max * 0.9);
  }

  function setFieldError(name, message) {
    const input = form.elements[name];
    if (!input) return;
    const wrap = input.closest(".field");
    const slot = document.getElementById(`${name}-error`);
    wrap.classList.toggle("invalid", Boolean(message));
    input.setAttribute("aria-invalid", message ? "true" : "false");
    if (slot) slot.textContent = message || "";
  }

  function clearErrors() {
    Object.keys(LIMITS).forEach((name) => setFieldError(name, ""));
  }

  function readPayload() {
    const value = (name) => form.elements[name].value.trim();
    return {
      brand_name: value("brand_name") || null,
      industry: value("industry") || null,
      campaign_objective: value("campaign_objective"),
      description: value("description"),
      ...(exampleLines(form.elements.example_tweets.value).length
        ? { example_tweets: exampleLines(form.elements.example_tweets.value) } : {}),
      ...(voicePrefs ? { voice_preferences: voicePrefs } : {}),
    };
  }

  function validate(payload) {
    const errors = {};
    for (const name of ["campaign_objective", "description"]) {
      const { min, max, label } = LIMITS[name];
      const len = payload[name].length;
      if (!len) errors[name] = `${label} is required.`;
      else if (len < min) errors[name] = `Add a little more detail (at least ${min} characters).`;
      else if (len > max) errors[name] = `Keep it under ${max} characters.`;
    }
    const examples = payload.example_tweets || [];
    const { min, max, maxChars } = LIMITS.example_tweets;
    if (examples.length && (examples.length < min || examples.length > max)) {
      errors.example_tweets = `Add ${min}–${max} example tweets (one per line), or leave this empty.`;
    } else if (examples.some((t) => [...t].length > maxChars)) {
      errors.example_tweets = `Each example tweet must be at most ${maxChars} characters.`;
    }
    return errors;
  }

  // ---------- States ----------

  function showState(name) {
    if (name !== "error") clearRetryCountdown(); // leaving the error view: no countdown keeps running
    output.querySelectorAll(".state").forEach((el) => {
      el.hidden = el.dataset.state !== name;
    });
    output.setAttribute("aria-busy", name === "loading" ? "true" : "false");
  }

  function startProgress() {
    const fill = $("#progress-fill");
    const title = $("#loading-title");
    const items = [...document.querySelectorAll("#stages li")];
    items.forEach((li) => li.classList.remove("active", "done"));
    fill.style.width = "4%";
    $("#x-loader").classList.add("is-animating");

    STAGES.forEach((stage, i) => {
      stageTimers.push(setTimeout(() => {
        items.forEach((li, j) => {
          li.classList.toggle("done", j < i);
          li.classList.toggle("active", j === i);
        });
        title.textContent = stage.title;
      }, stage.at));
    });

    // Ease toward 92% so the bar keeps moving without ever claiming completion.
    const started = performance.now();
    const tick = () => {
      const elapsed = (performance.now() - started) / 1000;
      fill.style.width = `${(4 + 88 * (1 - Math.exp(-elapsed / 14))).toFixed(1)}%`;
    };
    tick();
    stageTimers.push(setInterval(tick, 700));
  }

  function stopProgress(success) {
    stageTimers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    stageTimers = [];
    $("#x-loader").classList.remove("is-animating");
    if (success) {
      $("#progress-fill").style.width = "100%";
      document.querySelectorAll("#stages li").forEach((li) => {
        li.classList.remove("active");
        li.classList.add("done");
      });
    }
  }

  function setLoading(isLoading) {
    generateBtn.disabled = isLoading;
    generateBtn.classList.toggle("is-loading", isLoading);
    generateBtn.querySelector(".btn-label").textContent = isLoading ? "Generating…" : "Generate tweets";
    $("#regenerate-btn").disabled = isLoading;
  }

  // ---------- Rendering ----------

  function toneFor(style) {
    const key = style.trim().toLowerCase();
    if (key in STYLE_TONES) return STYLE_TONES[key];
    let hash = 0;
    for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return hash % 5;
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const safeUrl = (url) => (typeof url === "string" && /^https?:\/\//i.test(url) ? url : null);

  function setBasis(tag, basis, evidenceCount = 0) {
    tag.dataset.basis = basis === "evidence" ? "evidence" : "inferred";
    tag.textContent = Review.basisTagLabel(basis, evidenceCount, voiceSource);
  }

  function quoteNode(ev) {
    const q = el("blockquote", "quote");
    q.append(el("span", "source-ref", ev.source_id), document.createTextNode(` “${ev.quote}”`));
    return q;
  }

  function renderResearch(report) {
    const chip = $("#research-status");
    chip.dataset.status = report.status;
    chip.textContent = RESEARCH_STATUS_LABELS[report.status] || report.status;
    $("#research-message").textContent = report.message;

    const template = $("#source-template");
    $("#source-list").replaceChildren(...report.sources.map((src, i) => {
      const node = template.content.firstElementChild.cloneNode(true);
      node.style.setProperty("--i", i);
      node.dataset.kind = src.kind;
      node.querySelector(".source-ref").textContent = src.id;
      node.querySelector(".source-name").textContent = src.name;
      const link = node.querySelector(".source-url");
      const url = safeUrl(src.url);
      if (url) {
        link.href = url;
        link.textContent = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
      } else {
        link.remove();
      }
      node.querySelector(".excerpts").replaceChildren(...src.excerpts.map((x) => el("li", "", x)));
      const insights = node.querySelector(".insights");
      // Interpretation and verbatim quote are shown separately; only quoted ones are findings.
      insights.replaceChildren(...(src.insights.length
        ? src.insights.map((ins) => {
          const li = el("li", "insight");
          const tag = el("span", "basis-tag");
          tag.dataset.basis = ins.basis;
          tag.textContent = ins.basis === "evidence" ? `Finding ${ins.id}` : "Inference";
          li.append(el("span", "", `${ins.text} `), tag);
          if (ins.quote) li.append(quoteNode({ source_id: src.id, quote: ins.quote }));
          return li;
        })
        : [el("li", "muted", "No specific insights were drawn from this source.")]));
      if (src.user_supplied) node.querySelector(".source-name").append(el("span", "muted", " · from your brief"));
      return node;
    }));

    const excluded = report.excluded || [];
    $("#excluded").hidden = !excluded.length;
    $("#excluded-list").replaceChildren(...excluded.map((x) => el("li", "", x)));
  }

  function renderProfile(profile) {
    $("#voice-tone").textContent = profile.tone;
    $("#voice-audience").textContent = profile.audience;

    const template = $("#trait-template");
    $("#trait-grid").replaceChildren(...profile.traits.map((trait, i) => {
      const node = template.content.firstElementChild.cloneNode(true);
      node.style.setProperty("--i", i);
      node.dataset.basis = trait.basis;
      node.querySelector(".trait-name").textContent = trait.name;
      setBasis(node.querySelector(".basis-tag"), trait.basis, trait.evidence.length);
      node.querySelector(".trait-desc").textContent = trait.description;
      node.querySelector(".quotes").replaceChildren(...trait.evidence.map(quoteNode));
      return node;
    }));

    $("#pattern-list").replaceChildren(...profile.writing_patterns.map((p) => {
      const li = el("li", "pattern");
      const tag = el("span", "basis-tag");
      setBasis(tag, p.basis, p.evidence.length);
      li.append(el("span", "pattern-text", p.pattern), tag, ...p.evidence.map(quoteNode));
      return li;
    }));
    $("#theme-chips").replaceChildren(...profile.themes.map((t) => el("span", "chip", t)));
    $("#avoid-chips").replaceChildren(...(profile.avoid.length
      ? profile.avoid.map((t) => el("span", "chip", t))
      : [el("span", "chip muted", "Nothing specific")]));
  }

  function renderSuccess(data) {
    voiceSource = data.voice_source; // e.g. answers are labelled "From your answers", never as researched voice
    renderResearch(data.research);
    renderProfile(data.voice_profile);

    const voiceList = $("#voice-list");
    voiceList.replaceChildren(...data.brand_voice_summary.map((point, i) => {
      const li = document.createElement("li");
      li.textContent = point;
      li.dataset.n = String(i + 1);
      li.style.setProperty("--i", i);
      return li;
    }));

    const brand = form.elements.brand_name.value.trim();
    $("#voice-title").textContent = Review.voiceTitle(data, brand); // never asserts a voice the evidence can't support

    const template = $("#tweet-template");
    const grid = $("#tweet-grid");
    lastTweets = data.tweets;
    grid.replaceChildren(...data.tweets.map((tweet, i) => {
      const node = template.content.firstElementChild.cloneNode(true);
      const chars = [...tweet.text].length;
      node.style.setProperty("--i", i);
      node.dataset.tone = String(toneFor(tweet.style));
      node.querySelector(".tweet-index").textContent = String(i + 1).padStart(2, "0");
      node.querySelector(".style-badge").textContent = Review.badgeLabel(tweet);
      node.querySelector(".tweet-text").textContent = tweet.text;
      node.querySelector(".tweet-traits").replaceChildren(...tweet.traits.map((t) => el("span", "chip chip-trait", t)));
      setBasis(node.querySelector(".tweet-why .basis-tag"), tweet.basis);
      // Research citations describe where the voice came from; they never verify product claims.
      node.querySelector(".tweet-why .basis-tag").textContent = Review.basisLabel(tweet);
      if (Review.needsReview(tweet)) {
        node.dataset.review = "true";
        node.querySelector(".needs-review").hidden = false;
        // One list item per reason; el() sets textContent, so reason text is never parsed as HTML.
        node.querySelector(".needs-review-text").replaceChildren(
          ...Review.reviewReasons(tweet).map((reason) => el("li", "", `${reason}.`)));
        node.querySelector(".copy-btn span").textContent = "Copy draft";
      }
      node.querySelector(".why-rationale").textContent = tweet.rationale;
      if (tweet.insight && tweet.source_ids.length) {
        const insight = node.querySelector(".why-insight");
        insight.hidden = false;
        insight.querySelector(".source-ref").textContent = tweet.source_ids.join(", ");
        insight.querySelector(".why-insight-text").textContent = tweet.insight;
        if (tweet.insight_quote) insight.after(quoteNode({ source_id: tweet.source_ids[0], quote: tweet.insight_quote }));
      }
      node.querySelector(".char-count").textContent = `${chars} / ${MAX_TWEET_CHARS}`;
      node.querySelector(".meter-fill").style.width = `${Math.min(100, (chars / MAX_TWEET_CHARS) * 100)}%`;
      node.querySelector(".copy-btn").addEventListener("click", (e) => copyText(Review.copyOne(tweet), e.currentTarget));
      return node;
    }));

    const { ready, review } = Review.summary(data.tweets);
    $("#results-title").textContent = review ? "Review before posting" : "Ready to post";
    $("#results-status").textContent = review
      ? `${ready} ready to post · ${review} need${review === 1 ? "s" : ""} review`
      : `All ${ready} ready to post`;
    $("#review-note").hidden = !review;

    showState("success");
    // Bring the tweets into view and move keyboard focus to their heading (tabindex="-1": focusable by script only,
    // not added to the tab order), so keyboard and screen-reader users land on the results too.
    const resultsTitle = $("#results-title");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resultsTitle.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    resultsTitle.focus({ preventScroll: true });
  }

  const ERROR_COPY = {
    0: ["Can't reach the backend", "Make sure the server is running (uvicorn app.main:app) and try again."],
    422: ["Check your brief", "Some fields need attention — see the highlighted inputs."],
    429: ["Taking a short breather", "The AI provider's rate limit was reached. Wait a moment, then try again."],
    502: ["Generation hit a snag", "The AI returned an unexpected result. Trying again usually fixes it."],
    503: ["Engine not configured", "The server is missing a Groq API key. Add GROQ_API_KEY and GROQ_API_KEY_BRAND_VOICE to backend/.env and restart."],
    504: ["That took too long", "The AI didn't respond in time. Please try again."],
  };

  function renderError(status, detail, retryAfter) {
    const [title, fallback] = ERROR_COPY[status] || ["Something went wrong", "Please try again in a moment."];
    $("#error-title").textContent = title;
    // Rate limits use the friendly copy (no provider name); other errors keep the server's specific message.
    $("#error-message").textContent = status !== 429 && typeof detail === "string" && detail ? detail : fallback;
    showState("error");
    startRetryCountdown(Review.retryDelaySeconds(status, retryAfter)); // 0 (no delay) except for 429
  }

  // "Try again" after a rate limit: disabled with a visible countdown, so an immediate retry can't hit the same limit.
  function clearRetryCountdown() {
    clearInterval(retryTimer);
    retryTimer = null;
    const btn = $("#retry-btn");
    btn.disabled = false;
    btn.textContent = "Try again";
  }

  function startRetryCountdown(seconds) {
    clearRetryCountdown();
    if (!seconds) return;
    const btn = $("#retry-btn");
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        clearRetryCountdown();
        return;
      }
      btn.disabled = true;
      btn.textContent = `Try again in ${left}s`;
      left -= 1;
    };
    tick();
    retryTimer = setInterval(tick, 1000);
  }

  function applyServerFieldErrors(detail) {
    if (!Array.isArray(detail)) return;
    for (const err of detail) {
      // loc may end in a list index (["body", "example_tweets", 2]): use the field name, wherever it appears.
      const name = Array.isArray(err.loc) ? err.loc.find((part) => part in LIMITS) : null;
      if (name) setFieldError(name, err.msg || "Invalid value.");
    }
  }

  // ---------- Voice questions (fallback) ----------

  function renderQuestions(detail) {
    $("#questions-message").textContent = detail.message || "";
    $("#voice-form-error").textContent = "";
    const questions = Array.isArray(detail.questions) ? detail.questions : [];
    $("#voice-questions").replaceChildren(...questions.map((q) => {
      const set = el("fieldset", "voice-question");
      set.append(el("legend", "", q.question));
      const previous = voicePrefs ? voicePrefs[q.field] : undefined;
      if (Array.isArray(q.options) && q.options.length) {
        set.dataset.required = "true";
        const choices = el("div", "choice-row");
        choices.append(...q.options.map((option) => {
          const label = el("label", "choice");
          const input = document.createElement("input");
          Object.assign(input, { type: "radio", name: q.field, value: option, checked: previous === option });
          label.append(input, el("span", "", option));
          return label;
        }));
        set.append(choices);
      } else {
        const input = document.createElement("input");
        Object.assign(input, { type: "text", name: q.field, maxLength: 200, value: previous || "" });
        input.setAttribute("aria-label", q.question);
        set.append(input);
      }
      return set;
    }));
    showState("questions");
    $("#voice-questions input")?.focus();
  }

  function readVoiceAnswers() {
    const voiceForm = $("#voice-form");
    const answers = {};
    for (const set of voiceForm.querySelectorAll(".voice-question")) {
      const inputs = [...set.querySelectorAll("input")];
      const name = inputs[0] && inputs[0].name;
      if (!name) continue;
      const value = set.dataset.required ? (inputs.find((i) => i.checked) || {}).value : inputs[0].value.trim();
      if (set.dataset.required && !value) return null;
      if (value) answers[name] = value;
    }
    return answers;
  }

  // ---------- Generate ----------

  async function generate() {
    if (inFlight) return;
    clearErrors();
    const payload = readPayload();
    const errors = validate(payload);
    if (Object.keys(errors).length) {
      Object.entries(errors).forEach(([name, msg]) => setFieldError(name, msg));
      form.elements[Object.keys(errors)[0]].focus();
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    inFlight = controller;
    setLoading(true);
    showState("loading");
    startProgress();
    // Show the loading (and any error) state: on narrow screens, and whenever the page is scrolled past the top of the
    // output (e.g. after a previous result was brought into view), or the state would appear off-screen.
    if (window.matchMedia("(max-width: 1020px)").matches || output.getBoundingClientRect().top < 0) {
      output.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    try {
      const res = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 409 && body.detail && body.detail.code === "voice_input_needed") {
        stopProgress(false);
        renderQuestions(body.detail); // fallback: no usable brand posts, so ask how to sound
        return;
      }
      if (!res.ok) {
        stopProgress(false);
        if (res.status === 422) applyServerFieldErrors(body.detail);
        renderError(res.status, res.status === 422 ? null : body.detail, res.headers.get("retry-after"));
        return;
      }
      if (!Array.isArray(body.tweets) || !Array.isArray(body.brand_voice_summary) || !body.voice_profile || !body.research) {
        stopProgress(false);
        renderError(502, null);
        return;
      }
      stopProgress(true);
      await new Promise((r) => setTimeout(r, 450)); // let the completed progress register
      renderSuccess(body);
    } catch (err) {
      stopProgress(false);
      if (err.name === "AbortError") renderError(504, null);
      else renderError(0, null);
    } finally {
      clearTimeout(timeout);
      inFlight = null;
      setLoading(false);
    }
  }

  // ---------- Clipboard ----------

  let toastTimer;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    if (button) {
      const label = button.querySelector("span");
      const original = label.textContent;
      button.classList.add("copied");
      label.textContent = "Copied";
      setTimeout(() => { button.classList.remove("copied"); label.textContent = original; }, 1600);
    }
    showToast(button ? "Tweet copied to clipboard" : "All tweets copied");
  }

  // ---------- Wiring ----------

  form.addEventListener("submit", (e) => { e.preventDefault(); generate(); });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); }
  });
  $("#voice-form").addEventListener("change", () => { $("#voice-form-error").textContent = ""; });
  $("#voice-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const answers = readVoiceAnswers();
    if (!answers) {
      $("#voice-form-error").textContent = "Please answer each question (the last one is optional).";
      return;
    }
    voicePrefs = answers;
    generate();
  });
  form.querySelectorAll("input, textarea").forEach((field) => {
    field.addEventListener("input", () => {
      if (field.id === "brand_name") voicePrefs = null; // answers belong to the brand they were given for
      updateCounter(field);
      if (field.closest(".field").classList.contains("invalid")) setFieldError(field.id, "");
    });
    updateCounter(field);
  });

  $("#retry-btn").addEventListener("click", generate);
  $("#regenerate-btn").addEventListener("click", generate);
  $("#copy-all-btn").addEventListener("click", () => {
    copyText(Review.copyAll(lastTweets), null);  // flagged tweets keep a [NEEDS REVIEW] marker
  });

  checkHealth();
})();
