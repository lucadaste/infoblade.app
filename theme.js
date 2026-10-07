(function () {
  var saved = null;
  try { saved = localStorage.getItem('ib-theme'); } catch (e) {}
  var theme = saved === 'light' || saved === 'dark' ? saved : 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  function syncMetaThemeColor(t) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#dcf0e5' : '#111111');
  }
  syncMetaThemeColor(theme);

  function setTheme(next) {
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ib-theme', next); } catch (e) {}
    syncMetaThemeColor(next);
    document.dispatchEvent(new CustomEvent('ib-theme-change', { detail: { theme: next } }));
    syncIframes(next);
  }

  // The tab-shell preloads neighboring pages as same-origin iframes and
  // never reloads them, so a toggle here would otherwise leave an
  // already-loaded pane stuck on whatever theme it had at load time until
  // its own page is reloaded. Reach into each iframe's own theme API so it
  // re-applies and re-dispatches exactly as if toggled locally.
  function syncIframes(next) {
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var w = iframes[i].contentWindow;
        if (w && w.__iiTheme && w.__iiTheme.get() !== next) w.__iiTheme.set(next);
      } catch (e) { /* not same-origin or not loaded yet; ignore */ }
    }
  }

  // Public API so any page's UI (e.g. the account dropdown) can read/flip the
  // theme without needing a `.theme-toggle` element to already be in the DOM.
  window.__iiTheme = {
    get: function () { return document.documentElement.getAttribute('data-theme'); },
    set: setTheme,
    toggle: function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      setTheme(next);
      return next;
    },
  };

  function wire() {
    syncMetaThemeColor(document.documentElement.getAttribute('data-theme'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
