// content.js 

(function () {
  'use strict';

  if (window.top !== window.self) return;
  if (window.__sfLoaded) return;
  window.__sfLoaded = true;

  const TEXT_SEL = [
    'p',
    'blockquote',
    'li:not(nav li):not(header li):not(footer li):not(aside li)',
    '[data-testid="tweetText"]',
    '[data-testid="birdwatch-pivot"]',
    '[data-testid="post-body"]',
    '[data-testid="post-content"]',
    '.article-body p',
  ].join(', ');

  const MIN_LEN    = 60;
  const IMG_MIN_PX = 300;

  let filterEnabled         = true;
  let imageDetectionEnabled = false;
  let youtubeFilterEnabled  = true;
  let currentYtInterceptor  = null; // { cleanup(), play() } for active video block
  let ytBlockedHref         = null; // href at the time the block was applied

  // ── Catch-all card boundary detection ──────────────────────────
  //
  // Works on any site without platform-specific selectors.
  // Climbs the DOM from the flagged element looking for a "card":
  //
  //   1. Feed-child: direct child of role="feed" — always a post card
  //      (LinkedIn occludable-update, X.com timeline cells, etc.)
  //   2. Semantic card: <article> / role="article" / role="listitem"
  //      with at least one peer sibling
  //   3. Custom element: hyphenated tag (shreddit-post, etc.) with peers
  //   4. Visual card: element with border/shadow + border-radius + peers
  //
  // Stops before page-frame elements (main, header, nav, body) and
  // before climbing INTO the feed container itself.
  // Returns null for single-page article context → inline paragraph mode.
  //
  function findCardBoundary(el) {
    let node = el.parentElement;
    const viewportH = window.innerHeight;
    let climbed = 0;

    while (node && node !== document.body && climbed < 16) {
      climbed++;

      if (node.dataset.sfCardBlurred || node.dataset.sfRevealed) return null;

      const tag  = node.tagName;
      const role = (node.getAttribute('role') || '').toLowerCase();

      // Absolute hard stops — never these page-frame containers
      if (/^(MAIN|BODY|HTML|HEADER|FOOTER|NAV)$/.test(tag)) break;
      if (/^(main|navigation|banner|contentinfo)$/.test(role)) break;

      const rect = node.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 50) { node = node.parentElement; continue; }
      if (rect.height > viewportH * 0.85)        { node = node.parentElement; continue; }

      const parentEl   = node.parentElement;
      const parentRole = (parentEl?.getAttribute('role') || '').toLowerCase();

      // ── 1. Feed-child ───────────────────────────────────────────
      // Direct children of role="feed" ARE post cards by definition.
      // This catches LinkedIn's occludable-update divs which have no
      // visible border/shadow themselves but are children of role="feed".
      // Check this FIRST — it's the most reliable signal.
      if (parentRole === 'feed') {
        const peers = [...parentEl.children].filter(c => c !== node && c.offsetHeight > 40);
        if (peers.length >= 1) return node;
      }

      // ── 2. Semantic card ────────────────────────────────────────
      if (tag === 'ARTICLE' || role === 'article' || role === 'listitem') {
        const peers = [...(parentEl?.children || [])].filter(c => c !== node && c.offsetHeight > 40);
        if (peers.length >= 1) return node;
      }

      // ── 3. Custom element / web component (e.g., shreddit-post) ─
      // Hyphenated tag names are always custom elements. If they're
      // substantial in size and have peers, they're feed items.
      if (tag.includes('-') && rect.height > 100) {
        const peers = [...(parentEl?.children || [])].filter(c => c !== node && c.offsetHeight > 40);
        if (peers.length >= 1) return node;
      }

      // ── 4. Visual card ──────────────────────────────────────────
      const cs            = getComputedStyle(node);
      const hasBorder     = parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none';
      const hasShadow     = cs.boxShadow !== 'none' && cs.boxShadow !== '';
      const hasBorderRadius = parseFloat(cs.borderRadius) > 4;

      if ((hasBorder || hasShadow) && hasBorderRadius) {
        const peers = [...(parentEl?.children || [])].filter(c => c !== node && c.offsetHeight > 40);
        if (peers.length >= 1) return node;
      }

      // Soft stop: don't climb above the feed container itself.
      // This fires AFTER the checks above so a feed's direct children
      // are evaluated before we stop.
      if (role === 'feed') break;

      node = node.parentElement;
    }

    return null;
  }

  // ── Placeholder event guards ────────────────────────────────────
  // Prevents placeholder clicks from reaching ancestor link/card handlers.
  //
  // Two layers:
  //   1. mousedown capture — blocks drag-start and text-selection on background
  //   2. click bubble     — stops ALL clicks bubbling past the placeholder,
  //                         covering parent divs with onclick navigation (LinkedIn,
  //                         Reddit, Twitter card wrappers, etc.)
  //
  // The reveal button's own click handler calls stopPropagation too, but that
  // only stops propagation from the button upward — this handles the case where
  // the click lands on the placeholder background rather than the button.
  function installGuards(placeholder) {
    placeholder.addEventListener('mousedown', e => {
      if (!e.target.closest('.sf-reveal-btn')) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    // Bubble phase: runs after the button's own click handler (if the click was
    // on the button, stopPropagation there already prevents this from firing).
    // Catches background clicks and stops them from reaching any ancestor.
    placeholder.addEventListener('click', e => {
      e.stopPropagation();
      if (!e.target.closest('.sf-reveal-btn')) e.preventDefault();
    });
  }

  // ── Text classification batch queue ────────────────────────────
  // Buffers classify requests for 50 ms then sends them as a single
  // background message, cutting per-page HTTP round-trips by ~70%.
  // Each entry: { text, resolve } where resolve(result) fires on completion.
  const _textBatchQueue = [];
  let _textBatchTimer = null;

  function _flushTextBatch() {
    _textBatchTimer = null;
    if (!_textBatchQueue.length) return;
    const batch = _textBatchQueue.splice(0);
    // Send all texts at once; background.js issues one /classify call per item
    // but they share a single message channel round-trip.
    Promise.allSettled(
      batch.map(({ text }) =>
        new Promise(res => {
          chrome.runtime.sendMessage({ type: 'classify', text })
            .then(r => res(r))
            .catch(() => res({ ok: false }));
        })
      )
    ).then(results => {
      results.forEach((r, i) => {
        batch[i].resolve(r.status === 'fulfilled' ? r.value : { ok: false });
      });
    });
  }

  function _batchClassifyText(text) {
    return new Promise(resolve => {
      _textBatchQueue.push({ text, resolve });
      if (!_textBatchTimer) _textBatchTimer = setTimeout(_flushTextBatch, 50);
    });
  }

  // ── Status polling ──────────────────────────────────────────────
  async function pollStatus() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'status' });
      if (!resp?.ok) return;
      const data = resp.data;
      const wasEnabled = filterEnabled;
      filterEnabled         = data.enabled ?? true;
      imageDetectionEnabled = data.imageDetectionEnabled ?? false;
      youtubeFilterEnabled  = data.youtubeFilterEnabled ?? true;

      if (wasEnabled && !filterEnabled) {
        document.querySelectorAll('.sf-card-placeholder').forEach(p => {
          if (p._sfCard) {
            p._sfCard.style.display = p._sfCardDisplay || '';
            delete p._sfCard.dataset.sfCardBlurred;
          }
          p.remove();
        });
        document.querySelectorAll('.sf-text-placeholder').forEach(p => {
          const el = p._sfEl;
          if (el) { el.classList.remove('sf-content'); delete el.dataset.slopBlurred; p.replaceWith(el); }
          else p.remove();
        });
        document.querySelectorAll('.sf-img-placeholder').forEach(p => {
          if (p._sfTarget) {
            p._sfTarget.style.opacity = '';
            p._sfTarget.style.pointerEvents = '';
            delete p._sfTarget.dataset.sfImgBlurred;
          }
          if (p._sfVideo && p._sfVideoPaused === false) p._sfVideo.play().catch(() => {});
          p.remove();
        });
        observer.disconnect();
        imageObserver.disconnect();
        clearInterval(statusTimer);
      }
    } catch (_) {}
  }

  // ── Card slop ───────────────────────────────────────────────────
  //
  // Hides the card with display:none and inserts a placeholder sibling
  // immediately after it. The original element stays in the DOM so
  // framework-managed components (React, Lit, shreddit-post) don't break.
  //
  // Key details:
  //   - Saves computed display before hiding so we restore to exactly
  //     the same value (important for custom elements / flex containers).
  //   - Reveal button listens on both pointerup AND click to ensure it
  //     fires even when surrounding JS intercepts click events.
  //   - `revealed` guard prevents double-fire if both events fire.
  //   - e.preventDefault() stops any default action on the propagation
  //     path (link navigation, form submit, etc.).
  //
  function applyCardSlop(card, confidence, type, btnText, method) {
    if (card.dataset.sfCardBlurred || card.dataset.sfRevealed) return;
    card.dataset.sfCardBlurred = 'true';

    try {
      const rect         = card.getBoundingClientRect();
      const savedDisplay = getComputedStyle(card).display;

      const label = type === 'image' ? 'Suspected AI Image Post' : 'Suspected AI Generated Post';
      const revealLabel = btnText || 'Show post';

      const placeholder = document.createElement('div');
      placeholder.className      = 'sf-card-placeholder';
      placeholder._sfCard        = card;
      placeholder._sfCardDisplay = savedDisplay === 'none' ? 'block' : savedDisplay;
      // Lock to the original element's exact rendered dimensions so the
      // placeholder never expands beyond the space the card already occupied.
      placeholder.style.width  = rect.width  + 'px';
      placeholder.style.height = Math.max(rect.height, 80) + 'px';

      installGuards(placeholder);

      placeholder.innerHTML = `
        <div class="sf-card-inner">
          <div class="sf-detect-row">
            <span class="sf-detect-icon">🤖</span>
            <span class="sf-detect-label">${label}</span>
            <span class="sf-detect-conf">${confidence}%</span>
            ${method ? `<span class="sf-detect-method">${method}</span>` : ''}
          </div>
          <button class="sf-reveal-btn" type="button">${revealLabel}</button>
        </div>`;

      let revealed = false;
      const doReveal = (e) => {
        if (revealed) return;
        revealed = true;
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        card.style.display = placeholder._sfCardDisplay;
        delete card.dataset.sfCardBlurred;
        card.dataset.sfRevealed = 'true';
        placeholder.remove();
      };

      const btn = placeholder.querySelector('.sf-reveal-btn');
      btn.style.pointerEvents = 'auto';
      btn.addEventListener('pointerup', doReveal);
      btn.addEventListener('click',     doReveal);

      card.style.display = 'none';
      card.insertAdjacentElement('afterend', placeholder);

      const countKey = type === 'image' ? 'imagesBlocked' : 'textBlocked';
      chrome.storage.session.get(countKey).then(s => {
        chrome.storage.session.set({ [countKey]: (s[countKey] || 0) + 1 });
      }).catch(() => {});
    } catch (_) {}
  }

  // ── Section-context injection ───────────────────────────────────
  //
  // Instead of hard-coding rules about what content to skip, we give the
  // model the section it came from. A paragraph in a "References" section
  // will be sent as "References\n<text>" — the model understands that is
  // bibliographic data, not AI-generated prose, without us ever needing to
  // know about citations specifically.
  //
  // Works for any site, any section type (References, FAQ, Glossary,
  // About, Terms & Conditions, etc.) without per-site special-casing.
  //
  function getClassifyText(el) {
    const content = el.textContent.trim().replace(/\s+/g, ' ');

    // Climb the DOM looking for the nearest preceding sibling heading.
    // A heading that immediately precedes a block of text names the
    // section it belongs to — exactly the context the model needs.
    let node = el;
    while (node && node !== document.body) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) {
          const heading = sib.textContent.trim();
          // Use headings that are reasonably short (i.e. a real section
          // title, not an article headline that is itself long prose).
          if (heading.length > 0 && heading.length < 120) {
            return heading + '\n' + content;
          }
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }

    return content;
  }

  // ── Card-level text classification (site-agnostic) ─────────────
  //
  // On modern SPAs (LinkedIn, Facebook, etc.) post text lives in <div>
  // and <span> elements with site-specific class names — never <p> or <li>.
  // Rather than hard-coding selectors per site, we detect post cards
  // structurally (same rules as findCardBoundary) and classify the card's
  // full text as one unit. No site knowledge required.

  function looksLikePostCard(el) {
    if (!el || el === document.body) return false;
    const tag    = el.tagName || '';
    const role   = (el.getAttribute('role') || '').toLowerCase();
    const parent = el.parentElement;
    if (!parent) return false;
    const parentRole = (parent.getAttribute('role') || '').toLowerCase();

    const rect = el.getBoundingClientRect();
    if (rect.width < 150 || rect.height < 80)             return false;
    if (rect.height > window.innerHeight * 0.85)           return false;

    const hasPeers = p => [...p.children].filter(c => c !== el && c.offsetHeight > 40).length >= 1;

    if (parentRole === 'feed'                                     && hasPeers(parent)) return true;
    if ((tag === 'ARTICLE' || role === 'article' || role === 'listitem') && hasPeers(parent)) return true;
    if (tag.includes('-') && rect.height > 100                   && hasPeers(parent)) return true;
    return false;
  }

  async function classifyCardText(card) {
    if (!filterEnabled) return;
    if (card.dataset.sfCardBlurred || card.dataset.sfRevealed || card.dataset.sfCardTextChecked) return;
    card.dataset.sfCardTextChecked = 'true';

    // Extract only content lines from the card — filter out UI chrome:
    // names, timestamps, reaction counts, button labels, accessibility labels
    // like "Feed post", dialog instructions, etc. These are typically short lines
    // that don't form prose. Lines ≥ 45 chars are almost always actual content.
    const raw = (card.innerText || card.textContent || '');
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length >= 45);
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_LEN) return;

    try {
      const resp = await _batchClassifyText(text);
      if (!resp?.ok) return;
      const { isSlop, confidence, method } = resp.data;
      if (isSlop) applyCardSlop(card, confidence, 'text', undefined, method);
    } catch (_) {}
  }

  // Scan root for post cards (or treat root itself as a card).
  // Called from the MutationObserver, SPA nav hooks, and startup.
  function _scanCardsIn(root) {
    if (looksLikePostCard(root)) { classifyCardText(root); return; }
    const candidates = root.querySelectorAll?.('article, [role="article"], [role="listitem"], [role="feed"] > *');
    if (candidates) for (const el of candidates) { if (looksLikePostCard(el)) classifyCardText(el); }
  }

  // ── Text classification ─────────────────────────────────────────
  async function classifyText(el) {
    if (!filterEnabled || el.dataset.slopChecked) return;
    // Skip elements already inside a card that was hidden at the card level
    if (el.closest('[data-sf-card-blurred]')) return;
    const content = el.textContent.trim().replace(/\s+/g, ' ');
    if (content.length < MIN_LEN) return;
    // Skip CSS blobs injected as text nodes
    if (/^\s*\.[\w-][\w-]*\s*\{/.test(content)) return;
    // Skip elements inside dialogs, alerts, navigation, or other non-content roles
    if (el.closest('[role="dialog"],[role="alert"],[role="status"],[role="alertdialog"],dialog,nav,aside,footer,header')) return;
    el.dataset.slopChecked = 'true';

    try {
      const resp = await _batchClassifyText(getClassifyText(el));
      if (!resp?.ok) return;
      const { isSlop, confidence, method } = resp.data;
      if (isSlop) applyTextSlop(el, confidence, method);
    } catch (_) {}
  }

  function applyTextSlop(el, confidence, method) {
    const card = findCardBoundary(el);
    if (card) { applyCardSlop(card, confidence, 'text', undefined, method); return; }

    // ── Article / no-card context: inline paragraph placeholder ────
    if (el.dataset.slopBlurred) return;
    try {
      el.dataset.slopBlurred = 'true';
      el.classList.add('sf-content');

      const placeholder = document.createElement('div');
      placeholder.className = 'sf-text-placeholder';
      placeholder._sfEl = el;
      installGuards(placeholder);

      placeholder.innerHTML = `
        <div class="sf-text-inner">
          <div class="sf-detect-row">
            <span class="sf-detect-icon">🤖</span>
            <span class="sf-detect-label">Suspected AI Text</span>
            <span class="sf-detect-conf">${confidence}%</span>
            ${method ? `<span class="sf-detect-method">${method}</span>` : ''}
          </div>
          <button class="sf-reveal-btn" type="button">Show text</button>
        </div>`;

      let revealed = false;
      const doReveal = (e) => {
        if (revealed) return;
        revealed = true;
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        el.classList.remove('sf-content');
        delete el.dataset.slopBlurred;
        placeholder.replaceWith(el);
      };

      const btn = placeholder.querySelector('.sf-reveal-btn');
      btn.style.pointerEvents = 'auto';
      btn.addEventListener('pointerup', doReveal);
      btn.addEventListener('click',     doReveal);

      el.parentNode.insertBefore(placeholder, el);

      chrome.storage.session.get('textBlocked').then(s => {
        chrome.storage.session.set({ textBlocked: (s.textBlocked || 0) + 1 });
      }).catch(() => {});
    } catch (_) {}
  }

  // ── Page-level AI density prior ─────────────────────────────────
  // After 4+ completed classifications, the page AI ratio adjusts the
  // effective threshold for subsequent borderline images:
  //   ≥ 50% AI  → +8 boost  (AI-heavy page, lower threshold)
  //   ≤ 10% AI  → −8 penalty (real-photo page, raise threshold)
  //   otherwise → no adjustment
  //
  // pageCompletedCount tracks COMPLETED classifications (not pending),
  // so the ratio is always accurate when the adjustment fires.
  let pageAiCount        = 0;  // confirmed AI images this page
  let pageCompletedCount = 0;  // completed classifications this page

  // LRU page image cache — capped at 500 to bound memory on infinite-scroll pages.
  const PAGE_CACHE_MAX = 500;
  const pageImageCache = new Map(); // src → {blocked: bool, confidence}
  function _pageImageCacheSet(key, value) {
    if (pageImageCache.has(key)) pageImageCache.delete(key);
    else if (pageImageCache.size >= PAGE_CACHE_MAX) pageImageCache.delete(pageImageCache.keys().next().value);
    pageImageCache.set(key, value);
  }

function getPagePriorAdjustment() {
  if (pageCompletedCount < 4) return 0;
  const ratio = pageAiCount / pageCompletedCount;
  if (ratio >= 0.5)  return  5;   // AI-heavy page → moderate boost
  if (ratio <= 0.10) return -5;   // real-photo page → moderate suppression
  return 0;
}

  // ── Image classification ────────────────────────────────────────
  function shouldSkipImage(img) {
    const src = img.src || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('chrome-extension:') || src.startsWith('moz-extension:')) return true;
    if (/\.gif(\?|$)/i.test(src)) return true;
    if (/\.svg(\?|$)/i.test(src)) return true;
    if (img.getAttribute('aria-hidden') === 'true') return true;
    if (img.getAttribute('role') === 'presentation') return true;
    const w = img.naturalWidth, h = img.naturalHeight;
    if (w && h) {
      const ratio = w / h;
      // Very extreme ratios → banners, strips, icons
      if (ratio > 5 || ratio < 0.2) return true;
      // Wide landscape screenshots (tweet screenshots, UI captures, panoramas) are
      // unlikely to be AI art. AI generators produce mostly square or mild portrait/
      // landscape (roughly 0.5–2.5). Skip aggressively wide or tall images.
      if (ratio > 2.5 || ratio < 0.45) return true;
    }
    return false;
  }

  // Smooth unblur for images confirmed as real.
  function _clearScan(el) {
    el.style.transition = 'filter 0.3s ease-out, opacity 0.3s ease-out';
    el.classList.remove('sf-scanning');
    setTimeout(() => { el.style.transition = ''; }, 350);
  }

  async function classifyImage(img) {
    if (!filterEnabled || !imageDetectionEnabled) return;
    if (img.dataset.sfQueued || img.dataset.sfProcessing || shouldSkipImage(img)) return;

    const srcKey = img.src.split('?')[0]; // Normalize: ignore query params
    if (pageImageCache.has(srcKey)) {
      const cached = pageImageCache.get(srcKey);
      if (cached.blocked) {
        applyImageSlop(img, cached.confidence, 'cached');
      }
      return;
    }

    // Skip small images before the HTTP round-trip — saves backend overhead.
    if (img.naturalWidth < IMG_MIN_PX || img.naturalHeight < IMG_MIN_PX) return;

    img.dataset.sfQueued = 'true';
    img.dataset.sfProcessing = 'true';

    // Blur immediately — the user should not see the image before the verdict.
    img.style.transition = 'filter 0.12s, opacity 0.12s';
    img.classList.add('sf-scanning');

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'classifyImage', url: img.src });
      if (!resp?.ok) { _clearScan(img); return; }

      const { isAiImage, confidence, method } = resp.data;
      // Cache result
      const shouldBlock = isAiImage;
      _pageImageCacheSet(srcKey, { blocked: shouldBlock, confidence });
      // Increment AFTER response so ratio is always based on real results.
      pageCompletedCount++;
      // Apply page-level prior: +8 on AI-heavy pages can push borderline images over threshold.
      // Threshold matches service.js: combined > 0.95 → confidence >= 95.
      const adjustedConf = confidence + getPagePriorAdjustment();
      const blockIt = shouldBlock || adjustedConf >= 92;
      if (blockIt) {
        pageAiCount++;
        // Snap-remove blur before replacing element — no transition needed.
        img.style.transition = '';
        img.classList.remove('sf-scanning');
        // Clear sfProcessing before applyImageSlop — its guard checks this flag
        // and would bail immediately if it's still set from the classify request.
        delete img.dataset.sfProcessing;
        applyImageSlop(img, confidence, method);
      } else {
        // Real image — fade the blur out smoothly.
        _clearScan(img);
      }
    } catch (_) { _clearScan(img); }
  }

  function findAssociatedVideo(img) {
    let node = img.parentNode;
    for (let i = 0; i < 4; i++) {
      if (!node || node === document.body) break;
      const v = node.querySelector('video');
      if (v) return v;
      node = node.parentNode;
    }
    return null;
  }

  function applyImageSlop(img, confidence, method) {
    if (img.dataset.sfImgBlurred || img.dataset.sfProcessing) return;
    delete img.dataset.sfProcessing;
    img.dataset.sfImgBlurred = 'true';
    if (!img.parentNode) return;

    try {
      const video = findAssociatedVideo(img);
      const weStartedVideo = video && !video.paused;
      if (weStartedVideo) video.pause();

      // Find the nearest positioned ancestor (up to 6 levels).
      // Appending inside it keeps our placeholder within the same clipping /
      // stacking context, so overflow:hidden on a parent container cannot clip us.
      let container = img.parentElement;
      for (let i = 0; i < 6 && container && container !== document.body; i++) {
        if (getComputedStyle(container).position !== 'static') break;
        container = container.parentElement;
      }
      if (!container || container === document.body) {
        container = img.parentElement;
        if (getComputedStyle(container).position === 'static') {
          container.style.position = 'relative';
        }
      }

      // Use opacity:0 + pointer-events:none instead of display:none.
      // This keeps the image in the layout flow so the container does not
      // collapse — critical for h-full / w-full / flex images on Reddit,
      // Twitter, LinkedIn, etc. where display:none shrinks the cell to zero
      // and overflow:hidden then clips the placeholder.
      img.style.opacity = '0';
      img.style.pointerEvents = 'none';

      // Measure both rects AFTER hiding the image (opacity doesn't affect layout
      // so positions stay identical to the visible state).
      const imgRect       = img.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      const placeholder = document.createElement('div');
      placeholder.className      = 'sf-img-placeholder';
      placeholder._sfTarget      = img;
      placeholder._sfVideo       = video || null;
      placeholder._sfVideoPaused = weStartedVideo ? false : null;

      placeholder.style.position = 'absolute';
      placeholder.style.zIndex   = '2147483647';

      // If the image essentially fills the container (within 8 px on each axis),
      // use inset:0 so the overlay automatically tracks any future container resize.
      // Otherwise pin to the exact measured offset so we don't cover sibling content.
      const fillsContainer =
        Math.abs(imgRect.width  - containerRect.width)  < 8 &&
        Math.abs(imgRect.height - containerRect.height) < 8;
      const nearOrigin =
        imgRect.top  - containerRect.top  < 4 &&
        imgRect.left - containerRect.left < 4;

      if (fillsContainer || nearOrigin) {
        placeholder.style.inset = '0';
      } else {
        placeholder.style.top    = (imgRect.top  - containerRect.top)  + 'px';
        placeholder.style.left   = (imgRect.left - containerRect.left) + 'px';
        placeholder.style.width  = imgRect.width  + 'px';
        placeholder.style.height = imgRect.height + 'px';
      }

      const nw = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
      if (nw > 0 && nw < 500) placeholder.classList.add('sf-compact');

      placeholder.innerHTML = `
        <div class="sf-img-inner">
          <div class="sf-detect-row">
            <span class="sf-detect-icon">🤖</span>
            <span class="sf-detect-label">Suspected AI Image</span>
            <span class="sf-detect-conf">${confidence}%</span>
            ${method ? `<span class="sf-detect-method">${method}</span>` : ''}
          </div>
          <button class="sf-reveal-btn" type="button">Show image</button>
        </div>`;

      let revealed = false;
      const doReveal = (e) => {
        if (revealed) return;
        revealed = true;
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        img.style.opacity = '';
        img.style.pointerEvents = '';
        delete img.dataset.sfImgBlurred;
        if (placeholder._sfVideo && placeholder._sfVideoPaused === false) {
          placeholder._sfVideo.play().catch(() => {});
        }
        placeholder.remove();
      };

      const btn = placeholder.querySelector('.sf-reveal-btn');
      btn.addEventListener('click', doReveal);
      installGuards(placeholder);

      container.appendChild(placeholder);

      chrome.storage.session.get('imagesBlocked').then(s => {
        chrome.storage.session.set({ imagesBlocked: (s.imagesBlocked || 0) + 1 });
      }).catch(() => {});
    } catch (err) {
      console.error('[sf] applyImageSlop:', err);
      img.style.opacity = '';
      img.style.pointerEvents = '';
      delete img.dataset.sfImgBlurred;
    }
  }

  // ── YouTube AI-label filter ─────────────────────────────────────
  // Detects YouTube's mandatory "Altered or synthetic content" disclosure
  // and warns on watch pages; dims feed/Shorts cards where the label appears.

  const YT_DISCLOSURE_TEXT = 'Altered or synthetic content';

  function reportYoutubeBlock() {
    chrome.runtime.sendMessage({ type: 'youtubeBlock' }).catch(() => {});
  }

  function getYtVideoCard(el) {
    let node = el;
    while (node && node !== document.body) {
      const tag = (node.tagName || '').toLowerCase();
      if (tag.startsWith('ytd-') && (
        tag.includes('grid') || tag.includes('compact') ||
        tag.includes('reel') || tag.includes('video-renderer')
      )) return node;
      node = node.parentElement;
    }
    return null;
  }

  function markYtAiCard(card) {
    if (card.dataset.sfYtAi) return;
    card.dataset.sfYtAi = 'true';
    card.style.setProperty('opacity', '0.35', 'important');
    card.style.setProperty('filter', 'grayscale(0.7)', 'important');
    const badge = document.createElement('div');
    badge.className = 'sf-yt-feed-badge';
    badge.textContent = '🤖 AI-disclosed';
    card.style.position = 'relative';
    card.appendChild(badge);
    reportYoutubeBlock();
  }

  // Navigate to the next Short.
  function navigateYtNext() {
    // Try YouTube's own next-Short button first
    const nextBtn = document.querySelector(
      '#navigation-button-down button, ytd-shorts #navigation-button-down button'
    );
    if (nextBtn) { nextBtn.click(); return; }
    // Fallback: scroll the page (desktop Shorts responds to this)
    window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
  }

  // Returns the positioned player container for the current page/Short.
  function getYtPlayerContainer() {
    // Watch page
    const watch = document.querySelector('#movie_player');
    if (watch && watch.offsetHeight > 50) return watch;
    // Active Short (YouTube marks the visible one with [is-active])
    const activeReel = document.querySelector('ytd-reel-video-renderer[is-active]');
    if (activeReel) return activeReel.querySelector('#player-container') || activeReel;
    // Fallback
    return document.querySelector('#shorts-player, ytd-shorts');
  }

  // Block a specific video element from playing until the user consents.
  // Returns { cleanup() — remove listener only, play() — remove listener + play }.
  function interceptVideoPlay(video) {
    if (video.dataset.sfYtBlocked) return { cleanup: () => {}, play: () => {} };
    video.dataset.sfYtBlocked = 'true';
    if (!video.paused) video.pause();

    const onPlay = () => { if (video.dataset.sfYtBlocked) video.pause(); };
    video.addEventListener('play', onPlay, true);

    return {
      cleanup() {
        delete video.dataset.sfYtBlocked;
        video.removeEventListener('play', onPlay, true);
      },
      play() {
        this.cleanup();
        video.play().catch(() => {});
      },
    };
  }

  // Remove any active YouTube block immediately (overlay + interceptor).
  function cleanupYtBlock() {
    ytBlockedHref = null;
    document.getElementById('sf-yt-overlay')?.remove();
    if (currentYtInterceptor) {
      currentYtInterceptor.cleanup();
      currentYtInterceptor = null;
    }
  }

  function blockYtVideoPlayer() {
    if (document.getElementById('sf-yt-overlay')) return;

    const container = getYtPlayerContainer();
    if (container?.dataset.sfYtAllowed) return;
    const video = container?.querySelector('video') || document.querySelector('video');
    currentYtInterceptor = video ? interceptVideoPlay(video) : { cleanup: () => {}, play: () => {} };

    if (!container) { reportYoutubeBlock(); return; }

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const overlay = document.createElement('div');
    overlay.id = 'sf-yt-overlay';
    overlay.className = 'sf-yt-overlay';
    const isShorts = location.pathname.startsWith('/shorts/');
    overlay.innerHTML =
      '<div class="sf-yt-ov-icon">&#x1F916;</div>' +
      '<div class="sf-yt-ov-title">AI-Disclosed Content</div>' +
      '<div class="sf-yt-ov-sub">The creator has labeled this video as containing ' +
      'altered or synthetic (AI-generated) content.</div>' +
      '<div class="sf-yt-ov-buttons">' +
      '<button class="sf-yt-play-btn" type="button">&#x25B6; Play anyway</button>' +
      (isShorts ? '<button class="sf-yt-next-btn" type="button">Next video &#x2193;</button>' : '') +
      '</div>';

    overlay.querySelector('.sf-yt-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      container.dataset.sfYtAllowed = 'true';
      const interceptor = currentYtInterceptor;
      currentYtInterceptor = null;
      overlay.remove();
      interceptor.play();
    });

    overlay.querySelector('.sf-yt-next-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanupYtBlock();
      navigateYtNext();
    });

    container.appendChild(overlay);
    ytBlockedHref = location.href;
    reportYoutubeBlock();
  }

  function checkYtInitialData() {
    try {
      const ipr = window.ytInitialPlayerResponse;
      if (ipr && (
        ipr.videoDetails?.containsSyntheticMedia === true ||
        ipr.containsSyntheticMedia === true
      )) return true;
    } catch (_) {}
    return false;
  }

  function findYtDisclosureNode() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes(YT_DISCLOSURE_TEXT)) return node;
    }
    return null;
  }

  function runYoutubeCheck() {
    if (!youtubeFilterEnabled) return;
    if (!location.hostname.includes('youtube.com')) return;

    const isWatchPage = /[?&]v=/.test(location.search) || location.pathname.startsWith('/shorts/');

    if (isWatchPage) {
      if (checkYtInitialData()) { blockYtVideoPlayer(); return; }
      const node = findYtDisclosureNode();
      if (node) blockYtVideoPlayer();
    } else {
      const node = findYtDisclosureNode();
      if (node) {
        const card = getYtVideoCard(node.parentElement);
        if (card) markYtAiCard(card);
      }
    }
  }

  // Debounced re-check on DOM mutations (description loads async on watch pages)
  let ytCheckQueued = false;
  const ytObserver = new MutationObserver(() => {
    if (!youtubeFilterEnabled || !location.hostname.includes('youtube.com')) return;
    // If the URL changed since we blocked, clear the overlay immediately
    if (ytBlockedHref && ytBlockedHref !== location.href) {
      cleanupYtBlock();
    }
    if (ytCheckQueued) return;
    ytCheckQueued = true;
    setTimeout(() => { ytCheckQueued = false; runYoutubeCheck(); }, 600);
  });
  ytObserver.observe(document.body, { childList: true, subtree: true });

  // ── IntersectionObserver ────────────────────────────────────────
  const imageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        imageObserver.unobserve(entry.target);
        classifyImage(entry.target);
      }
    }
  }, { rootMargin: '400px' });

  function watchImage(img) {
    if (img.dataset.sfImgChecked) return;
    img.dataset.sfImgChecked = 'watching';
    const maybeObserve = () => {
      if (!shouldSkipImage(img) &&
          img.naturalWidth  >= IMG_MIN_PX &&
          img.naturalHeight >= IMG_MIN_PX) {
        imageObserver.observe(img);
      }
    };
    if (img.complete) {
      maybeObserve();
    } else {
      img.addEventListener('load',  maybeObserve, { once: true });
      img.addEventListener('error', () => {},     { once: true });
    }
  }

  // ── MutationObserver ────────────────────────────────────────────
  let scanQueued = false;
  const pendingNodes = new Set();

  const observer = new MutationObserver(mutations => {
    if (!filterEnabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) pendingNodes.add(node);
      }
    }
    if (pendingNodes.size && !scanQueued) {
      scanQueued = true;
      setTimeout(async () => {
        const nodes = [...pendingNodes];
        pendingNodes.clear();
        scanQueued = false;
        for (const node of nodes) {
          _scanCardsIn(node);
          const textEls = node.matches?.(TEXT_SEL) ? [node] : [...node.querySelectorAll(TEXT_SEL)];
          for (const el of textEls) await classifyText(el);
          const imgs = node.matches?.('img[src]') ? [node] : [...node.querySelectorAll('img[src]')];
          for (const img of imgs) watchImage(img);
        }
      }, 300);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ── SPA navigation hooks ────────────────────────────────────────
  function onNavigate() {
    // Reset page-level prior and cache on every navigation — new page, fresh context
    pageAiCount        = 0;
    pageCompletedCount = 0;
    pageImageCache.clear();
    // Clean up the YouTube block immediately so overlay and interceptor don't
    // linger while the next video loads. The scan runs after a short delay.
    cleanupYtBlock();
    const prevContainer = getYtPlayerContainer();
    if (prevContainer) delete prevContainer.dataset.sfYtAllowed;
    setTimeout(() => {
      _scanCardsIn(document.body);
      document.querySelectorAll(TEXT_SEL).forEach(classifyText);
      document.querySelectorAll('img[src]').forEach(watchImage);
      runYoutubeCheck();
    }, 400);
  }

  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    history[method] = function (...args) { orig.apply(this, args); onNavigate(); };
  }
  window.addEventListener('popstate', onNavigate);

  // ── Startup ─────────────────────────────────────────────────────
  const statusTimer = setInterval(pollStatus, 2000);
  pollStatus();

  setTimeout(() => {
    _scanCardsIn(document.body);
    document.querySelectorAll(TEXT_SEL).forEach(classifyText);
    document.querySelectorAll('img[src]').forEach(watchImage);
    runYoutubeCheck();
  }, 300);
})();
