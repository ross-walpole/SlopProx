// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

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

  // These are updated from the server's /status config on every poll cycle.
  let MIN_LEN         = 50;
  let IMG_MIN_PX      = 300;
  let IMG_DISP_MIN_PX = 200;
  let IMG_CONF_FORCE  = 92;

  // Hover events that trigger video previews on thumbnail containers.
  // Blocked in capture phase during classification so preview cannot start
  // before the verdict arrives. Does not include click/pointer{down,up} to
  // avoid breaking scroll and our own reveal button.
  const _HOVER_BLOCK_EVENTS = [
    'mouseenter', 'mouseleave', 'mouseover', 'mouseout',
    'pointerenter', 'pointerleave', 'pointerover', 'pointerout',
  ];

  const _SF_DEBUG = (typeof chrome !== 'undefined' && chrome.runtime?.id)
    ? (ctx, err) => console.debug(`[sf:${ctx}]`, err?.message ?? err)
    : () => {};

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
      // substantial in size, have peers, AND contain visible text content
      // (a title, description, etc.), they're feed cards.
      // The text check prevents returning image-wrapper custom elements
      // (e.g. yt-image, ytd-thumbnail) that also have hyphens and peers
      // but contain no text — those are not cards.
      if (tag.includes('-') && rect.height > 100) {
        const peers = [...(parentEl?.children || [])].filter(c => c !== node && c.offsetHeight > 40);
        if (peers.length >= 1 && (node.innerText?.trim().length > 30)) return node;
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
  const _TEXT_BATCH_MAX = 200;
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
      if (_textBatchQueue.length >= _TEXT_BATCH_MAX) {
        const dropped = _textBatchQueue.shift();
        dropped.resolve({ ok: false });
      }
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
      const patterns = data.trustedPatterns || [];
      if (patterns.length && patterns.some(p => location.href.startsWith(p))) {
        filterEnabled = false;
        observer.disconnect();
        imageObserver.disconnect();
        clearInterval(statusTimer);
        return;
      }
      const wasEnabled      = filterEnabled;
      const wasImageEnabled = imageDetectionEnabled;
      filterEnabled         = data.enabled ?? true;
      imageDetectionEnabled = data.imageDetectionEnabled ?? false;
      youtubeFilterEnabled  = data.youtubeFilterEnabled ?? true;

      if (data.config) {
        if (data.config.textMinLength    != null) MIN_LEN         = data.config.textMinLength;
        if (data.config.imageMinNaturalPx != null) IMG_MIN_PX     = data.config.imageMinNaturalPx;
        if (data.config.imageMinDisplayPx != null) IMG_DISP_MIN_PX = data.config.imageMinDisplayPx;
        if (data.config.imageForceConfidence != null) IMG_CONF_FORCE = data.config.imageForceConfidence;
      }

      if (wasEnabled && !filterEnabled) {
        document.querySelectorAll('.sf-card-placeholder').forEach(p => {
          if (p._sfCard) {
            p._sfCard.style.display = p._sfCardDisplay || '';
            delete p._sfCard.dataset.sfCardBlurred;
          }
          (p.parentElement?.dataset?.sfWrapper ? p.parentElement : p).remove();
        });
        document.querySelectorAll('.sf-text-placeholder').forEach(p => {
          const el = p._sfEl;
          const wrapper = p.parentElement?.dataset?.sfWrapper ? p.parentElement : p;
          if (el) { el.classList.remove('sf-content'); delete el.dataset.slopBlurred; wrapper.replaceWith(el); }
          else wrapper.remove();
        });
        document.querySelectorAll('.sf-img-placeholder').forEach(p => {
          if (p._sfTarget) {
            p._sfTarget.style.opacity       = '';
            p._sfTarget.style.pointerEvents = '';
            delete p._sfTarget.dataset.sfImgBlurred;
          }
          unblockVideosNear(p, false);
          p.remove();
        });
        // Clean up any intercept shields still active from in-flight classifications.
        document.querySelectorAll('[data-sf-shield]').forEach(s => {
          s._sfRelease?.(); // remove capture-phase hover block from container
          const img = s._sfTarget;
          if (img) {
            img.style.opacity       = '';
            img.style.pointerEvents = '';
            img.classList.remove('sf-scanning');
            delete img.dataset.sfImgBlurred;
            delete img.dataset.sfQueued;
            delete img.dataset.sfProcessing;
          }
          s.remove();
        });
        observer.disconnect();
        imageObserver.disconnect();
        clearInterval(statusTimer);
      }

      // Re-queue images that loaded before image detection was ready.
      // The IntersectionObserver unobserves each image before calling classifyImage,
      // so any image seen while imageDetectionEnabled=false is permanently dropped.
      // Reset their sfImgChecked marker so watchImage re-observes them.
      if (!wasImageEnabled && imageDetectionEnabled && filterEnabled) {
        document.querySelectorAll('img[src]').forEach(img => {
          if (img.dataset.sfImgChecked === 'watching' && !img.dataset.sfImgBlurred) {
            delete img.dataset.sfImgChecked;
            watchImage(img);
          }
        });
      }

      // Re-scan text elements whose previous classify call failed (API unavailable /
      // token not yet acquired). slopChecked is cleared on failure so they are eligible.
      if (filterEnabled && !document.documentElement.dataset.sfProxy) {
        _scanCardsIn(document.body);
        document.querySelectorAll(TEXT_SEL).forEach(el => {
          if (!el.dataset.slopChecked) classifyText(el);
        });
      }
    } catch (err) { _SF_DEBUG('poll-status', err); }
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
  function _detectRowHtml(label, confidence, method) {
    return `<div class="sf-detect-row">
      <span class="sf-detect-icon"><span class="sf-icon-chev">&gt;</span><span class="sf-icon-cur">_</span></span>
      <span class="sf-detect-label">${label}</span>
      <span class="sf-detect-conf">${confidence}%</span>
      ${method ? `<span class="sf-detect-method">${method}</span>` : ''}
    </div>`;
  }

  function _wireRevealBtn(placeholder, onReveal) {
    let revealed = false;
    const doReveal = (e) => {
      if (revealed) return;
      revealed = true;
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      onReveal();
    };
    const btn = placeholder.querySelector('.sf-reveal-btn');
    btn.style.pointerEvents = 'auto';
    btn.addEventListener('pointerup', doReveal);
    btn.addEventListener('click',     doReveal);
  }

  function applyCardSlop(card, confidence, type, btnText, method) {
    if (card.dataset.sfCardBlurred || card.dataset.sfRevealed) return;
    if (!card.parentElement) return; // detached from DOM while awaiting API
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
      // Width is handled by CSS (width:100%). Height is locked so the page
      // doesn't jump when the card is hidden.
      placeholder.style.height = Math.max(rect.height, 80) + 'px';

      installGuards(placeholder);

      placeholder.innerHTML = `
        <div class="sf-card-inner">
          ${_detectRowHtml(label, confidence, method)}
          <button class="sf-reveal-btn" type="button">${revealLabel}</button>
        </div>`;

      // Wrap in a context-appropriate element to produce valid HTML.
      // Inserting a bare <div> inside <ul>/<ol> or <table> causes browsers
      // to hoist it out, placing the placeholder in the wrong position.
      const parentTag = card.parentElement.tagName;
      const cardTag   = card.tagName;
      let toInsert = placeholder;
      if (cardTag === 'LI' || parentTag === 'UL' || parentTag === 'OL') {
        const li = document.createElement('li');
        li.dataset.sfWrapper = 'true';
        li.style.cssText = 'list-style:none;padding:0;margin:0';
        li.appendChild(placeholder);
        toInsert = li;
      } else if (cardTag === 'TR' || parentTag === 'TBODY' || parentTag === 'THEAD' || parentTag === 'TFOOT' || parentTag === 'TABLE') {
        const tr = document.createElement('tr');
        tr.dataset.sfWrapper = 'true';
        const td = document.createElement('td');
        td.setAttribute('colspan', '999');
        td.style.cssText = 'padding:0;border:none';
        td.appendChild(placeholder);
        tr.appendChild(td);
        toInsert = tr;
      }

      _wireRevealBtn(placeholder, () => {
        card.style.display = placeholder._sfCardDisplay;
        delete card.dataset.sfCardBlurred;
        card.dataset.sfRevealed = 'true';
        toInsert.remove();
      });

      card.style.display = 'none';
      card.insertAdjacentElement('afterend', toInsert);

      const countKey = type === 'image' ? 'imagesBlocked' : 'textBlocked';
      chrome.storage.session.get(countKey).then(s => {
        chrome.storage.session.set({ [countKey]: (s[countKey] || 0) + 1 });
      }).catch(() => {});
    } catch (err) { _SF_DEBUG('apply-card-slop', err); }
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
    if (document.documentElement.dataset.sfProxy === '1') return;
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
      if (!resp?.ok) {
        delete card.dataset.sfCardTextChecked; // allow retry on next poll cycle
        return;
      }
      const { isSlop, confidence, method } = resp.data;
      if (isSlop) applyCardSlop(card, confidence, 'text', undefined, method);
    } catch (err) { _SF_DEBUG('classify-card', err); }
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
    if (document.documentElement.dataset.sfProxy === '1') return;
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
      if (!resp?.ok) {
        delete el.dataset.slopChecked; // allow retry on next poll cycle
        return;
      }
      const { isSlop, confidence, method } = resp.data;
      if (isSlop) applyTextSlop(el, confidence, method);
    } catch (err) { _SF_DEBUG('classify-text', err); }
  }

  function applyTextSlop(el, confidence, method) {
    // Guard: a concurrent classifyCardText may have hidden the card while we were awaiting
    // the batch API. findCardBoundary returns null when it sees data-sf-card-blurred, which
    // would incorrectly trigger inline mode inside a hidden card.
    if (el.closest('[data-sf-card-blurred]')) return;
    const card = findCardBoundary(el);
    if (card) { applyCardSlop(card, confidence, 'text', undefined, method); return; }

    // ── Article / no-card context: inline paragraph placeholder ────
    if (el.dataset.slopBlurred) return;
    if (!el.parentNode) return; // detached from DOM while awaiting API
    try {
      el.dataset.slopBlurred = 'true';
      el.classList.add('sf-content');

      const placeholder = document.createElement('div');
      placeholder.className = 'sf-text-placeholder';
      placeholder._sfEl = el;
      installGuards(placeholder);

      placeholder.innerHTML = `
        <div class="sf-text-inner">
          ${_detectRowHtml('Suspected AI Text', confidence, method)}
          <button class="sf-reveal-btn" type="button">Show text</button>
        </div>`;

      // When el is a <li>, a bare <div> sibling is invalid HTML and browsers
      // may hoist it out of the list. Wrap the placeholder in a <li> instead.
      let toInsert = placeholder;
      if (el.tagName === 'LI') {
        const li = document.createElement('li');
        li.dataset.sfWrapper = 'true';
        li.style.cssText = 'list-style:none;padding:0;margin:0';
        li.appendChild(placeholder);
        toInsert = li;
      }

      _wireRevealBtn(placeholder, () => {
        el.classList.remove('sf-content');
        delete el.dataset.slopBlurred;
        toInsert.replaceWith(el);
      });

      el.parentNode.insertBefore(toInsert, el);

      chrome.storage.session.get('textBlocked').then(s => {
        chrome.storage.session.set({ textBlocked: (s.textBlocked || 0) + 1 });
      }).catch(() => {});
    } catch (err) { _SF_DEBUG('apply-text-slop', err); }
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

    // Skip images inside interactive controls — avatars in buttons, menu icons, etc.
    if (img.closest('[role="button"],[role="menuitem"],[role="option"],[role="tab"]')) return true;

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

    // Skip images rendered at small display sizes — catches profile pictures and
    // avatars whose natural dimensions are large (e.g. 512×512) but are shown at
    // e.g. 40×40. getBoundingClientRect is reliable here because shouldSkipImage
    // is only called after the image has loaded and entered (or is near) the viewport.
    const rendered = img.getBoundingClientRect();
    if (rendered.width > 0 && rendered.height > 0 &&
        (rendered.width < IMG_DISP_MIN_PX || rendered.height < IMG_DISP_MIN_PX)) return true;

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

    const srcKey = img.src.split('?')[0];

    // Cache hit: verdict is immediate — no race window, use applyImageSlop directly.
    if (pageImageCache.has(srcKey)) {
      const cached = pageImageCache.get(srcKey);
      pageImageCache.delete(srcKey);
      pageImageCache.set(srcKey, cached); // LRU promote
      if (cached.blocked) applyImageSlop(img, cached.confidence, 'cached');
      return;
    }

    if (img.naturalWidth < IMG_MIN_PX || img.naturalHeight < IMG_MIN_PX) return;

    // Don't stack multiple shields on the same card. YouTube's moving thumbnail
    // adds several <img> preview frames when the user hovers; without this guard
    // each frame would create its own shield/placeholder at the card level.
    if (!img.closest('[data-sf-card-blurred]')) {
      const existingCard = findCardBoundary(img);
      if (existingCard?.querySelector('[data-sf-shield], .sf-img-placeholder')) return;
    }

    img.dataset.sfQueued     = 'true';
    img.dataset.sfProcessing = 'true';

    // ── EARLY INTERCEPTION ──────────────────────────────────────────
    // Find the container and create the intercept shield BEFORE the API
    // call. The shield is transparent during classification but sits at
    // max z-index and blocks all hover/pointer events that would trigger
    // the site's video-preview logic. If verdict = slop the shield is
    // promoted to the visible placeholder in-place (zero timing gap).
    // If verdict = real it is removed cleanly with _abortShield.
    let container, shieldStyle;
    try {
      ({ container, shieldStyle } = _prepareContainer(img));
    } catch (err) {
      _SF_DEBUG('prepare-container', err);
      delete img.dataset.sfQueued;
      delete img.dataset.sfProcessing;
      return;
    }

    const shield = document.createElement('div');
    shield.dataset.sfShield    = 'true';
    shield.style.position      = 'absolute';
    shield.style.zIndex        = '2147483647';
    // pointer-events:none so clicks pass through to the card's <a> link during
    // classification. Hover suppression is handled by the document-level capture
    // block — the shield itself does not need to absorb events.
    shield.style.pointerEvents = 'none';
    shield.style.cursor        = 'default';
    Object.assign(shield.style, shieldStyle);
    container.appendChild(shield);

    // Capture-phase blocker kills hover events on the container before the
    // site's own listeners can fire. Stored on the shield for pollStatus cleanup.
    const releaseHoverBlock   = _installHoverBlock(container);
    shield._sfRelease         = releaseHoverBlock;

    // Block all videos already present within the container boundary.
    // Broader than findAssociatedVideo (which only checks 4 ancestor levels)
    // because on YouTube the video preview element may be a distant sibling.
    for (const v of container.querySelectorAll('video')) {
      _killAutoplayVideo(v);
      blockVideoPlay(v);
    }

    // Apply scanning visual. pointer-events:none on the image itself prevents
    // mouseover/mouseenter from reaching the image and bubbling to site listeners
    // on ancestor elements that are not covered by the shield's capture block.
    img.style.pointerEvents = 'none';
    img.style.transition    = 'filter 0.12s, opacity 0.12s';
    img.classList.add('sf-scanning');

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'classifyImage', url: img.src });

      if (!resp?.ok) { _abortShield(img, shield, releaseHoverBlock); return; }

      const { isAiImage, confidence, method } = resp.data;
      _pageImageCacheSet(srcKey, { blocked: isAiImage, confidence });
      pageCompletedCount++;
      const adjustedConf = confidence + getPagePriorAdjustment();

      if (isAiImage || adjustedConf >= IMG_CONF_FORCE) {
        pageAiCount++;
        img.style.transition = '';
        img.classList.remove('sf-scanning');
        img.style.opacity = '0';
        delete img.dataset.sfProcessing;
        _promoteShield(shield, img, container, confidence, method, releaseHoverBlock);
      } else {
        _abortShield(img, shield, releaseHoverBlock);
      }
    } catch (err) {
      _SF_DEBUG('classify-image', err);
      _abortShield(img, shield, releaseHoverBlock);
    }
  }

  // Verdict = real: remove shield and restore image to normal.
  function _abortShield(img, shield, releaseHoverBlock) {
    const container = shield.parentElement; // capture before removal
    releaseHoverBlock();
    shield.remove();
    img.style.pointerEvents = '';
    delete img.dataset.sfQueued;
    delete img.dataset.sfProcessing;
    _clearScan(img);
    if (container) {
      unblockVideosNear(container, false);
      _releaseContainerPos(container);
    }
  }

  // Verdict = slop: transition the transparent shield into the visible
  // placeholder in-place. There is no timing gap between "shield removed"
  // and "placeholder added" because we reuse the same element.
  function _promoteShield(shield, img, container, confidence, method, releaseHoverBlock) {
    img.dataset.sfImgBlurred = 'true';

    delete shield.dataset.sfShield;
    shield.className           = 'sf-img-placeholder';
    shield.style.pointerEvents = 'auto'; // was none during classification; reveal btn needs events
    shield._sfTarget           = img;
    shield._sfRelease          = null; // prevent double-call from pollStatus

    const nw = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
    if (nw > 0 && nw < 500) shield.classList.add('sf-compact');

    shield.innerHTML = `
      <div class="sf-img-inner">
        ${_detectRowHtml('Suspected AI Image', confidence, method)}
        <button class="sf-reveal-btn" type="button">Show image</button>
      </div>`;

    _wireRevealBtn(shield, () => {
      img.style.opacity       = '';
      img.style.pointerEvents = '';
      delete img.dataset.sfImgBlurred;
      releaseHoverBlock();
      unblockVideosNear(container, true);
      shield.remove();
      _releaseContainerPos(container);
    });
    installGuards(shield);

    chrome.storage.session.get('imagesBlocked').then(s => {
      chrome.storage.session.set({ imagesBlocked: (s.imagesBlocked || 0) + 1 });
    }).catch(() => {});
  }

  // ── Container preparation (shared by classifyImage and applyImageSlop) ──
  // Preferred container is the card boundary (e.g. ytd-rich-item-renderer on
  // YouTube). Placing our shield/placeholder there puts it ABOVE intermediate
  // custom-element stacking contexts such as yt-image or a.yt-simple-endpoint,
  // which would otherwise lose to a sibling ytd-moving-thumbnail-renderer even
  // if our element has z-index:2147483647 (stacking contexts are compared at
  // the level they share a common ancestor, not by their own z-index values).
  function _prepareContainer(img) {
    const imgRect = img.getBoundingClientRect();

    // Use card boundary when available so we outrank nested site overlays.
    const card = !img.closest('[data-sf-card-blurred]') ? findCardBoundary(img) : null;
    let container = card;

    if (!container) {
      // No card: climb to nearest non-static, non-sticky, non-fixed ancestor.
      container = img.parentElement;
      for (let i = 0; i < 6 && container && container !== document.body; i++) {
        const pos = getComputedStyle(container).position;
        if (pos !== 'static' && pos !== 'sticky' && pos !== 'fixed') break;
        container = container.parentElement;
      }
      if (!container || container === document.body) container = img.parentElement;

      const containerRect = container.getBoundingClientRect();
      if (containerRect.width  > imgRect.width  * 3 &&
          containerRect.height > imgRect.height * 2) {
        container = img.parentElement;
      }
    }

    _acquireContainerPos(container);

    const finalRect  = container.getBoundingClientRect();
    const fillsContainer =
      Math.abs(imgRect.width  - finalRect.width)  < 8 &&
      Math.abs(imgRect.height - finalRect.height) < 8;
    const nearOrigin =
      imgRect.top  - finalRect.top  < 4 &&
      imgRect.left - finalRect.left < 4;

    const shieldStyle = {};
    if (fillsContainer || nearOrigin) {
      shieldStyle.inset = '0';
    } else {
      shieldStyle.top    = (imgRect.top  - finalRect.top)  + 'px';
      shieldStyle.left   = (imgRect.left - finalRect.left) + 'px';
      shieldStyle.width  = imgRect.width  + 'px';
      shieldStyle.height = imgRect.height + 'px';
    }

    return { container, shieldStyle };
  }

  // ── Container position management ──────────────────────────────
  // When classifyImage needs an absolutely-positioned shield it calls
  // _acquireContainerPos to make the container position:relative.
  // Every code path that removes the shield (abort or reveal) must call
  // _releaseContainerPos so the change is reverted once no placeholders
  // remain. Without this the container permanently becomes a positioning
  // ancestor, breaking tooltips and dropdowns that rely on a distant ancestor.
  function _acquireContainerPos(container) {
    const n = parseInt(container.dataset.sfPosRef || '0');
    if (n === 0 && getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
      container.dataset.sfPosOwned = 'true';
    }
    container.dataset.sfPosRef = String(n + 1);
  }

  function _releaseContainerPos(container) {
    if (!container) return;
    const n = Math.max(0, parseInt(container.dataset.sfPosRef || '0') - 1);
    if (n === 0) {
      delete container.dataset.sfPosRef;
      if (container.dataset.sfPosOwned) {
        delete container.dataset.sfPosOwned;
        container.style.position = '';
      }
    } else {
      container.dataset.sfPosRef = String(n);
    }
  }

  // ── Capture-phase hover block ───────────────────────────────────
  // Registered on DOCUMENT so it fires before any site listener anywhere in
  // the tree, regardless of registration order or phase. Only blocks events
  // whose target is inside our container. stopImmediatePropagation prevents
  // further capture listeners and all bubble-phase listeners from receiving
  // the event — including on the container itself and its ancestors.
  // Note: no early return for our own elements (shield, placeholder, button).
  // Hover events should always be suppressed; our UI only needs click/pointerup.
  function _installHoverBlock(container) {
    function blocker(e) {
      if (!container.contains(e.target) && container !== e.target) return;
      e.stopImmediatePropagation();
    }
    for (const evt of _HOVER_BLOCK_EVENTS) {
      document.addEventListener(evt, blocker, true);
    }
    return function releaseHoverBlock() {
      for (const evt of _HOVER_BLOCK_EVENTS) {
        document.removeEventListener(evt, blocker, true);
      }
    };
  }

  // ── Autoplay removal ────────────────────────────────────────────
  // Strips the autoplay attribute synchronously (called from MutationObserver)
  // before the browser can act on it. Also overrides video.load() so a
  // load() → implicit-autoplay cycle cannot restart playback.
  function _killAutoplayVideo(vid) {
    vid.removeAttribute('autoplay');
    vid.autoplay = false;
    vid.preload  = 'none';
    if (!vid.paused) vid.pause();
    if (!vid.dataset.sfLoadBlocked) {
      vid.dataset.sfLoadBlocked = 'true';
      const nativeLoad = HTMLVideoElement.prototype.load.bind(vid);
      vid.load = function () {
        this.removeAttribute('autoplay');
        this.autoplay = false;
        nativeLoad();
      };
    }
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

  // Override video.play as an own property on the element.
  // Own-property overrides on DOM nodes are visible across Chrome's isolated-world
  // boundary, so page JS calling video.play() receives our no-op directly.
  // Event-based interception (addEventListener 'play') has a latency gap — the
  // browser starts playback before our handler can pause it. Overriding the method
  // prevents playback from beginning at all, with no race condition.
  function blockVideoPlay(video) {
    if (!video || video.dataset.sfVidBlocked) return;
    video.dataset.sfVidBlocked = 'true';
    if (!video.paused) video.pause();
    video.play = () => Promise.resolve();
  }

  function unblockVideoPlay(video, andPlay) {
    if (!video || !video.dataset.sfVidBlocked) return;
    delete video.dataset.sfVidBlocked;
    delete video.play; // removes own-property, restores prototype play
    if (andPlay) HTMLVideoElement.prototype.play.call(video).catch(() => {});
  }

  // Unblock every sfVidBlocked video found within 6 ancestor levels of el.
  function unblockVideosNear(el, andPlay) {
    let n = el;
    for (let i = 0; i < 6 && n && n !== document.body; i++) {
      n.querySelectorAll?.('video[data-sf-vid-blocked]').forEach(v => unblockVideoPlay(v, andPlay));
      n = n.parentElement;
    }
  }

  // Block any video near el that isn't already blocked.
  // Called synchronously from the MutationObserver so hover-autoplay cannot
  // slip through the 300 ms batch window.
  // Also checks for in-flight shields ([data-sf-shield]) so videos added
  // during classification are caught before the placeholder exists.
  function blockVideosNear(el) {
    const vids = el.tagName === 'VIDEO' ? [el] : [...(el.querySelectorAll?.('video') || [])];
    for (const vid of vids) {
      if (vid.dataset.sfVidBlocked) continue;
      let n = vid.parentElement;
      for (let i = 0; i < 6 && n && n !== document.body; i++) {
        if (n.querySelector('.sf-img-placeholder, [data-sf-shield]')) {
          _killAutoplayVideo(vid); // strip autoplay attr before browser acts on it
          blockVideoPlay(vid);
          break;
        }
        n = n.parentElement;
      }
    }
  }

  function interceptFeedVideo(video) {
    if (!video || video.dataset.sfVidBlocked) return null;
    blockVideoPlay(video);
    return {
      release() { unblockVideoPlay(video, false); },
      play()    { unblockVideoPlay(video, true);  },
    };
  }

  // Cache-hit path only — no race window, so no shield needed.
  // Live classifications go through classifyImage → _promoteShield instead.
  function applyImageSlop(img, confidence, method) {
    if (img.dataset.sfImgBlurred || img.dataset.sfProcessing) return;
    delete img.dataset.sfProcessing;
    img.dataset.sfImgBlurred = 'true';
    if (!img.parentNode) return;

    let container;
    try {
      interceptFeedVideo(findAssociatedVideo(img));
      img.style.opacity       = '0';
      img.style.pointerEvents = 'none';

      const prepared = _prepareContainer(img); // also calls _acquireContainerPos
      container = prepared.container;
      const releaseHoverBlock = _installHoverBlock(container);

      const placeholder = document.createElement('div');
      placeholder.className      = 'sf-img-placeholder';
      placeholder._sfTarget      = img;
      placeholder.style.position      = 'absolute';
      placeholder.style.zIndex        = '2147483647';
      placeholder.style.pointerEvents = 'auto';
      Object.assign(placeholder.style, prepared.shieldStyle);

      const nw = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
      if (nw > 0 && nw < 500) placeholder.classList.add('sf-compact');

      placeholder.innerHTML = `
        <div class="sf-img-inner">
          ${_detectRowHtml('Suspected AI Image', confidence, method)}
          <button class="sf-reveal-btn" type="button">Show image</button>
        </div>`;

      _wireRevealBtn(placeholder, () => {
        img.style.opacity       = '';
        img.style.pointerEvents = '';
        delete img.dataset.sfImgBlurred;
        releaseHoverBlock();
        unblockVideosNear(container, true);
        placeholder.remove();
        _releaseContainerPos(container);
      });
      installGuards(placeholder);
      container.appendChild(placeholder);

      chrome.storage.session.get('imagesBlocked').then(s => {
        chrome.storage.session.set({ imagesBlocked: (s.imagesBlocked || 0) + 1 });
      }).catch(() => {});
    } catch (err) {
      _SF_DEBUG('apply-image-slop', err);
      img.style.opacity       = '';
      img.style.pointerEvents = '';
      delete img.dataset.sfImgBlurred;
      _releaseContainerPos(container);
    }
  }

  // ── YouTube AI-label filter ─────────────────────────────────────
  // Detects YouTube's mandatory "Altered or synthetic content" disclosure
  // and warns on watch pages; dims feed/Shorts cards where the label appears.

  const YT_DISCLOSURE_TEXT = 'Altered or synthetic content';

  function reportYoutubeBlock() {
    // Proxy's injected.js handles counting when active — avoid double-counting.
    if (document.documentElement.dataset.sfProxy === '1') return;
    chrome.runtime.sendMessage({ type: 'youtubeBlock' }).catch(() => {});
    chrome.storage.session.get('youtubeBlocked').then(s => {
      chrome.storage.session.set({ youtubeBlocked: (s.youtubeBlocked || 0) + 1 });
    }).catch(() => {});
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
    badge.textContent = '>_ AI-DISCLOSED';
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
      '<div class="sf-yt-ov-icon"><span class="sf-icon-chev">&gt;</span><span class="sf-icon-cur">_</span></div>' +
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
    } catch (err) { _SF_DEBUG('yt-synthetic-check', err); }
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
        if (node.nodeType !== 1) continue;
        // Block videos near placeholders SYNCHRONOUSLY — hover-autoplay fires
        // immediately and cannot wait for the 300 ms batch window below.
        blockVideosNear(node);
        pendingNodes.add(node);
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
