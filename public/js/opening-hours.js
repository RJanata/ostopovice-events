'use strict';

// Otevírací doby: data/opening-hours.json (generuje scripts/lib/opening-hours.js z configu).
// Karta = jedno místo s otevírací dobou na zvolený týden (Po–Ne); výjimky z adminu se do
// týdne promítnou a zvýrazní, svátky jsou u dne vyznačené. U názvu ikona „teď otevřeno / zavřeno“.

const TIME_ZONE = 'Europe/Prague';
const DAY_ON = ['v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu', 'v neděli'];
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

const {
  DAY_SHORT, addDays, weekdayIndex, formatShort, toMinutes, formatTime, isoWeek, regularHours, regularIntervals,
} = window.OpeningHours; // opening-hours-core.js

/** „10.–16. 11.“, přes konec měsíce „30. 11. – 6. 12.“ */
function formatRange(from, to) {
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}.–${formatShort(to)}`;
  return `${formatShort(from)} – ${formatShort(to)}`;
}

// ---------- Otevírací doba v konkrétní den ----------

/**
 * Intervaly otevření v daný den: [{ from, to, note }], prázdné = zavřeno, null = neznámé.
 * exception = výjimka, která ten den platí (má přednost před pravidelnou dobou).
 */
const hoursOn = (place, day) => window.OpeningHours.hoursOn(data.exceptions, place, day);

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

// ikonka „i“ u upravené doby (výjimky); v bublině běžná otevírací doba
// „!“ v trojúhelníku (Tabler alert-triangle)
const ICON_INFO = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0"/><path d="M12 16h.01"/></svg>';
const infoIcon = (info) => (info ? `<span class="hours-day__info" title="${escapeHtml(info)}">${ICON_INFO}</span>` : '');

function intervalHtml(i, info = '') {
  return `<span class="hours-day__interval">${infoIcon(info)}${formatTime(i.from)}–${formatTime(i.to)}${i.note ? `<small>${escapeHtml(i.note)}</small>` : ''}</span>`;
}

// akce z kalendáře u místa v daný den: ikonka kalendáře u dne, v bublině čas a název, odkaz na měsíc v kalendáři
const ICON_EVENT = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h3v3H8z" fill="currentColor" stroke="none"/></svg>';
const eventsOn = (place, day) => (place.events || []).filter((e) => e.day === day);
const eventText = (e) => `${e.time ? `${e.time} ` : ''}${e.title}`;

/** Ikonka akce s časem začátku první akce (víc akcí = „+N“). */
function eventsIcon(place, day) {
  const list = eventsOn(place, day);
  if (!list.length) return '';
  const text = list.map(eventText).join('\n');
  const time = list[0].time || 'celý den';
  // není odkaz: klepnutí rozbalí řádek s podrobnostmi (tam je odkaz do kalendáře)
  return `<span class="hours-day__event" title="${escapeHtml(text)}" aria-label="${escapeHtml(`Akce: ${text}`)}">${ICON_EVENT}<span>${escapeHtml(time)}${list.length > 1 ? ` +${list.length - 1}` : ''}</span></span>`;
}

/**
 * Podrobnosti dne po klepnutí na řádek (hlavně pro mobil, kde nejsou bubliny):
 * svátek, výjimka s běžnou dobou a akce z kalendáře.
 */
function dayDetails(place, day, exception, holiday) {
  const parts = [];
  if (holiday) parts.push(`<li class="hours-detail hours-detail--holiday">${escapeHtml(holiday.join(' · '))}</li>`);
  if (exception) {
    // upravená doba je vidět v řádku; tady jen ta běžná (a důvod výjimky)
    parts.push(`<li class="hours-detail hours-detail--exception">Běžně: ${escapeHtml(intervalsText(regularIntervals(place, day)))}`
      + `${exception.note ? ` · ${escapeHtml(exception.note)}` : ''}</li>`);
  }
  for (const e of eventsOn(place, day)) {
    // odkaz do kalendáře rovnou s vybraným dnem (#d=…)
    parts.push(`<li class="hours-detail"><a href="./#d=${day}">${ICON_EVENT}${escapeHtml(eventText(e))}</a></li>`);
  }
  return parts.join('');
}

const openDays = new Set(); // rozbalené řádky „místo|den“ (přežijí překreslení každou minutu)

const intervalsText = (list) => (list === null ? 'neznámá' : list.length
  ? list.map((i) => `${formatTime(i.from)}–${formatTime(i.to)}`).join(', ') : 'zavřeno');

/**
 * Časy dne. V kartě, kde má některý den dopoledne i odpoledne, jsou dva sloupce:
 * dopolední intervaly vlevo, odpolední vpravo — ať jsou stejné časy pod sebou.
 */
function timesHtml(intervals, twoColumns, info = '') {
  if (!intervals) return '<span class="hours-day__closed">?</span>';
  // info = text běžné doby u výjimky: ikonka „i“ vlevo od první (nebo jediné) hodnoty
  if (!intervals.length) return `<span class="hours-day__closed">${infoIcon(info)}—</span>`;
  if (!twoColumns || intervals.length > 2) return intervals.map((i, n) => intervalHtml(i, n ? '' : info)).join('');
  const slots = ['', ''];
  if (intervals.length === 2) intervals.forEach((i, n) => { slots[n] = intervalHtml(i, n ? '' : info); });
  else slots[toMinutes(intervals[0].from) < NOON ? 0 : 1] = intervalHtml(intervals[0], info);
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
    const regularInfo = exception ? `Běžně: ${intervalsText(regularIntervals(place, day))}` : '';
    const classes = ['hours-day',
      day === now.day && 'hours-day--today',
      i >= 5 && 'hours-day--weekend',
      holiday && 'hours-day--holiday',
      holiday && 'hours-day--holiday-tint', // svátek podbarvený i s výjimkou (výjimka jen barvou doby)
      exception && 'hours-day--exception',
      intervals && !intervals.length && 'hours-day--closed',
      twoColumns && 'hours-day--two'].filter(Boolean).join(' ');
    const title = [`${DAY_SHORT[i]} ${formatShort(day)}`, holiday?.join(' · '), exception && `Výjimka: ${exceptionText(exception)}`].filter(Boolean).join(' – ');
    const details = dayDetails(place, day, exception, holiday);
    const key = `${place.id}|${day}`;
    const open = details && openDays.has(key);
    const expandable = details
      ? ` data-day-key="${escapeHtml(key)}" role="button" tabindex="0" aria-expanded="${open}"` : '';
    return `<li class="${classes}${details ? ' hours-day--expandable' : ''}${open ? ' hours-day--open' : ''}" title="${escapeHtml(title)}"${expandable}>
        <span class="hours-day__name"><span class="hours-day__weekday">${DAY_SHORT[i]}</span><small class="hours-day__date"><span>${Number(day.slice(8))}.</span><span>${Number(day.slice(5, 7))}.</span></small>${eventsIcon(place, day)}</span>
        <span class="hours-day__times"${regularInfo ? ` title="${escapeHtml(regularInfo)}"` : ''}>${timesHtml(intervals, twoColumns, regularInfo)}</span>
        ${exception?.note ? `<span class="hours-day__note">${escapeHtml(exception.note)}</span>` : ''}
        ${details ? `<ul class="hours-day__details"${open ? '' : ' hidden'}>${details}</ul>` : ''}
      </li>`;
  }).join('');

  // výjimky jen z následujícího týdne (po zobrazeném), ať je dovolená vidět včas; vzdálenější ani proběhlé ne.
  // Výjimka, která zasahuje i do zobrazeného týdne, je vidět přímo u dnů.
  const weekEnd = addDays(weekStart, 6);
  const nextWeekEnd = addDays(weekStart, 13);
  // jen výjimky, které u místa opravdu něco mění (ne „zavřeno“, když má běžně zavřeno)
  const upcoming = data.exceptions.filter((x) => x.places.includes(place.id)
    && x.from > weekEnd && x.from <= nextWeekEnd && window.OpeningHours.exceptionChanges(x, place));

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
  // klepnutí na den s podrobnostmi (svátek, výjimka, akce) rozbalí / sbalí řádek; odkazy fungují normálně
  const toggleDay = (row) => {
    const open = !openDays.has(row.dataset.dayKey);
    if (open) openDays.add(row.dataset.dayKey); else openDays.delete(row.dataset.dayKey);
    row.classList.toggle('hours-day--open', open);
    row.setAttribute('aria-expanded', String(open));
    row.querySelector('.hours-day__details').hidden = !open;
  };
  $('hours').addEventListener('click', (ev) => {
    const row = ev.target.closest('.hours-day--expandable');
    if (row && !ev.target.closest('a')) toggleDay(row);
  });
  $('hours').addEventListener('keydown', (ev) => {
    const row = ev.target.closest?.('.hours-day--expandable');
    if (row && ev.target === row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggleDay(row); }
  });
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
