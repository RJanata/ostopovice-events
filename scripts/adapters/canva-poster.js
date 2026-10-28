// Měsíční plakát akcí v Canvě (MŠ/ZŠ Ostopovice). Odkaz na plakát se při každém běhu
// hledá na stránce školy (source.url) podle textu odkazu (options.linkText), protože škola
// může plakát vyměnit za nový design.
//
// Stránka Canvy (/design/…/view) má v HTML vložený celý dokument jako JSON
// (window['bootstrap'] = JSON.parse('…')) se zkrácenými názvy klíčů. Používáme:
//   dokument:  I = obrázky [{ id, files: [{ url }] }], D.A.A = stránky, O = čas poslední úpravy
//   stránka:   E = prvky
//   prvek:     A? = typ (K text, I obrázek), A = shora, B = zleva, D = šířka, C = výška
//   text:      a.C.A = řádky
//   obrázek:   a.B.A.A = id obrázku
//
// Na plakátu jsou sloupce textu; akce = skupina řádků oddělená prázdným řádkem:
//   úterý 6. 10.                 ← datum (i „čtvrtek a pátek 29. a 30. 10.“), rok z nadpisu „říjen 2026“
//   DOŽÍNKY VE STODOLE           ← název
//   všechny třídy MŠ a ZŠ        ← další řádky = popis (pro koho, čas, místo)
// Bereme jen akce označené ikonkou „pro veřejnost“ (options.markerImage = kus adresy obrázku).
// Ikonka leží vlevo od textu u řádku s datem; akci najdeme podle její výšky na stránce.
import * as cheerio from 'cheerio';
import { BROWSER_USER_AGENT, fetchText } from '../lib/http.js';
import { normalize, tidyTitle } from '../lib/text.js';
import { fromPragueTime, isoDay } from '../lib/time.js';

const MONTHS = ['leden', 'unor', 'brezen', 'duben', 'kveten', 'cerven', 'cervenec', 'srpen', 'zari', 'rijen', 'listopad', 'prosinec'];
const MONTH_HEADING = new RegExp(`^(${MONTHS.join('|')})\\s+(\\d{4})$`);
// „Od 8.00“, „od 17:00“, „od 13.30 do 14.00“, „16.30–18.00“
const TIME = /(?:^|[^\d.:])(\d{1,2})[.:](\d{2})(?![\d.:])(?:\s*(?:-|–|do)\s*(\d{1,2})[.:](\d{2})(?![\d.:]))?/i;
// jak daleko vlevo od textu může ikonka ležet (v bodech plakátu; teď je to ~48)
const MAX_MARKER_GAP = 120;

/** Obsah JS řetězce v apostrofech ('…') → skutečný text. */
function decodeJsString(literal) {
  const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  return literal.replace(/\\(?:u([0-9a-f]{4})|x([0-9a-f]{2})|([\s\S]))/gi, (m, u, x, c) => {
    if (u || x) return String.fromCharCode(parseInt(u || x, 16));
    return simple[c] ?? c;
  });
}

/** Najde v bootstrap JSONu dokument: objekt s obrázky (I) a stránkami (D.A.A). */
function findDocument(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node.I) && Array.isArray(node.D?.A?.A)) return node;
  for (const value of Object.values(node)) {
    const found = findDocument(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Odkaz na plakát na stránce školy (odkaz, jehož text obsahuje options.linkText). */
async function findPosterUrl(source) {
  const $ = cheerio.load(await fetchText(source.url));
  const wanted = normalize(source.options.linkText).replace(/\s+/g, ' ');
  const link = $('a[href*="canva"]').filter((_, a) => normalize($(a).text()).replace(/\s+/g, ' ').includes(wanted)).first();
  if (!link.length) throw new Error(`Na stránce školy chybí odkaz „${source.options.linkText}“ na Canvu`);
  return new URL(link.attr('href'), source.url).href;
}

const slug = (text) => normalize(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const textOf = (el) => el.a.C.A.join('');

/** Výška řádku textového bloku = výška bloku / počet řádků. Ne velikost písma × řádkování ze stylu:
 *  Canva text zmenšuje, aby se vešel do rámečku (listopad 2026: styl 13,7, skutečně 11,5). */
function lineHeight(el) {
  return el.C / el.a.C.A.length;
}

/** Skupiny neprázdných řádků (akce) s indexem prvního řádku. */
function lineGroups(lines) {
  const groups = [];
  let current = null;
  lines.forEach((line, index) => {
    const text = line.replace(/\s+/g, ' ').trim();
    if (!text) {
      current = null;
      return;
    }
    if (!current) {
      current = { firstLine: index, lines: [] };
      groups.push(current);
    }
    current.lines.push(text);
  });
  return groups;
}

/** „úterý 6. 10.“ / „čtvrtek a pátek 29. a 30. 10.“ / „30. 10. – 2. 11.“ → { start, end }. */
function parseDateLine(line, heading) {
  const numbers = (line.match(/\d{1,2}(?=\s*\.)/g) || []).map(Number);
  let parts;
  if (numbers.length === 2) parts = [numbers[0], numbers[1], numbers[0], numbers[1]];
  else if (numbers.length === 3) parts = [numbers[0], numbers[2], numbers[1], numbers[2]];
  else if (numbers.length === 4) parts = numbers;
  else return null;
  const [d1, m1, d2, m2] = parts;
  if (m1 < 1 || m1 > 12 || m2 < 1 || m2 > 12) return null;
  // plakát za prosinec může mít akce v lednu příštího roku (a naopak)
  const year = (month) => heading.year + (month - heading.month > 6 ? -1 : heading.month - month > 6 ? 1 : 0);
  return { start: isoDay(year(m1), m1, d1), end: isoDay(year(m2), m2, d2) };
}

/** Řádky zalomené jen kvůli šířce sloupce („…pro“ / „rodiče, děti…“) spojí do jedné věty. */
function joinWrapped(lines) {
  const out = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (previous && !/[.!?:)]$/.test(previous) && /^\p{Ll}/u.test(line)) out[out.length - 1] = `${previous} ${line}`;
    else out.push(line);
  }
  return out;
}

/** Akce označené ikonkou na jedné stránce plakátu. */
function pageEvents(page, markerIds, source, posterUrl) {
  const elements = page.E || [];
  const texts = elements.filter((e) => e['A?'] === 'K' && Array.isArray(e.a?.C?.A));
  const headingMatch = texts.map((e) => normalize(textOf(e)).trim().match(MONTH_HEADING)).find(Boolean);
  if (!headingMatch) return { heading: null, events: [] };
  const heading = { month: MONTHS.indexOf(headingMatch[1]) + 1, year: Number(headingMatch[2]) };

  const markers = elements.filter((e) => e['A?'] === 'I' && markerIds.has(e.a?.B?.A?.A));
  const picked = new Map(); // stejnou akci nebrat dvakrát
  for (const marker of markers) {
    const centerY = marker.A + marker.C / 2;
    const block = texts
      .filter((t) => t.B > marker.B && t.B - marker.B < MAX_MARKER_GAP && t.A <= centerY && centerY <= t.A + t.C)
      .sort((a, b) => a.B - b.B)[0];
    if (!block) continue; // ikonka v legendě („AKCE PRO VEŘEJNOST“) nemá vpravo program
    const groups = lineGroups(block.a.C.A);
    if (!groups.length) continue;
    const line = (centerY - block.A) / lineHeight(block);
    const group = groups.reduce((best, g) => (Math.abs(g.firstLine + 0.5 - line) < Math.abs(best.firstLine + 0.5 - line) ? g : best));
    picked.set(`${block._ || block.A}-${group.firstLine}`, group);
  }

  const events = [];
  for (const group of picked.values()) {
    const [dateLine, titleLine, ...rest] = group.lines;
    const details = joinWrapped(rest);
    const date = parseDateLine(dateLine || '', heading);
    if (!date || !titleLine) continue;
    const title = tidyTitle(titleLine);
    const time = details.join('\n').match(TIME);
    const base = {
      uid: `${source.id}-${date.start}-${slug(title)}`,
      audience: details[0] || '',
      title,
      location: '',
      url: posterUrl,
      description: details.join('\n'),
      cancelled: /\bzrusen/i.test(normalize(group.lines.join('\n'))),
    };
    const hour = time && Number(time[1]);
    if (time && date.start === date.end && hour < 24 && Number(time[2]) < 60) {
      const [y, m, d] = date.start.split('-').map(Number);
      const start = fromPragueTime(y, m, d, hour, Number(time[2]));
      const end = time[3] ? fromPragueTime(y, m, d, Number(time[3]), Number(time[4])) : start;
      events.push({ ...base, start: start.toISOString(), end: (end > start ? end : start).toISOString(), allDay: false });
    } else {
      events.push({ ...base, start: date.start, end: date.end, allDay: true });
    }
  }
  // víc akcí se stejným názvem v jeden den (třídní schůzky) rozliší 1. řádek popisu = pro koho
  const counts = new Map();
  for (const e of events) counts.set(e.uid, (counts.get(e.uid) || 0) + 1);
  for (const e of events) {
    if (counts.get(e.uid) > 1) e.uid += `-${slug(e.audience)}`;
    delete e.audience;
  }
  return { heading, events };
}

export async function fetchEvents(source, { log } = {}) {
  const posterUrl = await findPosterUrl(source);
  const html = await fetchText(posterUrl, { userAgent: BROWSER_USER_AGENT });
  const match = html.match(/window\['bootstrap'\]\s*=\s*JSON\.parse\('((?:[^'\\]|\\[\s\S])*)'\)/);
  if (!match) throw new Error('Stránka Canvy nemá vložená data plakátu (změnila se Canva, nebo vrátila „Unsupported client“?)');
  const doc = findDocument(JSON.parse(decodeJsString(match[1])));
  if (!doc) throw new Error('V datech Canvy chybí dokument se stránkami');
  // akce odkazují přímo na svůj list plakátu (…/view#2 = 2. list), bez sledovacích parametrů utm_… / utlId
  const posterLink = new URL(posterUrl).origin + new URL(posterUrl).pathname;

  const marker = source.options.markerImage;
  const markerIds = new Set(doc.I.filter((m) => (m.files || []).some((f) => String(f.url).includes(marker))).map((m) => m.id));
  if (!markerIds.size) throw new Error(`Na plakátu chybí ikonka akcí pro veřejnost (${marker})`);

  let pages = doc.D.A.A.map((page, index) => pageEvents(page, markerIds, source, `${posterLink}#${index + 1}`)).filter((p) => p.heading);
  if (source.options.latestPageOnly && pages.length) {
    const key = (p) => p.heading.year * 12 + p.heading.month;
    const latest = Math.max(...pages.map(key));
    pages = pages.filter((p) => key(p) === latest);
  }
  if (log) {
    const updated = typeof doc.O === 'number' ? new Date(doc.O).toISOString().slice(0, 10) : '?';
    const months = pages.map((p) => `${p.heading.month}/${p.heading.year}: ${p.events.length}`).join(', ');
    log(`  plakát upraven ${updated} (${months})`);
  }
  return pages.flatMap((p) => p.events);
}
