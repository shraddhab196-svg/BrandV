// Review status, labels and copy text for generated tweets. Pure functions: used by app.js in the browser and
// unit-tested with Node (backend/tests/test_frontend.py), so what users copy is tested, not just rendered.
(function (root) {
  "use strict";

  const REVIEW_TAG = "[NEEDS REVIEW]";

  // Factual grounding (unverified_details) and style quality (quality_issues) are separate checks; either needs review.
  const issues = (tweet) => [tweet.unverified_details, tweet.quality_issues].flatMap((x) => (Array.isArray(x) ? x : []));

  const needsReview = (tweet) => issues(tweet).length > 0;

  // Backend items already explain the risk and quote the wording ("Number not in your brief: “40% faster”").
  // No trailing punctuation: callers add their own full stop.
  const reviewReason = (tweet) => issues(tweet).join("; ").replace(/[.\s…]+$/, "");

  // Content style and format in the existing badge ("witty · question"); older responses show the format only.
  const badgeLabel = (tweet) => (tweet.content_style ? `${tweet.content_style} · ${tweet.style}` : tweet.style);

  // Voice card title, honest about where the voice came from and how much evidence backs it.
  function voiceTitle(data, brand) {
    const confidence = (data.voice_profile || {}).voice_confidence;
    if (data.voice_source === "user_preferences") return "Your chosen voice";
    if (data.voice_source === "user_examples") {
      return confidence === "low" ? "Voice from your example tweets (limited evidence)" : "Voice from your example tweets";
    }
    if (confidence === "none" || data.voice_source === "brief") return "Suggested voice (from your brief)";
    const name = brand ? `How ${brand} sounds` : "How this brand sounds";
    return confidence === "low" ? `${name} (limited evidence)` : name;
  }

  // Trait/pattern label that keeps evidence, inference and the brief apart: "Evidence-backed" = quotes from 2+ posts;
  // "Limited evidence" = quoted, but not enough to rely on; otherwise inferred, "from brief" only when the voice came
  // from the brief (with research, an unquoted item is the analyst's inference, not the brief).
  function basisTagLabel(basis, evidenceCount, voiceSource) {
    if (basis === "evidence") return "Evidence-backed";
    if (evidenceCount > 0) return "Limited evidence";
    if (voiceSource === "user_preferences") return "From your answers";
    if (!voiceSource || voiceSource === "brief") return "Inferred from brief";
    return "Inferred";
  }

  // Research citations mean research shaped the voice/style; they never verify product claims.
  function basisLabel(tweet) {
    const sources = (tweet.source_ids || []).join(", ");
    return sources ? `Voice from research · ${sources}` : "Based on voice profile";
  }

  // One entry per review reason (rendered as a list), without trailing punctuation.
  const reviewReasons = (tweet) => issues(tweet).map((reason) => reason.replace(/[.\s…]+$/, ""));

  // The product-brief reminder only fits unsupported claims; quality issues (repetition, vagueness) just need a review.
  const hasClaimIssue = (tweet) => Array.isArray(tweet.unverified_details) && tweet.unverified_details.length > 0;

  function copyOne(tweet) {
    if (!needsReview(tweet)) return tweet.text;
    const reminder = hasClaimIssue(tweet) ? "Check against your product brief before publishing." : "Review before publishing.";
    return `${REVIEW_TAG} ${reviewReason(tweet)}. ${reminder}\n\n${tweet.text}`;
  }

  // Seconds before "Try again" is enabled: only for rate limits (429). Prefer the server's Retry-After (seconds),
  // otherwise a conservative default; capped so the button never stays locked for long.
  const RETRY_DEFAULT_SECONDS = 20;
  const RETRY_MAX_SECONDS = 120;
  function retryDelaySeconds(status, retryAfter) {
    if (status !== 429) return 0;
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isFinite(seconds) || seconds <= 0) return RETRY_DEFAULT_SECONDS;
    return Math.min(Math.ceil(seconds), RETRY_MAX_SECONDS);
  }

  function copyAll(tweets) {
    return tweets.map((tweet, i) => {
      const line = `${i + 1}. ${needsReview(tweet) ? `${REVIEW_TAG} ` : ""}[${tweet.style}] ${tweet.text}`;
      return needsReview(tweet) ? `${line}\n   (${reviewReason(tweet)})` : line;
    }).join("\n\n");
  }

  function summary(tweets) {
    const review = tweets.filter(needsReview).length;
    return { ready: tweets.length - review, review };
  }

  const api = { REVIEW_TAG, needsReview, reviewReason, reviewReasons, badgeLabel, voiceTitle, basisLabel, basisTagLabel,
    copyOne, copyAll, summary, retryDelaySeconds, RETRY_DEFAULT_SECONDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BrandVoiceReview = api;
})(typeof window !== "undefined" ? window : globalThis);
