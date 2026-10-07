// Sběr akcí ze všech zdrojů → public/data/events.json + public/data/akce.ics
//
// Spuštění: npm run collect  (volitelně --only=knihovna pro jeden zdroj)
//
// Zásady:
//   - zdroj, který selže, nesmaže svá data: zůstanou poslední úspěšně stažené akce
//   - proběhlé akce si držíme sami (zdroje je obvykle ze seznamu mažou)
//   - kategorie se počítají při každém běhu znovu, takže změna pravidel platí i zpětně
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildRules, buildTagMap, categorize, extractTags } from './lib/categorize.js';
import { buildIcs } from './lib/ics.js';
import { normalize, shortHash, truncate } from './lib/text.js';
import { addDays, eventLastDay, fromPragueTime, pragueDay } from './lib/time.js';
import * as icalAdapter from './adapters/ical.js';
import * as ipoRssAdapter from './adapters/ipo-rss.js';
import * as wixEventsAdapter from './adapters/wix-events.js';
import * as nhjmopAdapter from './adapters/nhjmop.js';

const ADAPTERS = {
  ical: icalAdapter,
  'ipo-rss': ipoRssAdapter,
  'wix-events': wixEventsAdapter,
  nhjmop: nhjmopAdapter,
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const ICS_FILE = path.join(DATA_DIR, 'akce.ics');

const CALENDAR_NAME = 'Akce v Ostopovicích';
const PAST_DAYS = 400; // jak dlouho držet proběhlé akce
const FUTURE_DAYS = 400; // jak daleko rozbalovat opakované akce
const ICS_PAST_DAYS = 60; // kolik proběhlých dní dávat do .ics kalendářů

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
};

const log = (...args) => console.log(...args);

/** Řádek „#link: https://…“ v popisu = odkaz na akci (hlavně pro vlastní Google kalendáře). */
function extractLink(description) {
  let url = '';
  const text = String(description || '').replace(/^[ \t]*#link[ \t]*:[ \t]*(\S+)[ \t]*$/gim, (line, link) => {
    if (!url && /^https?:\/\//i.test(link)) url = link;
    return '';
  });
  return { url, description: text };
}

function finalizeEvent(raw, source, rules, tagMap) {
  const linked = extractLink(raw.description);
  const tagged = extractTags(linked.description, tagMap);
  const event = {
    id: `${source.id}-${shortHash(raw.uid)}`,
    source: source.id,
    title: raw.title,
    start: raw.start,
    end: raw.end || raw.start,
    allDay: Boolean(raw.allDay),
    location: raw.location || '',
    url: linked.url || raw.url || '',
    description: truncate(tagged.description),
    image: raw.image || '',
  };
  if (raw.extra) event.extra = raw.extra;
  if (tagged.categories.length) event.tagCategories = tagged.categories;
  if (raw.cancelled || /^\W*zruseno\b/.test(normalize(raw.title))) event.cancelled = true;
  return applySourceRules(event, source, rules);
}

/**
 * Pravidla zdroje, která se počítají při každém běhu znovu (i u akcí z archivu):
 * kategorie a skrytí adresy u známých míst (knihovna, hřiště…).
 */
function applySourceRules(event, source, rules) {
  const e = { ...event };
  // archiv obsahuje akce už s ručními úpravami → vrátit původní hodnoty, úpravy se aplikují znovu
  for (const [field, originalField] of Object.entries(OVERRIDABLE)) {
    if (originalField in e) {
      e[field] = e[originalField];
      delete e[originalField];
    }
  }
  for (const field of OVERRIDE_ONLY) delete e[field];
  const hide = source.hideLocations || [];
  if (e.location && hide.some((pattern) => new RegExp(pattern, 'i').test(e.location))) e.location = '';
  e.categories = categorize(e, source, rules);
  return e;
}

// pole, která jde přepsat v overrides.json; původní hodnota se schová pod druhým jménem
const OVERRIDABLE = {
  title: 'originalTitle',
  location: 'originalLocation',
  start: 'originalStart',
  end: 'originalEnd',
  allDay: 'originalAllDay',
};
// pole, která vznikají jen z ručních úprav (ze zdroje nikdy nepřijdou)
const OVERRIDE_ONLY = ['note', 'hidden'];

/**
 * Ruční úpravy z config/overrides.json:
 *   series["zdroj|Původní název"] — platí pro všechny termíny akce s tímto názvem (i budoucí)
 *   events["id"]                  — platí pro jeden konkrétní termín (má přednost)
 */
function applyOverrides(event, overrides) {
  const changes = {
    ...overrides.series?.[`${event.source}|${event.title}`],
    ...overrides.events?.[event.id],
  };
  if (!Object.keys(changes).length) return event;
  const result = { ...event, ...changes };
  for (const [field, originalField] of Object.entries(OVERRIDABLE)) {
    if (field in changes && changes[field] !== event[field]) result[originalField] = event[field];
  }
  if (!result.note) delete result.note;
  return result;
}

/** Stejná akce ve dvou zdrojích (stejný název a den) → necháme první podle pořadí zdrojů. */
function dedupe(events, sourceOrder) {
  const byKey = new Map();
  const sorted = [...events].sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source]);
  const result = [];
  for (const e of sorted) {
    if (e.hidden) {
      result.push(e);
      continue;
    }
    const key = `${normalize(e.title).replace(/[^a-z0-9]+/g, ' ').trim()}|${e.allDay ? e.start : pragueDay(new Date(e.start))}`;
    const existing = byKey.get(key);
    if (existing && existing.source !== e.source) {
      existing.alsoIn = [...new Set([...(existing.alsoIn || []), e.source])];
      continue;
    }
    byKey.set(key, e);
    result.push(e);
  }
  return result;
}

const sortKey = (e) => {
  if (!e.allDay) return new Date(e.start).toISOString();
  const [y, m, d] = e.start.split('-').map(Number);
  return fromPragueTime(y, m, d).toISOString();
};

async function main() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  const { sources } = await readJson(path.join(ROOT, 'config', 'sources.json'));
  const categoriesConfig = await readJson(path.join(ROOT, 'config', 'categories.json'));
  const overrides = await readJson(path.join(ROOT, 'config', 'overrides.json'), { events: {}, series: {} });
  const previous = await readJson(EVENTS_FILE, { events: [], sources: [] });
  const rules = buildRules(categoriesConfig);
  const tagMap = buildTagMap(categoriesConfig);

  const now = new Date();
  const today = pragueDay(now);
  const window = {
    from: new Date(now.getTime() - PAST_DAYS * 864e5),
    to: new Date(now.getTime() + FUTURE_DAYS * 864e5),
  };
  const oldestKept = addDays(today, -PAST_DAYS);

  const allEvents = [];
  const sourceStatus = [];
  let failures = 0;

  for (const source of sources) {
    if (source.enabled === false) continue;
    const prevEvents = previous.events.filter((e) => e.source === source.id);
    const prevStatus = previous.sources?.find((s) => s.id === source.id) || {};
    const status = { id: source.id, lastSuccess: prevStatus.lastSuccess || null, ok: true, error: null, count: 0 };
    let fresh = null;

    if (!only || only === source.id) {
      const adapter = ADAPTERS[source.type];
      try {
        if (!adapter) throw new Error(`Neznámý typ zdroje: ${source.type}`);
        const raw = await adapter.fetchEvents(source, { ...window, log });
        const prevFuture = prevEvents.filter((e) => eventLastDay(e) >= today).length;
        if (!raw.length && prevFuture > 0 && !source.allowEmpty) {
          throw new Error('Zdroj nevrátil žádné akce, i když dřív nějaké měl (změnil se web?)');
        }
        fresh = raw.map((r) => finalizeEvent(r, source, rules, tagMap));
        status.lastSuccess = now.toISOString();
      } catch (err) {
        failures += 1;
        status.ok = false;
        status.error = err.message;
        log(`✗ ${source.id}: ${err.message}`);
      }
    } else {
      status.ok = prevStatus.ok ?? true;
      status.error = prevStatus.error ?? null;
    }

    let events;
    if (fresh) {
      // nově stažené + proběhlé akce z archivu, které už zdroj nevypisuje
      const freshIds = new Set(fresh.map((e) => e.id));
      const archived = prevEvents.filter((e) => !freshIds.has(e.id) && eventLastDay(e) < today);
      events = [...fresh, ...archived.map((e) => applySourceRules(e, source, rules))];
      log(`✓ ${source.id}: ${fresh.length} ze zdroje, ${archived.length} z archivu`);
    } else {
      events = prevEvents.map((e) => applySourceRules(e, source, rules));
    }

    events = events
      .filter((e) => eventLastDay(e) >= oldestKept)
      .map((e) => applyOverrides(e, overrides));
    // skryté akce zůstávají v datech (admin je musí umět znovu zobrazit), web a .ics je vynechají
    status.count = events.length;
    sourceStatus.push(status);
    allEvents.push(...events);
  }

  const sourceOrder = Object.fromEntries(sources.map((s, i) => [s.id, i]));
  const events = dedupe(allEvents, sourceOrder).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const publicSources = sources
    .filter((s) => s.enabled !== false)
    .map(({ id, name, village, icon, color, link, display, adminRefresh }) => ({
      id, name, village, icon, color, link: link || null, display: display || 'events', adminRefresh: Boolean(adminRefresh),
      ...sourceStatus.find((st) => st.id === id),
    }));

  const output = {
    generatedAt: now.toISOString(),
    calendarName: CALENDAR_NAME,
    sources: publicSources,
    categories: categoriesConfig.categories.map(({ id, label, color, icon }) => ({ id, label, color, icon })),
    events,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(EVENTS_FILE, JSON.stringify(output, null, 1) + '\n');

  const sourcesById = Object.fromEntries(sources.map((s) => [s.id, s]));
  const categoryLabels = Object.fromEntries(categoriesConfig.categories.map((c) => [c.id, c.label]));
  // do .ics jen akce (ne svátky) a jen nedávné a budoucí — kalendáře v telefonu nepotřebují rok historie
  const icsFrom = addDays(today, -ICS_PAST_DAYS);
  const icsEvents = events.filter((e) => !e.hidden && sourcesById[e.source]?.display !== 'dayLabel' && eventLastDay(e) >= icsFrom);
  await writeFile(ICS_FILE, buildIcs(icsEvents, { name: CALENDAR_NAME, sourcesById, categoryLabels }));
  // samostatný kalendář pro každou kategorii (kdo chce jen „Pro děti“, odebírá jen ten)
  for (const category of categoriesConfig.categories) {
    const list = icsEvents.filter((e) => e.categories.includes(category.id));
    await writeFile(path.join(DATA_DIR, `akce-${category.id}.ics`),
      buildIcs(list, { name: `${CALENDAR_NAME} – ${category.label}`, sourcesById, categoryLabels }));
  }

  log(`Hotovo: ${events.length} akcí, ${failures} zdrojů selhalo.`);
  // Selhání jednoho zdroje nemá shodit celé nasazení; jen když selžou všechny.
  if (failures && failures === sourceStatus.filter((s) => !only || s.id === only).length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
