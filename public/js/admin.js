'use strict';

// Správa akcí: úpravy se ukládají do config/overrides.json v repozitáři přes náš server
// api.craz.cz (projekt api-server): editor se přihlásí heslem, server zapíše soubor pod
// GitHub App s editorem jako autorem a k úpravě připíše editedBy/editedAt.
// Přegenerování webu (GitHub Action) spouští tlačítko, scripts/collect.js úpravy aplikuje.
//
// overrides.json:
//   series["zdroj|Původní název"] — všechny termíny akce (i budoucí)
//   events["id"]                  — jeden termín (má přednost)

const REPO = 'RJanata/ostopovice-events';
const BRANCH = 'main';
const OVERRIDES_PATH = 'config/overrides.json';
// při vývoji (stránka z localhostu) jde server přepnout: admin.html?api=http://localhost:3999/ostopovice-events
const API = (location.hostname === 'localhost' && new URLSearchParams(location.search).get('api'))
  || 'https://api.craz.cz/ostopovice-events';
const SESSION_KEY = 'adminSession';
const OLD_TOKEN_KEY = 'adminGithubToken'; // dřívější přístup osobním GitHub tokenem — při startu se smaže
const TIME_ZONE = 'Europe/Prague';

let data = null;
let sourcesById = {};
let categories = [];
let overrides = { series: {}, events: {} };
let overridesSha = null;
let editingId = null;
let editor = null; // přihlášený editor { id, firstName, name }

const $ = (id) => document.getElementById(id);

// ---------- Pomocné ----------

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** when = { start, end, allDay } ve formátu events.json */
function formatWhen(when) {
  if (when.allDay) {
    const [y, m, d] = when.start.split('-').map(Number);
    const text = `${d}. ${m}. ${y}`;
    return when.end && when.end !== when.start ? `${text} – ${when.end.split('-').map(Number).reverse().join('. ')}` : text;
  }
  return new Date(when.start).toLocaleString('cs-CZ', {
    timeZone: TIME_ZONE, day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function lastDay(when) {
  if (when.allDay) return when.end || when.start;
  return dayKey(new Date(when.end || when.start));
}

/** ISO okamžik → pražské { date: 'YYYY-MM-DD', time: 'HH:MM' } */
function toPragueParts(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Pražský místní čas → ISO v UTC (správně i přes přechod letního času). */
function fromPragueParts(date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms) => {
    const p = toPragueParts(new Date(ms).toISOString());
    const [py, pmo, pd] = p.date.split('-').map(Number);
    const [ph, pmi] = p.time.split(':').map(Number);
    return Date.UTC(py, pmo - 1, pd, ph, pmi) - ms;
  };
  let result = guess - offsetAt(guess);
  result = guess - offsetAt(result);
  return new Date(result).toISOString();
}

function setMessage(element, text, kind = '') {
  element.textContent = text;
  element.className = `admin-status${kind ? ` is-${kind}` : ''}`;
}

// ---------- Server (api.craz.cz) ----------

function getSession() {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}

function setSession(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* soukromý režim apod. */ }
}

/** Volání serveru; vrací JSON, chyby vyhazuje s českou zprávou ze serveru. */
async function api(path, { method = 'GET', body } = {}) {
  const session = getSession();
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Server správy (api.craz.cz) neodpovídá.');
  }
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/login') {
    setSession('');
    showEditor(null);
  }
  if (!response.ok) throw Object.assign(new Error(result.error || `Server: HTTP ${response.status}`), { status: response.status });
  return result;
}

function decodeBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

/** Úpravy: přihlášený je čte přes server, nepřihlášený jen pro prohlížení z veřejného repozitáře. */
async function loadOverrides() {
  if (editor) {
    const result = await api('/overrides');
    overrides = result.overrides;
    overridesSha = result.sha;
    return;
  }
  const response = await fetch(`https://api.github.com/repos/${REPO}/contents/${OVERRIDES_PATH}?ref=${BRANCH}`);
  if (response.status === 404) {
    overrides = { series: {}, events: {} };
    return;
  }
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  const parsed = JSON.parse(decodeBase64((await response.json()).content));
  overrides = { series: parsed.series || {}, events: parsed.events || {} };
}

async function saveOverrides(next, message) {
  if (!editor) throw new Error('Nejdřív se přihlaste (nahoře).');
  try {
    const result = await api('/overrides', { method: 'PUT', body: { overrides: next, sha: overridesSha, message } });
    overrides = result.overrides;
    overridesSha = result.sha;
  } catch (err) {
    if (err.status === 409) {
      await loadOverrides();
      throw new Error('Soubor mezitím změnil někdo jiný. Úpravy jsem znovu načetl, zkuste uložit ještě jednou.');
    }
    throw err;
  }
}

/**
 * Kolik úprav ještě není na webu: commity do overrides.json novější než poslední vygenerování dat.
 * Počítá se z GitHubu, takže to platí i po zavření prohlížeče nebo na jiném počítači.
 */
async function countUnpublishedChanges() {
  if (!editor) return 0;
  return (await api(`/pending?since=${encodeURIComponent(data.generatedAt)}`)).count;
}

async function updateRegenerateButton() {
  const button = $('regenerate');
  let count = 0;
  try {
    count = await countUnpublishedChanges();
  } catch {
    // bez spojení se serverem tlačítko jen nezvýrazníme
  }
  button.classList.toggle('button--alert', count > 0);
  button.textContent = count > 0
    ? `Přegenerovat web (${count} ${count === 1 ? 'úprava čeká' : count < 5 ? 'úpravy čekají' : 'úprav čeká'})`
    : 'Přegenerovat web';
}

/** Ikona kategorie jako na hlavní stránce (jednobarevné SVG jako maska). */
function categoryIcon(category) {
  if (!category.icon) return '';
  const url = new URL(`icons/categories/${category.icon}`, document.baseURI).href;
  return `<span class="cat-icon" style="--icon:url('${escapeHtml(url)}')"></span>`;
}

// ---------- Model akce ----------

const baseTitle = (e) => e.originalTitle || e.title;
const baseLocation = (e) => ('originalLocation' in e ? e.originalLocation : e.location) || '';
const seriesKey = (e) => `${e.source}|${baseTitle(e)}`;
const pick = (obj, key, originalKey) => (originalKey in obj ? obj[originalKey] : obj[key]);
const baseWhen = (e) => ({
  start: pick(e, 'start', 'originalStart'),
  end: pick(e, 'end', 'originalEnd'),
  allDay: pick(e, 'allDay', 'originalAllDay'),
});
const WHEN_FIELDS = ['start', 'end', 'allDay'];
// long ze zdroje (#long v popisu); undefined = rozhoduje délka akce
const baseLong = (e) => ('originalLong' in e ? (e.originalLong ?? undefined) : e.long);
const DISPLAY_VALUES = { auto: undefined, long: true, bar: false };
const displayOf = (long) => (long === true ? 'long' : long === false ? 'bar' : 'auto');

/** Kdo a kdy akci naposledy upravil (u hromadné i jednotlivé úpravy platí ta novější). */
function lastEdit(e) {
  const stamps = [overrides.series[seriesKey(e)], overrides.events[e.id]].filter((o) => o?.editedBy);
  if (!stamps.length) return '';
  const latest = stamps.reduce((a, b) => ((b.editedAt || '') > (a.editedAt || '') ? b : a));
  const date = latest.editedAt
    ? new Date(latest.editedAt).toLocaleDateString('cs-CZ', { timeZone: TIME_ZONE, day: 'numeric', month: 'numeric', year: 'numeric' })
    : '';
  return `${latest.editedBy}${date ? `, ${date}` : ''}`;
}

const STAMP_FIELDS = ['editedBy', 'editedAt'];
const withoutStamp = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !STAMP_FIELDS.includes(k)));

function effective(e) {
  const changes = { ...withoutStamp(overrides.series[seriesKey(e)]), ...withoutStamp(overrides.events[e.id]) };
  const base = baseWhen(e);
  return {
    changes,
    title: changes.title || baseTitle(e),
    when: {
      start: changes.start ?? base.start,
      end: changes.end ?? base.end,
      allDay: changes.allDay ?? base.allDay,
    },
    note: changes.note || '',
    location: 'location' in changes ? changes.location : baseLocation(e),
    categories: changes.categories || e.categories,
    hidden: Boolean(changes.hidden),
    long: 'long' in changes ? changes.long : baseLong(e),
    changed: Object.keys(changes).length > 0,
  };
}

/** Liší se úpravy od toho, co je teď na webu (events.json)? */
function isUnpublished(e, eff = effective(e)) {
  const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
  return !same(eff.title, e.title)
    || !same(eff.location, e.location)
    || !same(eff.note, e.note)
    || eff.hidden !== Boolean(e.hidden)
    || eff.long !== e.long
    || WHEN_FIELDS.some((f) => !same(eff.when[f], e[f]))
    || (eff.changes.categories && !same(eff.changes.categories, e.categories));
}

function seriesCount(e) {
  const key = seriesKey(e);
  return data.events.filter((x) => seriesKey(x) === key).length;
}

// ---------- Seznam ----------

/** Ručně změněná část akce: oranžově, v bublině původní hodnota ze zdroje. */
const edited = (changed, original) => (changed
  ? ` class="is-edited" title="${escapeHtml(original ? `Upraveno ručně, původně: ${original}` : 'Upraveno ručně')}"`
  : '');
const LONG_LABELS = { true: 'tenká čára', false: 'plný pruh', null: 'zobrazení automaticky' };

function renderList() {
  const query = normalize($('admin-search').value.trim());
  const source = $('admin-source').value;
  const upcomingOnly = $('admin-upcoming').checked;
  const changedOnly = $('admin-changed').checked;
  const today = dayKey(new Date());

  const rows = data.events.filter((e) => {
    if (sourcesById[e.source]?.display === 'dayLabel') return false;
    if (source && e.source !== source) return false;
    const eff = effective(e);
    if (upcomingOnly && lastDay(eff.when) < today) return false;
    if (changedOnly && !eff.changed) return false;
    if (query && !normalize(`${eff.title} ${baseTitle(e)}`).includes(query)) return false;
    return true;
  });

  if (!rows.length) {
    $('admin-list').innerHTML = '<p class="empty">Žádné akce neodpovídají filtru.</p>';
    return;
  }

  $('admin-list').innerHTML = rows.map((e) => {
    const eff = effective(e);
    const src = sourcesById[e.source] || { name: e.source };
    const tags = eff.categories
      .map((id) => categories.find((c) => c.id === id))
      .filter(Boolean)
      .map((c) => `<span class="tag" style="--chip-color:${escapeHtml(c.color)}">${categoryIcon(c)}${escapeHtml(c.label)}</span>`)
      .join('');
    const badges = [
      eff.changed && `<span class="admin-badge admin-badge--changed">upraveno${lastEdit(e) ? `: ${escapeHtml(lastEdit(e))}` : ''}</span>`,
      eff.hidden && '<span class="admin-badge admin-badge--hidden">skryto</span>',
      isUnpublished(e, eff) && '<span class="admin-badge admin-badge--pending">čeká na přegenerování webu</span>',
    ].filter(Boolean).join(' ');
    const ch = eff.changes;
    const renamed = eff.title !== baseTitle(e) ? `<span>původně: ${escapeHtml(baseTitle(e))}</span>` : '';
    const placeEdited = 'location' in ch && ch.location !== baseLocation(e);
    const placeText = eff.location || (placeEdited ? 'místo odebráno' : '');
    const place = placeText
      ? `<span${edited(placeEdited, baseLocation(e) || 'bez místa')}>📍 ${escapeHtml(placeText)}</span>`
      : '';
    const display = 'long' in ch ? `<span${edited(true)}>${LONG_LABELS[ch.long]}</span>` : '';
    const link = e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">původní akce ↗</a>` : '';
    const moved = formatWhen(eff.when) !== formatWhen(baseWhen(e)) ? `<span>původně: ${escapeHtml(formatWhen(baseWhen(e)))}</span>` : '';
    return `<div class="admin-row${eff.hidden ? ' admin-row--hidden' : ''}" data-id="${escapeHtml(e.id)}">
        <div class="admin-row__date"><span${edited(moved, formatWhen(baseWhen(e)))}>${escapeHtml(formatWhen(eff.when))}</span></div>
        <div>
          <div class="admin-row__title"><span${edited(renamed, baseTitle(e))}>${escapeHtml(eff.title)}</span></div>
          <div class="admin-row__meta">
            <span>${escapeHtml(src.name)}</span>${place}<span class="event__tags${ch.categories ? ' is-edited' : ''}"${ch.categories ? ' title="Kategorie upravené ručně"' : ''}>${tags}</span>${display}${renamed}${moved}${link}${badges}
          </div>
          ${eff.note ? `<div class="admin-row__note"><span${edited(true)}>${escapeHtml(eff.note)}</span></div>` : ''}
        </div>
        <button type="button" class="button button--small button--ghost" data-action="edit"${editor ? '' : ' disabled title="Nejdřív se přihlaste"'}>Upravit</button>
        ${editingId === e.id ? '<div class="admin-edit-slot"></div>' : ''}
      </div>`;
  }).join('');

  const slot = document.querySelector('.admin-edit-slot');
  if (slot) mountEditForm(slot, data.events.find((e) => e.id === editingId));
}

// ---------- Úprava ----------

function mountEditForm(slot, e) {
  const form = $('edit-form').content.firstElementChild.cloneNode(true);
  const eff = effective(e);
  const count = seriesCount(e);
  const ownChanges = overrides.events[e.id];

  form.elements.title.value = eff.title;
  form.elements.title.placeholder = baseTitle(e);
  form.querySelector('.admin-original').textContent = `Původní název ze zdroje: ${baseTitle(e)}`;
  form.elements.location.value = eff.location;
  form.elements.location.placeholder = baseLocation(e) || 'např. Sokolovna Ostopovice, Školní 5';
  form.querySelector('.admin-original-location').textContent = baseLocation(e)
    ? `Ze zdroje: ${baseLocation(e)}`
    : 'Zdroj místo neuvádí (nebo jde o „domácí“ místo pořadatele, které se nezobrazuje).';

  const catBox = form.querySelector('.admin-categories');
  catBox.innerHTML = categories.map((c) => `<label class="admin-check"><input type="checkbox" name="cat" value="${escapeHtml(c.id)}"${eff.categories.includes(c.id) ? ' checked' : ''}> ${escapeHtml(c.label)}</label>`).join('');
  form.elements.customCategories.checked = Boolean(eff.changes.categories);
  const syncCats = () => {
    const on = form.elements.customCategories.checked;
    catBox.setAttribute('aria-disabled', String(!on));
    catBox.querySelectorAll('input').forEach((i) => { i.disabled = !on; });
  };
  form.elements.customCategories.addEventListener('change', syncCats);
  syncCats();

  form.elements.hidden.checked = eff.hidden;
  form.elements.display.value = displayOf(eff.long);
  form.querySelector('.admin-original-display').textContent = baseLong(e) === true
    ? 'Ze zdroje: tenká čára (#long v popisu).'
    : 'Tenká čára = dlouhodobá akce (výstava, uzavírka…): v měsíci čára u čísel dnů, v seznamu zvlášť.';
  form.elements.note.value = eff.note;

  // datum a čas (prázdný čas = celodenní akce)
  const { when } = eff;
  if (when.allDay) {
    form.elements.startDate.value = when.start;
    form.elements.endDate.value = when.end && when.end !== when.start ? when.end : '';
  } else {
    const from = toPragueParts(when.start);
    const to = toPragueParts(when.end || when.start);
    form.elements.startDate.value = from.date;
    form.elements.startTime.value = from.time;
    form.elements.endDate.value = to.date !== from.date ? to.date : '';
    form.elements.endTime.value = when.end && when.end !== when.start ? to.time : '';
  }
  form.querySelector('.admin-original-when').textContent = `Ze zdroje: ${formatWhen(baseWhen(e))}`;

  const whenInputs = form.querySelectorAll('.admin-when input');
  const syncScope = () => {
    const series = count > 1 && form.elements.scope.value === 'series';
    whenInputs.forEach((i) => { i.disabled = series; });
    form.querySelector('.admin-when-series').hidden = !series;
  };

  if (count > 1) {
    form.querySelector('.admin-scope').hidden = false;
    form.querySelector('.admin-scope-series').textContent = `všechny termíny „${baseTitle(e)}“ (${count}, i budoucí)`;
    form.elements.scope.value = ownChanges ? 'event' : 'series';
    form.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener('change', syncScope));
  }
  syncScope();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const changes = {};
    const title = form.elements.title.value.trim();
    if (title && title !== baseTitle(e)) changes.title = title;
    const location = form.elements.location.value.trim();
    if (location !== baseLocation(e)) changes.location = location;
    if (form.elements.customCategories.checked) {
      const picked = [...form.querySelectorAll('input[name="cat"]:checked')].map((i) => i.value);
      if (!picked.length) {
        setMessage($('admin-message'), 'Vyberte aspoň jednu kategorii, nebo vypněte „Vlastní kategorie“.', 'error');
        return;
      }
      changes.categories = picked;
    }
    if (form.elements.hidden.checked) changes.hidden = true;
    const long = DISPLAY_VALUES[form.elements.display.value];
    if (long !== baseLong(e)) changes.long = long ?? null;
    const note = form.elements.note.value.trim();
    if (note) changes.note = note;

    const scope = count > 1 ? form.elements.scope.value : 'event';

    // datum a čas — jen u jednoho termínu
    if (scope === 'event') {
      let newWhen;
      try {
        newWhen = readWhen(form);
      } catch (err) {
        setMessage($('admin-message'), err.message, 'error');
        return;
      }
      const base = baseWhen(e);
      if (WHEN_FIELDS.some((f) => newWhen[f] !== base[f])) Object.assign(changes, newWhen);
    }

    const next = { series: { ...overrides.series }, events: { ...overrides.events } };
    if (scope === 'series') {
      next.series[seriesKey(e)] = changes;
      // úprava jednoho termínu by tu hromadnou přebila → necháme z ní jen přesunuté datum
      const own = next.events[e.id] || {};
      const keep = Object.fromEntries(WHEN_FIELDS.filter((f) => f in own).map((f) => [f, own[f]]));
      if (Object.keys(keep).length) next.events[e.id] = keep;
      else delete next.events[e.id];
    } else {
      next.events[e.id] = changes;
    }
    await commit(next, e, `Admin: ${changes.title || baseTitle(e)}`, scope);
  });

  form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    editingId = null;
    renderList();
  });

  form.querySelector('[data-action="reset"]').addEventListener('click', async () => {
    const next = { series: { ...overrides.series }, events: { ...overrides.events } };
    delete next.series[seriesKey(e)];
    delete next.events[e.id];
    await commit(next, e, `Admin: vrácení úprav „${baseTitle(e)}“`, 'series');
  });

  slot.replaceWith(form);
  form.elements.title.focus();
}

/** Datum a čas z formuláře → { start, end, allDay } ve formátu events.json */
function readWhen(form) {
  const startDate = form.elements.startDate.value;
  const startTime = form.elements.startTime.value;
  const endDate = form.elements.endDate.value || startDate;
  const endTime = form.elements.endTime.value;
  if (!startDate) throw new Error('Vyplňte datum začátku.');
  if (!startTime) {
    if (endTime) throw new Error('Bez času začátku je akce celodenní – smažte i čas konce, nebo doplňte čas začátku.');
    if (endDate < startDate) throw new Error('Konec akce je dřív než začátek.');
    return { start: startDate, end: endDate, allDay: true };
  }
  const start = fromPragueParts(startDate, startTime);
  const end = endTime ? fromPragueParts(endDate, endTime) : start;
  if (end < start) throw new Error('Konec akce je dřív než začátek.');
  return { start, end, allDay: false };
}

async function commit(next, e, message, scope) {
  const msg = $('admin-message');
  setMessage(msg, 'Ukládám…');
  try {
    await saveOverrides(next, message);
    editingId = null;
    setMessage(msg, 'Uloženo. Na web se úprava dostane po kliknutí na „Přegenerovat web“ (nebo při další automatické aktualizaci).', 'ok');
    renderList();
    updateRegenerateButton();
  } catch (err) {
    setMessage(msg, err.message, 'error');
  }
}

// ---------- Ruční načtení kalendářů (spuštění GitHub Action) ----------

const POLL_MS = 8000;
const POLL_LIMIT_MS = 6 * 60 * 1000;
const START_LIMIT_MS = 60 * 1000;
const PUBLISH_POLL_MS = 5000;
const PUBLISH_LIMIT_MS = 4 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let following = false; // právě sledujeme běžící načítání → tlačítka zůstávají neaktivní

/** Poslední běh workflow (ruční i automatický): { id, status, conclusion, event, createdAt, startedBy } */
async function latestRun() {
  return (await api('/runs/latest')).run;
}

function runLabel(run) {
  if (run.startedBy) return `spustil(a) ${run.startedBy}`;
  if (run.event === 'schedule') return 'automatická aktualizace';
  if (run.event === 'workflow_dispatch') return 'spuštěno ručně';
  return run.event;
}

function syncRefreshButtons() {
  document.querySelectorAll('[data-refresh]').forEach((b) => {
    b.disabled = !editor || following;
    b.title = !editor ? 'Nejdřív se přihlaste' : following ? 'Načítání právě běží' : '';
  });
}

/**
 * Sleduje běžící načítání až do konce. Čas se počítá od založení běhu na GitHubu,
 * takže po odchodu z adminu a návratu se ukáže správně. only = jen pro text hlášky.
 */
async function followRun(initial, only = '') {
  if (following) return;
  following = true;
  syncRefreshButtons();
  const status = $('refresh-status');
  let run = initial;
  let lastPoll = Date.now();
  // starší server čas založení běhu neposílá → počítat od chvíle, kdy jsme ho uviděli
  const seenAt = Date.now();
  const startOf = (r) => (r.createdAt ? new Date(r.createdAt).getTime() : seenAt);
  try {
    while (run.status !== 'completed') {
      const elapsed = Date.now() - startOf(run);
      if (elapsed > POLL_LIMIT_MS) {
        setMessage(status, 'Načítání trvá déle než obvykle – stav najdete na GitHubu v záložce Actions.');
        return;
      }
      setMessage(status, `${only === 'none' ? 'Přegenerovávám web' : 'Načítám kalendáře'} (${runLabel(run)})… ${Math.max(0, Math.round(elapsed / 1000))} s`);
      await sleep(1000);
      if (Date.now() - lastPoll >= POLL_MS) {
        lastPoll = Date.now();
        const latest = await latestRun();
        if (latest && (latest.id === run.id || startOf(latest) > startOf(run))) run = latest;
      }
    }
    if (run.conclusion === 'success') {
      const what = only === 'none' ? 'úpravy jsou promítnuté'
        : only ? `„${sourcesById[only]?.name || only}“ je načtený` : 'kalendáře jsou načtené';
      // web se nasazuje v témže běhu, ale pojistka: hotovo až když web opravdu vrací nová data
      // (CDN GitHub Pages); lokální náhled (localhost) nová data nikdy nedostane → tam nečekat
      const before = data.generatedAt;
      const done = Date.now();
      while (location.hostname !== 'localhost' && Date.now() - done < PUBLISH_LIMIT_MS) {
        setMessage(status, `Hotovo – ${what}, čekám na zveřejnění webu… ${Math.round((Date.now() - done) / 1000)} s`);
        await sleep(PUBLISH_POLL_MS);
        await reloadEvents({ render: false });
        if (data.generatedAt !== before) break;
      }
      renderList();
      if (data.generatedAt !== before) setMessage(status, `Hotovo – ${what} a web je aktualizovaný.`, 'ok');
      else if (location.hostname === 'localhost') setMessage(status, `Hotovo – ${what}. Ostrý web se zveřejní zhruba do minuty (lokální náhled má svá data).`, 'ok');
      else setMessage(status, `Hotovo – ${what}. Web se ještě zveřejňuje, za chvíli obnovte stránku.`, 'ok');
    } else {
      setMessage(status, `Načtení skončilo chybou (${run.conclusion}). Podrobnosti: GitHub → Actions.`, 'error');
    }
  } catch (err) {
    setMessage(status, err.message, 'error');
  } finally {
    following = false;
    syncRefreshButtons();
  }
}

/** Při otevření adminu: když se zrovna načítá (ručně i automaticky), ukázat to a sledovat. */
async function showRunningRun() {
  if (!editor || following) return;
  try {
    const run = await latestRun();
    if (run && run.status !== 'completed') followRun(run);
  } catch {
    // stav běhu je jen informace navíc
  }
}

/** Spustí načtení kalendářů; only = id jednoho zdroje, prázdné = všechny, 'none' = nic nestahovat (jen úpravy). */
async function refreshSources(only = '') {
  const status = $('refresh-status');
  if (!editor) {
    setMessage(status, 'Nejdřív se přihlaste (nahoře).', 'error');
    return;
  }
  if (following) return;
  following = true;
  syncRefreshButtons();
  let run = null;
  try {
    const before = await latestRun();
    await api('/refresh', { method: 'POST', body: { only } });
    setMessage(status, 'Spuštěno, čekám na start…');
    // GitHub běh založí až za pár sekund
    const asked = Date.now();
    while (!run && Date.now() - asked < START_LIMIT_MS) {
      await sleep(3000);
      const latest = await latestRun();
      if (latest && latest.id !== before?.id) run = latest;
    }
    if (!run) setMessage(status, 'Načítání se zatím nespustilo – stav najdete na GitHubu v záložce Actions.');
  } catch (err) {
    setMessage(status, err.message, 'error');
  } finally {
    following = false;
    syncRefreshButtons();
  }
  if (run) await followRun(run, only);
}

// ---------- Přihlášení ----------

function showEditor(next) {
  editor = next;
  $('login-form').hidden = Boolean(editor);
  $('login-info').hidden = !editor;
  $('login-name').textContent = editor ? editor.name : '';
  // bez přihlášení jde admin jen prohlížet: tlačítka úprav a načítání jsou neaktivní
  syncRefreshButtons();
  if (!editor) editingId = null;
  if (data) renderList();
}

async function checkSession() {
  const status = $('login-status');
  if (!getSession()) {
    showEditor(null);
    setMessage(status, 'Bez přihlášení lze úpravy jen prohlížet.');
    return;
  }
  try {
    showEditor((await api('/me')).editor);
    setMessage(status, '');
  } catch (err) {
    setMessage(status, err.message, 'error');
  }
}

function setupLogin() {
  try { localStorage.removeItem(OLD_TOKEN_KEY); } catch { /* nic */ }
  $('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const status = $('login-status');
    const password = $('login-password').value;
    if (!password) return;
    setMessage(status, 'Přihlašuji…');
    try {
      const result = await api('/login', { method: 'POST', body: { password } });
      setSession(result.token);
      showEditor(result.editor);
      $('login-password').value = '';
      setMessage(status, '');
      await reloadOverrides();
      updateRegenerateButton();
      showRunningRun();
    } catch (err) {
      setMessage(status, err.message, 'error');
    }
  });
  $('logout').addEventListener('click', () => {
    setSession('');
    showEditor(null);
    setMessage($('login-status'), 'Odhlášeno. Bez přihlášení lze úpravy jen prohlížet.');
    updateRegenerateButton();
  });
}

async function reloadOverrides() {
  try {
    await loadOverrides();
  } catch (err) {
    setMessage($('admin-message'), `Úpravy se nepodařilo načíst (${err.message}). Zobrazuji stav z webu.`, 'error');
  }
  renderList();
}

// ---------- Start ----------

async function reloadEvents({ render = true } = {}) {
  const response = await fetch(`data/events.json?t=${Date.now()}`, { cache: 'no-store' });
  data = await response.json();
  sourcesById = Object.fromEntries(data.sources.map((s) => [s.id, s]));
  categories = data.categories;
  $('last-update').textContent = new Date(data.generatedAt).toLocaleString('cs-CZ', {
    timeZone: TIME_ZONE, day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  if (render) renderList();
  updateRegenerateButton();
}

async function init() {
  setupLogin();
  await checkSession();

  await reloadEvents({ render: false });
  $('refresh-single').innerHTML = data.sources
    .filter((s) => s.adminRefresh)
    .map((s) => `<button type="button" class="button button--ghost" data-refresh="${escapeHtml(s.id)}">Načíst jen ${escapeHtml(s.name)}</button>`)
    .join(' ');
  document.querySelectorAll('[data-refresh]').forEach((b) => {
    b.addEventListener('click', () => refreshSources(b.dataset.refresh));
  });
  showEditor(editor); // tlačítka „Načíst jen…“ vznikla až teď → nastavit jim stav podle přihlášení
  $('admin-source').innerHTML += data.sources
    .filter((s) => s.display !== 'dayLabel')
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');

  ['admin-search', 'admin-source', 'admin-upcoming', 'admin-changed'].forEach((id) => {
    $(id).addEventListener(id === 'admin-search' ? 'input' : 'change', renderList);
  });
  $('admin-list').addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-action="edit"]');
    if (!button) return;
    const id = button.closest('.admin-row').dataset.id;
    editingId = editingId === id ? null : id;
    renderList();
  });

  await reloadOverrides();
  showRunningRun();
}

init();
