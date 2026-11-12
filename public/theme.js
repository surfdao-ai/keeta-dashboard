/* Theme bootstrap — runs synchronously in <head> before first paint so the
   chosen theme applies with no flash. CSP-safe (separate file, no inline). */
(function () {
  var theme = 'dark';
  try { theme = localStorage.getItem('dashkee.theme') || theme; } catch (e) { /* private mode */ }
  if (theme !== 'light' && theme !== 'dark') theme = 'dark';
  document.documentElement.dataset.theme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f2f3f8' : '#1a1b26');
})();
