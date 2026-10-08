// Program akcí psaný jako obyčejný text (např. Klub seniorů). Očekávaná struktura:
//
//   LEDEN 2026                      ← nadpis měsíce (jen odděluje, datum se bere z řádku níž)
//   31. ledna 2026 | sobota         ← řádek s datem (i rozsah „1. - 4. září 2026“)
//   - PLES SENIORŮ                  ← položka = akce (víc položek pod jedním datem = víc akcí)
//   na Sokolovně                    ← další řádky = popis akce
//
// Položky bez konkrétního data („... října 2026“) se přeskočí. Čas („od 16:00“) a známá
// místa (source.options.places) se z textu vytáhnou zvlášť.
import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.js';
import { normalize } from '../lib/text.js';
import { CZECH_MONTHS, fromPragueTime, isoDay } from '../lib/time.js';

const MONTH_NAMES = Object.keys(CZECH_MONTHS).join('|');
const DATE_LINE = new RegExp(
  `^(\\d{1,2})\\.\\s*(?:(?:-|–|až)\\s*(\\d{1,2})\\.\\s*)?(${MONTH_NAMES})\\s+(\\d{4})`, 'i',
);
const MONTH_HEADING = /^(leden|únor|březen|duben|květen|červen|červenec|srpen|září|říjen|listopad|prosinec)\s+\d{4}\s*$/i;
const SECTION_BREAK = /^(\*[\s*]*|program na rok.*|průběžně.*)$/i;
const TIME = /\bod\s+(\d{1,2})[:.](\d{2})/i;

/** HTML → řádky textu (br a blokové prvky = nový řádek). */
function htmlToLines(html, selector) {
  const $ = cheerio.load(html);
  $('script, style').remove();
  const root = $(selector).first().length ? $(selector).first() : $('body');
  root.find('br').replaceWith('\n');
  root.find('p, div, li, h1, h2, h3, h4, h5, tr').each((_, el) => { $(el).append('\n'); });
  return root.text()
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Úvodní slova psaná VERZÁLKAMI → běžný text: „PLES SENIORŮ“ → „Ples seniorů“,
 * „OSLAVA MDŽ S HUDBOU“ → „Oslava MDŽ s hudbou“ (krátké zkratky 2–3 písmena zůstávají).
 */
function tidyTitle(text) {
  const title = text.replace(/^[-–]\s*/, '').replace(/[,;]\s*$/, '').trim();
  const words = title.split(/\s+/);
  let index = 0;
  const out = [];
  for (const word of words) {
    const letters = word.replace(/[^\p{L}]/gu, '');
    const isUpper = letters && letters === letters.toLocaleUpperCase('cs') && letters !== letters.toLocaleLowerCase('cs');
    if (!isUpper || index !== out.length) {
      out.push(word);
      continue;
    }
    index += 1;
    const keepAcronym = letters.length >= 2 && letters.length <= 3;
    out.push(keepAcronym ? word : word.toLocaleLowerCase('cs'));
  }
  const result = out.join(' ');
  return result.charAt(0).toLocaleUpperCase('cs') + result.slice(1);
}

export async function fetchEvents(source) {
  const lines = htmlToLines(await fetchText(source.url), source.options?.selector || '#document');
  const places = source.options?.places || [];

  const items = [];
  let date = null; // { start, end } jako YYYY-MM-DD
  let current = null;

  for (const line of lines) {
    const dateMatch = line.match(DATE_LINE);
    if (dateMatch) {
      const month = CZECH_MONTHS[dateMatch[3].toLowerCase()];
      const year = Number(dateMatch[4]);
      const first = Number(dateMatch[1]);
      const last = dateMatch[2] ? Number(dateMatch[2]) : first;
      date = { start: isoDay(year, month, first), end: isoDay(year, month, last), line };
      current = null;
      continue;
    }
    if (MONTH_HEADING.test(line) || SECTION_BREAK.test(line) || /^\.\.\./.test(line)) {
      date = null;
      current = null;
      continue;
    }
    if (!date) continue;
    if (/^[-–]\s*/.test(line)) {
      current = { date, title: line, details: [] };
      items.push(current);
    } else if (current) {
      current.details.push(line);
    }
  }

  return items.map(({ date: d, title, details }) => {
    const fullText = [d.line, title, ...details].join('\n');
    const time = fullText.match(TIME);
    const place = places.find((p) => new RegExp(p.match, 'i').test(normalize(fullText)));
    // z názvu vypustit části, které jsou zvlášť jako místo a čas („…, v Restauraci u Volejníků, od 16:00“)
    const cleanTitle = tidyTitle(title)
      .split(/,\s*/)
      .filter((part, i) => i === 0 || !(TIME.test(part) || (place && new RegExp(place.match, 'i').test(normalize(part)))))
      .join(', ');
    const base = {
      uid: `${source.id}-${d.start}-${normalize(cleanTitle).replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
      title: cleanTitle,
      location: place?.name || '',
      url: source.link || source.url,
      description: details.join('\n'),
      cancelled: /\bzrusen/i.test(normalize(fullText)),
    };
    if (time && d.start === d.end) {
      const [y, m, day] = d.start.split('-').map(Number);
      const start = fromPragueTime(y, m, day, Number(time[1]), Number(time[2]));
      return { ...base, start: start.toISOString(), end: start.toISOString(), allDay: false };
    }
    return { ...base, start: d.start, end: d.end, allDay: true };
  });
}
