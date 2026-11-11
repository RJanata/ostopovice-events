// Otevírací doby: config/opening-hours.json (instituce a obchody) + config/opening-hours-exceptions.json
// (výjimky z adminu) → public/data/opening-hours.json pro stránku oteviraci-doby.html.
// Přidá státní svátky ze zdrojů typu dayLabel, ať je stránka nemusí číst z velkého events.json.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalize } from './text.js';
import { TIME_ZONE, addDays, eventLastDay, pragueDay } from './time.js';

const KEEP_PAST_EXCEPTIONS_DAYS = 14; // proběhlé výjimky na webu nepotřebujeme (v configu zůstanou)
const HOLIDAY_DAYS = 200; // na jak dlouho dopředu svátky
const EVENT_DAYS_BACK = 7; // akce u míst (ikonka v panelu): kolik dní zpět…
const EVENT_DAYS_AHEAD = 120; // …a dopředu
const LONG_EVENT_DAYS = 8; // dlouhodobé akce (výstavy) se u míst neukazují — stejně jako v kalendáři
const timeFormatter = new Intl.DateTimeFormat('cs-CZ', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const INTERVAL = /^\d{2}:\d{2}-\d{2}:\d{2}$/;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

function checkHours(hours, where, log) {
  if (!hours) return;
  for (const [day, list] of Object.entries(hours)) {
    if (!DAYS.includes(day)) log(`  ! otevírací doby: ${where} má neznámý den „${day}“`);
    for (const item of list) {
      const time = typeof item === 'string' ? item : item.time;
      if (!INTERVAL.test(time || '')) log(`  ! otevírací doby: ${where}, ${day}: chybný čas „${time}“`);
    }
  }
}

/**
 * Pravidlo, které akce z kalendáře patří k místu (place.eventMatch, regulární výrazy bez diakritiky):
 * sources = akce zdroje bez uvedeného místa (knihovna má domácí adresu skrytou), locations = místo akce,
 * titles = název akce (např. „Vechtrovna: Hudební večer“).
 */
function eventMatcher(rule) {
  if (!rule) return null;
  const regexes = (list) => (list || []).map((text) => new RegExp(normalize(text)));
  const locations = regexes(rule.locations);
  const titles = regexes(rule.titles);
  return (e) => ((rule.sources || []).includes(e.source) && !e.location)
    || locations.some((re) => re.test(normalize(e.location)))
    || titles.some((re) => re.test(normalize(e.title)));
}

function isLongEvent(e) {
  if (e.long === true || e.long === false) return e.long;
  const first = e.allDay ? e.start : pragueDay(new Date(e.start));
  const days = (Date.parse(eventLastDay(e)) - Date.parse(first)) / 864e5 + 1;
  return days >= LONG_EVENT_DAYS;
}

/** Akce u místa: [{ day, time, title }] (bez skrytých a dlouhodobých). */
function placeEvents(place, events, sourcesById, today) {
  const match = eventMatcher(place.eventMatch);
  if (!match) return [];
  const from = addDays(today, -EVENT_DAYS_BACK);
  const to = addDays(today, EVENT_DAYS_AHEAD);
  return events
    .filter((e) => !e.hidden && sourcesById[e.source]?.display !== 'dayLabel' && match(e) && !isLongEvent(e))
    .map((e) => ({
      day: e.allDay ? e.start : pragueDay(new Date(e.start)),
      time: e.allDay ? '' : timeFormatter.format(new Date(e.start)),
      title: e.title,
    }))
    .filter((e) => e.day >= from && e.day <= to);
}

export async function buildOpeningHours({ root, outFile, events, sourcesById, today, log }) {
  const config = await readJson(path.join(root, 'config', 'opening-hours.json'));
  const { exceptions = [] } = await readJson(path.join(root, 'config', 'opening-hours-exceptions.json'), { exceptions: [] });
  const placeIds = new Set(config.places.map((p) => p.id));

  for (const place of config.places) {
    checkHours(place.hours, place.id, log);
    for (const season of place.seasons || []) checkHours(season.hours, `${place.id} (${season.label})`, log);
  }

  const keepFrom = addDays(today, -KEEP_PAST_EXCEPTIONS_DAYS);
  // výjimka může platit pro víc míst naráz (např. všichni zavřeno ve svátek); starší tvar měl jen place
  const publicExceptions = exceptions
    .map((x) => ({ ...x, places: x.places || (x.place ? [x.place] : []) }))
    .filter((x) => {
      const unknown = x.places.filter((id) => !placeIds.has(id));
      if (unknown.length) log(`  ! otevírací doby: výjimka ${x.id} má neznámá místa ${unknown.join(', ')}`);
      x.places = x.places.filter((id) => placeIds.has(id));
      return x.places.length && (x.to || x.from) >= keepFrom;
    })
    .map(({ id, places, from, to, hours, note }) => ({ id, places, from, to: to || from, hours: hours || [], note: note || '' }))
    .sort((a, b) => a.from.localeCompare(b.from));

  // svátky: { "2026-12-24": ["Štědrý den"] }
  const holidayTo = addDays(today, HOLIDAY_DAYS);
  const holidays = {};
  for (const e of events) {
    if (e.hidden || sourcesById[e.source]?.display !== 'dayLabel') continue;
    const first = e.allDay ? e.start : e.start.slice(0, 10);
    const last = eventLastDay(e);
    if (last < keepFrom || first > holidayTo) continue;
    for (let d = first; d <= last; d = addDays(d, 1)) (holidays[d] ||= []).push(e.title);
  }

  const output = {
    categories: config.categories,
    // checked = poznámka pro nás, odkud je otevírací doba
    places: config.places.map(({ checked: _, eventMatch, ...place }) => {
      const list = placeEvents({ eventMatch }, events, sourcesById, today);
      return list.length ? { ...place, events: list } : place;
    }),
    exceptions: publicExceptions,
    holidays,
  };
  await writeFile(outFile, JSON.stringify(output, null, 1) + '\n');
  log(`Otevírací doby: ${output.places.length} míst, ${publicExceptions.length} výjimek`);
}
