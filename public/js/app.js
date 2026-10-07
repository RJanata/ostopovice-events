'use strict';

// Souhrnný kalendář akcí — vykreslení dat z data/events.json (generuje scripts/collect.js).
// Stav filtrů se drží v URL za # (dá se sdílet odkazem), např.
//   #v=month&z=knihovna,sokol&t=deti&q=jóga&m=2026-11

const TIME_ZONE = 'Europe/Prague';
const LIST_DAYS_STEP = 45; // kolik dní seznam ukáže najednou
const PAST_DAYS_STEP = 60; // o kolik dní zpět posune „Zobrazit proběhlé“
const MONTH_PILLS = 3; // počet řádků s akcemi v buňce měsíce
const MULTI_DAY_LIST_LIMIT = 7; // delší akce se v seznamu neopakují u každého dne

const state = {
  view: 'list',
  sources: null, // Set povolených zdrojů; null = všechny
  categories: null,
  villages: null,
  query: '',
  month: null, // 'YYYY-MM'
  selectedDay: null,
  listFrom: null, // seznam začíná tímto dnem
  listDays: LIST_DAYS_STEP,
};

let data = null;
let sourcesById = {};
let categoriesById = {};
let today = '';

// ---------- Pomocné funkce: datum a text ----------

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('cs-CZ', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });

const dayKey = (date) => dayKeyFormatter.format(date);

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → Date v poledne UTC (bezpečné pro formátování dne). */
function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function formatDay(key, options) {
  return new Intl.DateTimeFormat('cs-CZ', { timeZone: 'UTC', ...options }).format(keyToDate(key));
}

const formatShortDate = (key) => formatDay(key, { day: 'numeric', month: 'numeric' });

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------- Příprava dat ----------

/** Doplní akci o dny, přes které vede, a text pro hledání. */
function prepareEvent(e) {
  let first;
  let last;
  if (e.allDay) {
    first = e.start;
    last = e.end || e.start;
  } else {
    const start = new Date(e.start);
    const end = new Date(e.end || e.start);
    first = dayKey(start);
    // konec přesně o půlnoci už do dalšího dne nepatří
    last = end > start ? dayKey(new Date(end.getTime() - 1)) : first;
  }
  if (last < first) last = first;
  e._first = first;
  e._last = last;
  e._search = normalize(`${e.title} ${e.location} ${e.description}`);
  return e;
}

function eventDays(e) {
  const days = [];
  for (let d = e._first; d <= e._last && days.length < 62; d = addDays(d, 1)) days.push(d);
  return days;
}

const isAllSelected = (set) => set === null;
const isEnabled = (set, id) => set === null || set.has(id);

function matchesFilters(e) {
  const source = sourcesById[e.source];
  if (e.hidden) return false;
  if (!isEnabled(state.sources, e.source)) return false;
  if (source?.display === 'dayLabel') return false;
  if (state.villages && source?.village && !state.villages.has(source.village)) return false;
  if (state.categories && !e.categories.some((c) => state.categories.has(c))) return false;
  if (state.query) {
    const words = normalize(state.query).split(/\s+/).filter(Boolean);
    if (!words.every((w) => e._search.includes(w))) return false;
  }
  return true;
}

/** Popisky dní ze zdrojů typu dayLabel (státní svátky) — zobrazují se vždy, nejsou ve filtru. */
function holidayLabels() {
  const map = new Map();
  for (const e of data.events) {
    if (sourcesById[e.source]?.display !== 'dayLabel') continue;
    for (const d of eventDays(e)) {
      if (!map.has(d)) map.set(d, []);
      if (!map.get(d).includes(e.title)) map.get(d).push(e.title);
    }
  }
  return map;
}

function compareEvents(a, b) {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return String(a.start).localeCompare(String(b.start)) || a.title.localeCompare(b.title, 'cs');
}

// ---------- URL stav ----------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const set = (key) => (p.has(key) ? new Set(p.get(key).split(',').filter(Boolean)) : null);
  state.view = p.get('v') === 'month' ? 'month' : 'list';
  state.sources = set('z');
  state.categories = set('t');
  state.villages = set('o');
  state.query = p.get('q') || '';
  state.month = /^\d{4}-\d{2}$/.test(p.get('m') || '') ? p.get('m') : null;
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.view !== 'list') p.set('v', state.view);
  if (state.sources) p.set('z', [...state.sources].join(','));
  if (state.categories) p.set('t', [...state.categories].join(','));
  if (state.villages) p.set('o', [...state.villages].join(','));
  if (state.query) p.set('q', state.query);
  if (state.view === 'month' && state.month && state.month !== today.slice(0, 7)) p.set('m', state.month);
  const hash = p.toString().replace(/%2C/g, ',');
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

// ---------- Filtry ----------

function sourceIcon(source, small = false) {
  return `<span class="source-icon${small ? ' source-icon--small' : ''}"><img src="icons/${escapeHtml(source.icon)}" alt=""></span>`;
}

function categoryIcon(category) {
  if (!category.icon) return '';
  // url() v CSS proměnné by se vyhodnotila vůči css/style.css → předáme absolutní adresu
  const url = new URL(`icons/categories/${category.icon}`, document.baseURI).href;
  return `<span class="cat-icon" style="--icon:url('${escapeHtml(url)}')"></span>`;
}

/**
 * Výběr ve filtru:
 *   - výchozí je „Vše“ (null) — položky nejsou označené, prochází všechno
 *   - klik na položku při „Vše“ → vybere se jen ona; další kliky položky přidávají/odebírají
 *   - klik na „Vše“, když je označené → „Vše“ se odznačí a označí se všechny položky
 *   - klik na „Vše“, když není označené → zpět na „Vše“
 *   - odznačení poslední položky → zpět na „Vše“
 */
const ALL = '__all__';

function toggleSelection(current, id, allIds) {
  if (id === ALL) return current === null ? new Set(allIds) : null;
  if (current === null) return new Set([id]);
  const set = new Set(current);
  if (set.has(id)) set.delete(id); else set.add(id);
  return set.size ? set : null;
}

function renderChips(container, items, selected, render, onToggle) {
  const allChip = `<button type="button" class="chip chip--all" data-id="${ALL}" aria-pressed="${selected === null}">Vše</button>`;
  container.innerHTML = allChip + items.map((item) => `
    <button type="button" class="chip${item.plain ? ' chip--plain' : ''}" data-id="${escapeHtml(item.id)}"
      aria-pressed="${selected !== null && selected.has(item.id)}" style="--chip-color:${escapeHtml(item.color)}">${render(item)}</button>`).join('');
  container.onclick = (ev) => {
    const chip = ev.target.closest('.chip');
    if (chip) onToggle(chip.dataset.id);
  };
}

function renderFilters() {
  const sources = data.sources.filter((s) => s.display !== 'dayLabel');
  renderChips(document.getElementById('source-filter'), sources, state.sources,
    (s) => `${sourceIcon(s)}<span>${escapeHtml(s.name)}</span>`,
    (id) => { state.sources = toggleSelection(state.sources, id, sources.map((s) => s.id)); update(); });

  const usedCategories = new Set(data.events.flatMap((e) => e.categories));
  const categories = data.categories.filter((c) => usedCategories.has(c.id));
  renderChips(document.getElementById('category-filter'), categories, state.categories,
    (c) => `${categoryIcon(c)}<span>${escapeHtml(c.label)}</span>`,
    (id) => { state.categories = toggleSelection(state.categories, id, categories.map((c) => c.id)); update(); });

  // filtr obcí se ukáže, až budou zdroje z víc obcí
  const villages = [...new Set(sources.map((s) => s.village).filter(Boolean))];
  const villageRow = document.getElementById('village-row');
  villageRow.hidden = villages.length < 2;
  if (villages.length >= 2) {
    renderChips(document.getElementById('village-filter'), villages.map((v) => ({ id: v, color: 'var(--accent)', plain: true })), state.villages,
      (v) => `<span>${escapeHtml(v.id)}</span>`,
      (id) => { state.villages = toggleSelection(state.villages, id, villages); update(); });
  }

  document.querySelectorAll('.view-switch button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  });
  const search = document.getElementById('search');
  if (search.value !== state.query) search.value = state.query;
  document.getElementById('reset-filters').hidden = !(state.sources || state.categories || state.villages || state.query);
}

// ---------- Karta akce ----------

function timeLabel(e, day) {
  if (e.allDay) {
    if (e._first === e._last) return 'celý den';
    return `celý den<small>${formatShortDate(e._first)} – ${formatShortDate(e._last)}</small>`;
  }
  const start = new Date(e.start);
  const end = new Date(e.end || e.start);
  if (e._first !== e._last) {
    const from = day === e._first ? timeFormatter.format(start) : `od ${formatShortDate(e._first)}`;
    return `${from}<small>do ${formatShortDate(e._last)} ${timeFormatter.format(end)}</small>`;
  }
  const endText = end > start ? `<small>– ${timeFormatter.format(end)}</small>` : '';
  return `${timeFormatter.format(start)}${endText}`;
}

function eventCard(e, day) {
  const source = sourcesById[e.source] || { name: e.source, color: '#888', icon: 'test.svg' };
  const tags = e.categories
    .map((id) => categoriesById[id])
    .filter(Boolean)
    .map((c) => `<span class="tag" style="--chip-color:${escapeHtml(c.color)}">${categoryIcon(c)}${escapeHtml(c.label)}</span>`)
    .join('');
  const title = e.url
    ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>`
    : escapeHtml(e.title);
  const alsoIn = (e.alsoIn || []).map((id) => sourcesById[id]?.name).filter(Boolean);
  const description = e.description && normalize(e.description) !== normalize(e.title)
    ? `<details class="event__details"><summary>Podrobnosti</summary><p>${escapeHtml(e.description)}</p></details>` : '';
  const classes = ['event', e.cancelled && 'event--cancelled', e._last < today && 'event--past'].filter(Boolean).join(' ');

  return `
    <article class="${classes}" style="--icon-color:${escapeHtml(source.color)}">
      <div class="event__time">${timeLabel(e, day)}</div>
      <div class="event__body">
        <h3 class="event__title">${title}</h3>
        ${e.note ? `<p class="event__note">${escapeHtml(e.note)}</p>` : ''}
        <div class="event__meta">
          <span class="event__source">${sourceIcon(source, true)}${escapeHtml(source.name)}${alsoIn.length ? ` (i ${escapeHtml(alsoIn.join(', '))})` : ''}</span>
          ${e.location ? `<span>${escapeHtml(e.location)}</span>` : ''}
          <span class="event__tags">${tags}</span>
        </div>
        ${description}
      </div>
    </article>`;
}

function dayHeading(day, holidays) {
  let relative = '';
  if (day === today) relative = 'Dnes';
  else if (day === addDays(today, 1)) relative = 'Zítra';
  else if (day === addDays(today, -1)) relative = 'Včera';
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const label = formatDay(day, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
  const holiday = holidays.get(day);
  return `<h2 class="day__heading">
      ${relative ? `<span class="day__relative">${relative}</span>` : ''}
      <span>${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</span>
      ${holiday ? `<span class="day__holiday">${escapeHtml(holiday.join(' · '))}</span>` : ''}
    </h2>`;
}

// ---------- Zobrazení: seznam ----------

/** Akce rozdělené po dnech v rozsahu from–to; dny se svátkem i bez akcí. */
function groupByDay(events, from, to, holidays, { holidayDays = true } = {}) {
  const byDay = new Map();

  const addTo = (day, e) => {
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  };
  for (const e of events) {
    if (e._last < from || e._first > to) continue;
    const days = eventDays(e).filter((d) => d >= from && d <= to);
    if (days.length <= MULTI_DAY_LIST_LIMIT) {
      // vícedenní akce (např. volby v pátek a sobotu) se ukáže u každého dne
      days.forEach((d) => addTo(d, e));
    } else {
      // dlouhé akce (výstavy apod.) jen u prvního zobrazeného dne
      addTo(days[0], e);
    }
  }

  if (holidayDays) {
    for (const day of holidays.keys()) {
      if (day >= from && day <= to && !byDay.has(day)) byDay.set(day, []);
    }
  }
  return byDay;
}

function renderDays(byDay, holidays) {
  return [...byDay.keys()].sort().map((day) => {
    const list = byDay.get(day).sort(compareEvents);
    return `<section class="day${list.length ? '' : ' day--empty'}">${dayHeading(day, holidays)}${list.map((e) => eventCard(e, day)).join('')}</section>`;
  }).join('');
}

function renderList(events, holidays) {
  const from = state.listFrom || today;
  // při hledání ukázat všechny nalezené akce, i ty za mnoho měsíců
  const to = state.query
    ? events.reduce((max, e) => (e._last > max ? e._last : max), from)
    : addDays(from, state.listDays);
  const byDay = groupByDay(events, from, to, holidays, { holidayDays: !state.query });

  const days = [...byDay.keys()].sort();
  const later = events.filter((e) => e._first > to).length;
  const hasPast = events.some((e) => e._first < from);

  let html = '';
  if (hasPast) {
    html += `<div class="more"><button type="button" class="button button--ghost" data-action="past">Zobrazit proběhlé akce</button></div>`;
  }
  if (!days.some((d) => byDay.get(d).length)) {
    html += `<p class="empty">${events.length ? 'V tomto období žádné akce nejsou.' : 'Filtrům neodpovídá žádná akce.'}</p>`;
  }
  html += renderDays(byDay, holidays);
  if (later) {
    html += `<div class="more"><button type="button" class="button button--ghost" data-action="later">Zobrazit další akce (${later})</button></div>`;
  }
  return html;
}

// ---------- Zobrazení: měsíc ----------

function renderMonth(events, holidays) {
  const month = state.month || today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const firstOfMonth = `${month}-01`;
  const weekday = (keyToDate(firstOfMonth).getUTCDay() + 6) % 7; // pondělí = 0
  const gridStart = addDays(firstOfMonth, -weekday);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = Math.ceil((weekday + daysInMonth) / 7);
  const gridEnd = addDays(gridStart, weeks * 7 - 1);

  const byDay = new Map();
  const inGrid = events.filter((e) => e._last >= gridStart && e._first <= gridEnd);
  for (const e of inGrid) {
    for (const d of eventDays(e)) {
      if (d < gridStart || d > gridEnd) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(e);
    }
  }

  // vybraný den může být i z okrajových týdnů (konec minulého / začátek dalšího měsíce)
  // bez vybraného dne se pod kalendářem vypíše celý měsíc
  const selected = state.selectedDay && state.selectedDay >= gridStart && state.selectedDay <= gridEnd ? state.selectedDay : null;

  const weekdayNames = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
  let weeksHtml = '';
  for (let w = 0; w < weeks; w++) {
    const weekStart = addDays(gridStart, w * 7);
    const weekEnd = addDays(weekStart, 6);
    const colOf = (d) => Math.round((keyToDate(d) - keyToDate(weekStart)) / 864e5);

    // akce v týdnu jako pruhy: začátek, konec (sloupce 0–6), pokračování z/do jiného týdne
    const items = inGrid
      .filter((e) => e._last >= weekStart && e._first <= weekEnd)
      .map((e) => ({
        e,
        from: colOf(e._first < weekStart ? weekStart : e._first),
        to: colOf(e._last > weekEnd ? weekEnd : e._last),
        before: e._first < weekStart,
        after: e._last > weekEnd,
      }))
      .sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || compareEvents(a.e, b.e));

    // rozdělení do řádků (pruhů) tak, aby se nepřekrývaly; co se nevejde → „+ N další“
    const lanes = [];
    const hiddenCount = Array(7).fill(0);
    let bars = '';
    for (const item of items) {
      let lane = lanes.findIndex((used) => used.slice(item.from, item.to + 1).every((x) => !x));
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(Array(7).fill(false));
      }
      if (lane >= MONTH_PILLS) {
        for (let c = item.from; c <= item.to; c++) hiddenCount[c] += 1;
        continue;
      }
      for (let c = item.from; c <= item.to; c++) lanes[lane][c] = true;
      const { e } = item;
      const src = sourcesById[e.source] || {};
      const time = e.allDay || item.before ? '' : `${timeFormatter.format(new Date(e.start))} `;
      const classes = ['month__pill',
        item.to > item.from && 'month__pill--multi',
        item.before && 'month__pill--before',
        item.after && 'month__pill--after',
        e.cancelled && 'month__pill--cancelled'].filter(Boolean).join(' ');
      bars += `<span class="${classes}" style="grid-column:${item.from + 1} / ${item.to + 2};grid-row:${lane + 2};--icon-color:${escapeHtml(src.color)}" title="${escapeHtml(time + e.title)}">`
        + `${sourceIcon(src)}<span>${escapeHtml(time + e.title)}</span></span>`;
    }

    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const list = byDay.get(d) || [];
      const holiday = holidays.get(d);
      const classes = ['month__day',
        !d.startsWith(month) && 'month__day--other',
        d === today && 'month__day--today',
        holiday && 'month__day--holiday',
        d === selected && 'month__day--selected'].filter(Boolean).join(' ');
      const more = hiddenCount[i] ? `<span class="month__more">+ ${hiddenCount[i]} další</span>` : '';
      const dots = list.length ? `<span class="month__dots">${list.slice(0, 6).map((e) => `<i style="--icon-color:${escapeHtml(sourcesById[e.source]?.color || '#888')}"></i>`).join('')}</span>` : '';
      const label = `${formatDay(d, { weekday: 'long', day: 'numeric', month: 'long' })}: ${list.length} akcí`;
      cells += `<button type="button" class="${classes}" data-day="${d}" aria-label="${escapeHtml(label)}" style="grid-column:${i + 1}">
          <span class="month__day-head">
            <span class="month__day-number">${Number(d.slice(8))}</span>
            ${holiday ? `<span class="month__day-holiday" title="${escapeHtml(holiday.join(' · '))}">${escapeHtml(holiday.join(' · '))}</span>` : ''}
          </span>
          ${dots}${more}
        </button>`;
    }
    weeksHtml += `<div class="month__week">${cells}${bars}</div>`;
  }
  const weekdaysHtml = `<div class="month__weekdays">${weekdayNames.map((n) => `<div class="month__weekday">${n}</div>`).join('')}</div>`;

  const title = formatDay(firstOfMonth, { month: 'long', year: 'numeric' });
  let selectedHtml;
  if (selected) {
    const list = (byDay.get(selected) || []).sort(compareEvents);
    selectedHtml = `<section class="day month__selected" id="selected-day">${dayHeading(selected, holidays)}`
      + (list.length ? list.map((e) => eventCard(e, selected)).join('') : '<p class="empty">Tento den žádné akce nejsou.</p>')
      + `<div class="more"><button type="button" class="button button--ghost" data-action="whole-month">Zobrazit celý ${escapeHtml(formatDay(firstOfMonth, { month: 'long' }))}</button></div>`
      + '</section>';
  } else {
    const lastOfMonth = addDays(firstOfMonth, daysInMonth - 1);
    const monthDays = groupByDay(events, firstOfMonth, lastOfMonth, holidays);
    const hasEvents = [...monthDays.values()].some((list) => list.length);
    selectedHtml = `<div class="month__selected" id="selected-day">`
      + (hasEvents ? renderDays(monthDays, holidays) : '<p class="empty">V tomto měsíci žádné akce nejsou.</p>')
      + '</div>';
  }

  return `
    <div class="month">
      <div class="month__nav">
        <h2>${escapeHtml(title)}</h2>
        <div class="month__nav-buttons">
          <button type="button" class="icon-button" data-action="prev-month" aria-label="Předchozí měsíc">‹</button>
          <button type="button" class="icon-button icon-button--text" data-action="this-month">Dnes</button>
          <button type="button" class="icon-button" data-action="next-month" aria-label="Další měsíc">›</button>
        </div>
      </div>
      <div class="month__grid">${weekdaysHtml}${weeksHtml}</div>
      ${selectedHtml}
    </div>`;
}

function shiftMonth(delta) {
  const [y, m] = (state.month || today.slice(0, 7)).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  state.month = date.toISOString().slice(0, 7);
  state.selectedDay = null;
}

// ---------- Stažení výběru jako .ics ----------

const isFilterActive = () => Boolean(state.sources || state.categories || state.villages || state.query);

function filterDescription() {
  const parts = [];
  if (state.sources) parts.push(`zdroje: ${[...state.sources].map((id) => sourcesById[id]?.name || id).join(', ')}`);
  if (state.categories) parts.push(`typ: ${[...state.categories].map((id) => categoriesById[id]?.label || id).join(', ')}`);
  if (state.villages) parts.push(`obec: ${[...state.villages].join(', ')}`);
  if (state.query) parts.push(`hledání: „${state.query}“`);
  return parts.join(' · ');
}

const filteredUpcoming = () => data.events.filter((e) => matchesFilters(e) && e._last >= today);

function downloadFiltered() {
  const events = filteredUpcoming();
  const ics = window.IcsExport.buildIcs(events, {
    name: `${data.calendarName} (${filterDescription()})`, sourcesById, categoriesById,
  });
  window.IcsExport.downloadIcs('akce-ostopovice-vyber.ics', ics);
}

// ---------- Hlavní vykreslení ----------

function update({ keepHash = false } = {}) {
  if (!keepHash) writeHash();
  renderFilters();
  const events = data.events.filter(matchesFilters);
  const holidays = holidayLabels();
  const upcoming = events.filter((e) => e._last >= today).length;
  document.getElementById('result-count').textContent = `${upcoming} nadcházejících akcí`;
  const downloadButton = document.getElementById('download-filtered');
  downloadButton.hidden = !isFilterActive() || !upcoming;
  refreshSubscribePanel?.();
  document.getElementById('view').innerHTML = state.view === 'month' ? renderMonth(events, holidays) : renderList(events, holidays);
}

function renderStatus() {
  const failed = data.sources.filter((s) => s.ok === false);
  const box = document.getElementById('status');
  if (!failed.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = failed.map((s) => {
    const since = s.lastSuccess ? ` Zobrazujeme data z ${new Date(s.lastSuccess).toLocaleString('cs-CZ', { timeZone: TIME_ZONE })}.` : '';
    return `<div>Zdroj <strong>${escapeHtml(s.name)}</strong> se při poslední aktualizaci nepodařilo načíst.${since}</div>`;
  }).join('');
}

function renderFooter() {
  document.getElementById('generated-at').textContent = new Date(data.generatedAt)
    .toLocaleString('cs-CZ', { timeZone: TIME_ZONE, day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  document.getElementById('source-links').innerHTML = data.sources
    .map((s) => (s.link ? `<a href="${escapeHtml(s.link)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>` : escapeHtml(s.name)))
    .join(', ');
}

/** Odběr kalendáře: celý, nebo jen vybrané kategorie (každá má vlastní .ics). */
let refreshSubscribePanel = null;

function setupSubscribe() {
  const link = document.getElementById('subscribe-link');
  let panel = null;
  link.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (panel) { panel.remove(); panel = null; refreshSubscribePanel = null; return; }
    panel = document.getElementById('subscribe-help').content.firstElementChild.cloneNode(true);

    const usedCategories = new Set(data?.events.flatMap((e) => e.categories) || []);
    const calendars = [{ label: 'Všechny akce', file: 'akce.ics', all: true }]
      .concat((data?.categories || [])
        .filter((c) => usedCategories.has(c.id) && c.id !== 'ostatni')
        .map((c) => ({ label: c.label, file: `akce-${c.id}.ics`, category: c })));

    refreshSubscribePanel = () => {
      if (!panel) return;
      const filtered = panel.querySelector('.subscribe-help__filtered');
      filtered.hidden = !isFilterActive();
      if (isFilterActive()) {
        const count = filteredUpcoming().length;
        panel.querySelector('.subscribe-help__filter-text').textContent = `${filterDescription()} (${count} nadcházejících akcí)`;
        panel.querySelector('[data-download-filtered]').disabled = !count;
      }
    };
    refreshSubscribePanel();

    panel.querySelector('.subscribe-help__list').innerHTML = calendars.map((cal) => {
      const url = new URL(`data/${cal.file}`, location.href).href;
      const icon = cal.category ? `<span class="tag" style="--chip-color:${escapeHtml(cal.category.color)}">${categoryIcon(cal.category)}${escapeHtml(cal.label)}</span>`
        : `<strong>${escapeHtml(cal.label)}</strong>`;
      const highlighted = cal.category && state.categories?.has(cal.category.id);
      return `<li class="${highlighted ? 'is-highlighted' : ''}">
          <span class="subscribe-help__name">${icon}</span>
          <a class="button button--small" href="${escapeHtml(url.replace(/^https?:/, 'webcal:'))}">Přidat</a>
          <button type="button" class="button button--small button--ghost" data-copy="${escapeHtml(url)}">Kopírovat odkaz</button>
        </li>`;
    }).join('');

    panel.addEventListener('click', async (e) => {
      if (e.target.closest('[data-download-filtered]')) { downloadFiltered(); return; }
      const button = e.target.closest('[data-copy]');
      if (!button) return;
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = 'Zkopírováno ✓';
      } catch {
        window.prompt('Zkopírujte adresu kalendáře:', button.dataset.copy);
      }
    });
    document.querySelector('.site-header .wrap').append(panel);
  });
}

function setupThemeToggle() {
  const button = document.getElementById('theme-toggle');
  const sync = () => button.setAttribute('aria-pressed', String(document.documentElement.getAttribute('data-theme') === 'dark'));
  sync();
  button.addEventListener('click', () => { window.toggleTheme(); sync(); });
}

function setupEvents() {
  document.querySelector('.view-switch').addEventListener('click', (ev) => {
    const button = ev.target.closest('button[data-view]');
    if (!button) return;
    state.view = button.dataset.view;
    update();
  });

  let searchTimer;
  document.getElementById('search').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = ev.target.value.trim(); update(); }, 150);
  });

  document.getElementById('download-filtered').addEventListener('click', downloadFiltered);

  document.getElementById('reset-filters').addEventListener('click', () => {
    state.sources = null;
    state.categories = null;
    state.villages = null;
    state.query = '';
    update();
  });

  document.getElementById('view').addEventListener('click', (ev) => {
    const action = ev.target.closest('[data-action]')?.dataset.action;
    const dayButton = ev.target.closest('[data-day]');
    if (action === 'past') {
      state.listFrom = addDays(state.listFrom || today, -PAST_DAYS_STEP);
      state.listDays += PAST_DAYS_STEP;
      update({ keepHash: true });
    } else if (action === 'later') {
      state.listDays += LIST_DAYS_STEP;
      update({ keepHash: true });
    } else if (action === 'prev-month' || action === 'next-month') {
      shiftMonth(action === 'prev-month' ? -1 : 1);
      update();
    } else if (action === 'this-month') {
      state.month = null;
      state.selectedDay = null;
      update();
    } else if (action === 'whole-month') {
      state.selectedDay = null;
      update({ keepHash: true });
    } else if (dayButton) {
      state.selectedDay = state.selectedDay === dayButton.dataset.day ? null : dayButton.dataset.day;
      update({ keepHash: true });
      // posouvat jen při výběru dne; po zrušení výběru zůstat u kalendáře
      if (state.selectedDay) document.getElementById('selected-day')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  window.addEventListener('hashchange', () => { readHash(); update({ keepHash: true }); });
}

async function init() {
  today = dayKey(new Date());
  readHash();
  setupEvents();
  setupSubscribe();
  setupThemeToggle();
  try {
    const response = await fetch('data/events.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (err) {
    document.getElementById('view').innerHTML = `<p class="empty">Akce se nepodařilo načíst (${escapeHtml(err.message)}).</p>`;
    return;
  }
  sourcesById = Object.fromEntries(data.sources.map((s) => [s.id, s]));
  categoriesById = Object.fromEntries(data.categories.map((c) => [c.id, c]));
  data.events.forEach(prepareEvent);
  renderStatus();
  renderFooter();
  update({ keepHash: true });
}

init();
