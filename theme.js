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
