// Sets the theme before the first paint, so there is no flash. Same rules as
// src/lib/theme.ts. A file, not an inline script, so the Content-Security-Policy
// (apps/web/security-headers.conf) can keep script-src to 'self'.
(function () {
  var choice = 'system';
  try {
    var stored = localStorage.getItem('lw-theme');
    if (stored === 'light' || stored === 'dark') choice = stored;
  } catch (e) {}
  var dark =
    choice === 'dark' ||
    (choice === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
