'use strict';

// Otevírací doby: data/opening-hours.json (generuje scripts/lib/opening-hours.js z configu).
// Karta = jedno místo s otevírací dobou na zvolený týden (Po–Ne); výjimky z adminu se do
// týdne promítnou a zvýrazní, svátky jsou u dne vyznačené. U názvu ikona „teď otevřeno / zavřeno“.

const TIME_ZONE = 'Europe/Prague';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_SHORT = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
const DAY_ON = ['v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu', 'v neděli'];
const UPCOMING_DAYS = 60; // jak daleko dopředu ukazovat plánované výjimky
const CLOSING_SOON_MINUTES = 60; // zavírají do hodiny → oranžově s počtem minut
const NOON = 12 * 60; // dopolední intervaly v levém sloupci, odpolední v pravém

let data = null;
const state = { category: null, week: 0 };

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------- Čas (vše v pražském čase, dny jako "YYYY-MM-DD") ----------

function pragueNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const keyToDate = (key) => new Date(`${key}T00:00:00Z`);
const addDays = (key, n) => { const d = keyToDate(key); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekdayIndex = (key) => (keyToDate(key).getUTCDay() + 6) % 7; // pondělí = 0
const formatShort = (key) => `${Number(key.slice(8))}. ${Number(key.slice(5, 7))}.`;
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const formatTime = (hhmm) => hhmm.replace(/^0/, '');

/** ISO číslo týdne (sudý / lichý týden u sběrného dvora). */
function isoWeek(key) {
  const d = keyToDate(key);
  d.setUTCDate(d.getUTCDate() + 3 - weekdayIndex(key)); // čtvrtek téhož týdne určuje rok i číslo týdne
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 864e5 + 1) / 7);
}

/** „10.–16. 11.“, přes konec měsíce „30. 11. – 6. 12.“ */
function formatRange(from, to) {
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}.–${formatShort(to)}`;
  return `${formatShort(from)} – ${formatShort(to)}`;
}

// ---------- Otevírací doba v konkrétní den ----------

/** Pravidelná doba platná v daný den (sezóny „duben–říjen“ apod., i přes Nový rok). */
function regularHours(place, day) {
  if (!place.seasons) return { hours: place.hours, season: null };
  const md = day.slice(5);
  const season = place.seasons.find((s) => (s.from <= s.to ? md >= s.from && md <= s.to : md >= s.from || md <= s.to));
  return { hours: season?.hours || {}, season };
}

/**
 * Intervaly otevření v daný den: [{ from, to, note }], prázdné = zavřeno, null = neznámé.
 * exception = výjimka, která ten den platí (má přednost před pravidelnou dobou).
 */
function hoursOn(place, day) {
  const exception = data.exceptions.find((x) => x.places.includes(place.id) && day >= x.from && day <= x.to) || null;
  if (exception) {
    return { exception, intervals: exception.hours.map((t) => ({ from: t.split('-')[0], to: t.split('-')[1] })) };
  }
  const { hours } = regularHours(place, day);
  if (!hours) return { exception: null, intervals: null };
  const week = isoWeek(day);
  const intervals = (hours[DAYS[weekdayIndex(day)]] || [])
    .map((item) => (typeof item === 'string' ? { time: item } : item))
    .filter((item) => !item.weeks || (item.weeks === 'even') === (week % 2 === 0))
    .map((item) => ({ from: item.time.split('-')[0], to: item.time.split('-')[1], note: item.note || '' }));
  return { exception: null, intervals };
}

/** Stav teď: { kind: open|soon|closed, text, minutes } (jen pro známou otevírací dobu). */
function openStatus(place, now) {
  const today = hoursOn(place, now.day).intervals;
  if (!today) return null;
  const current = today.find((i) => now.minutes >= toMinutes(i.from) && now.minutes < toMinutes(i.to));
  if (current) {
    const left = toMinutes(current.to) - now.minutes;
    return left <= CLOSING_SOON_MINUTES
      ? { kind: 'soon', minutes: left, text: `Zavírá za ${left} min (v ${formatTime(current.to)})` }
      : { kind: 'open', text: `Otevřeno do ${formatTime(current.to)}` };
  }
  for (let n = 0; n < 14; n++) {
    const day = addDays(now.day, n);
    const next = (hoursOn(place, day).intervals || []).find((i) => n > 0 || toMinutes(i.from) > now.minutes);
    if (!next) continue;
    let when;
    if (n === 0) when = `v ${formatTime(next.from)}`;
    else if (n === 1) when = `zítra v ${formatTime(next.from)}`;
    else if (n < 7) when = `${DAY_ON[weekdayIndex(day)]} v ${formatTime(next.from)}`;
    else when = `${formatShort(day)} v ${formatTime(next.from)}`;
    return { kind: 'closed', text: `Zavřeno, otevře ${when}` };
  }
  return { kind: 'closed', text: 'Zavřeno' };
}

// ---------- Vykreslení ----------

// ikony sociálních sítí v zápatí panelu (stejné jako v patičce webu)
const SOCIAL = {
  facebook: { label: 'Facebook', svg: '<svg class="hours-social__icon hours-social__icon--filled" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 22v-8h2.7l.4-3h-3.1V9.1c0-.9.3-1.5 1.6-1.5h1.7V5a23 23 0 0 0-2.5-.1c-2.5 0-4.2 1.5-4.2 4.3V11H7.3v3h2.8v8h3.4Z"/></svg>' },
  instagram: { label: 'Instagram', svg: '<svg class="hours-social__icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>' },
};

const STATUS_LABEL = { open: 'Otevřeno', closed: 'Zavřeno' };

/** Fazolka se stavem teď; zavírají do hodiny → oranžová s počtem minut. Celý text v bublině. */
function statusBadge(status) {
  if (!status) return '';
  const label = STATUS_LABEL[status.kind] || `ještě ${status.minutes} min`;
  return `<span class="hours-status hours-status--${status.kind}" title="${escapeHtml(status.text)}">${escapeHtml(label)}</span>`;
}

function intervalHtml(i) {
  return `<span class="hours-day__interval">${formatTime(i.from)}–${formatTime(i.to)}${i.note ? `<small>${escapeHtml(i.note)}</small>` : ''}</span>`;
}

/**
 * Časy dne. V kartě, kde má některý den dopoledne i odpoledne, jsou dva sloupce:
 * dopolední intervaly vlevo, odpolední vpravo — ať jsou stejné časy pod sebou.
 */
function timesHtml(intervals, twoColumns) {
  if (!intervals) return '<span class="hours-day__closed">?</span>';
  if (!intervals.length) return '<span class="hours-day__closed" title="zavřeno">—</span>';
  if (!twoColumns || intervals.length > 2) return intervals.map(intervalHtml).join('');
  const slots = ['', ''];
  if (intervals.length === 2) intervals.forEach((i, n) => { slots[n] = intervalHtml(i); });
  else slots[toMinutes(intervals[0].from) < NOON ? 0 : 1] = intervalHtml(intervals[0]);
  return slots.map((s) => `<span class="hours-day__slot">${s}</span>`).join('');
}

function exceptionRange(x) {
  return x.from === x.to ? formatShort(x.from) : formatRange(x.from, x.to);
}

function exceptionText(x) {
  const hours = x.hours.length ? x.hours.map((t) => t.split('-').map(formatTime).join('–')).join(', ') : 'zavřeno';
  return `${hours}${x.note ? ` (${x.note})` : ''}`;
}

const hasLabel = (place) => Boolean(place.hoursLabel || place.seasons);

function placeCard(place, weekStart, now, { labelRow }) {
  const known = Boolean(place.hours || place.seasons);
  const week = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(weekStart, i);
    return { day, i, ...hoursOn(place, day), holiday: data.holidays[day] };
  });
  const twoColumns = week.some((d) => d.intervals?.length === 2);

  const seasons = new Set(place.seasons ? week.map((d) => regularHours(place, d.day).season?.label).filter(Boolean) : []);
  const rows = week.map(({ day, i, exception, intervals, holiday }) => {
    const classes = ['hours-day',
      day === now.day && 'hours-day--today',
      i >= 5 && 'hours-day--weekend',
      holiday && 'hours-day--holiday',
      exception && 'hours-day--exception',
      intervals && !intervals.length && 'hours-day--closed',
      twoColumns && 'hours-day--two'].filter(Boolean).join(' ');
    const title = [`${DAY_SHORT[i]} ${formatShort(day)}`, holiday?.join(' · '), exception && `Výjimka: ${exceptionText(exception)}`].filter(Boolean).join(' – ');
    return `<li class="${classes}" title="${escapeHtml(title)}">
        <span class="hours-day__name">${DAY_SHORT[i]} <small>${formatShort(day)}</small></span>
        <span class="hours-day__times">${timesHtml(intervals, twoColumns)}</span>
        ${exception?.note ? `<span class="hours-day__note">${escapeHtml(exception.note)}</span>`
          : holiday ? `<span class="hours-day__note hours-day__note--holiday">${escapeHtml(holiday.join(' · '))}</span>` : ''}
      </li>`;
  }).join('');

  // výjimky mimo zobrazený týden (dopředu), ať je dovolená vidět včas
  const weekEnd = addDays(weekStart, 6);
  const upcoming = data.exceptions.filter((x) => x.places.includes(place.id)
    && x.to >= now.day && x.from <= addDays(now.day, UPCOMING_DAYS) && (x.from > weekEnd || x.to < weekStart));

  const label = [place.hoursLabel, [...seasons].join(' / ')].filter(Boolean).join(' · ');
  // adresa jen s číslem orientačním (U Kaple 5), odkaz na mapu ale s celou adresou (260/5)
  const shortAddress = place.address?.replace(/\b\d+\/(\d+[a-z]?)\b/i, '$1');
  const mapUrl = place.map || (place.address
    && `https://mapy.com/cs/?q=${encodeURIComponent(place.village ? place.address : `${place.address}, Ostopovice`)}`);
  const contacts = [
    place.address && `<a href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener" title="${escapeHtml(place.address)}">${escapeHtml(shortAddress)}</a>`,
    place.phone && `<a href="tel:${escapeHtml(place.phone.replace(/\s+/g, ''))}">${escapeHtml(place.phone.replace(/^\+420\s*/, ''))}</a>`,
  ].filter(Boolean);
  const webLink = place.web
    ? `<a href="${escapeHtml(place.web)}" target="_blank" rel="noopener">${escapeHtml(place.web.replace(/^https?:\/\/(www\.)?/, '').replace(/#.*$/, '').replace(/\/$/, ''))}</a>`
    : '';
  const socialLinks = Object.entries(place.social || {})
    .filter(([network, url]) => SOCIAL[network] && url)
    .map(([network, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${SOCIAL[network].label}" aria-label="${SOCIAL[network].label}: ${escapeHtml(place.name)}">${SOCIAL[network].svg}</a>`)
    .join('');
  // ikony sítí vpravo: na řádku s webem, a když web není, rovnou na prvním řádku
  const social = socialLinks ? `<span class="hours-social">${socialLinks}</span>` : '';
  const title = place.web
    ? `<a href="${escapeHtml(place.web)}" target="_blank" rel="noopener">${escapeHtml(place.name)}</a>`
    : escapeHtml(place.name);

  // pevně pět částí: karty v řadě sdílejí řádky mřížky (subgrid), takže dny jsou vedle sebe na stejné výšce
  return `<article class="hours-card">
      <header class="hours-card__head">
        ${categoryIcon(place)}
        <h2 class="hours-card__title">${title}${place.village ? ` <span class="hours-card__village">(${escapeHtml(place.village)})</span>` : ''}</h2>
        ${known ? statusBadge(openStatus(place, now)) : ''}
      </header>
      ${labelRow ? `<p class="hours-card__label">${escapeHtml(label) || '&nbsp;'}</p>` : '<div></div>'}
      ${known ? `<ul class="hours-days">${rows}</ul>` : '<p class="hours-card__unknown">Otevírací dobu zatím doplňujeme.</p>'}
      <div class="hours-card__extra">
        ${upcoming.length ? `<ul class="hours-upcoming">${upcoming.map((x) => `<li><strong>${exceptionRange(x)}</strong> ${escapeHtml(exceptionText(x))}</li>`).join('')}</ul>` : ''}
        ${place.note ? `<p class="hours-card__note">${escapeHtml(place.note)}</p>` : ''}
      </div>
      <div class="hours-card__contacts">
        <p class="hours-card__line"><span>${contacts.join('<span aria-hidden="true"> · </span>')}</span>${!webLink && socialLinks ? social : ''}</p>
        ${webLink ? `<p class="hours-card__line">${webLink}${social}</p>` : ''}
      </div>
    </article>`;
}

/** Ikona druhu nebo místa: PNG jako obrázek (znak obce, logo knihovny), SVG jako maska v barvě druhu. */
function categoryIcon(category) {
  if (!category.icon) return '';
  // url() v CSS proměnné by se vyhodnotila vůči css/style.css → absolutní adresa
  const url = new URL(`icons/${category.icon}`, document.baseURI).href;
  if (/\.svg$/.test(category.icon)) return `<span class="cat-icon" style="--icon:url('${escapeHtml(url)}')"></span>`;
  return `<span class="source-icon source-icon--small"><img src="icons/${escapeHtml(category.icon)}" alt=""></span>`;
}

function renderFilter() {
  const items = [{ id: null, label: 'Vše' }, ...data.categories];
  $('hours-filter').innerHTML = items.map((c) => `<button type="button" class="chip${c.id ? '' : ' chip--all'}" data-category="${c.id || ''}"
      aria-pressed="${String(state.category === c.id)}" style="--chip-color:${escapeHtml(c.color || 'var(--accent)')}">
      ${c.id ? categoryIcon(c) : ''}${escapeHtml(c.label)}</button>`).join('');
}

function render() {
  const now = pragueNow();
  const weekStart = addDays(now.day, -weekdayIndex(now.day) + state.week * 7);
  $('week-range').innerHTML = `${formatRange(weekStart, addDays(weekStart, 6))} <small>${isoWeek(weekStart)}. týden</small>`;
  $('week-label').setAttribute('aria-pressed', String(state.week === 0));
  document.querySelector('[data-week="-1"]').disabled = state.week <= 0;

  renderFilter();
  const places = data.places.filter((p) => !state.category || p.category === state.category);
  // skupiny podle druhu (Obec, Pohostinství, Služby); při filtru jen jedna
  $('hours').innerHTML = data.categories
    .filter((c) => places.some((p) => p.category === c.id))
    .map((c) => {
      const list = places.filter((p) => p.category === c.id);
      // podřádek (Úřední hodiny, Zimní provoz…) jen když ho má aspoň jedna karta ve skupině
      const labelRow = list.some(hasLabel);
      const cards = list.map((p) => placeCard(p, weekStart, now, { labelRow })).join('');
      return `<section class="hours-group" aria-label="${escapeHtml(c.label)}">
          ${state.category ? '' : `<h2 class="hours-group__title" style="--chip-color:${escapeHtml(c.color)}">${escapeHtml(c.label)}</h2>`}
          <div class="hours-cards" style="--chip-color:${escapeHtml(c.color)}">${cards}</div>
        </section>`;
    }).join('') || '<p class="empty">Nic tu není.</p>';
}

// ---------- Stav v adrese (#k=pohostinstvi) ----------

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const k = params.get('k');
  state.category = data.categories.some((c) => c.id === k) ? k : null;
}

function writeHash() {
  const hash = state.category ? `#k=${state.category}` : '';
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname + location.search);
}

function setup() {
  $('hours-filter').addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-category]');
    if (!chip) return;
    const id = chip.dataset.category || null;
    // druhý klik na vybraný druh = zpět na vše
    state.category = state.category === id ? null : id;
    writeHash();
    render();
  });
  document.querySelector('.hours-week').addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-week]');
    if (!button) return;
    const delta = Number(button.dataset.week);
    state.week = delta === 0 ? 0 : Math.max(0, state.week + delta);
    render();
  });
  window.addEventListener('hashchange', () => { readHash(); render(); });
  const toggle = $('theme-toggle');
  const sync = () => toggle.setAttribute('aria-pressed', String(document.documentElement.getAttribute('data-theme') === 'dark'));
  sync();
  toggle.addEventListener('click', () => { window.toggleTheme(); sync(); });
  // stav „otevřeno / zavřeno“ se mění s časem → po minutě překreslit (jen když je stránka vidět)
  setInterval(() => { if (!document.hidden) render(); }, 60000);
}

/** Nadpis na víc řádků → tlačítka (přepnutí stránek, režim) se přesunou z úrovně nadpisu pod něj. */
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
    if (Math.round(entry.contentRect.width) === width) return;
    width = Math.round(entry.contentRect.width);
    requestAnimationFrame(fit);
  }).observe(header);
}

function countVisit() {
  if (location.hostname !== 'kalendar.prolidiostopovice.cz') return;
  const url = new URL('https://stats.craz.cz/hit/ostopovice-events');
  url.searchParams.set('p', location.pathname + location.hash);
  if (document.referrer) url.searchParams.set('r', document.referrer);
  fetch(url, { mode: 'no-cors', keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
}

async function init() {
  countVisit();
  setupHeaderFit();
  try {
    const response = await fetch('data/opening-hours.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (err) {
    $('hours').innerHTML = `<p class="empty">Otevírací doby se nepodařilo načíst (${escapeHtml(err.message)}).</p>`;
    return;
  }
  readHash();
  setup();
  render();
}

init();
