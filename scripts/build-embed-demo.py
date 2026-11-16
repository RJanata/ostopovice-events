# Ukázka vložení kalendáře a otevíracích dob do webu obce (www.ostopovice.cz).
# Ze stažené stránky kalendáře obce (embed-demo/raw/page.html) udělá dvě stránky:
#   embed-demo/index.html           – kalendář akcí (iframe /embed)
#   embed-demo/oteviraci-doby.html  – otevírací doby (iframe /embed-oteviraci-doby)
# Sekce .ipopagetext (a „Měsíční přehled akcí“) jde pryč, místo ní kód z embed-demo/snippet-*.html.
# Odkazy na kalendář a otevírací doby vedou na tyto lokální stránky (relativně → složka jde nasadit
# kamkoli), ostatní odkazy, styly a obrázky na živý web obce.
#
# Spuštění: C:\Utilities\Python\python.exe -I scripts/build-embed-demo.py [adresa kalendáře] [výstupní složka]
#   bez adresy: http://localhost:4173 (npm run serve); pro nasazení https://kalendar.prolidiostopovice.cz
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'embed-demo'
RAW = ROOT / 'raw'
OBEC = 'https://www.ostopovice.cz'
CALENDAR_URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173').rstrip('/')
# výstup: lokální ukázka → embed-demo/embed_demo/, s ostrým kalendářem → embed-demo/embed_demo_craz.cz/
# (k nahrání na craz.cz/dev/ostopovice.cz); třetí argument složku přepíše
LOCAL = CALENDAR_URL.startswith('http://localhost')
OUT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else ROOT / ('embed_demo' if LOCAL else 'embed_demo_craz.cz')
OUT.mkdir(parents=True, exist_ok=True)
PAGES = {'calendar': 'index.html', 'hours': 'oteviraci-doby.html'}


def div_span(html, opening):
    """Začátek a konec <div> (včetně vnořených) od daného otevíracího tagu."""
    start = html.index(opening)
    depth = 0
    for m in re.finditer(r'<div\b|</div>', html[start:]):
        depth += 1 if m.group(0) == '<div' else -1
        if depth == 0:
            return start, start + m.end()
    sys.exit(f'konec {opening} nenalezen')


def cut(html, opening):
    start, end = div_span(html, opening)
    return html[:start] + html[end:]


# ---------- styl a fonty ----------
# Fonty web obce cizí adrese nepustí (CORS) → lokálně (raw/fonts/<oid>, stažené curl);
# ostatní adresy ve stylu absolutně na živý web.
fonts = {p.name for p in (RAW / 'fonts').iterdir() if p.read_bytes()[:4] in (b'wOF2', b'wOFF')}
(OUT / 'fonts').mkdir(exist_ok=True)
for name in fonts:
    (OUT / 'fonts' / f'{name}.woff2').write_bytes((RAW / 'fonts' / name).read_bytes())

# Sofia Pro i pro vložený kalendář (?font=sofia) — JEN pro lokální ukázku: placené písmo obce,
# public/fonts/sofia-pro/ je v .gitignore, takže se na kalendar.prolidiostopovice.cz nedostane.
# (řez 600 má web obce jako woff2 omylem PostScript Type 1 → použitý jeho záložní .woff)
SOFIA = {'300.woff2': '8115825', '400.woff2': '8115826', '400-italic.woff2': '8115827', '500.woff2': '8117773',
         '600.woff': '8116138', '700.woff2': '8115823'}
SOFIA_DIR = ROOT.parent / 'public' / 'fonts' / 'sofia-pro'
SOFIA_DIR.mkdir(parents=True, exist_ok=True)
for name, oid in SOFIA.items():
    (SOFIA_DIR / name).write_bytes((RAW / 'fonts' / oid).read_bytes())
# Ukázka na craz.cz: Sofia Pro pro iframe leží u ukázky (fonts/sofia-pro/), iframe si ji vezme podle
# data-sofia-fonts; .htaccess (Apache ve Web Station na NASu) ji povolí ostrému kalendáři (CORS).
if not LOCAL:
    (OUT / 'fonts' / 'sofia-pro').mkdir(parents=True, exist_ok=True)
    for name, oid in SOFIA.items():
        (OUT / 'fonts' / 'sofia-pro' / name).write_bytes((RAW / 'fonts' / oid).read_bytes())
    (OUT / 'fonts' / 'sofia-pro' / '.htaccess').write_text(
        '# písmo smí načíst vložený kalendář (iframe z kalendar.prolidiostopovice.cz)\n'
        '<IfModule mod_headers.c>\n'
        f'  Header set Access-Control-Allow-Origin "{CALENDAR_URL}"\n'
        '</IfModule>\n', encoding='utf-8', newline='\n')

FONT_URL = re.compile(r'/file\.php\?nid=18899&(amp;)?oid=(\d+)')


def font_to(prefix):
    return lambda m: f'{prefix}{m.group(2)}.woff2' if m.group(2) in fonts else m.group(0)


css = (RAW / 'style.css').read_text(encoding='utf-8')
css = FONT_URL.sub(font_to('fonts/'), css)
css = re.sub(r"url\((['\"]?)/(?!/)", rf'url(\1{OBEC}/', css)
(OUT / 'style.css').write_text(css, encoding='utf-8')

# Úpravy jen pro ukázku: menší mezera pod drobečkovou navigací, bez cookie lišty,
# ikony pravého menu (web je přiřazuje podle pořadí odkazů, to se změnilo).
CLOCK = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' "
         "stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E"
         "%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 7v5l3 2'/%3E%3C/svg%3E")
ICONS = ['/file.php?nid=18899&oid=8360621', '/file.php?nid=18899&oid=8360620', '/image.php?nid=18899&oid=10467651',
         '/file.php?nid=18899&oid=8360627', '/image.php?nid=18899&oid=8955502', '/file.php?nid=18899&oid=9000139',
         '/image.php?nid=18899&oid=10792843', CLOCK]
icon_css = '\n'.join(
    f'.row.fix-links > div > a:nth-of-type({i}):before {{ background-image: url("{OBEC + u if u.startswith("/") else u}") !important; }}'
    for i, u in enumerate(ICONS, 1))
DEMO_STYLE = f'''<style>
#iponavigation {{ margin-bottom: 15px; }}
{icon_css}
</style>
'''

# ---------- stránka ----------
src = (RAW / 'page.html').read_text(encoding='utf-8')
# „Měsíční přehled akcí“ je v HTML jinde, do .ipopagetext ho přesouvá až skript webu → pryč taky
src = cut(src, '<div class="data-aggregator-calendar"')
src = cut(src, '<div id="snippet-cookiesConfirmation-euCookiesSnp">')
# ukázka nemá být ve vyhledávačích
src = src.replace('<meta name="robots" content="index,follow" />', '<meta name="robots" content="noindex,nofollow" />')
src = re.sub(r"<script src='https://www\.google\.com/recaptcha[^>]*></script>", '', src)
src = re.sub(r'href="/style\.php[^"]*"', 'href="style.css"', src, count=1)
src = src.replace('</head>', DEMO_STYLE + '</head>', 1)
src = FONT_URL.sub(font_to('fonts/'), src)

# pravé červené menu: bez Svozu odpadu a Krizového portálu, pod Kalendář akcí Otevírací doby
src = re.sub(r'\s*<a href="/odpadove-hospodarstvi">Svoz odpadu</a>', '', src)
src = re.sub(r'\s*<a href="https://www\.krizport\.cz/">Krizový portál</a>', '', src)
src = src.replace('<a href="https://www.ostopovice.cz/kalendar-akci#data-aggregator-calendar-10767427">Kalendář akcí</a>',
                  f'<a href="{PAGES["calendar"]}">Kalendář akcí</a>\n\t\t<a href="{PAGES["hours"]}">Otevírací doby</a>')
src = src.replace('href="/kalendar-akci"', f'href="{PAGES["calendar"]}"')
# horní menu: bez 4. položky Infokanál KT (pro ukázku zbytečná)
src = src.replace('<li class="topmenuitem1" id="ipomenu13976580"><a href="/infokanal-kt">Infokanál KT</a></li>', '')
# skript webu přepisuje text 7. odkazu menu na „Infokanál KT“ (podle pořadí) → po odebrání položek by trefil jiný
src = src.replace('$(el).find(".row.fix-links > div > a:nth-child(7)").text("Infokanál KT");',
                  '// (ukázka) přepis textu 7. odkazu na „Infokanál KT“ vypnutý, pořadí položek se změnilo')

# ostatní adresy od kořene webu obce → absolutně na živý web (místo <base>, ať fungují lokální odkazy)
src = re.sub(r'(\s(?:href|src|action)=["\'])/(?!/)', rf'\1{OBEC}/', src)


def page(html, snippet_file, title):
    snippet = (ROOT / snippet_file).read_text(encoding='utf-8')
    snippet = snippet.replace('https://kalendar.prolidiostopovice.cz', CALENDAR_URL)
    if LOCAL:  # písmo webu obce i v iframe (soubory jen lokálně)
        snippet = re.sub(r'(src="[^"]*/embed[^"?]*)"', r'\1?font=sofia"', snippet)
    else:  # písmo z ukázky na craz.cz (viz .htaccess výš)
        snippet = snippet.replace('<iframe class="ostopovice-embed"', '<iframe class="ostopovice-embed" data-sofia-fonts="fonts/sofia-pro/"')
    snippet = snippet.replace('data-calendar-page="/kalendar-akci"', f'data-calendar-page="{PAGES["calendar"]}"')
    snippet = snippet.replace('data-hours-page="/oteviraci-doby"', f'data-hours-page="{PAGES["hours"]}"')
    start, end = div_span(html, '<div class="ipopagetext">')
    html = html[:start] + snippet + html[end:]
    if title != 'Kalendář akcí':
        html = html.replace('<title>Kalendář akcí |', f'<title>{title} |', 1)
        html = html.replace('<span class="currentPage">Kalendář akcí</span>', f'<span class="currentPage">{title}</span>')
        html = html.replace('<li class="topmenuitem2 active" id="ipomenu8078135">', '<li class="topmenuitem2" id="ipomenu8078135">')
    return html


for name, snippet_file, title in (('calendar', 'snippet-calendar.html', 'Kalendář akcí'),
                                  ('hours', 'snippet-hours.html', 'Otevírací doby')):
    html = page(src, snippet_file, title)
    (OUT / PAGES[name]).write_text(html, encoding='utf-8')
    print(f'{OUT / PAGES[name]} ({len(html)} B)')
