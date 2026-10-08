'use strict';

// Souhrnný kalendář akcí — vykreslení dat z data/events.json (generuje scripts/collect.js).
// Stav filtrů se drží v URL za # (dá se sdílet odkazem), např.
//   #v=month&z=knihovna,sokol&t=deti&q=jóga&m=2026-11

const TIME_ZONE = 'Europe/Prague';
const LIST_DAYS_STEP = 45; // kolik dní seznam ukáže najednou
const PAST_DAYS_STEP = 60; // o kolik dní zpět posune „Zobrazit proběhlé“
const MONTH_PILLS = 4; // počet řádků s akcemi v buňce měsíce (při víc akcích 3 + „+ N další“)
const MULTI_DAY_LIST_LIMIT = 7; // delší akce se v seznamu neopakují u každého dne
const LONG_EVENT_DAYS = 8; // od této délky je akce „dlouhodobá“ (výstavy): v měsíci tenká čára, ve výpisu zvlášť

const state = {
  showCalendar: true, // kalendář nad seznamem (seznam je vždy)
  sources: null, // Set povolených zdrojů; null = všechny
  categories: null,
  villages: null,
  query: '',
  month: null, // 'YYYY-MM'
  selectedDay: null,
  pastDays: 0, // o kolik dní před začátkem seznamu ukázat proběhlé akce („Zobrazit proběhlé“)
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
  e._span = eventDays(e).length;
  e._long = !e.recurring && e._span >= LONG_EVENT_DAYS;
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


/** Na mobilu (úzký kalendář s tečkami) se jako čára kreslí už akce od 2 dnů. */
const MOBILE_LINE_DAYS = 2;
const narrowScreen = window.matchMedia('(max-width: 640px)');
const isMonthLine = (e) => !e.recurring && e._span >= (narrowScreen.matches ? MOBILE_LINE_DAYS : LONG_EVENT_DAYS);

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const set = (key) => (p.has(key) ? new Set(p.get(key).split(',').filter(Boolean)) : null);
  // k=0 = kalendář skrytý (v=list = starší odkazy na seznam)
  state.showCalendar = p.get('k') !== '0' && p.get('v') !== 'list';
  state.sources = set('z');
  state.categories = set('t');
  state.villages = set('o');
  state.query = p.get('q') || '';
  state.month = /^\d{4}-\d{2}$/.test(p.get('m') || '') ? p.get('m') : null;
}

function writeHash() {
  const p = new URLSearchParams();
  if (!state.showCalendar) p.set('k', '0');
  if (state.sources) p.set('z', [...state.sources].join(','));
  if (state.categories) p.set('t', [...state.categories].join(','));
  if (state.villages) p.set('o', [...state.villages].join(','));
  if (state.query) p.set('q', state.query);
  if (state.showCalendar && state.month && state.month !== today.slice(0, 7)) p.set('m', state.month);
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
 *   - výchozí je „Vše“ (null) — prochází všechno
 *   - klik na položku → vybere se jen ona (přepíná se mezi položkami);
 *     druhý klik na jedinou vybranou položku → zpět na „Vše“ (když je tlačítko Vše skryté)
 *   - Ctrl/⌘ + klik → položka se k výběru přidá, nebo z něj odebere;
 *     při „Vše“ se tak vybere všechno kromě této položky
 *   - klik na „Vše“ → zpět na všechno
 *   - když přes Ctrl zůstane vybráno nic, nebo zase všechno → zpět na „Vše“
 */
const ALL = '__all__';

function toggleSelection(current, id, multi, allIds) {
  if (id === ALL) return null;
  if (!multi) return current?.size === 1 && current.has(id) ? null : new Set([id]);
  const set = new Set(current ?? allIds);
  if (set.has(id)) set.delete(id); else set.add(id);
  return set.size && set.size < allIds.length ? set : null;
}

function renderChips(container, items, selected, render, onToggle) {
  const allChip = `<button type="button" class="chip chip--all" data-id="${ALL}" aria-pressed="${selected === null}"><span class="chip__label">Vše</span></button>`;
  container.innerHTML = allChip + items.map((item) => `
    <button type="button" class="chip${item.plain ? ' chip--plain' : ''}" data-id="${escapeHtml(item.id)}"
      aria-pressed="${selected !== null && selected.has(item.id)}" style="--chip-color:${escapeHtml(item.color)}"
      aria-label="${escapeHtml(item.label || item.name || item.id)}"
      title="${escapeHtml(item.label || item.name || item.id)} – Ctrl + klik: přidat k výběru / odebrat z výběru">${render(item)}</button>`).join('');
  // souhrn výběru pod štítky (vidět jen v úrovni „jen ikony“, viz fitFilters)
  const summary = container.nextElementSibling;
  if (summary?.classList.contains('chips__selected')) {
    summary.textContent = selected === null ? '' // „Vše“ je vidět přímo na tlačítku
      : items.filter((item) => selected.has(item.id)).map((item) => item.label || item.name || item.id).join(', ');
  }
  container.onclick = (ev) => {
    const chip = ev.target.closest('.chip');
    if (chip) onToggle(chip.dataset.id, ev.ctrlKey || ev.metaKey);
  };
}

const wrapsToMoreLines = (container) => {
  const chips = [...container.children].filter((chip) => chip.offsetParent); // skryté (Vše) nepočítat
  return chips.length > 1 && chips[chips.length - 1].offsetTop > chips[0].offsetTop + 2;
};

/**
 * Úrovně zhuštění filtrů, od nejvolnější. Použije se první, při které se všechny řady
 * štítků vejdou na jeden řádek (pro všechny řady stejná, aby nadpisy vypadaly jednotně).
 *   top   — nadpisy (Zdroj, Kategorie) nad štítky místo vlevo
 *   short — krátké názvy (Obec, Knihovna, Děti…)
 *   icons — jen ikony, pod řadou malý souhrn výběru
 */
const FILTER_LEVELS = [
  [],
  ['short'],
  ['top', 'short'],
  ['icons'],
  ['top', 'icons'],
];

function fitFilters() {
  const filters = document.querySelector('.filters');
  const rows = [...filters.querySelectorAll('.chips')].filter((c) => c.offsetParent);
  if (!rows.length) return;
  for (const [index, level] of FILTER_LEVELS.entries()) {
    filters.classList.toggle('filters--top', level.includes('top'));
    filters.classList.toggle('filters--short', level.includes('short'));
    filters.classList.toggle('filters--icons', level.includes('icons'));
    if (index === FILTER_LEVELS.length - 1 || !rows.some(wrapsToMoreLines)) return;
  }
}

function renderFilters() {
  const sources = data.sources.filter((s) => s.display !== 'dayLabel');
  renderChips(document.getElementById('source-filter'), sources, state.sources,
    (s) => `${sourceIcon(s)}<span class="chip__label">${escapeHtml(s.name)}</span><span class="chip__label-short">${escapeHtml(s.shortName || s.name)}</span>`,
    (id, multi) => { state.sources = toggleSelection(state.sources, id, multi, sources.map((s) => s.id)); update(); });

  const usedCategories = new Set(data.events.flatMap((e) => e.categories));
  const categories = data.categories.filter((c) => usedCategories.has(c.id));
  renderChips(document.getElementById('category-filter'), categories, state.categories,
    (c) => `${categoryIcon(c)}<span class="chip__label">${escapeHtml(c.label)}</span><span class="chip__label-short">${escapeHtml(c.shortLabel || c.label)}</span>`,
    (id, multi) => { state.categories = toggleSelection(state.categories, id, multi, categories.map((c) => c.id)); update(); });

  // filtr obcí se ukáže, až budou zdroje z víc obcí
  const villages = [...new Set(sources.map((s) => s.village).filter(Boolean))];
  const villageRow = document.getElementById('village-row');
  villageRow.hidden = villages.length < 2;
  if (villages.length >= 2) {
    renderChips(document.getElementById('village-filter'), villages.map((v) => ({ id: v, color: 'var(--accent)', plain: true })), state.villages,
      (v) => `<span>${escapeHtml(v.id)}</span>`,
      (id, multi) => { state.villages = toggleSelection(state.villages, id, multi, villages); update(); });
  }
  fitFilters();

  document.querySelectorAll('#calendar-toggle').forEach((b) => {
    b.setAttribute('aria-pressed', String(state.showCalendar));
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
        <div class="event__meta">
          <span class="event__source">${sourceIcon(source, true)}${escapeHtml(source.name)}${alsoIn.length ? ` (i ${escapeHtml(alsoIn.join(', '))})` : ''}</span>
          ${e.location ? `<span>📍 ${escapeHtml(e.location)}</span>` : ''}
          <span class="event__tags">${tags}</span>
        </div>
        ${e.note ? `<p class="event__note">${escapeHtml(e.note)}</p>` : ''}
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
    if (e._long || e._last < from || e._first > to) continue;
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

/**
 * Karty akcí jednoho dne. Pravidelné akce (cvičení, kurzy…) jsou sbalené do jednoho
 * řádku na konci dne; při hledání se rozbalí, aby bylo vidět, co se našlo.
 */
function dayEvents(list, day) {
  const sorted = [...list].sort(compareEvents);
  const single = sorted.filter((e) => !e.recurring);
  const regular = sorted.filter((e) => e.recurring);
  let html = single.map((e) => eventCard(e, day)).join('');
  if (regular.length) {
    const names = [...new Set(regular.map((e) => e.title))].join(', ');
    html += `<details class="day__regular"${state.query ? ' open' : ''}>
        <summary>Pravidelné (${regular.length}): ${escapeHtml(names)}</summary>
        ${regular.map((e) => eventCard(e, day)).join('')}
      </details>`;
  }
  return html;
}

/** Sbalený řádek s dlouhodobými akcemi (výstavy…), které v období from–to probíhají. */
function longEventsBlock(events, from, to) {
  const list = events.filter((e) => e._long && e._last >= from && e._first <= to).sort(compareEvents);
  if (!list.length) return '';
  return `<details class="day__regular day__long"${state.query ? ' open' : ''}>
      <summary>Dlouhodobé (${list.length}): ${escapeHtml(list.map((e) => e.title).join(', '))}</summary>
      ${list.map((e) => eventCard(e, e._first < from ? from : e._first)).join('')}
    </details>`;
}

function renderDays(byDay, holidays) {
  return [...byDay.keys()].sort().map((day) => {
    const list = byDay.get(day);
    const classes = ['day', !list.length && 'day--empty', day === state.selectedDay && 'day--selected'].filter(Boolean).join(' ');
    const empty = !list.length && day === state.selectedDay ? '<p class="empty">Tento den žádné akce nejsou.</p>' : '';
    return `<section class="${classes}" id="day-${day}">${dayHeading(day, holidays)}${dayEvents(list, day)}${empty}</section>`;
  }).join('');
}

/**
 * Začátek seznamu podle kalendáře: aktuální měsíc (nebo skrytý kalendář) → od dneška,
 * jiný zobrazený měsíc (dopředu i dozadu) → od jeho prvního dne.
 */
function listStart() {
  const month = state.showCalendar && state.month;
  return month && month !== today.slice(0, 7) ? `${month}-01` : today;
}

/** Seznam jediného dne vybraného v kalendáři. */
function renderSelectedDay(events, holidays) {
  const day = state.selectedDay;
  const byDay = groupByDay(events, day, day, holidays);
  if (!byDay.has(day)) byDay.set(day, []);
  return longEventsBlock(events, day, day)
    + renderDays(byDay, holidays)
    + `<div class="more"><button type="button" class="button button--ghost" data-action="clear-day">Zobrazit všechny akce</button></div>`;
}

function renderList(events, holidays) {
  if (state.selectedDay) return renderSelectedDay(events, holidays);
  const from = addDays(listStart(), -state.pastDays);
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
  const longBlock = longEventsBlock(events, from, to);
  html += longBlock;
  if (!longBlock && !days.some((d) => byDay.get(d).length)) {
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
  // dlouhodobé akce: každá dostane jednu výšku čáry pro celý měsíc (aby mezi týdny „neskákala“)
  const longLane = new Map();
  const laneEnds = [];
  for (const e of inGrid.filter(isMonthLine).sort((a, b) => a._first.localeCompare(b._first) || compareEvents(a, b))) {
    let lane = laneEnds.findIndex((end) => end < e._first);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = e._last;
    longLane.set(e, lane);
  }

  for (let w = 0; w < weeks; w++) {
    const weekStart = addDays(gridStart, w * 7);
    const weekEnd = addDays(weekStart, 6);
    const colOf = (d) => Math.round((keyToDate(d) - keyToDate(weekStart)) / 864e5);

    // akce v týdnu jako pruhy: začátek, konec (sloupce 0–6), pokračování z/do jiného týdne
    // dlouhodobé akce = tenké čáry v řádku s čísly dnů (za čísly); víc souběžných nad sebou
    const longItems = inGrid.filter((e) => isMonthLine(e) && e._last >= weekStart && e._first <= weekEnd).sort(compareEvents);
    let longLines = '';
    longItems.forEach((e) => {
      const from = colOf(e._first < weekStart ? weekStart : e._first);
      const to = colOf(e._last > weekEnd ? weekEnd : e._last);
      const classes = ['month__long', e._first < weekStart && 'month__long--before', e._last > weekEnd && 'month__long--after'].filter(Boolean).join(' ');
      const offset = longLane.get(e) * 4; // víc souběžných pod sebou
      longLines += `<span class="${classes}" style="grid-column:${from + 1} / ${to + 2};grid-row:1;top:${offset}px;--icon-color:${escapeHtml(sourcesById[e.source]?.color || '#888')}" title="${escapeHtml(`${e.title} (${formatShortDate(e._first)} – ${formatShortDate(e._last)})`)}"></span>`;
    });

    const items = inGrid
      .filter((e) => !e.recurring && !isMonthLine(e) && e._last >= weekStart && e._first <= weekEnd)
      .map((e) => ({
        e,
        from: colOf(e._first < weekStart ? weekStart : e._first),
        to: colOf(e._last > weekEnd ? weekEnd : e._last),
        before: e._first < weekStart,
        after: e._last > weekEnd,
      }))
      .sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || compareEvents(a.e, b.e));

    // rozdělení do řádků (pruhů) tak, aby se nepřekrývaly
    const lanes = [];
    for (const item of items) {
      let lane = lanes.findIndex((used) => used.slice(item.from, item.to + 1).every((x) => !x));
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(Array(7).fill(false));
      }
      for (let c = item.from; c <= item.to; c++) lanes[lane][c] = true;
      item.lane = lane;
    }
    // den s víc akcemi, než je řádků: poslední řádek uvolnit pro „+ N další“;
    // když se akce vejdou přesně, ukážou se všechny (4 akce = 4 řádky, žádné „+1“)
    const overflowCol = Array.from({ length: 7 }, (_, c) => lanes.filter((used) => used[c]).length > MONTH_PILLS);
    const isVisible = (item) => item.lane < MONTH_PILLS - 1
      || (item.lane === MONTH_PILLS - 1 && !overflowCol.slice(item.from, item.to + 1).some(Boolean));
    const hiddenCount = Array(7).fill(0);
    let bars = '';
    for (const item of items) {
      if (!isVisible(item)) {
        for (let c = item.from; c <= item.to; c++) hiddenCount[c] += 1;
        continue;
      }
      const { lane } = item;
      const { e } = item;
      const src = sourcesById[e.source] || {};
      const time = e.allDay || item.before ? '' : `${timeFormatter.format(new Date(e.start))} `;
      const classes = ['month__pill',
        item.to > item.from && 'month__pill--multi',
        item.before && 'month__pill--before',
        item.after && 'month__pill--after',
        e.cancelled && 'month__pill--cancelled'].filter(Boolean).join(' ');
      // v buňce kalendáře krátký název (bez společného prefixu zdroje), v bublině plný
      bars += `<span class="${classes}" data-event-id="${escapeHtml(e.id)}" style="grid-column:${item.from + 1} / ${item.to + 2};grid-row:${lane + 2};--icon-color:${escapeHtml(src.color)}">`
        + `${sourceIcon(src)}<span>${escapeHtml(time + (e.shortTitle || e.title))}</span></span>`;
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
      // „+ N další“ na místě posledního řádku akcí (pod buňkou je klikací den)
      if (hiddenCount[i]) {
        bars += `<span class="month__more" style="grid-column:${i + 1};grid-row:${MONTH_PILLS + 1}">+ ${hiddenCount[i]} další</span>`;
      }
      const single = list.filter((e) => !e.recurring && !isMonthLine(e));
      const regular = list.filter((e) => e.recurring);
      // tečky (jen na mobilu): plné = jednorázové akce, obrysové = pravidelné
      const dotFor = (e, cls = '') => `<i${cls ? ` class="${cls}"` : ''} style="--icon-color:${escapeHtml(sourcesById[e.source]?.color || '#888')}"></i>`;
      const dots = single.length || regular.length
        ? `<span class="month__dots">${single.slice(0, 6).map((e) => dotFor(e)).join('')}${regular.slice(0, 3).map((e) => dotFor(e, 'is-regular')).join('')}</span>`
        : '';
      const regularMarks = regular.length
        ? `<span class="month__regular" title="${escapeHtml(`Pravidelné: ${[...new Set(regular.map((e) => e.title))].join(', ')}`)}">`
          + `${regular.slice(0, 3).map((e) => sourceIcon(sourcesById[e.source] || { icon: 'nezarazene.svg' }, true)).join('')}`
          + `${regular.length > 3 ? `<small>+${regular.length - 3}</small>` : ''}</span>`
        : '';
      const label = `${formatDay(d, { weekday: 'long', day: 'numeric', month: 'long' })}: ${list.length} akcí`;
      cells += `<button type="button" class="${classes}" data-day="${d}" aria-label="${escapeHtml(label)}" style="grid-column:${i + 1}">
          <span class="month__day-head">
            <span class="month__day-number">${Number(d.slice(8))}</span>
            ${regularMarks}
            ${holiday ? `<span class="month__day-holiday" title="${escapeHtml(holiday.join(' · '))}">${escapeHtml(holiday.join(' · '))}</span>` : ''}
          </span>
          ${dots}
        </button>`;
    }
    weeksHtml += `<div class="month__week">${cells}${longLines}${bars}</div>`;
  }
  const weekdaysHtml = `<div class="month__weekdays">${weekdayNames.map((n) => `<div class="month__weekday">${n}</div>`).join('')}</div>`;

  const title = formatDay(firstOfMonth, { month: 'long', year: 'numeric' });
  const slideClass = monthSlide ? ` month__grid--from-${monthSlide}` : '';
  monthSlide = null;
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
      <div class="month__grid${slideClass}">${weekdaysHtml}${weeksHtml}</div>
    </div>`;
}

function shiftMonth(delta) {
  const [y, m] = (state.month || today.slice(0, 7)).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  state.month = date.toISOString().slice(0, 7);
  resetListRange();
  monthSlide = delta > 0 ? 'next' : 'prev';
}

let monthSlide = null; // směr animace při přechodu na jiný měsíc

/** Seznam znovu od začátku (vybraný den, proběhlé a „další akce“ pryč). */
function resetListRange() {
  state.selectedDay = null;
  state.pastDays = 0;
  state.listDays = LIST_DAYS_STEP;
}

/** Přejetí prstem po kalendáři doleva/doprava = další/předchozí měsíc. */
function setupMonthSwipe() {
  narrowScreen.addEventListener('change', () => { if (data && state.showCalendar) update({ keepHash: true }); });
  const view = document.getElementById('view');
  let start = null;
  view.addEventListener('touchstart', (ev) => {
    start = ev.target.closest('.month__grid') && ev.touches.length === 1
      ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY, time: Date.now() }
      : null;
  }, { passive: true });
  view.addEventListener('touchend', (ev) => {
    if (!start) return;
    const dx = ev.changedTouches[0].clientX - start.x;
    const dy = ev.changedTouches[0].clientY - start.y;
    const quick = Date.now() - start.time < 800;
    start = null;
    // vodorovně, dost daleko a výrazně víc než svisle (svislé posouvání stránky nerušit)
    if (!quick || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    shiftMonth(dx < 0 ? 1 : -1);
    update();
  });
}

// ---------- Stažení výběru jako .ics ----------

const isFilterActive = () => Boolean(state.sources || state.categories || state.villages || state.query);

function filterDescription() {
  const parts = [];
  if (state.sources) parts.push(`zdroje: ${[...state.sources].map((id) => sourcesById[id]?.name || id).join(', ')}`);
  if (state.categories) parts.push(`kategorie: ${[...state.categories].map((id) => categoriesById[id]?.label || id).join(', ')}`);
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
  const upcomingAll = events.filter((e) => e._last >= today);
  const upcoming = upcomingAll.length; // i s pravidelnými (pro stažení výběru)
  const upcomingSingle = upcomingAll.filter((e) => !e.recurring).length;
  const regularCount = upcoming - upcomingSingle;
  document.getElementById('result-count').textContent = `${upcomingSingle} nadcházejících akcí`
    + (regularCount ? ` a ${regularCount} termínů pravidelných` : '');
  const downloadButton = document.getElementById('download-filtered');
  downloadButton.hidden = !CUSTOM_ICS_ENABLED || !isFilterActive() || !upcoming;
  refreshSubscribePanel?.();
  document.getElementById('view').innerHTML = (state.showCalendar ? renderMonth(events, holidays) : '')
    + `<div class="event-list">${renderList(events, holidays)}</div>`;
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

/**
 * Vlastní výběr do kalendáře (stažení .ics podle filtru) je zatím vypnutý: statický web
 * neumí odběr libovolné kombinace, jen jednorázový import. Vrátí se s dynamickým odběrem
 * (Cloudflare Worker nebo služba na NASu).
 */
const CUSTOM_ICS_ENABLED = false;

/** Panel kalendáře: odběr všech akcí, nebo jednorázové stažení podle filtru. */
let refreshSubscribePanel = null;

function setupSubscribe() {
  const link = document.getElementById('subscribe-link');
  let panel = null;
  link.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (panel) { panel.remove(); panel = null; refreshSubscribePanel = null; return; }
    panel = document.getElementById('subscribe-help').content.firstElementChild.cloneNode(true);

    const allUrl = new URL('data/akce.ics', location.href).href;
    panel.querySelector('[data-custom-ics]').hidden = !CUSTOM_ICS_ENABLED;
    panel.querySelector('[data-subscribe-all]').href = allUrl.replace(/^https?:/, 'webcal:');

    refreshSubscribePanel = () => {
      if (!panel) return;
      const text = panel.querySelector('.subscribe-help__filter-text');
      const button = panel.querySelector('[data-download-filtered]');
      if (!isFilterActive()) {
        text.textContent = 'zatím není nic vybráno.';
        button.disabled = true;
        return;
      }
      const count = filteredUpcoming().length;
      text.textContent = `${filterDescription()} (${count} nadcházejících akcí)`;
      button.disabled = !count;
    };
    refreshSubscribePanel();

    panel.addEventListener('click', async (e) => {
      if (e.target.closest('[data-download-filtered]')) { downloadFiltered(); return; }
      const button = e.target.closest('[data-copy-all]');
      if (!button) return;
      try {
        await navigator.clipboard.writeText(allUrl);
        button.textContent = 'Zkopírováno ✓';
      } catch {
        window.prompt('Zkopírujte adresu kalendáře:', allUrl);
      }
    });
    document.querySelector('.site-header .wrap').append(panel);
  });
}

// ---------- Bublina nad akcí v měsíci ----------

function tooltipTime(e) {
  if (e.allDay) {
    return e._first === e._last ? 'celý den' : `${formatShortDate(e._first)} – ${formatShortDate(e._last)}`;
  }
  const start = new Date(e.start);
  const end = new Date(e.end || e.start);
  const from = timeFormatter.format(start);
  if (e._first !== e._last) return `${formatShortDate(e._first)} ${from} – ${formatShortDate(e._last)} ${timeFormatter.format(end)}`;
  return end > start ? `${from} – ${timeFormatter.format(end)}` : from;
}

function setupEventTooltip() {
  const tip = document.createElement('div');
  tip.className = 'event-tooltip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  const view = document.getElementById('view');

  view.addEventListener('mouseover', (ev) => {
    const pill = ev.target.closest('.month__pill');
    if (!pill) return;
    const e = data?.events.find((x) => x.id === pill.dataset.eventId);
    if (!e) return;
    const source = sourcesById[e.source] || { name: e.source };
    tip.innerHTML = `
      <div class="event-tooltip__time">${escapeHtml(tooltipTime(e))}${e.cancelled ? ' · <strong>zrušeno</strong>' : ''}</div>
      <div class="event-tooltip__title">${escapeHtml(e.title)}</div>
      ${e.location ? `<div>📍 ${escapeHtml(e.location)}</div>` : ''}
      ${e.note ? `<div class="event-tooltip__note">${escapeHtml(e.note)}</div>` : ''}
      <div class="event-tooltip__source">${source.icon ? sourceIcon(source, true) : ''}${escapeHtml(source.name)}</div>`;
    tip.hidden = false;
    // nad pruhem, případně pod ním; vždy uvnitř okna
    const r = pill.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let top = r.top - t.height - 8;
    if (top < 8) top = r.bottom + 8;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - t.width - 8);
    tip.style.top = `${top + window.scrollY}px`;
    tip.style.left = `${left + window.scrollX}px`;
  });
  view.addEventListener('mouseout', (ev) => {
    if (ev.target.closest('.month__pill') && !ev.relatedTarget?.closest?.('.month__pill')) tip.hidden = true;
  });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
}

function setupThemeToggle() {
  const button = document.getElementById('theme-toggle');
  const sync = () => button.setAttribute('aria-pressed', String(document.documentElement.getAttribute('data-theme') === 'dark'));
  sync();
  button.addEventListener('click', () => { window.toggleTheme(); sync(); });
}

function setupEvents() {
  document.getElementById('calendar-toggle').addEventListener('click', () => {
    state.showCalendar = !state.showCalendar;
    if (!state.showCalendar) resetListRange(); // bez kalendáře seznam vždy od dneška
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
    // pruh akce leží nad buňkami dnů → vybrat den, na který se kliklo
    const dayButton = ev.target.closest('[data-day]') || (ev.target.closest('.month__pill')
      && document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el.matches('.month__day')));
    if (action === 'past') {
      state.pastDays += PAST_DAYS_STEP;
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
      resetListRange();
      update();
    } else if (action === 'clear-day') {
      state.selectedDay = null;
      update({ keepHash: true });
    } else if (dayButton) {
      // vybraný den = seznam jen s tímto dnem; druhý klik = zpět na celý seznam
      state.selectedDay = state.selectedDay === dayButton.dataset.day ? null : dayButton.dataset.day;
      update({ keepHash: true });
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
  setupEventTooltip();
  setupMonthSwipe();
  // přepočet zhuštění filtrů při změně šířky (okno, posuvník, otočení telefonu)
  let fitFrame = 0;
  let fitWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width === fitWidth) return; // změna výšky (např. nadpisy nad štítky) nic nemění
    fitWidth = width;
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(fitFilters);
  }).observe(document.querySelector('.filters'));
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
