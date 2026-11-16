// Vložený kalendář / otevírací doby (embed*.html) na cizí stránce:
// 1) Rámeček se neumí sám natáhnout podle obsahu, proto po každé změně výšky (načtení, filtry,
//    přepnutí měsíce, změna šířky) pošle rodičovské stránce zprávu a ta si iframe nastaví.
// 2) Odkazy mezi kalendářem a otevíracími dobami (např. „Změna otevírací doby“) vedou na stránky
//    webu, do kterého jsme vložení — jejich adresy pošle rodičovská stránka ve zprávě „ping“.
//    Bez ní se odkazy otevřou na kalendar.prolidiostopovice.cz v novém okně.
// Kód pro rodičovskou stránku je v embed-demo/snippet-*.html.
(function () {
  // písmo na zkoušku: ?font=figtree nebo ?font=sofia (jen lokální ukázka), jinak systémové (css/style.css)
  var font = new URLSearchParams(location.search).get('font');
  if (font === 'figtree' || font === 'sofia') document.documentElement.dataset.font = font;
  if (window.parent === window) return; // otevřeno samostatně, ne v rámečku
  var last = 0;
  var pages = null; // { calendar: 'https://…/kalendar-akci', hours: 'https://…/oteviraci-doby' }

  function report() {
    var height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    window.parent.postMessage({ type: 'ostopovice-calendar:height', height: height }, '*');
  }

  document.addEventListener('DOMContentLoaded', function () {
    new ResizeObserver(report).observe(document.body);
    report();
  });
  // Pojistka: v rámečku z JINÉHO webu (kalendar.prolidiostopovice.cz na www.ostopovice.cz) Chrome
  // ResizeObserver po prvním hlášení nedoručoval → výšku navíc kontrolovat v intervalu
  // (zpráva odejde jen při změně, takže to nic nestojí).
  window.addEventListener('load', report);
  setInterval(function () { if (document.body) report(); }, 500);

  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent || !ev.data || ev.data.type !== 'ostopovice-calendar:ping') return;
    if (ev.data.pages) pages = ev.data.pages;
    last = 0;
    report();
  });

  // odkaz na naši stránku → stejná stránka na webu rodiče (celé okno, ne rámeček)
  document.addEventListener('click', function (ev) {
    var link = ev.target.closest && ev.target.closest('a[href]');
    if (!link || !pages) return;
    var url = new URL(link.href);
    if (url.origin !== location.origin) return;
    var path = url.pathname.replace(/\.html$/, '');
    var page = /\/(embed-)?oteviraci-doby$/.test(path) ? pages.hours
      : /\/(index|embed)?$/.test(path) ? pages.calendar : null;
    if (!page) return;
    link.href = page.split('#')[0] + url.hash;
    link.target = '_top';
  }, true);
})();
