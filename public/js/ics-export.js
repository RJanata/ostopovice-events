'use strict';

// Vytvoření .ics přímo v prohlížeči — pro jednorázový import akcí podle vlastního filtru.
// (Statický web neumí odběr libovolné kombinace; ten je jen pro „vše“ a jednotlivé kategorie.)
// UID akcí jsou stejné jako v odebíraných kalendářích, takže opakovaný import akce aktualizuje.

(function () {
  function escapeText(text) {
    return String(text || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  const encoder = new TextEncoder();

  /** Zalomení řádků na 75 oktetů (RFC 5545), bez rozdělení znaku. */
  function fold(line) {
    const out = [];
    let current = '';
    let bytes = 0;
    for (const ch of line) {
      const len = encoder.encode(ch).length;
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

  const utcStamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = (day) => day.replace(/-/g, '');

  function nextDay(day) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }

  /**
   * @param events  akce ve formátu events.json
   * @param options { name, sourcesById, categoriesById }
   */
  function buildIcs(events, { name, sourcesById, categoriesById }) {
    const now = utcStamp(new Date().toISOString());
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ostopovice-events//CS', 'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`, 'X-WR-TIMEZONE:Europe/Prague',
    ];
    for (const e of events) {
      const source = sourcesById[e.source];
      lines.push('BEGIN:VEVENT', `UID:${e.id}@ostopovice-events`, `DTSTAMP:${now}`);
      if (e.allDay) {
        lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.start)}`, `DTEND;VALUE=DATE:${dateStamp(nextDay(e.end || e.start))}`);
      } else {
        lines.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end || e.start)}`);
      }
      lines.push(`SUMMARY:${escapeText(e.title)}`);
      if (e.cancelled) lines.push('STATUS:CANCELLED');
      if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
      const description = [e.description, source && `Zdroj: ${source.name}`].filter(Boolean).join('\n\n');
      if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
      if (e.url) lines.push(`URL:${e.url}`);
      const labels = (e.categories || []).map((c) => categoriesById[c]?.label || c);
      if (labels.length) lines.push(`CATEGORIES:${labels.map(escapeText).join(',')}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  function downloadIcs(filename, content) {
    const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.IcsExport = { buildIcs, downloadIcs };
})();
