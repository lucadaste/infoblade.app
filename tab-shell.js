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
  var contentNodes = Array.prototype.filter.call(document.body.children, function (el) {
    return !SKIP_TAGS[el.tagName];
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
    if (pane) tabScroll.style.height = pane.offsetHeight + 'px';
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
    iframe.addEventListener('load', function () { syncHeight(iframe); });
    iframe.src = TABS[i].file + '?embed=1';
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

  function setActiveNav(i) {
    document.querySelectorAll('.bottom-nav .bn-item').forEach(function (el, idx) {
      el.classList.toggle('active', idx === i);
    });
    document.querySelectorAll('.nav-links a').forEach(function (el, idx) {
      if (idx < TABS.length) el.classList.toggle('active', idx === i);
    });
  }

  function onSettle() {
    var i = Math.round(tabScroll.scrollLeft / paneWidth());
    if (i < 0 || i >= TABS.length || i === activeIndex) return;
    activeIndex = i;
    var t = TABS[i];
    history.pushState({ tabIndex: i }, '', t.path);
    document.title = t.title;
    setActiveNav(i);
    notifyChatWidget(i);
    syncStripHeight();
    ensureLoaded(i - 1);
    ensureLoaded(i + 1);
  }

  var scrollTimer;
  tabScroll.addEventListener('scroll', function () {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(onSettle, 120);
  }, { passive: true });
  tabScroll.addEventListener('scrollend', onSettle);

  function goTo(i) {
    if (i < 0 || i >= TABS.length) return;
    ensureLoaded(i - 1);
    ensureLoaded(i);
    ensureLoaded(i + 1);
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    tabScroll.scrollTo({ left: i * paneWidth(), behavior: reduced ? 'auto' : 'smooth' });
  }

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
    activeIndex = i;
    tabScroll.scrollLeft = i * paneWidth();
    document.title = TABS[i].title;
    setActiveNav(i);
    notifyChatWidget(i);
    syncStripHeight();
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      tabScroll.scrollLeft = activeIndex * paneWidth();
    }, 100);
  });
})();
