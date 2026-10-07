// Barevný režim: výchozí světlý, volba se pamatuje v prohlížeči.
// Načítá se v <head> bez defer, aby stránka v tmavém režimu neblikla světlou.
(function () {
  var KEY = 'theme';
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* soukromý režim apod. */ }
  if (saved === 'dark') root.setAttribute('data-theme', 'dark');

  window.toggleTheme = function () {
    var dark = root.getAttribute('data-theme') !== 'dark';
    if (dark) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    try { if (dark) localStorage.setItem(KEY, 'dark'); else localStorage.removeItem(KEY); } catch (e) { /* nevadí */ }
    return dark;
  };
})();
