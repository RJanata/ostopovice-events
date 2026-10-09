'use strict';

// Souhrnný kalendář akcí — vykreslení dat z data/events.json (generuje scripts/collect.js).
// Stav filtrů se drží v URL za # (dá se sdílet odkazem), např.
//   #z=knihovna,sokol&t=deti&q=jóga&m=2026-11

const TIME_ZONE = 'Europe/Prague';
const SHOW_ALL_BELOW = 30; // když za seznamem zbývá míň akcí, „Zobrazit další“ ukáže všechny naráz
const RECENT_DAYS = 7; // „Nedávno přidané“ = akce přidané za posledních N dní…
const RECENT_SINCE = Date.parse('2026-10-08T12:00:00+02:00'); // …ale ne dřív (do té doby se plnily zdroje)
const MONTH_PILLS = 4; // počet řádků s akcemi v buňce měsíce (při víc akcích 3 + „+ N další“)
const MULTI_DAY_LIST_LIMIT = 7; // delší akce se v seznamu neopakují u každého dne
const LONG_EVENT_DAYS = 8; // od této délky je akce „dlouhodobá“ (výstavy): v měsíci tenká čára, ve výpisu zvlášť

const state = {
  sources: null, // Set povolených zdrojů; null = všechny
  categories: null,
  villages: null,
  regular: true, // zobrazovat pravidelné akce (zaškrtávátko „Pravidelné“)
  query: '',
  month: null, // 'YYYY-MM'
  selectedDay: null,
  showPast: false, // v aktuálním měsíci i proběhlé akce od 1. dne („Zobrazit proběhlé“)
  showRecent: false, // místo seznamu jen nedávno přidané akce
  calendarCollapsed: false, // mřížka měsíce sbalená („Skrýt“); při hledání se sbalí sama
  collapsedBySearch: false, // sbalilo ji hledání → po smazání hledání se zase rozbalí
  extraMonths: 0, // kolik dalších měsíců za vybraným seznam ukazuje („Zobrazit další akce“); Infinity = všechny
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
  if (!state.regular && e.recurring) return false;
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
  state.sources = set('z');
  state.categories = set('t');
  state.villages = set('o');
  state.regular = p.get('r') !== '0';
  state.query = p.get('q') || '';
  state.month = /^\d{4}-\d{2}$/.test(p.get('m') || '') ? p.get('m') : null;
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.sources) p.set('z', [...state.sources].join(','));
  if (state.categories) p.set('t', [...state.categories].join(','));
  if (state.villages) p.set('o', [...state.villages].join(','));
  if (!state.regular) p.set('r', '0');
  if (state.query) p.set('q', state.query);
  if (state.month && state.month !== today.slice(0, 7)) p.set('m', state.month);
  const hash = p.toString().replace(/%2C/g, ',');
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

// ---------- Filtry ----------

function sourceIcon(source, small = false) {
  return `<span class="source-icon${small ? ' source-icon--small' : ''}"><img src="icons/${escapeHtml(source.icon)}" alt=""></span>`;
}

/**
 * Ikona pravidelné akce v měsíci: u vlastních Google kalendářů (Nezařazené) ikona kategorie
 * (cvičení, bohoslužba…), jinak ikona zdroje.
 */
function regularIcon(e) {
  const source = sourcesById[e.source];
  if (e.icon) return `<span class="regular-cat">${eventIcon(e)}</span>`;
  const category = source?.type === 'ical' && categoriesById[e.categories.find((id) => id !== 'ostatni')];
  if (category?.icon) return `<span class="regular-cat" style="--chip-color:${escapeHtml(category.color)}">${categoryIcon(category)}</span>`;
  return sourceIcon(source || { icon: 'nezarazene.svg' }, true);
}

/** Barva akce = barva první kategorie (kromě Ostatní), jinak zdroje. */
function eventColor(e) {
  const category = categoriesById[e.categories.find((id) => id !== 'ostatni')];
  return category?.color || sourcesById[e.source]?.color || '#888';
}

/** Vlastní ikona akce z popisu (#icon:ball-football → icons/tabler/ball-football.svg). */
function eventIcon(e) {
  if (!e.icon) return '';
  const url = new URL(`icons/tabler/${e.icon}.svg`, document.baseURI).href;
  return `<span class="cat-icon event-icon" style="--chip-color:${escapeHtml(eventColor(e))};--icon:url('${escapeHtml(url)}')"></span>`;
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
      : items.filter((item) => selected.has(item.id)).map((item) => item.fullName || item.label || item.name || item.id).join(', ');
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
  const fits = () => !rows.some(wrapsToMoreLines);
  for (const [index, level] of FILTER_LEVELS.entries()) {
    filters.classList.toggle('filters--top', level.includes('top'));
    filters.classList.toggle('filters--short', level.includes('short'));
    filters.classList.toggle('filters--icons', level.includes('icons'));
    // „Pravidelné“ je na konci štítků; k nadpisu nahoru jde, jen když jsou nadpisy nahoře
    // a na konec štítků se nevejde
    filters.classList.remove('filters--regular-top');
    if (fits()) return;
    if (level.includes('top')) {
      filters.classList.add('filters--regular-top');
      if (fits()) return;
    }
    if (index === FILTER_LEVELS.length - 1) return;
  }
}

function renderFilters() {
  const sources = data.sources.filter((s) => s.display !== 'dayLabel');
  renderChips(document.getElementById('source-filter'), sources, state.sources,
    (s) => `${sourceIcon(s)}<span class="chip__label">${escapeHtml(s.name)}</span><span class="chip__label-short">${escapeHtml(s.shortName || s.name)}</span>`,
    (id, multi) => { state.sources = toggleSelection(state.sources, id, multi, sources.map((s) => s.id)); update(); });

  // jen kategorie s nadcházejícími akcemi (např. „Ostatní“ se ukáže, až nějakou akci bude mít)
  const usedCategories = new Set(data.events.filter((e) => !e.hidden && e._last >= today).flatMap((e) => e.categories));
  state.categories?.forEach((id) => usedCategories.add(id)); // vybranou kategorii z odkazu neschovávat
  const categories = data.categories.filter((c) => usedCategories.has(c.id));
  renderChips(document.getElementById('category-filter'), categories, state.categories,
    (c) => `${categoryIcon(c)}<span class="chip__label">${escapeHtml(c.label)}</span><span class="chip__label-short">${escapeHtml(c.shortLabel || c.label)}</span>`,
    (id, multi) => { state.categories = toggleSelection(state.categories, id, multi, categories.map((c) => c.id)); update(); });
  // zaškrtávátko na konci řady kategorií (počítá se do zhuštění filtrů jako další štítek)
  document.getElementById('category-filter').insertAdjacentHTML('beforeend', `
    <label class="regular-toggle" title="Pravidelné akce (cvičení, kurzy, bohoslužby…)">
      <input type="checkbox" class="regular-input"${state.regular ? ' checked' : ''}><span>Pravidelné</span>
    </label>`);

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

  document.querySelectorAll('.regular-input').forEach((input) => { input.checked = state.regular; });
  const search = document.getElementById('search');
  if (search.value !== state.query) search.value = state.query;
  document.getElementById('search-clear').hidden = !search.value;
  document.getElementById('reset-filters').hidden = !isFilterActive();
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
        <h3 class="event__title">${eventIcon(e)}${title}</h3>
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

const isCurrentMonth = () => !state.month || state.month === today.slice(0, 7);

/**
 * Začátek seznamu podle kalendáře: aktuální měsíc → od dneška (s „Zobrazit proběhlé“
 * od 1. dne měsíce), jiný zobrazený měsíc (dopředu i dozadu) → od jeho prvního dne.
 */
function listStart(events) {
  // hledání: nalezené akce od dneška bez ohledu na zobrazený měsíc, proběhlé jen přes odkaz
  if (state.query) {
    return state.showPast ? events.reduce((min, e) => (e._first < min ? e._first : min), today) : today;
  }
  if (!isCurrentMonth()) return `${state.month}-01`;
  return state.showPast ? `${today.slice(0, 7)}-01` : today;
}

/**
 * Proběhlé akce, které seznam od dneška neukazuje: aktuální měsíc od 1. dne do včerejška
 * (bez pravidelných), při hledání všechny nalezené proběhlé akce.
 */
const pastHidden = (events) => (state.query
  ? events.filter((e) => e._last < today)
  : events.filter((e) => !e.recurring && e._last < today && e._last >= `${today.slice(0, 7)}-01`));

/** Nedávno přidané nadcházející akce; z opakované akce jen nejbližší termín. */
function recentlyAdded(events) {
  const since = Math.max(Date.now() - RECENT_DAYS * 864e5, RECENT_SINCE);
  const seen = new Set();
  return events
    .filter((e) => e.added && Date.parse(e.added) >= since && e._last >= today)
    .sort((a, b) => a._first.localeCompare(b._first) || compareEvents(a, b))
    .filter((e) => {
      if (!e.recurring) return true;
      const key = `${e.source}|${e.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Seznam nedávno přidaných akcí (místo běžného seznamu). */
function renderRecent(events, holidays) {
  const list = recentlyAdded(events);
  const byDay = new Map();
  for (const e of list) {
    const day = e._first < today ? today : e._first;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  return listButtons(events)
    + (list.length ? renderDays(byDay, holidays) : '<p class="empty">Za poslední dny nepřibyla žádná akce.</p>');
}

/** Řádek tlačítek nad seznamem: proběhlé akce tohoto měsíce a nedávno přidané. */
function listButtons(events) {
  const buttons = [];
  const past = pastHidden(events).length;
  if ((isCurrentMonth() || state.query) && past && !state.showRecent) {
    buttons.push(`<button type="button" class="link-button" data-action="past" aria-pressed="${state.showPast}">`
      + `${state.showPast ? 'Skrýt' : 'Zobrazit'} proběhlé akce (${past})</button>`);
  }
  const recent = recentlyAdded(events).length;
  if (recent || state.showRecent) {
    buttons.push(`<button type="button" class="link-button" data-action="recent" aria-pressed="${state.showRecent}">`
      + `${state.showRecent ? 'Zobrazit všechny akce' : `Nedávno přidané události (${recent})`}</button>`);
  }
  return buttons.length ? `<div class="more">${buttons.join('')}</div>` : '';
}

/** Seznam jediného dne vybraného v kalendáři. */
function renderSelectedDay(events, holidays) {
  const day = state.selectedDay;
  const byDay = groupByDay(events, day, day, holidays);
  if (!byDay.has(day)) byDay.set(day, []);
  return longEventsBlock(events, day, day)
    + renderDays(byDay, holidays)
    + `<div class="more"><button type="button" class="link-button" data-action="clear-day">Zobrazit všechny akce</button></div>`;
}

/** 'YYYY-MM' posunutý o n měsíců. */
function shiftMonthKey(month, n) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

const lastDayOfMonth = (month) => addDays(`${shiftMonthKey(month, 1)}-01`, -1);

/**
 * Seznam pod kalendářem: jen akce vybraného měsíce (aktuální měsíc od dneška),
 * „Zobrazit další akce“ přidá vždy jeden další měsíc. Při hledání všechny nalezené akce.
 */
function renderList(events, holidays) {
  if (state.selectedDay) return renderSelectedDay(events, holidays);
  if (state.showRecent) return renderRecent(events, holidays);
  const from = listStart(events);
  const lastEventDay = events.reduce((max, e) => (e._last > max ? e._last : max), from);
  // při hledání ukázat všechny nalezené akce, i ty za mnoho měsíců
  const to = state.query || state.extraMonths === Infinity
    ? lastEventDay
    : lastDayOfMonth(shiftMonthKey(state.month || today.slice(0, 7), state.extraMonths));
  const byDay = groupByDay(events, from, to, holidays, { holidayDays: !state.query });

  const days = [...byDay.keys()].sort();
  // „Zobrazit další akce“ přidá jeden měsíc (odkaz je, i když je měsíc prázdný);
  // když už za seznamem zbývá málo akcí, ukáže všechny zbývající naráz
  const nextMonth = shiftMonthKey(to.slice(0, 7), 1);
  const nextCount = events.filter((e) => !e.recurring && e._first <= lastDayOfMonth(nextMonth) && e._last >= `${nextMonth}-01`).length;
  const remaining = events.filter((e) => !e.recurring && e._first > to).length;
  const remainingAll = events.some((e) => e._first > to);
  const showAllNext = remaining < SHOW_ALL_BELOW;

  let html = listButtons(events);
  const longBlock = longEventsBlock(events, from, to);
  html += longBlock;
  if (!longBlock && !days.some((d) => byDay.get(d).length)) {
    const message = !events.length ? 'Filtrům neodpovídá žádná akce.'
      : state.query ? 'Hledání neodpovídá žádná nadcházející akce.'
        : 'V tomto období žádné akce nejsou.';
    html += `<p class="empty">${message}</p>`;
  }
  html += renderDays(byDay, holidays);
  if (!state.query && remainingAll) {
    const monthName = formatDay(`${nextMonth}-01`, { month: 'long', ...(nextMonth.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }) });
    const label = showAllNext ? `Zobrazit všechny další akce (${remaining})` : `Zobrazit další akce – ${escapeHtml(monthName)} (${nextCount})`;
    html += `<div class="more"><button type="button" class="link-button" data-action="${showAllNext ? 'all-later' : 'later'}">${label}</button></div>`;
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
        + `${e.icon ? eventIcon(e) : sourceIcon(src)}<span>${escapeHtml(time + (e.shortTitle || e.title))}</span></span>`;
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
          + `${regular.slice(0, 3).map(regularIcon).join('')}`
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
  // vykreslí se ve stavu, v jakém byl kalendář naposledy; změnu (s animací) dodělá syncCalendarCollapse
  return `
    <div class="month${renderedCollapsed ? ' month--collapsed' : ''}">
      <div class="month__nav">
        <h2>${escapeHtml(title)}</h2>
        <div class="month__nav-buttons">
          ${collapseButton(renderedCollapsed)}
          <button type="button" class="icon-button" data-action="prev-month" aria-label="Předchozí měsíc">‹</button>
          <button type="button" class="icon-button icon-button--text" data-action="this-month">Dnes</button>
          <button type="button" class="icon-button" data-action="next-month" aria-label="Další měsíc">›</button>
        </div>
      </div>
      <div class="month__body"><div class="month__body-inner">
        <div class="month__grid${slideClass}">${weekdaysHtml}${weeksHtml}</div>
      </div></div>
    </div>`;
}

let renderedCollapsed = false; // stav sbalení, ve kterém je kalendář právě na stránce

function collapseButton(collapsed) {
  const arrow = collapsed
    ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>'
    : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>';
  const calendar = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  return `<button type="button" class="icon-button icon-button--text month__toggle" data-action="toggle-calendar" aria-expanded="${!collapsed}">`
    + `${calendar}${collapsed ? 'Zobrazit' : 'Skrýt'}${arrow}</button>`;
}

/** Sbalí / rozbalí mřížku měsíce podle stavu — přepnutím třídy na stránce, aby proběhla animace. */
function syncCalendarCollapse() {
  const month = document.querySelector('.month');
  if (!month || renderedCollapsed === state.calendarCollapsed) return;
  renderedCollapsed = state.calendarCollapsed;
  void month.offsetHeight; // čerstvě vložený kalendář: nejdřív spočítat výchozí stav, ať přechod proběhne
  month.classList.toggle('month--collapsed', renderedCollapsed);
  month.querySelector('.month__toggle').outerHTML = collapseButton(renderedCollapsed);
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
  state.showPast = false;
  state.showRecent = false;
  state.extraMonths = 0;
}

/** Přejetí prstem po kalendáři doleva/doprava = další/předchozí měsíc. */
function setupMonthSwipe() {
  narrowScreen.addEventListener('change', () => { if (data) update({ keepHash: true }); });
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

const isFilterActive = () => Boolean(state.sources || state.categories || state.villages || state.query || !state.regular);

function filterDescription() {
  const parts = [];
  if (state.sources) parts.push(`zdroje: ${[...state.sources].map((id) => sourcesById[id]?.name || id).join(', ')}`);
  if (state.categories) parts.push(`kategorie: ${[...state.categories].map((id) => categoriesById[id]?.label || id).join(', ')}`);
  if (state.villages) parts.push(`obec: ${[...state.villages].join(', ')}`);
  if (state.query) parts.push(`hledání: „${state.query}“`);
  if (!state.regular) parts.push('bez pravidelných');
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
  document.getElementById('view').innerHTML = renderMonth(events, holidays)
    + `<div class="event-list">${renderList(events, holidays)}</div>`;
  syncCalendarCollapse();
}

// Krátký výpadek zdroje návštěvníky neruší (data jsou pár hodin stará, ale platná);
// upozornění až když se zdroj nepodařilo načíst déle než STALE_HOURS.
const STALE_HOURS = 24;

function renderStatus() {
  const staleBefore = Date.now() - STALE_HOURS * 3600e3;
  const failed = data.sources.filter((s) => s.ok === false && (!s.lastSuccess || Date.parse(s.lastSuccess) < staleBefore));
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
  // svátky se nevypisují; vlastní Google kalendáře souhrnně jednou položkou, jejich doplňkové zdroje (farnost) zvlášť
  const credit = (name, icon, link) => {
    const label = link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>` : escapeHtml(name);
    return `<span class="site-footer__source">${icon ? sourceIcon({ icon }, true) : ''}${label}</span>`;
  };
  const sources = data.sources.filter((s) => s.display !== 'dayLabel');
  const google = sources.filter((s) => s.type === 'ical');
  const items = [
    ...sources.filter((s) => s.type !== 'ical').map((s) => credit(s.fullName || s.name, s.icon, s.link)),
    ...sources.flatMap((s) => s.feeds || []).map((f) => credit(f.fullName, f.icon, f.link)),
    ...(google.length ? [credit('Google kalendáře', google[0].icon, null)] : []),
  ];
  document.getElementById('source-links').innerHTML = items.join(', ');
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
    document.querySelector('.filters__tools').after(panel);
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

/** Nadpis na víc řádků → přepínač režimu se přesune z úrovně nadpisu k podnadpisu. */
function setupHeaderFit() {
  const header = document.querySelector('.site-header');
  const title = header.querySelector('h1');
  const fit = () => {
    header.classList.remove('site-header--stacked');
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
    if (title.getBoundingClientRect().height > lineHeight * 1.5) header.classList.add('site-header--stacked');
  };
  fit();
  let width = 0;
  new ResizeObserver(([entry]) => {
    if (Math.round(entry.contentRect.width) === width) return; // reaguje jen na šířku
    width = Math.round(entry.contentRect.width);
    requestAnimationFrame(fit);
  }).observe(header);
}

function setupThemeToggle() {
  const button = document.getElementById('theme-toggle');
  const sync = () => button.setAttribute('aria-pressed', String(document.documentElement.getAttribute('data-theme') === 'dark'));
  sync();
  button.addEventListener('click', () => { window.toggleTheme(); sync(); });
}

function setupEvents() {
  let searchTimer;
  // vlastní křížek místo prohlížečového (ten je vidět jen při najetí myší / v Chrome)
  document.getElementById('search-clear').addEventListener('click', () => {
    const search = document.getElementById('search');
    search.value = '';
    search.dispatchEvent(new Event('input'));
    search.focus();
  });
  document.getElementById('search').addEventListener('input', (ev) => {
    document.getElementById('search-clear').hidden = !ev.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const query = ev.target.value.trim();
      // při hledání kalendář překáží → sbalit; po smazání hledání vrátit, pokud ho sbalilo hledání
      if (query && !state.query && !state.calendarCollapsed) {
        state.calendarCollapsed = true;
        state.collapsedBySearch = true;
      } else if (!query && state.collapsedBySearch) {
        state.calendarCollapsed = false;
        state.collapsedBySearch = false;
      }
      // hledání v jednom vybraném dni nedává smysl → začátek i konec hledání vrací seznam do výchozího
      // stavu (bez vybraného dne, proběhlých, nedávno přidaných a dalších měsíců)
      if (Boolean(query) !== Boolean(state.query)) resetListRange();
      state.query = query;
      update();
    }, 150);
  });

  document.getElementById('download-filtered').addEventListener('click', downloadFiltered);

  document.querySelector('.filters').addEventListener('change', (ev) => {
    if (!ev.target.classList.contains('regular-input')) return;
    state.regular = ev.target.checked;
    update();
  });

  document.getElementById('reset-filters').addEventListener('click', () => {
    state.sources = null;
    state.categories = null;
    state.villages = null;
    state.regular = true;
    state.query = '';
    if (state.collapsedBySearch) {
      state.calendarCollapsed = false;
      state.collapsedBySearch = false;
    }
    update();
  });

  document.getElementById('view').addEventListener('click', (ev) => {
    const action = ev.target.closest('[data-action]')?.dataset.action;
    // pruh akce leží nad buňkami dnů → vybrat den, na který se kliklo
    const dayButton = ev.target.closest('[data-day]') || (ev.target.closest('.month__pill')
      && document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el.matches('.month__day')));
    if (action === 'past') {
      state.showPast = !state.showPast;
      update({ keepHash: true });
    } else if (action === 'recent') {
      state.showRecent = !state.showRecent;
      update({ keepHash: true });
    } else if (action === 'later') {
      state.extraMonths += 1;
      update({ keepHash: true });
    } else if (action === 'toggle-calendar') {
      state.calendarCollapsed = !state.calendarCollapsed;
      state.collapsedBySearch = false;
      syncCalendarCollapse();
    } else if (action === 'all-later') {
      state.extraMonths = Infinity;
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

/**
 * Počítadlo návštěv (projekt hit-counter na NASu, report v nas-stats): jeden požadavek
 * při otevření s cestou stránky a tím, odkud návštěvník přišel. Bez cookies; jen na ostrém webu.
 */
function countVisit() {
  if (location.hostname !== 'kalendar.prolidiostopovice.cz') return;
  const url = new URL('https://stats.craz.cz/hit/ostopovice-events');
  url.searchParams.set('p', location.pathname + location.hash);
  if (document.referrer) url.searchParams.set('r', document.referrer);
  fetch(url, { mode: 'no-cors', keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
}

async function init() {
  countVisit();
  today = dayKey(new Date());
  readHash();
  if (state.query) state.calendarCollapsed = state.collapsedBySearch = true; // odkaz s hledáním
  setupEvents();
  setupSubscribe();
  setupThemeToggle();
  setupHeaderFit();
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
