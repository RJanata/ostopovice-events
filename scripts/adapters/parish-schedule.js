// Pořad bohoslužeb farnosti (farnost.troubsko.cz) — tabulka na aktuální týden:
//   den | datum (např. „4.10.“, bez roku) | svátek | místo | čas(y) | úmysl
// Bereme jen řádky, kde místo odpovídá options.placeMatch (např. „kaple Ostopovice“).
// Víc časů v jedné buňce („7:30 9:00“) = víc bohoslužeb. Rozpis má jen aktuální týden,
// proběhlé bohoslužby drží archiv (viz collect.js).
import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.js';
import { normalize } from '../lib/text.js';
import { fromPragueTime, pragueDay } from '../lib/time.js';

const DURATION_MINUTES = 60;

/** „4.10.“ → nejbližší takové datum k dnešku (rozpis je vždy kolem aktuálního týdne). */
function resolveDate(text, now = new Date()) {
  const m = String(text).match(/(\d{1,2})\.\s*(\d{1,2})\./);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(pragueDay(now).slice(0, 4));
  const candidates = [year - 1, year, year + 1].map((y) => fromPragueTime(y, month, day, 12));
  const best = candidates.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
  return { year: Number(pragueDay(best).slice(0, 4)), month, day };
}

export async function fetchEvents(feed) {
  const options = feed.options || {};
  const placeMatch = normalize(options.placeMatch || '');
  const $ = cheerio.load(await fetchText(feed.url));
  const table = $('table').first();
  if (!table.length) throw new Error('Na stránce chybí tabulka s pořadem bohoslužeb (změnil se web?)');

  // buňka → řádky textu (<br> a odstavce = nový řádek, jinak by se slévaly „růženceMše“)
  const cellLines = (td) => {
    $(td).find('br').replaceWith('\n');
    $(td).find('p, div').each((_, el) => { $(el).append('\n'); });
    return $(td).text().split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  };

  const events = [];
  table.find('tr').each((_, tr) => {
    const cells = $(tr).find('td').map((__, td) => [cellLines(td)]).get();
    if (cells.length < 5) return; // nadpis týdne apod.
    const [, dateLines, celebrationLines, placeLines, timeLines, intentionLines = []] = cells;
    const place = placeLines.join(' ');
    if (!placeMatch || !normalize(place).includes(placeMatch)) return;
    const date = resolveDate(dateLines.join(' '));
    if (!date) return;
    const celebration = celebrationLines.join(' · ');
    const times = [...timeLines.join(' ').matchAll(/(\d{1,2})[:.](\d{2})/g)];

    times.forEach((t, index) => {
      // víc časů a stejně řádků úmyslů → každá bohoslužba svůj úmysl, jinak všechny řádky
      const intention = times.length > 1 && intentionLines.length === times.length
        ? intentionLines[index]
        : intentionLines.join(' · ');
      const start = fromPragueTime(date.year, date.month, date.day, Number(t[1]), Number(t[2]));
      events.push({
        uid: `${feed.id}-${start.toISOString()}`,
        title: options.title || 'Mše svatá',
        start: start.toISOString(),
        end: new Date(start.getTime() + DURATION_MINUTES * 60000).toISOString(),
        allDay: false,
        location: options.location || place,
        url: feed.link || feed.url,
        description: [celebration, intention && `Úmysl: ${intention}`].filter(Boolean).join('\n'),
        categories: options.categories,
      });
    });
  });
  return events;
}
