// Weby na Wixu s aplikací Wix Events (např. knihovna).
//
// Hlavní cesta: veřejné Wix Events API, které používá i samotný web. Token pro
// anonymního návštěvníka vydá /_api/v1/access-tokens na doméně webu. API vrátí
// všechny termíny včetně opakovaných akcí (kurzy, cvičení).
//
// Záloha: když API selže, vezmeme seznam vložený ve stránce (wix-warmup-data).
// Ten je ale omezený (widget ukazuje max. ~20 položek), proto je to jen nouzovka.
import { fetchText } from '../lib/http.js';
import { htmlToText } from '../lib/text.js';

const EVENTS_APP_ID = '140603ad-af8d-84a5-2c80-a0f60cb47351';
const QUERY_URL = 'https://www.wixapis.com/events/v3/events/query';
const PAGE_SIZE = 100;

/** 'Lípová 67/15, 664 49 Ostopovice, Česko' → 'Lípová 67/15, Ostopovice' */
function shortenAddress(address) {
  return String(address || '')
    .replace(/,\s*Česko\s*$/, '')
    .replace(/\b\d{3}\s?\d{2}\s+/, '')
    .split(',').map((part) => part.trim()).filter(Boolean)
    .filter((part, i, all) => all.indexOf(part) === i)
    .join(', ');
}

/** Název místa + adresa, bez opakování (název „Ostopovice“ je v adrese i tak). */
function composeLocation(name, address) {
  const short = shortenAddress(address);
  if (!name) return short;
  if (!short || short.includes(name)) return short || name;
  return `${name}, ${short}`;
}

function makeEvent(source, { id, seriesId, title, slug, start, end, locationName, address, description, image }) {
  const location = composeLocation(String(locationName || '').trim(), address);
  return {
    uid: seriesId ? `wix-${seriesId}@${new Date(start).toISOString()}` : `wix-${id}`,
    title: String(title).trim(),
    start: new Date(start).toISOString(),
    end: new Date(end || start).toISOString(),
    allDay: false,
    location,
    url: source.options.detailBaseUrl + slug,
    description: String(description || '').trim(),
    image: image || '',
  };
}

async function fetchViaApi(source, { from }) {
  const origin = new URL(source.url).origin;
  const tokens = JSON.parse(await fetchText(`${origin}/_api/v1/access-tokens`));
  const auth = tokens.apps?.[EVENTS_APP_ID]?.instance;
  if (!auth) throw new Error('Web nevydal token pro Wix Events');

  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await fetch(QUERY_URL, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: {
          filter: { status: { $in: ['UPCOMING', 'STARTED', 'ENDED'] } },
          sort: [{ fieldName: 'dateAndTimeSettings.startDate', order: 'ASC' }],
          paging: { limit: PAGE_SIZE, offset },
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Wix API: HTTP ${response.status}`);
    const page = await response.json();
    all.push(...(page.events || []));
    if (!page.events?.length || all.length >= (page.pagingMetadata?.total ?? 0)) break;
  }

  return all
    .filter((e) => !e.dateAndTimeSettings?.dateAndTimeTbd && e.dateAndTimeSettings?.startDate)
    .filter((e) => new Date(e.dateAndTimeSettings.endDate || e.dateAndTimeSettings.startDate) >= from)
    .map((e) => makeEvent(source, {
      id: e.id,
      seriesId: e.dateAndTimeSettings.recurrenceStatus !== 'ONE_TIME' ? e.dateAndTimeSettings.recurringEvents?.categoryId : null,
      title: e.title,
      slug: e.slug,
      start: e.dateAndTimeSettings.startDate,
      end: e.dateAndTimeSettings.endDate,
      locationName: e.location?.name,
      address: e.location?.address?.formattedAddress,
      description: [e.shortDescription, htmlToText(e.detailedDescription)].filter(Boolean).join('\n\n'),
      image: e.mainImage?.url,
    }));
}

async function fetchFromPage(source) {
  const html = await fetchText(source.url);
  const m = html.match(/<script[^>]*id="wix-warmup-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Ve stránce chybí wix-warmup-data');
  const found = new Map();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.scheduling?.config && node.title && node.slug && node.id) {
      found.set(node.id, node);
      return;
    }
    for (const value of Object.values(node)) walk(value);
  })(JSON.parse(m[1]));

  return [...found.values()]
    .filter((e) => !e.scheduling.config.scheduleTbd && e.scheduling.config.startDate)
    .map((e) => {
      const cfg = e.scheduling.config;
      return makeEvent(source, {
        id: e.id,
        seriesId: cfg.recurrences?.status ? cfg.recurrences.categoryId : null,
        title: e.title,
        slug: e.slug,
        start: cfg.startDate,
        end: cfg.endDate,
        locationName: e.location?.name,
        address: e.location?.address,
        description: e.description,
        image: e.mainImage?.url,
      });
    });
}

export async function fetchEvents(source, ctx) {
  try {
    return await fetchViaApi(source, ctx);
  } catch (err) {
    ctx.log(`  ! ${source.id}: API selhalo (${err.message}), beru seznam ze stránky`);
    return fetchFromPage(source);
  }
}
