(function () {
  var saved = null;
  try { saved = localStorage.getItem('ib-theme'); } catch (e) {}
  var theme = saved === 'light' || saved === 'dark' ? saved : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);

  function syncMetaThemeColor(t) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#f1faf5' : '#111111');
  }
  syncMetaThemeColor(theme);

  function wire() {
    syncMetaThemeColor(document.documentElement.getAttribute('data-theme'));
    var toggles = document.querySelectorAll('.theme-toggle');
    if (!toggles.length) return;
    toggles.forEach(function (btn) {
      btn.setAttribute('aria-pressed', document.documentElement.getAttribute('data-theme') === 'light');
      btn.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('ib-theme', next); } catch (e) {}
        syncMetaThemeColor(next);
        toggles.forEach(function (b) { b.setAttribute('aria-pressed', next === 'light'); });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
