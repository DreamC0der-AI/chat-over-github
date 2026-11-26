// Sets the colour theme before the first paint, so a dark theme doesn't flash white.
// A separate file because the Content-Security-Policy allows no inline scripts.
try {
  var t = localStorage.getItem('cog.theme');
  if (t !== 'light' && t !== 'dark' && t !== 'dimmed') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
} catch (e) {}

// A page from before a deploy can ask for a stylesheet or script chunk the server no longer has
// (Safari restores tabs from its cache). The deploy keeps recent builds' files, but if one is
// still missing, reload once to get the current page instead of showing it without styles.
(function () {
  var KEY = 'cog.assetReload';
  function reloadOnce() {
    try {
      var last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 60000) return;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch (e) {
      return;
    }
    location.reload();
  }
  document.addEventListener(
    'error',
    function (e) {
      var el = e.target;
      var url = el && (el.tagName === 'LINK' ? el.href : el.tagName === 'SCRIPT' ? el.src : '');
      if (url && url.indexOf('/assets/') !== -1) reloadOnce();
    },
    true,
  );
  // Vite's event for a lazy chunk that failed to load.
  window.addEventListener('vite:preloadError', function (e) {
    e.preventDefault();
    reloadOnce();
  });
})();
