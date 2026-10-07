// Kalendář akcí na webech s redakčním systémem IPO (ANTEE) — RSS s <dueDate>/<endDate>.
// Feed obsahuje jen nadcházející akce; proběhlé si drží archiv (viz lib/store.js).
import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.js';
import { htmlToText } from '../lib/text.js';
import { parseCzechDate } from '../lib/time.js';

function stripTracking(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith('utm_')) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export async function fetchEvents(source) {
  const xml = await fetchText(source.url);
  const $ = cheerio.load(xml, { xml: true });
  const events = [];

  $('item').each((_, el) => {
    const item = $(el);
    const start = parseCzechDate(item.find('dueDate').text());
    if (!start) return;
    const end = parseCzechDate(item.find('endDate').text()) || start;
    const guid = item.find('guid').text().trim();
    const html = item.find('content\\:encoded').text() || item.find('description').text();
    const image = item.find('enclosure').attr('url')
      || cheerio.load(html)('img').first().attr('src') || '';

    events.push({
      uid: guid || stripTracking(item.find('link').text().trim()),
      title: item.find('title').text().trim(),
      start,
      end: end < start ? start : end,
      allDay: true,
      location: '',
      url: stripTracking(item.find('link').text().trim()),
      description: htmlToText(html),
      image,
    });
  });
  return events;
}
