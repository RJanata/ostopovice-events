// Zápis souhrnného .ics, aby si lidi mohli kalendář přidat do telefonu.
import { addDays } from './time.js';

function escapeText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Zalomení řádků na 75 oktetů podle RFC 5545 (bez rozdělení UTF-8 znaku). */
function fold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch);
    if (bytes + len > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += len;
  }
  out.push(current);
  return out.join('\r\n ');
}

const utcStamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateStamp = (day) => day.replace(/-/g, '');

export function buildIcs(events, { name, sourcesById, categoryLabels = {} }) {
  const now = utcStamp(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ostopovice-events//CS',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-TIMEZONE:Europe/Prague',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of events) {
    const source = sourcesById[e.source];
    lines.push('BEGIN:VEVENT', `UID:${e.id}@ostopovice-events`, `DTSTAMP:${now}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.start)}`, `DTEND;VALUE=DATE:${dateStamp(addDays(e.end || e.start, 1))}`);
    } else {
      lines.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end || e.start)}`);
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.cancelled) lines.push('STATUS:CANCELLED');
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    const description = [e.description, source && `Zdroj: ${source.name}`].filter(Boolean).join('\n\n');
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (e.categories?.length) lines.push(`CATEGORIES:${e.categories.map((c) => escapeText(categoryLabels[c] || c)).join(',')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
