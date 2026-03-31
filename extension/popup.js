(async () => {
  const dot       = document.getElementById('dot');
  const mainEl    = document.getElementById('main');
  const offlineEl = document.getElementById('offline');
  const textCount = document.getElementById('textCount');
  const imgCount  = document.getElementById('imgCount');

  // Read session counters persisted by content scripts
  const stored = await chrome.storage.session.get(['textBlocked', 'imagesBlocked']).catch(() => ({}));
  textCount.textContent = (stored.textBlocked  || 0).toLocaleString();
  imgCount.textContent  = (stored.imagesBlocked || 0).toLocaleString();

  try {
    const r = await fetch('http://127.0.0.1:8083/status', { signal: AbortSignal.timeout(800) });
    const { enabled } = await r.json();
    dot.className = 'status-dot ' + (enabled ? 'on' : 'off');
  } catch (_) {
    dot.className = 'status-dot off';
    mainEl.style.display    = 'none';
    offlineEl.style.display = 'block';
  }
})();
