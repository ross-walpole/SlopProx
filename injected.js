// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// injected.js

(function () {
  'use strict';

  // Don't run inside iframes, and don't double-inject
  if (window.top !== window.self) return;
  if (window.__sfLoaded) return;
  window.__sfLoaded = true;

  const _trustedPatterns = window.__sfTrustedPatterns || [];
  if (_trustedPatterns.length && _trustedPatterns.some(p => location.href.startsWith(p))) return;

  // Signal to the browser extension's content.js (which runs in an isolated world
  // and cannot see window.__sfLoaded) that the proxy is handling text classification.
  // DOM attributes are shared across worlds, so this is the correct coordination mechanism.
  document.documentElement.dataset.sfProxy = '1';

  const CLASSIFY_URL = '/__slop_filter_classify';
  const STATUS_URL   = '/__slop_filter_status';
  const SELECTORS    = 'p, blockquote, li:not(nav li):not(header li):not(footer li):not(aside li)';
  const MIN_LEN      = 60;

  // Block-level tags that count as "child block elements" for the leaf-div check below.
  const BLOCK_TAGS = new Set(['P','DIV','SECTION','ARTICLE','BLOCKQUOTE','UL','OL','TABLE','PRE','H1','H2','H3','H4','H5','H6']);

  // Returns true if el is a div/span that contains substantial text but no
  // child block elements — i.e. it IS the text container, not a layout wrapper.
  function isTextLeaf(el) {
    const tag = el.tagName;
    if (tag !== 'DIV' && tag !== 'SPAN' && tag !== 'SECTION') return false;
    for (const child of el.children) {
      if (BLOCK_TAGS.has(child.tagName)) return false;
    }
    const text = (el.textContent || '').trim();
    if (text.length < MIN_LEN) return false;
    if (/^\s*\.[\w-][\w-]*\s*\{/.test(text)) return false;
    if (text.includes('{font-style:') || text.includes('{display:') || text.includes(';word-wrap:')) return false;
    const sample = text.slice(0, 120);
    const wordCount = sample.split(/\s+/).length;
    if (wordCount < 8) return false;
    return true;
  }

  let filterEnabled = true;
  let youtubeFilterEnabled = true;
  let currentYtInterceptor = null;
  let ytBlockedHref = null;

  // ── Section-context injection ───────────────────────────────────
  function getClassifyText(el) {
    const content = el.textContent.trim().replace(/\s+/g, ' ');
    let node = el;
    while (node && node !== document.body) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) {
          const heading = sib.textContent.trim();
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

  // ── Shared detect-row HTML (mirrors content.js _detectRowHtml) ──
  function _detectRowHtml(label, confidence, method) {
    return `<div class="sf-detect-row">
      <span class="sf-detect-icon"><span class="sf-icon-chev">&gt;</span><span class="sf-icon-cur">_</span></span>
      <span class="sf-detect-label">${label}</span>
      <span class="sf-detect-conf">${confidence}%</span>
      ${method ? `<span class="sf-detect-method">${method}</span>` : ''}
    </div>`;
  }

  // ── Click-propagation guards (mirrors content.js installGuards) ──
  function installGuards(placeholder) {
    placeholder.addEventListener('mousedown', e => {
      if (!e.target.closest('.sf-reveal-btn')) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
    placeholder.addEventListener('click', e => {
      e.stopPropagation();
      if (!e.target.closest('.sf-reveal-btn')) e.preventDefault();
    });
  }

  // ── Reveal button wiring (mirrors content.js _wireRevealBtn) ────
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

  // ── Card boundary detection (mirrors content.js findCardBoundary) ─
  function findCardBoundary(el) {
    let node = el.parentElement;
    const viewportH = window.innerHeight;
    let climbed = 0;

    while (node && node !== document.body && climbed < 16) {
      climbed++;

      if (node.dataset.sfCardBlurred || node.dataset.sfRevealed) return null;

      const tag  = node.tagName;
      const role = (node.getAttribute('role') || '').toLowerCase();

      if (/^(MAIN|BODY|HTML|HEADER|FOOTER|NAV)$/.test(tag)) break;
      if (/^(main|navigation|banner|contentinfo)$/.test(role)) break;

      const rect = node.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 50) { node = node.parentElement; continue; }
      if (rect.height > viewportH * 0.85)        { node = node.parentElement; continue; }

      const parentEl   = node.parentElement;
      const parentRole = (parentEl?.getAttribute('role') || '').toLowerCase();

      if (parentRole === 'feed') {
        const peers = [...parentEl.children].filter(c => c !== node && c.offsetHeight > 40);
        if (peers.length >= 1) return node;
      }

      if (tag === 'ARTICLE' || role === 'article' || role === 'listitem') {
        const peers = [...(parentEl?.children || [])].filter(c => c !== node && c.offsetHeight > 40);
        if (peers.length >= 1) return node;
      }

      if (tag.includes('-') && rect.height > 100) {
        const peers = [...(parentEl?.children || [])].filter(c => c !== node && c.offsetHeight > 40);
        if (peers.length >= 1) return node;
      }

      const cs            = getComputedStyle(node);
      const hasBorder     = parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none';
      const hasShadow     = cs.boxShadow !== 'none' && cs.boxShadow !== '';
      const hasBorderRadius = parseFloat(cs.borderRadius) > 4;

      if ((hasBorder || hasShadow) && hasBorderRadius) {
        const peers = [...(parentEl?.children || [])].filter(c => c !== node && c.offsetHeight > 40);
        if (peers.length >= 1) return node;
      }

      if (role === 'feed') break;

      node = node.parentElement;
    }

    return null;
  }

  // ── Card placeholder (mirrors content.js applyCardSlop) ─────────
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
      placeholder.style.height = Math.max(rect.height, 80) + 'px';

      installGuards(placeholder);

      placeholder.innerHTML = `
        <div class="sf-card-inner">
          ${_detectRowHtml(label, confidence, method)}
          <button class="sf-reveal-btn" type="button">${revealLabel}</button>
        </div>`;

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
    } catch (err) { _sfDebug('apply-card-slop', err); }
  }

  // ── Text placeholder ─────────────────────────────────────────────
  function applySlop(el, confidence, method) {
    // Guard: concurrent card classification may have already hidden the card.
    if (el.closest('[data-sf-card-blurred]')) return;

    const card = findCardBoundary(el);
    if (card) { applyCardSlop(card, confidence, 'text', undefined, method); return; }

    if (el.dataset.slopBlurred) return;
    if (!el.parentNode) return; // detached from DOM while awaiting API
    try {
      el.dataset.slopBlurred = 'true';
      el.classList.add('sf-content'); // display:none via CSS

      const placeholder = document.createElement('div');
      placeholder.className = 'sf-text-placeholder';
      placeholder._sfEl = el;
      installGuards(placeholder);

      placeholder.innerHTML = `
        <div class="sf-text-inner">
          ${_detectRowHtml('Suspected AI Text', confidence, method)}
          <button class="sf-reveal-btn" type="button">Show text</button>
        </div>`;

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
    } catch (err) { _sfDebug('apply-text-slop', err); }
  }

  // ── Minimal debug logger ─────────────────────────────────────────
  function _sfDebug(ctx, err) {
    console.debug(`[sf:${ctx}]`, err?.message ?? err);
  }

  // ── Status polling ──────────────────────────────────────────────
  let _pollFailCount = 0;

  async function pollStatus() {
    try {
      const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(800) });
      const data = await r.json();
      _pollFailCount = 0;
      const { enabled, youtubeFilterEnabled: ytEnabled } = data;
      if (filterEnabled && !enabled) {
        document.querySelectorAll('.sf-content').forEach(el => el.classList.remove('sf-content'));
        document.querySelectorAll('.sf-text-placeholder').forEach(el => el.remove());
        observer.disconnect();
        clearInterval(statusTimer);
      }
      filterEnabled = enabled;
      if (typeof ytEnabled === 'boolean') youtubeFilterEnabled = ytEnabled;
    } catch (err) {
      _sfDebug('poll-status', err);
      _pollFailCount++;
      // After 3 consecutive failures (~6 s) assume the proxy has stopped.
      // Remove the sfProxy signal so content.js can take over text classification.
      if (_pollFailCount >= 3) {
        delete document.documentElement.dataset.sfProxy;
        observer.disconnect();
        clearInterval(statusTimer);
      }
    }
  }

  // ── YouTube AI-label filter ─────────────────────────────────────
  const YT_DISCLOSURE_TEXT = 'Altered or synthetic content';
  const REPORT_URL = '/__slop_filter_youtube';

  function reportYoutubeBlock() {
    fetch(REPORT_URL, { method: 'POST', signal: AbortSignal.timeout(800) }).catch(() => {});
  }

  function getVideoCard(el) {
    let node = el;
    while (node && node !== document.body) {
      if (node.tagName && node.tagName.toLowerCase().startsWith('ytd-') &&
          (node.tagName.toLowerCase().includes('grid') ||
           node.tagName.toLowerCase().includes('compact') ||
           node.tagName.toLowerCase().includes('reel') ||
           node.tagName.toLowerCase().includes('video-renderer'))) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function markAiCard(card) {
    if (card.dataset.sfYtAi) return;
    card.dataset.sfYtAi = 'true';
    card.style.setProperty('opacity', '0.35', 'important');
    card.style.setProperty('filter', 'grayscale(0.7)', 'important');

    const badge = document.createElement('div');
    badge.className = 'sf-yt-feed-badge';
    badge.textContent = '>_ AI-disclosed';
    card.style.position = 'relative';
    card.appendChild(badge);
    reportYoutubeBlock();
  }

  function getYtPlayerContainer() {
    const watch = document.querySelector('#movie_player');
    if (watch && watch.offsetHeight > 50) return watch;
    const activeReel = document.querySelector('ytd-reel-video-renderer[is-active]');
    if (activeReel) return activeReel.querySelector('#player-container') || activeReel;
    return document.querySelector('#shorts-player, ytd-shorts');
  }

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

  function cleanupYtBlock() {
    ytBlockedHref = null;
    document.getElementById('sf-yt-overlay')?.remove();
    if (currentYtInterceptor) {
      currentYtInterceptor.cleanup();
      currentYtInterceptor = null;
    }
  }

  function showWatchPageBanner() {
    if (document.getElementById('sf-yt-overlay')) return;

    const container = getYtPlayerContainer();
    if (container?.dataset.sfYtAllowed) return;
    const video = container?.querySelector('video') || document.querySelector('video');
    currentYtInterceptor = video ? interceptVideoPlay(video) : { cleanup: () => {}, play: () => {} };

    if (!container) { reportYoutubeBlock(); return; }

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const isShorts = location.pathname.startsWith('/shorts/');
    const overlay = document.createElement('div');
    overlay.id = 'sf-yt-overlay';
    overlay.className = 'sf-yt-overlay';
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
      const nextBtn = document.querySelector('#navigation-button-down button, ytd-shorts #navigation-button-down button');
      if (nextBtn) { nextBtn.click(); return; }
      window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
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
        ipr.containsSyntheticMedia === true ||
        ipr.playerConfig?.audioConfig?.containsSyntheticMedia === true
      )) return true;
    } catch (err) { _sfDebug('yt-synthetic-check', err); }
    return false;
  }

  function findDisclosureNode() {
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
      if (checkYtInitialData()) { showWatchPageBanner(); return; }
      const node = findDisclosureNode();
      if (node) { showWatchPageBanner(); return; }
    } else {
      const node = findDisclosureNode();
      if (node) {
        const card = getVideoCard(node.parentElement);
        if (card) markAiCard(card);
      }
    }
  }

  function isCssBlob(text) {
    if (text.includes('{font-style:') || text.includes('{display:') || text.includes(';word-wrap:')) return true;
    if (/\.[\w-][\w-]*\s*\{/.test(text)) return true;
    const pairs = (text.match(/[\w-]+\s*:\s*[\w#%(),.-]+/g) || []).length;
    return pairs > 4;
  }

  function isChrome(el) {
    return !!el.closest('[role="dialog"], [role="alert"], [role="status"], [role="navigation"]');
  }

  // ── Card-level classification (checks if the element's post card is slop) ──
  function looksLikePostCard(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 80) return false;
    const tag  = el.tagName;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'ARTICLE' || role === 'article' || role === 'listitem') return true;
    if (tag.includes('-') && rect.height > 100) return true;
    const cs = getComputedStyle(el);
    const hasBorder = parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none';
    const hasShadow = cs.boxShadow !== 'none' && cs.boxShadow !== '';
    const hasBorderRadius = parseFloat(cs.borderRadius) > 4;
    return (hasBorder || hasShadow) && hasBorderRadius;
  }

  async function classifyCardText(card) {
    if (!filterEnabled || card.dataset.sfCardBlurred || card.dataset.sfRevealed || card.dataset.sfCardChecked) return;
    card.dataset.sfCardChecked = 'true';
    const raw = (card.innerText || card.textContent || '');
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length >= 45);
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_LEN) return;
    try {
      const r = await fetch(CLASSIFY_URL, {
        method: 'POST',
        body: text,
        headers: { 'Content-Type': 'text/plain' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return;
      const { isSlop, confidence, method } = await r.json();
      if (isSlop) applyCardSlop(card, confidence, 'text', undefined, method);
    } catch (err) { _sfDebug('classify-card', err); }
  }

  function _scanCardsIn(root) {
    if (looksLikePostCard(root)) { classifyCardText(root); return; }
    const candidates = root.querySelectorAll?.('article, [role="article"], [role="listitem"], [role="feed"] > *');
    if (candidates) for (const el of candidates) { if (looksLikePostCard(el)) classifyCardText(el); }
  }

  // ── Classify a single element via the proxy relay endpoint ──────
  async function classify(el) {
    if (!filterEnabled || el.dataset.slopChecked) return;
    if (el.closest('[data-sf-card-blurred]')) return;

    const content = el.textContent.trim().replace(/\s+/g, ' ');
    if (content.length < MIN_LEN) return;

    if (isCssBlob(content) || isChrome(el)) return;

    el.dataset.slopChecked = 'true';

    try {
      const r = await fetch(CLASSIFY_URL, {
        method: 'POST',
        body: getClassifyText(el),
        headers: { 'Content-Type': 'text/plain' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return;
      const { isSlop, confidence, method } = await r.json();
      if (isSlop) applySlop(el, confidence, method);
    } catch (err) { _sfDebug('classify', err); }
  }

  // ── MutationObserver: handles SPAs + infinite-scroll feeds ──────
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
          const els = node.matches?.(SELECTORS)
            ? [node]
            : [...node.querySelectorAll(SELECTORS)];
          for (const el of els) await classify(el);
          if (isTextLeaf(node)) { await classify(node); }
          else for (const el of (node.querySelectorAll?.('div, span, section') || [])) {
            if (isTextLeaf(el)) await classify(el);
          }
        }
      }, 300);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ── MutationObserver: re-run YouTube check when new content loads ──
  let ytCheckQueued = false;
  const ytObserver = new MutationObserver(() => {
    if (!youtubeFilterEnabled || !location.hostname.includes('youtube.com')) return;
    if (ytBlockedHref && ytBlockedHref !== location.href) {
      cleanupYtBlock();
    }
    if (ytCheckQueued) return;
    ytCheckQueued = true;
    setTimeout(() => { ytCheckQueued = false; runYoutubeCheck(); }, 600);
  });
  ytObserver.observe(document.body, { childList: true, subtree: true });

  // ── SPA navigation hooks ────────────────────────────────────────
  function onNavigate() {
    cleanupYtBlock();
    const prevContainer = getYtPlayerContainer();
    if (prevContainer) delete prevContainer.dataset.sfYtAllowed;
    setTimeout(() => {
      document.querySelectorAll('article, [role="article"], [role="listitem"], [role="feed"] > *')
        .forEach(el => { if (looksLikePostCard(el)) classifyCardText(el); });
      document.querySelectorAll(SELECTORS).forEach(classify);
      document.querySelectorAll('div, span, section').forEach(el => { if (isTextLeaf(el)) classify(el); });
      runYoutubeCheck();
    }, 400);
  }

  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    history[method] = function (...args) { orig.apply(this, args); onNavigate(); };
  }
  window.addEventListener('popstate', onNavigate);

  const statusTimer = setInterval(pollStatus, 2000);
  pollStatus();

  setTimeout(() => {
    document.querySelectorAll('article, [role="article"], [role="listitem"], [role="feed"] > *')
      .forEach(el => { if (looksLikePostCard(el)) classifyCardText(el); });
    document.querySelectorAll(SELECTORS).forEach(classify);
    document.querySelectorAll('div, span, section').forEach(el => { if (isTextLeaf(el)) classify(el); });
    runYoutubeCheck();
  }, 300);
})();
