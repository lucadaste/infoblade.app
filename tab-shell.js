// Turns Home/Stocks/Markets/Crypto/Track Record into one continuous wide
// strip you scroll/swipe horizontally between, like the Robinhood app.
//
// Each of the 5 pages still exists as its own real HTML file (so direct
// links, reloads, and SEO all work normally). Whichever one is loaded
// top-level keeps its own content in place as the "self" pane; the other 4
// are pulled in as same-origin iframes (?embed=1, which hides their header/
// footer/bottom-nav via CSS) and laid out side by side in a flex row that
// snaps on scroll. Vertical scrolling stays the normal page/window scroll —
// this is one wide page, not five independent screens.
(function () {
  if (document.documentElement.classList.contains('is-embedded')) return;

  var TABS = [
    { path: '/',              file: '/home.html',     title: 'infoblade | Home' },
    { path: '/feed.html',     file: '/feed.html',     title: 'infoblade | Stock Markets' },
    { path: '/markets.html',  file: '/markets.html',  title: 'infoblade | Prediction Markets' },
    { path: '/crypto.html',   file: '/crypto.html',   title: 'infoblade | Crypto Markets' },
    { path: '/accuracy.html', file: '/accuracy.html', title: 'infoblade | Track Record' },
  ];

  function normalize(pathname) {
    if (pathname === '/index.html' || pathname === '/home.html') return '/';
    return pathname;
  }

  var selfIndex = TABS.findIndex(function (t) {
    return t.path === normalize(location.pathname) || t.file === location.pathname;
  });
  if (selfIndex === -1) return;

  var bottomNavEl = document.querySelector('.bottom-nav');
  if (!bottomNavEl) return;

  // Everything that isn't the two nav bars or a script/style/link tag is page
  // content — move it into the "self" pane. Reparenting (not re-rendering)
  // keeps every already-bound event listener on these nodes working.
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, LINK: 1, NAV: 1 };
  // Screen-pinned UI (the AI chat panel and bubble, scroll-to-top) stays
  // directly in <body>: a pane is shifted with a transform mid-swipe (see
  // beginMove), and a transformed ancestor re-anchors position: fixed
  // children to itself, which threw the chat dock off by a full pane width.
  var contentNodes = Array.prototype.filter.call(document.body.children, function (el) {
    return !SKIP_TAGS[el.tagName] && getComputedStyle(el).position !== 'fixed';
  });

  var tabScroll = document.createElement('div');
  tabScroll.className = 'tab-scroll';

  var panes = TABS.map(function (t, i) {
    var pane = document.createElement('div');
    pane.className = 'tab-pane';
    if (i === selfIndex) {
      pane.classList.add('tab-pane-self');
      contentNodes.forEach(function (node) { pane.appendChild(node); });
    } else {
      var iframe = document.createElement('iframe');
      iframe.className = 'tab-iframe';
      iframe.title = t.title;
      iframe.setAttribute('scrolling', 'no');
      iframe.style.height = window.innerHeight + 'px';
      pane.appendChild(iframe);
    }
    tabScroll.appendChild(pane);
    return pane;
  });

  document.body.insertBefore(tabScroll, bottomNavEl);

  // Measures the iframe's body, not documentElement.scrollHeight: the latter
  // is never smaller than the iframe's own viewport, i.e. the height we last
  // set, so it could only ever grow — content that shrank (a collapsed list,
  // a redirect to a shorter page) left a tall blank pane behind.
  function syncHeight(iframe) {
    try {
      var doc = iframe.contentDocument;
      if (!doc || !doc.body) return;
      var apply = function () {
        var cs = doc.defaultView.getComputedStyle(doc.body);
        var h = Math.ceil(doc.body.getBoundingClientRect().bottom + (parseFloat(cs.marginBottom) || 0));
        if (h > 0) iframe.style.height = h + 'px';
      };
      apply();
      if ('ResizeObserver' in window) {
        new ResizeObserver(apply).observe(doc.body);
      } else {
        setInterval(apply, 500);
      }
    } catch (e) { /* same-origin should always succeed; ignore if not ready */ }
  }

  // The panes sit side by side in one flex row, so by default the strip is
  // as tall as the TALLEST pane — on a short tab (e.g. Stocks) you could
  // scroll far past its content into blank space that only existed because
  // a neighboring tab was long. Clamp the strip to the visible pane instead
  // (overflow-y is already hidden, so neighbors are just clipped).
  function syncStripHeight() {
    var pane = panes[activeIndex];
    if (!pane) return;
    var h = pane.offsetHeight;
    // Mid-swipe the neighbors are offset to their own scroll position (see
    // beginMove), so the strip must stay tall enough to show them all the
    // way down to the bottom of the viewport instead of clipping them.
    if (moving) h = Math.max(h, window.scrollY + window.innerHeight - tabScroll.offsetTop);
    tabScroll.style.height = h + 'px';
  }
  if ('ResizeObserver' in window) {
    var paneObserver = new ResizeObserver(syncStripHeight);
    panes.forEach(function (p) { paneObserver.observe(p); });
  } else {
    setInterval(syncStripHeight, 500);
  }

  function ensureLoaded(i) {
    if (i < 0 || i >= TABS.length || i === selfIndex) return;
    var iframe = panes[i].querySelector('iframe');
    if (!iframe || iframe.src) return;
    iframe.addEventListener('load', function () { onFrameLoad(i, iframe); });
    iframe.src = TABS[i].file + '?embed=1';
  }

  // A pane is just a viewport onto its tab — anything it links to (a coin,
  // a stock, the watchlist...) has to open as a real page, not inside the
  // strip. Left alone, the iframe itself navigated: the coin page showed up
  // squeezed into the Crypto pane with the address bar still on
  // /crypto.html and no way back but reloading. Links are rerouted on click
  // (hookLinks); this catches anything that still slipped through (a script
  // assigning location.href) after the fact.
  function onFrameLoad(i, iframe) {
    var w;
    try { w = iframe.contentWindow; } catch (e) { return; }
    var path = w.location.pathname;
    // home.html bounces signed-out visitors to the landing page, which is
    // built to render inside the Home pane — that one stays put.
    var expected = path === TABS[i].file || (i === 0 && (path === '/' || path === '/index.html'));
    if (!expected) {
      var href = w.location.href;
      iframe.src = TABS[i].file + '?embed=1';
      navigate(href);
      return;
    }
    syncHeight(iframe);
    hookLinks(w.document);
  }

  ensureLoaded(selfIndex - 1);
  ensureLoaded(selfIndex + 1);

  function paneWidth() { return tabScroll.clientWidth || window.innerWidth; }

  // Instant, synchronous — runs in the same task as the DOM move above, so
  // the browser never paints the intermediate "flattened but unscrolled" state.
  tabScroll.scrollLeft = selfIndex * paneWidth();
  history.replaceState({ tabIndex: selfIndex }, '', location.href);

  var activeIndex = selfIndex;

  // chat-widget.js loads before this script on every tab page (see each
  // page's <script> order) — tells it which tab is actually scrolled into
  // view so the AI chat's embed/icon mode tracks the visible tab instead of
  // staying stuck on whichever tab happened to load the top-level document.
  function notifyChatWidget(i) {
    var t = TABS[i];
    if (t && window.iiSetActiveTabPage) window.iiSetActiveTabPage(t.file.replace(/^\//, ''));
  }
  notifyChatWidget(selfIndex);

  // Live scroll position (scroll events already fire once per frame) for chat-widget.js, so its fixed-position
  // dock slides with Home instead of hanging over the next tab until the
  // swipe settles. ii-tab-moving switches off the panel's transitions while
  // the strip is in motion so the dock never lags its pane.
  var TAB_FILES = TABS.map(function (t) { return t.file.replace(/^\//, ''); });
  function reportScrollPos() {
    var w = paneWidth();
    if (window.iiSetTabScroll) window.iiSetTabScroll(TAB_FILES, tabScroll.scrollLeft / w, w);
  }
  reportScrollPos();

  function setActiveNav(i) {
    document.querySelectorAll('.bottom-nav .bn-item').forEach(function (el, idx) {
      el.classList.toggle('active', idx === i);
    });
    document.querySelectorAll('.nav-links a').forEach(function (el, idx) {
      if (idx < TABS.length) el.classList.toggle('active', idx === i);
    });
  }

  // Each tab keeps its own vertical scroll position, like the tabs in a
  // native app. All five panes share the one window scroll, so without this
  // switching tabs kept whatever depth you were at: scroll down Home, tap
  // Stocks, and you landed at Stocks' footer. While the strip moves, every
  // other pane is shifted (translateY) so it already shows from its own
  // remembered position; once the strip settles, the shift is dropped and
  // the window scrolled to match in the same frame, so nothing visibly jumps.
  var scrollMem = TABS.map(function () { return 0; });
  // Back/forward between tabs is handled by popstate below; the browser's own
  // restore would fight it (it put Track Record back at Home's depth).
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  var moving = false;
  function beginMove() {
    if (moving) return;
    moving = true;
    scrollMem[activeIndex] = window.scrollY;
    panes.forEach(function (pane, i) {
      var dy = i === activeIndex ? 0 : window.scrollY - scrollMem[i];
      pane.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
    });
    syncStripHeight();
    document.documentElement.classList.add('ii-tab-moving');
  }
  function endMove(i) {
    var wasMoving = moving;
    moving = false;
    document.documentElement.classList.remove('ii-tab-moving');
    panes.forEach(function (pane) { pane.style.transform = ''; });
    syncStripHeight();
    if (wasMoving) window.scrollTo({ top: scrollMem[i], behavior: 'instant' });
  }

  function onSettle() {
    var i = Math.round(tabScroll.scrollLeft / paneWidth());
    if (i < 0 || i >= TABS.length) return;
    var changed = i !== activeIndex;
    activeIndex = i;
    endMove(i);
    setActiveNav(i);
    if (!changed) return;
    var t = TABS[i];
    history.pushState({ tabIndex: i }, '', t.path);
    document.title = t.title;
    notifyChatWidget(i);
    ensureLoaded(i - 1);
    ensureLoaded(i + 1);
  }

  var scrollTimer;
  function settle() {
    clearTimeout(scrollTimer);
    reportScrollPos();
    onSettle();
  }
  tabScroll.addEventListener('scroll', function () {
    beginMove();
    reportScrollPos();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(settle, 120);
  }, { passive: true });
  tabScroll.addEventListener('scrollend', settle);

  function goTo(i) {
    if (i < 0 || i >= TABS.length) return;
    // Tapping the tab you're already on scrolls it back to the top, the
    // usual app convention.
    if (i === activeIndex && !moving) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    ensureLoaded(i - 1);
    ensureLoaded(i);
    ensureLoaded(i + 1);
    // Highlight the destination right away instead of after the swipe
    // settles — the old tab stayed lit for the whole animation.
    setActiveNav(i);
    beginMove();
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    tabScroll.scrollTo({ left: i * paneWidth(), behavior: reduced ? 'auto' : 'smooth' });
  }

  // Opens a URL from any pane: one of the five tabs swipes over to it
  // (reloading that pane first when the URL carries a query, e.g. Home's
  // "Full analysis" link into a specific market); any other page loads as
  // a normal top-level navigation. Pages call this through window.top so a
  // click inside an embedded pane never navigates the pane itself.
  function navigate(href) {
    var u;
    try { u = new URL(href, location.href); } catch (e) { location.href = href; return; }
    if (u.origin !== location.origin) { location.href = u.href; return; }
    u.searchParams.delete('embed');
    var i = TABS.findIndex(function (t) { return t.path === normalize(u.pathname) || t.file === u.pathname; });
    if (i === -1) { location.href = u.href; return; }
    if (u.search || u.hash) {
      if (i === selfIndex) { location.href = u.href; return; }
      var iframe = panes[i].querySelector('iframe');
      if (!iframe.src) iframe.addEventListener('load', function () { onFrameLoad(i, iframe); });
      u.searchParams.set('embed', '1');
      iframe.src = u.pathname + u.search + u.hash;
    }
    goTo(i);
  }
  window.iiNavigate = navigate;

  function hookLinks(doc) {
    doc.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      var raw = a.getAttribute('href') || '';
      if (!raw || raw.charAt(0) === '#' || /^(javascript|mailto|tel|sms):/i.test(raw)) return;
      e.preventDefault();
      navigate(a.href);
    });
  }
  hookLinks(document);

  // Only the two neighbors load up front; fetch the rest once the page has
  // gone idle so jumping straight from Home to Track Record doesn't land on
  // a pane that's only just started loading.
  window.addEventListener('load', function () {
    var idle = window.requestIdleCallback || function (fn) { setTimeout(fn, 1500); };
    idle(function () { TABS.forEach(function (_, i) { ensureLoaded(i); }); }, { timeout: 4000 });
  });

  document.querySelectorAll('.bottom-nav .bn-item').forEach(function (el, idx) {
    if (idx >= TABS.length) return;
    el.addEventListener('click', function (e) { e.preventDefault(); goTo(idx); });
  });
  document.querySelectorAll('.nav-links a').forEach(function (el, idx) {
    if (idx >= TABS.length) return;
    el.addEventListener('click', function (e) { e.preventDefault(); goTo(idx); });
  });
  document.querySelectorAll('.nav-icon, .nav-wordmark').forEach(function (el) {
    el.addEventListener('click', function (e) { e.preventDefault(); goTo(0); });
  });

  window.addEventListener('popstate', function () {
    var i = TABS.findIndex(function (t) { return t.path === normalize(location.pathname); });
    if (i === -1) return;
    ensureLoaded(i - 1);
    ensureLoaded(i);
    ensureLoaded(i + 1);
    if (i === activeIndex) return;
    scrollMem[activeIndex] = window.scrollY;
    activeIndex = i;
    tabScroll.scrollLeft = i * paneWidth();
    moving = true;
    endMove(i);
    document.title = TABS[i].title;
    setActiveNav(i);
    notifyChatWidget(i);
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      tabScroll.scrollLeft = activeIndex * paneWidth();
    }, 100);
  });
})();
