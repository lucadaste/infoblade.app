// Swipe left/right anywhere in the main content to switch between the 5 bottom-nav
// tabs (Home, Stocks, Markets, Crypto, Track Record), like the Robinhood app.
// Touches starting on the header nav, footer, or bottom-nav are ignored, and swipes
// starting inside a horizontally-scrollable element (pill filters, tables, charts)
// are left alone so they can scroll natively.
(function () {
  var ORDER = ['/', '/feed.html', '/markets.html', '/crypto.html', '/accuracy.html'];

  function normalize(path) {
    if (path === '/index.html' || path === '/home.html') return '/';
    return path;
  }

  var idx = ORDER.indexOf(normalize(location.pathname));
  if (idx === -1) return;

  var THRESHOLD = 70;      // min horizontal px to count as a swipe
  var MAX_OFF_AXIS = 60;   // max vertical drift allowed
  var MAX_TIME = 700;      // ms

  var startX = 0, startY = 0, startT = 0, tracking = false, skip = false;

  function hasHorizontalScroll(el) {
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.scrollWidth > el.clientWidth + 2) {
        var overflowX = getComputedStyle(el).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  document.addEventListener('touchstart', function (e) {
    var target = e.target;
    if (e.touches.length !== 1 || (target.closest && target.closest('nav, footer, .bottom-nav'))) {
      tracking = false;
      return;
    }
    skip = hasHorizontalScroll(target);
    var t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    startT = Date.now();
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    if (!tracking || skip) { tracking = false; return; }
    tracking = false;

    var t = e.changedTouches[0];
    var dx = t.clientX - startX;
    var dy = t.clientY - startY;
    var dt = Date.now() - startT;

    if (dt > MAX_TIME || Math.abs(dy) > MAX_OFF_AXIS || Math.abs(dx) < THRESHOLD) return;

    var nextIdx = idx;
    if (dx < 0 && idx < ORDER.length - 1) nextIdx = idx + 1;      // swipe left -> next tab
    else if (dx > 0 && idx > 0) nextIdx = idx - 1;                // swipe right -> prev tab
    if (nextIdx === idx) return;

    document.body.classList.add('swipe-exit');
    setTimeout(function () { location.href = ORDER[nextIdx]; }, 100);
  }, { passive: true });
})();
