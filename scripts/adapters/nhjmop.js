// Rozpis hřiště z nhjmop.cz (národní házená, Jihomoravská oblast) — domácí utkání oddílu.
import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.js';
import { fromPragueTime, isoDay, parseCzechLongDate } from '../lib/time.js';

const MATCH_MINUTES = 75;

export async function fetchEvents(source) {
  const html = await fetchText(source.url);
  const $ = cheerio.load(html);
  const pageUrl = source.link || source.url;
  const events = [];

  $('section.hriste-den').each((_, sectionEl) => {
    const section = $(sectionEl);
    const date = parseCzechLongDate(section.find('.hriste-den__nazev').first().text());
    if (!date) return;

    section.find('li.hriste-zapas').each((__, matchEl) => {
      const match = $(matchEl);
      const time = match.find('.hriste-zapas__cas').text().trim();
      const competition = match.find('.hriste-zapas__soutez').text().trim();
      const teams = match.find('.hriste-zapas__utkani').text().replace(/\s+/g, ' ').trim();
      const score = match.find('.hriste-zapas__skore').text().replace(/\s+/g, ' ').trim();
      const number = match.find('.hriste-zapas__cislo').text().replace(/^č\.\s*u\.\s*/, '').trim();

      const t = time.match(/^(\d{1,2}):(\d{2})$/);
      const base = {
        uid: `nhjmop-${number || `${isoDay(date.year, date.month, date.day)}-${teams}`}`,
        title: `Národní házená: ${competition} · ${teams}`,
        shortTitle: `${competition} · ${teams}`, // do měsíčního kalendáře (prefix je u Sokola všude stejný)
        location: source.options?.location || '',
        url: pageUrl,
        // číslo utkání je jen interní údaj soutěže; ukazujeme jen výsledek odehraných zápasů
        description: score ? `Výsledek: ${score}` : '',
        extra: { competition, teams, score },
      };

      if (t) {
        const start = fromPragueTime(date.year, date.month, date.day, Number(t[1]), Number(t[2]));
        events.push({
          ...base,
          start: start.toISOString(),
          end: new Date(start.getTime() + MATCH_MINUTES * 60000).toISOString(),
          allDay: false,
        });
      } else {
        const day = isoDay(date.year, date.month, date.day);
        events.push({ ...base, start: day, end: day, allDay: true });
      }
    });
  });
  return events;
}
