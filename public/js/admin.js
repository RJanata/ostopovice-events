'use strict';

// Správa akcí: úpravy se ukládají do config/overrides.json v repozitáři přes GitHub API.
// Commit spustí GitHub Action, která web přegeneruje (scripts/collect.js úpravy aplikuje).
//
// overrides.json:
//   series["zdroj|Původní název"] — všechny termíny akce (i budoucí)
//   events["id"]                  — jeden termín (má přednost)

const REPO = 'RJanata/ostopovice-events';
const BRANCH = 'main';
const OVERRIDES_PATH = 'config/overrides.json';
const TOKEN_KEY = 'adminGithubToken';
const TIME_ZONE = 'Europe/Prague';

const OVERRIDES_COMMENT = 'Ruční úpravy akcí (spravuje je i admin.html). series: klíč "zdroj|Původní název" = platí pro '
  + 'všechny termíny akce s tímto názvem, i budoucí. events: klíč = id jednoho termínu (má přednost). '
  + 'Hodnoty: title, categories, location, hidden (true = nezobrazovat).';

let data = null;
let sourcesById = {};
let categories = [];
let overrides = { series: {}, events: {} };
let overridesSha = null;
let editingId = null;

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

// ---------- GitHub API ----------

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

async function github(path, options = {}) {
  const token = getToken();
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return response;
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

async function loadOverrides() {
  const response = await github(`/repos/${REPO}/contents/${OVERRIDES_PATH}?ref=${BRANCH}`);
  if (response.status === 404) {
    overrides = { series: {}, events: {} };
    overridesSha = null;
    return;
  }
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  const file = await response.json();
  const parsed = JSON.parse(decodeBase64(file.content));
  overrides = { series: parsed.series || {}, events: parsed.events || {} };
  overridesSha = file.sha;
}

function serializeOverrides(o) {
  const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v && Object.keys(v).length));
  return `${JSON.stringify({ $comment: OVERRIDES_COMMENT, series: clean(o.series), events: clean(o.events) }, null, 2)}\n`;
}

async function saveOverrides(next, message) {
  if (!getToken()) throw new Error('Nejdřív uložte GitHub token (nahoře).');
  const response = await github(`/repos/${REPO}/contents/${OVERRIDES_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({
      // [skip ci] = commit nespustí přegenerování webu; to se udělá najednou tlačítkem „Přegenerovat web“
      message: `${message} [skip ci]`,
      content: encodeBase64(serializeOverrides(next)),
      branch: BRANCH,
      ...(overridesSha ? { sha: overridesSha } : {}),
    }),
  });
  if (response.status === 409 || response.status === 422) {
    await loadOverrides();
    throw new Error('Soubor mezitím změnil někdo jiný. Úpravy jsem znovu načetl, zkuste uložit ještě jednou.');
  }
  if (response.status === 401 || response.status === 403) throw new Error('Token nemá oprávnění zapisovat do repozitáře.');
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  const result = await response.json();
  overrides = { series: next.series, events: next.events };
  overridesSha = result.content.sha;
}

/**
 * Kolik úprav ještě není na webu: commity do overrides.json novější než poslední vygenerování dat.
 * Počítá se z GitHubu, takže to platí i po zavření prohlížeče nebo na jiném počítači.
 */
async function countUnpublishedChanges() {
  const since = data.generatedAt;
  const response = await github(`/repos/${REPO}/commits?path=${OVERRIDES_PATH}&sha=${BRANCH}&since=${since}&per_page=100`);
  if (!response.ok) return 0;
  const commits = await response.json();
  return commits.filter((c) => new Date(c.commit.committer.date) > new Date(since)).length;
}

async function updateRegenerateButton() {
  const button = $('regenerate');
  let count = 0;
  try {
    count = await countUnpublishedChanges();
  } catch {
    // bez spojení s GitHubem tlačítko jen nezvýrazníme
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

function effective(e) {
  const changes = { ...overrides.series[seriesKey(e)], ...overrides.events[e.id] };
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
    || WHEN_FIELDS.some((f) => !same(eff.when[f], e[f]))
    || (eff.changes.categories && !same(eff.changes.categories, e.categories));
}

function seriesCount(e) {
  const key = seriesKey(e);
  return data.events.filter((x) => seriesKey(x) === key).length;
}

// ---------- Seznam ----------

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
      eff.changed && '<span class="admin-badge admin-badge--changed">upraveno</span>',
      eff.hidden && '<span class="admin-badge admin-badge--hidden">skryto</span>',
      isUnpublished(e, eff) && '<span class="admin-badge admin-badge--pending">čeká na přegenerování webu</span>',
    ].filter(Boolean).join(' ');
    const renamed = eff.title !== baseTitle(e) ? `<span>původně: ${escapeHtml(baseTitle(e))}</span>` : '';
    const place = eff.location ? `<span>📍 ${escapeHtml(eff.location)}</span>` : '';
    const link = e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">původní akce ↗</a>` : '';
    const moved = formatWhen(eff.when) !== formatWhen(baseWhen(e)) ? `<span>původně: ${escapeHtml(formatWhen(baseWhen(e)))}</span>` : '';
    return `<div class="admin-row${eff.hidden ? ' admin-row--hidden' : ''}" data-id="${escapeHtml(e.id)}">
        <div class="admin-row__date">${escapeHtml(formatWhen(eff.when))}</div>
        <div>
          <div class="admin-row__title">${escapeHtml(eff.title)}</div>
          <div class="admin-row__meta">
            <span>${escapeHtml(src.name)}</span>${place}<span class="event__tags">${tags}</span>${renamed}${moved}${link}${badges}
          </div>
          ${eff.note ? `<div class="admin-row__note">${escapeHtml(eff.note)}</div>` : ''}
        </div>
        <button type="button" class="button button--small button--ghost" data-action="edit">Upravit</button>
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

const WORKFLOW_FILE = 'update.yml';
const POLL_MS = 8000;
const POLL_LIMIT_MS = 6 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function latestDispatchRun() {
  const response = await github(`/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=1`);
  if (!response.ok) return null;
  return (await response.json()).workflow_runs?.[0] || null;
}

/** Spustí načtení kalendářů; only = id jednoho zdroje, prázdné = všechny. */
async function refreshSources(only = '') {
  const buttons = document.querySelectorAll('[data-refresh]');
  const status = $('refresh-status');
  if (!getToken()) {
    setMessage(status, 'Nejdřív uložte GitHub token (nahoře).', 'error');
    return;
  }
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const before = await latestDispatchRun();
    const response = await github(`/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: BRANCH, inputs: { only } }),
    });
    if (response.status === 403 || response.status === 404) {
      throw new Error('Token nemá oprávnění spouštět Actions (Permissions → Actions: Read and write).');
    }
    if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
    setMessage(status, 'Spuštěno, čekám na start…');

    // počkat na nový běh a sledovat ho do konce
    const started = Date.now();
    let run = null;
    while (Date.now() - started < POLL_LIMIT_MS) {
      await sleep(POLL_MS);
      const latest = await latestDispatchRun();
      if (latest && latest.id !== before?.id) run = latest;
      if (!run) continue;
      if (run.status !== 'completed') {
        setMessage(status, `Načítám kalendáře… (${Math.round((Date.now() - started) / 1000)} s)`);
        continue;
      }
      if (run.conclusion === 'success') {
        const what = only ? `„${sourcesById[only]?.name || only}“ je načtený` : 'kalendáře jsou načtené';
        setMessage(status, `Hotovo – ${what} a web je aktualizovaný.`, 'ok');
        await reloadEvents();
      } else {
        setMessage(status, `Načtení skončilo chybou (${run.conclusion}). Podrobnosti: GitHub → Actions.`, 'error');
      }
      return;
    }
    setMessage(status, 'Načítání trvá déle než obvykle – stav najdete na GitHubu v záložce Actions.');
  } catch (err) {
    setMessage(status, err.message, 'error');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// ---------- Token ----------

async function checkToken() {
  const status = $('token-status');
  const token = getToken();
  $('token-forget').hidden = !token;
  if (!token) {
    setMessage(status, 'Bez tokenu lze úpravy jen prohlížet.');
    return;
  }
  const response = await github(`/repos/${REPO}`);
  if (!response.ok) {
    setMessage(status, `Token nefunguje (HTTP ${response.status}).`, 'error');
    return;
  }
  const repo = await response.json();
  if (repo.permissions && !repo.permissions.push) {
    setMessage(status, 'Token repozitář vidí, ale nemá právo zápisu (Contents: Read and write).', 'error');
    return;
  }
  setMessage(status, 'Token je uložený a funguje.', 'ok');
}

function setupToken() {
  $('repo-name').textContent = REPO;
  $('token-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const value = $('token-input').value.trim();
    if (!value) return;
    try { localStorage.setItem(TOKEN_KEY, value); } catch { /* nic */ }
    $('token-input').value = '';
    await checkToken();
    await reloadOverrides();
  });
  $('token-forget').addEventListener('click', () => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* nic */ }
    checkToken();
  });
}

async function reloadOverrides() {
  try {
    await loadOverrides();
  } catch (err) {
    setMessage($('admin-message'), `Úpravy se nepodařilo načíst z GitHubu (${err.message}). Zobrazuji stav z webu.`, 'error');
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
  setupToken();
  checkToken();

  await reloadEvents({ render: false });
  $('refresh-single').innerHTML = data.sources
    .filter((s) => s.adminRefresh)
    .map((s) => `<button type="button" class="button button--ghost" data-refresh="${escapeHtml(s.id)}">Načíst jen ${escapeHtml(s.name)}</button>`)
    .join(' ');
  document.querySelectorAll('[data-refresh]').forEach((b) => {
    b.addEventListener('click', () => refreshSources(b.dataset.refresh));
  });
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
}

init();
