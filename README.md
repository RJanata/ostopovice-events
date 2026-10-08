# Akce v Ostopovicích

Souhrnný kalendář obecních, kulturních a sportovních akcí z více zdrojů na jednom místě.
Statický web (HTML + CSS + JS) na GitHub Pages, data přegeneruje GitHub Action třikrát denně.
Běží na https://kalendar.prolidiostopovice.cz.

```
zdroje (RSS, Wix, rozpis hřiště, Google iCal)
   → scripts/collect.js  (Node, GitHub Action 3× denně)
   → public/data/events.json + public/data/akce.ics
   → statický web public/ (filtry podle zdroje a typu akce, seznam a měsíc)
```

## Zdroje

| Zdroj | Typ adaptéru | Jak se čte |
|---|---|---|
| Obec Ostopovice | `ipo-rss` | RSS kalendáře akcí (redakční systém IPO). Jen datum, bez času → celodenní akce. Feed má jen nadcházející akce, proběhlé drží náš archiv. |
| Knihovna Ostopovice | `wix-events` | Veřejné Wix Events API (token návštěvníka z `/_api/v1/access-tokens`). Vrací i všechny termíny opakovaných akcí a proběhlé akce. Záloha: seznam vložený ve stránce (omezený). |
| Klub seniorů | `text-program` | Program jako prostý text: řádek s datem („31. ledna 2026 \| sobota“, i rozsahy) a pod ním položky s pomlčkou. Čas („od 16:00“) a známá místa (`options.places`) se vytáhnou zvlášť. Položky bez data se přeskočí. **Každý rok je potřeba přepsat `url` na `program-<rok>.html`.** |
| TJ Sokol Ostopovice | `nhjmop` | Rozpis hřiště z nhjmop.cz (domácí utkání národní házené, celá sezóna). |
| Státní svátky | `ical` | Google iCal; jen „Státní svátek“, zobrazují se jako popisek dne (`display: dayLabel`). |
| Nezařazené | `ical` | Vlastní Google kalendář (opakované události jen na tento a příští měsíc, `recurringMonths`) pro akce v obci, které nepatří pod žádný jiný zdroj (`allowEmpty`, `adminRefresh`). Navíc doplňkový zdroj (`extraFeeds`) **Farnost Troubsko** (`parish-schedule`): z týdenního pořadu bohoslužeb jen ty v kapli Ostopovice, kategorie Církev. Selhání doplňku nesmaže jeho poslední akce. |
| Připravované události | `ical` | Vlastní Google kalendář se zástupnými akcemi; skutečný zdroj se stejnou akcí má přednost. |

## Konfigurace

- **`config/sources.json`** — seznam zdrojů. Nový Google kalendář = zkopírovat blok `pripravovane`,
  změnit `id`, `name`, `url` (veřejná adresa ve formátu iCal), `icon` a `color`.
  - `categories` — kategorie, které dostane každá akce zdroje (Sokol → Sport)
  - `fallbackCategories` — jen když pravidla nic nenajdou (obec → Obec, knihovna → Kultura)
  - `skipRules: true` — pravidla podle klíčových slov se nepoužijí
  - `village` — obec; až budou zdroje z víc obcí, objeví se na webu filtr „Obec“
  - `hideLocations` — regexy „domácích“ adres zdroje (knihovna, hřiště); ty se nezobrazují,
    adresa se ukáže jen u akcí, které jsou jinde
  - `enabled: false` — zdroj dočasně vypnout
  - `fullName` — plný název do patičky webu (Obec Ostopovice…); doplňkové zdroje (`extraFeeds`)
    mají v patičce vlastní položku s `fullName`, `icon` a `link`. Svátky se v patičce
    nevypisují, vlastní Google kalendáře souhrnně jako „vlastní Google kalendáře“.
  - `options.recurringMonths` (iCal) — opakované události jen do konce (n-1). dalšího měsíce
    (2 = tento a příští), ať pravidelné akce nezahltí kalendář na rok dopředu
- **`config/categories.json`** — kategorie a klíčová slova (regulární výrazy bez diakritiky,
  porovnávají se s názvem a popisem akce).
- **Kategorie přímo v popisu akce** (hlavně pro vlastní Google kalendáře): do popisu události
  stačí napsat `#deti #kultura`, nebo samostatný řádek `Kategorie: Pro děti, Kultura`.
  Platí id i název kategorie, bez ohledu na diakritiku (`#vzdelavani` = `#Vzdělávání`).
  Štítky mají přednost před pravidly a z popisu na webu zmizí.
  Odkaz na akci jde zapsat samostatným řádkem `#link: https://…` — stane se z něj odkaz
  v názvu akce a v popisu se nezobrazí.
  Vlastní ikona akce: `#icon:ball-football` (kdekoli v popisu, hlavně u pravidelných akcí
  z Google kalendáře). Název je z [Tabler Icons](https://tabler.io/icons); sběr ikonu stáhne
  do `public/icons/tabler/` (commituje se s daty), neexistující název jen zaloguje a ignoruje.
  Ikona se ukáže v kalendáři (místo ikony zdroje) i před názvem akce, v barvě její kategorie. Další aliasy jdou přidat
  do kategorie jako `"tags": ["deticky"]`.
- **`config/overrides.json`** — ruční opravy jednotlivých akcí podle `id` (najdeš ho
  v `public/data/events.json`), např.:
  ```json
  { "events": { "obec-fjsj2r": { "title": "Komunální volby 2026" }, "obec-xyz": { "hidden": true } } }
  ```
  Původní název zdroje zůstává v datech jako `originalTitle`.
- Ikony zdrojů: `public/icons/` (loga a favicony organizací, PNG/SVG). Ikony kategorií: `public/icons/categories/` (jednobarevné SVG, obarví se barvou kategorie).

## Správa akcí (admin.html)

Stránka `admin.html` (na webu není odkaz, adresa `…/ostopovice-events/admin.html`) umí u akce
změnit název, místo/adresu, datum a čas (jen u jednoho termínu), přidat poznámku
(na webu se zobrazí vždy u akce pod zdrojem, typem a adresou), nastavit vlastní kategorie nebo ji skrýt — u opakovaných akcí buď jeden termín,
nebo všechny termíny naráz (i budoucí). Ukládá do `config/overrides.json` přes GitHub API
s `[skip ci]`, takže jednotlivé úpravy web nepřegenerují. Úpravy se posbírají a na web je
pošle tlačítko „Přegenerovat web“, které zčervená, jakmile v repu jsou úpravy novější než
data na webu (případně je promítne nejbližší automatická aktualizace).

Tlačítkem „Znovu načíst“ spustí workflow ručně — buď pro všechny zdroje, nebo jen pro
zdroje s `adminRefresh: true` (workflow má vstup `only`, který předá `--only=<id>`).

Potřebuje GitHub token: Settings → Developer settings → Fine-grained tokens, přístup jen
k tomuto repozitáři, *Contents* a *Actions*: Read and write. Token se uloží v `localStorage` prohlížeče.
Pozor: všechny GitHub Pages jednoho účtu sdílí doménu `<účet>.github.io`, takže token vidí
i stránky ostatních projektů na stejné doméně — používej jen na svém počítači.

## Chování sběru

- Zdroj, který selže, nesmaže svá data: zůstanou poslední úspěšně stažená a web ukáže upozornění.
- Zdroj, který najednou vrátí 0 akcí, i když dřív nějaké měl, se bere jako chyba (nejspíš se změnil web).
- Proběhlé akce se drží 400 dní.
- Kategorie se počítají při každém běhu znovu, takže úprava pravidel platí i zpětně.
- Akce s názvem začínajícím „ZRUŠENO“ se zobrazí přeškrtnuté.
- Státní svátky nejsou ve filtru zdrojů — zobrazují se vždy (u čísla dne v měsíci, v seznamu i dny bez akcí).
- Skryté akce zůstávají v `events.json` (s `hidden: true`), aby je šlo v adminu znovu zobrazit.
- Kromě `akce.ics` vzniká i `akce-<kategorie>.ics` pro každou kategorii (odběr jen „Pro děti“ apod.);
  v .ics jsou akce od 60 dní zpět. Pro libovolnou kombinaci filtrů nabízí web jednorázové
  stažení .ics vytvořeného přímo v prohlížeči (`js/ics-export.js`).
- Stejná akce ve dvou zdrojích (stejný název a den) se zobrazí jen jednou.
- Každá akce má `added` = kdy se u nás poprvé objevila. Nový termín už známé opakované akce
  (řada se rozbalí o další měsíc) novou akcí není. Web z toho ukazuje „Nedávno přidané události“
  (posledních 7 dní, ne dřív než 8. 10. 2026 12:00 — do té doby se zdroje teprve plnily).
- **Upozornění e-mailem:** když běh najde nové nadcházející akce, zapíše je do `added-events.md`
  a workflow je přidá jako komentář do issue „Nově přidané akce (upozornění)“ se zmínkou vlastníka
  repa → GitHub pošle e-mail. Issue workflow založí sám; nezavírat.
- „Zobrazit proběhlé akce (N)“ je jen v aktuálním měsíci a ukáže proběhlé akce od 1. dne měsíce.
- Seznam pod kalendářem ukazuje jen akce vybraného měsíce (aktuální měsíc od dneška); „Zobrazit další akce – <měsíc> (N)“ přidá vždy jeden další měsíc; když za seznamem zbývá méně než 30 akcí (bez pravidelných), je místo něj „Zobrazit všechny další akce (N)“ a ukáže je naráz. Při hledání se ukážou všechny nalezené akce.

## Návštěvnost

Stránka při otevření pošle jeden požadavek na `https://stats.craz.cz/hit/ostopovice-events`
(cesta stránky a odkud návštěvník přišel; bez cookies, jen na ostrém webu — `countVisit()`
v `js/app.js`). Zapisuje ho projekt **hit-counter** na NASu, report GoAccess je v **nas-stats**
(`http://nas:3102`, jen z domácí sítě).

## Lokálně

```bash
npm install
npm run collect          # stáhne data do public/data
npm run collect -- --only=knihovna
npm run serve            # náhled na http://localhost:4173
```

## Nasazení (GitHub Pages)

1. Repozitář musí být veřejný (Pages zdarma).
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Workflow `.github/workflows/update.yml` běží 3× denně, po každém pushi do `main`
   a ručně (Actions → Aktualizace a nasazení → Run workflow).
4. Data se commitují jen tehdy, když se změnily akce. Když se 45 dní nic nezmění,
   workflow udělá prázdný commit, aby GitHub plánované spouštění nevypnul.

### Vlastní doména (volitelně)

Teď `kalendar.prolidiostopovice.cz` (soubor `CNAME`). Postup: v DNS přidat `CNAME kalendar → <účet>.github.io`,
pak Settings → Pages → Custom domain a zaškrtnout Enforce HTTPS. Hosting zůstává na GitHubu.

## Filtry v URL

Stav filtrů je v adrese za `#`, takže jde poslat odkaz, např.
`#t=deti` (jen akce pro děti), `#m=2026-11&z=sokol` (listopad, jen Sokol), `#q=jóga`.
Dvojklik na štítek filtru vybere jen tuto položku.
Zaškrtávátko „Pravidelné“ (vedle kategorií) skryje pravidelné akce, v adrese `#r=0`.
Ve filtru kategorií jsou jen kategorie, které mají nějakou nadcházející akci
(„Ostatní“ se tak ukáže, až do ní něco spadne).
