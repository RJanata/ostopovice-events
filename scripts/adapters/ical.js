// Obecný iCal zdroj (Google Kalendář a cokoliv dalšího, co umí .ics).
import ical from 'node-ical';
import { fetchText } from '../lib/http.js';
import { htmlToText } from '../lib/text.js';
import { addDays, fromPragueTime, pragueDay } from '../lib/time.js';

/**
 * source.options:
 *   includeDescriptions: [..] — vezme jen události, jejichž DESCRIPTION je v seznamu
 *                              (u státních svátků tak vyřadíme „Významný den“)
 *   recurringMonths: 2      — opakované události jen do konce (n-1). dalšího měsíce
 *                              (2 = tento + příští); jednorázové akce bez omezení
 */
export async function fetchEvents(source, { from, to }) {
  const text = await fetchText(source.url);
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Odpověď není iCal (není kalendář veřejný?)');
  const data = ical.sync.parseICS(text);
  const include = source.options?.includeDescriptions;
  const months = source.options?.recurringMonths;
  // 1. den měsíce za posledním povoleným (v pražském čase), opakování od něj dál se nerozbalí
  const today = pragueDay(new Date());
  const recurringTo = months
    ? fromPragueTime(Number(today.slice(0, 4)), Number(today.slice(5, 7)) + months, 1)
    : to;

  const events = [];
  for (const item of Object.values(data)) {
    if (item.type !== 'VEVENT' || item.status === 'CANCELLED') continue;
    const description = typeof item.description === 'string' ? item.description : item.description?.val;
    if (include && !include.includes(String(description || '').trim())) continue;

    const instances = ical.expandRecurringEvent(item, { from, to: item.rrule && recurringTo < to ? recurringTo : to, expandOngoing: true })
      .filter((inst) => !item.rrule || inst.start < recurringTo);
    for (const inst of instances) {
      const allDay = Boolean(inst.isFullDay);
      let start;
      let end;
      if (allDay) {
        start = pragueDay(inst.start);
        // DTEND je u celodenních akcí exkluzivní → poslední den = DTEND - 1
        end = inst.end ? addDays(pragueDay(inst.end), -1) : start;
        if (end < start) end = start;
      } else {
        start = inst.start.toISOString();
        end = (inst.end || inst.start).toISOString();
      }
      const summary = typeof inst.summary === 'string' ? inst.summary : inst.summary?.val;
      events.push({
        uid: `${item.uid}@${start}`,
        title: String(summary || '(bez názvu)').trim(),
        start,
        end,
        allDay,
        location: item.location ? String(item.location).trim() : '',
        url: typeof item.url === 'string' ? item.url : item.url?.val || '',
        description: htmlToText(description),
        recurring: Boolean(item.rrule), // opakovaná událost (cvičení, tréninky…)
      });
    }
  }
  // kalendář sdílený jen jako „volno/obsazeno“ posílá místo názvů „Busy“ a žádné podrobnosti
  if (events.length && events.every((e) => /^(busy|zaneprázdněn[ýa]?|obsazeno)$/i.test(e.title))) {
    throw new Error('Kalendář je veřejně sdílený jen jako „volno/obsazeno“ – v Google Kalendáři je potřeba zpřístupnit všechny podrobnosti událostí');
  }
  return events;
}
