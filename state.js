// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// state.js
module.exports = {
  FILTER_ENABLED: true,
  AD_BLOCKING_ENABLED: true,
  IMAGE_DETECTION_ENABLED: false,
  YOUTUBE_FILTER_ENABLED: true,

  PROXY_ENABLED: true,
  // Domains the app itself requires — never MITM'd, never removable by the user.
  // App-specific bypasses (Discord, Steam, OutSystems, etc.) are added dynamically.
  BYPASS_DOMAINS_PROTECTED: [
    'localhost',
    '127.0.0.1',
    'huggingface.co',
    'cdn-lfs.huggingface.co',
    'cdn-lfs-us-1.huggingface.co',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'api.github.com',
  ],
  BYPASS_DOMAINS: [
    'localhost',
    '127.0.0.1',
    'huggingface.co',
    'cdn-lfs.huggingface.co',
    'cdn-lfs-us-1.huggingface.co',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'api.github.com',
  ],

  filteredCount: 0,
  adsBlocked: 0,
  imagesBlocked: 0,
  youtubeBlocked: 0,
};