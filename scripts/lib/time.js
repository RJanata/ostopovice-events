// Všechny časy akcí ukládáme takto:
//   celodenní akce: start/end jako "YYYY-MM-DD" (end = poslední den akce, včetně)
//   akce s časem:   start/end jako ISO řetězec v UTC
// Frontend je pak vykresluje v pražském čase.

export const TIME_ZONE = 'Europe/Prague';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Den (YYYY-MM-DD) daného okamžiku v pražském čase. */
export function pragueDay(date) {
  return dayFormatter.format(date);
}

/** Posun pražského času oproti UTC (v minutách) v daném okamžiku. */
function pragueOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Pražský místní čas → Date (správně i přes přechody letního času). */
export function fromPragueTime(year, month, day, hour = 0, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - pragueOffsetMinutes(new Date(guess)) * 60000;
  // druhý průchod pro případ, že odhad padl na druhou stranu přechodu času
  result = guess - pragueOffsetMinutes(new Date(result)) * 60000;
  return new Date(result);
}

export function isoDay(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Přičte dny k "YYYY-MM-DD". */
export function addDays(dayString, days) {
  const [y, m, d] = dayString.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Poslední den akce v pražském čase (pro rozhodnutí, zda už proběhla). */
export function eventLastDay(event) {
  if (event.allDay) return event.end || event.start;
  return pragueDay(new Date(event.end || event.start));
}

/** Parsuje české datum "10. 10. 2026" → "2026-10-10". */
export function parseCzechDate(text) {
  const m = String(text || '').match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (!m) return null;
  return isoDay(Number(m[3]), Number(m[2]), Number(m[1]));
}

export const CZECH_MONTHS = {
  ledna: 1, února: 2, března: 3, dubna: 4, května: 5, června: 6,
  července: 7, srpna: 8, září: 9, října: 10, listopadu: 11, prosince: 12,
};

/** Parsuje "sobota 10. října 2026" → { year, month, day }. */
export function parseCzechLongDate(text) {
  const m = String(text || '').toLowerCase().match(/(\d{1,2})\.\s*([a-záčďéěíňóřšťúůýž]+)\s+(\d{4})/);
  if (!m || !CZECH_MONTHS[m[2]]) return null;
  return { year: Number(m[3]), month: CZECH_MONTHS[m[2]], day: Number(m[1]) };
}
