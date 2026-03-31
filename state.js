// Shared mutable state — required as a singleton across all modules.
// Properties are mutated directly; Node's module cache ensures one instance.
module.exports = {
  FILTER_ENABLED: true,
  AD_BLOCKING_ENABLED: true,
  IMAGE_DETECTION_ENABLED: false, // opt-in — requires ~84 MB local model
  YOUTUBE_FILTER_ENABLED: true,
  filteredCount: 0,
  adsBlocked: 0,
  imagesBlocked: 0,
  youtubeBlocked: 0,
};
