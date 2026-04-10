// injected.js

(function () {
  'use strict';

  // Don't run inside iframes, and don't double-inject
  if (window.top !== window.self) return;
  if (window.__sfLoaded) return;
  window.__sfLoaded = true;

  const CLASSIFY_URL = '/__slop_filter_classify';
  const STATUS_URL   = '/__slop_filter_status';
  const SELECTORS    = 'p, blockquote, li:not(nav li):not(header li):not(footer li):not(aside li)';
  const MIN_LEN      = 60;

  // Block-level tags that count as "child block elements" for the leaf-div check below.
  const BLOCK_TAGS = new Set(['P','DIV','SECTION','ARTICLE','BLOCKQUOTE','UL','OL','TABLE','PRE','H1','H2','H3','H4','H5','H6']);

  // Returns true if el is a div/span that contains substantial text but no
  // child block elements — i.e. it IS the text container, not a layout wrapper.
  // This catches sites that render content directly in divs (SPAs, quiz sites, etc.)
  function isTextLeaf(el) {
    const tag = el.tagName;
    if (tag !== 'DIV' && tag !== 'SPAN' && tag !== 'SECTION') return false;
    for (const child of el.children) {
      if (BLOCK_TAGS.has(child.tagName)) return false;
    }
    const text = (el.textContent || '').trim();
    if (text.length < MIN_LEN) return false;
    // Skip CSS blobs — wiki templates and other sites inline CSS as text content
    if (/^\s*\.[\w-][\w-]*\s*\{/.test(text)) return false;
    if (text.includes('{font-style:') || text.includes('{display:') || text.includes(';word-wrap:')) return false;
    // Skip pure navigation/UI chrome (no sentence-ending punctuation in first 120 chars)
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
  // Prepend the nearest preceding section heading to the text before
  // sending it to the classifier. "References\n<citation text>" scores
  // very differently than the citation alone — no hard-coded rules needed.
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

  // ── Status polling ──────────────────────────────────────────────
  async function pollStatus() {
    try {
      const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(800) });
      const data = await r.json();
      const { enabled, youtubeFilterEnabled: ytEnabled } = data;
      if (filterEnabled && !enabled) {
        // Filter turned off: restore all hidden elements and stop watching
        document.querySelectorAll('.sf-content').forEach(el => el.classList.remove('sf-content'));
        document.querySelectorAll('.sf-text-placeholder').forEach(el => el.remove());
        observer.disconnect();
        clearInterval(statusTimer);
      }
      filterEnabled = enabled;
      if (typeof ytEnabled === 'boolean') youtubeFilterEnabled = ytEnabled;
    } catch (_) {}
  }

  // ── YouTube AI-label filter ─────────────────────────────────────
  // Detects YouTube's mandatory "Altered or synthetic content" AI disclosure
  // and shows a warning banner before the player on watch pages, and dims
  // feed cards where the label is present.

  const YT_DISCLOSURE_TEXT = 'Altered or synthetic content';
  const REPORT_URL = '/__slop_filter_youtube';

  function reportYoutubeBlock() {
    fetch(REPORT_URL, { method: 'POST', signal: AbortSignal.timeout(800) }).catch(() => {});
  }

  // Find the closest video card ancestor for a disclosure element in the feed.
  function getVideoCard(el) {
    let node = el;
    while (node && node !== document.body) {
      // YouTube uses <ytd-*-renderer> custom elements as card roots
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
    badge.textContent = '🤖 AI-disclosed';
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
      const nextBtn = document.querySelector('#navigation-button-down button, ytd-shorts #navigation-button-down button');
      if (nextBtn) { nextBtn.click(); return; }
      window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
    });

    container.appendChild(overlay);
    ytBlockedHref = location.href;
    reportYoutubeBlock();
  }

  // Check ytInitialPlayerResponse (populated synchronously on watch pages before
  // the first paint — safe to read at DOMContentLoaded or later).
  function checkYtInitialData() {
    try {
      const ipr = window.ytInitialPlayerResponse;
      if (ipr && (
        ipr.videoDetails?.containsSyntheticMedia === true ||
        ipr.containsSyntheticMedia === true ||
        ipr.playerConfig?.audioConfig?.containsSyntheticMedia === true
      )) return true;
    } catch (_) {}
    return false;
  }

  // Walk text nodes looking for the disclosure string.
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

    // Watch page: check initial data first, then DOM
    if (isWatchPage) {
      if (checkYtInitialData()) { showWatchPageBanner(); return; }
      const node = findDisclosureNode();
      if (node) { showWatchPageBanner(); return; }
    } else {
      // Feed / search / channel pages: look for disclosure text in any card
      const node = findDisclosureNode();
      if (node) {
        const card = getVideoCard(node.parentElement);
        if (card) markAiCard(card);
      }
    }
  }

  // Returns true if the text looks like an inline CSS blob.
  // Checked regardless of where in the string the CSS appears (e.g. after a "^" reference prefix).
  function isCssBlob(text) {
    if (text.includes('{font-style:') || text.includes('{display:') || text.includes(';word-wrap:')) return true;
    if (/\.[\w-][\w-]*\s*\{/.test(text)) return true;
    // More than 4 CSS property:value pairs signals a style block
    const pairs = (text.match(/[\w-]+\s*:\s*[\w#%(),.-]+/g) || []).length;
    return pairs > 4;
  }

  // Returns true if the element is inside a structural chrome region that should
  // never be classified — dialogs, status regions, and landmark nav elements.
  function isChrome(el) {
    return !!el.closest('[role="dialog"], [role="alert"], [role="status"], [role="navigation"]');
  }

  // ── Classify a single element via the proxy relay endpoint ──────
  async function classify(el) {
    if (!filterEnabled || el.dataset.slopChecked) return;

    const content = el.textContent.trim().replace(/\s+/g, ' ');
    if (content.length < MIN_LEN) return;

    // Skip CSS blobs and UI chrome before hitting the network
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
    } catch (_) {}
  }

  function applySlop(el, confidence, method) {
    if (el.dataset.slopBlurred) return;
    try {
      el.dataset.slopBlurred = 'true';
      el.classList.add('sf-content'); // display:none via CSS

      const placeholder = document.createElement('div');
      placeholder.className = 'sf-text-placeholder';

      placeholder.innerHTML = `
        <div class="sf-text-inner">
          <div class="sf-detect-row">
            <span class="sf-detect-icon">&#x1F916;</span>
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
        placeholder.remove();
      };

      const btn = placeholder.querySelector('.sf-reveal-btn');
      btn.addEventListener('pointerup', doReveal);
      btn.addEventListener('click',     doReveal);

      el.parentNode.insertBefore(placeholder, el);
    } catch (_) {}
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
          const els = node.matches?.(SELECTORS)
            ? [node]
            : [...node.querySelectorAll(SELECTORS)];
          for (const el of els) await classify(el);
          // Also check leaf divs/spans for sites that don't use semantic elements
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
  // YouTube is a SPA and loads description / feed cards asynchronously.
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

  // ── SPA navigation hooks ────────────────────────────────────────
  function onNavigate() {
    cleanupYtBlock();
    const prevContainer = getYtPlayerContainer();
    if (prevContainer) delete prevContainer.dataset.sfYtAllowed;
    setTimeout(() => {
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
    document.querySelectorAll(SELECTORS).forEach(classify);
    document.querySelectorAll('div, span, section').forEach(el => { if (isTextLeaf(el)) classify(el); });
    runYoutubeCheck();
  }, 300);
})();
