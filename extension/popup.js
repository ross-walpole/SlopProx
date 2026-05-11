// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// popup.js

(async () => {
  const dot        = document.getElementById('dot');
  const statusLabel = document.getElementById('statusLabel');
  const mainEl     = document.getElementById('main');
  const offlineEl  = document.getElementById('offline');
  const footerText = document.getElementById('footerText');
  const textCount  = document.getElementById('textCount');
  const adsCount   = document.getElementById('adsCount');
  const imgCount   = document.getElementById('imgCount');
  const ytCount    = document.getElementById('ytCount');

  // Session counters tracked by content scripts
  const stored = await chrome.storage.session
    .get(['textBlocked', 'imagesBlocked', 'youtubeBlocked'])
    .catch(() => ({}));

  textCount.textContent = (stored.textBlocked    || 0).toLocaleString();
  imgCount.textContent  = (stored.imagesBlocked  || 0).toLocaleString();
  ytCount.textContent   = (stored.youtubeBlocked || 0).toLocaleString();
  adsCount.textContent  = '—'; // updated from /status below

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'status' });
    if (!resp?.ok) throw new Error('no response');
    const data = resp.data;

    const anyActive = data.enabled || data.imageDetectionEnabled || data.youtubeFilterEnabled || data.adBlockEnabled;
    dot.className   = 'status-dot ' + (anyActive ? 'on' : 'off');
    statusLabel.textContent = anyActive ? 'LIVE' : 'PAUSED';

    if (typeof data.adsBlocked === 'number') {
      adsCount.textContent = data.adsBlocked.toLocaleString();
    }

    if (!data.enabled) {
      footerText.textContent = 'Text filtering paused';
    }
  } catch (_) {
    dot.className          = 'status-dot off';
    statusLabel.textContent = 'OFFLINE';
    mainEl.style.display   = 'none';
    offlineEl.style.display = 'block';
  }
})();
