// Sets the colour theme before the first paint, so a dark theme doesn't flash white.
// A separate file because the Content-Security-Policy allows no inline scripts.
try {
  var t = localStorage.getItem('cog.theme');
  if (t !== 'light' && t !== 'dark' && t !== 'dimmed') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
} catch (e) {}
