'use strict';

// Správa výjimek z otevírací doby: config/opening-hours-exceptions.json v repozitáři přes náš
// server api.craz.cz (stejné přihlášení jako správa akcí). Server po uložení sám spustí
// přegenerování webu (jen promítnutí, nic nestahuje), takže výjimka je venku do pár minut.
// Pravidelné otevírací doby a seznam míst jsou v config/opening-hours.json (mění se v gitu).

// při vývoji (stránka z localhostu) jde server přepnout: admin-hours.html?api=http://localhost:3999/ostopovice-events
const API = (location.hostname === 'localhost' && new URLSearchParams(location.search).get('api'))
  || 'https://api.craz.cz/ostopovice-events';
const SESSION_KEY = 'adminSession'; // sdílené se správou akcí
const TIME_ZONE = 'Europe/Prague';

let editor = null;
let categories = [];
let places = [];
let exceptions = [];
let sha = null;
let editingId = null;

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const formatTime = (hhmm) => hhmm.replace(/^0(?=\d)/, '');
/** „8:00“, „8.00“, „800“, „8“ → "08:00"; neplatné → null */
function parseTime(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})(?:[:.]?(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (h > 24 || min > 59 || (h === 24 && min)) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
const formatDate = (key) => `${Number(key.slice(8))}. ${Number(key.slice(5, 7))}. ${key.slice(0, 4)}`;
const formatRange = (x) => (x.from === x.to ? formatDate(x.from) : `${formatDate(x.from)} – ${formatDate(x.to)}`);
const formatHours = (hours) => (hours.length ? hours.map((h) => h.split('-').map((t) => t.replace(/^0(?=\d)/, '')).join('–')).join(', ') : 'zavřeno');

function setMessage(element, text, kind = '') {
  element.textContent = text;
  element.className = `admin-status${kind ? ` is-${kind}` : ''}`;
}

// ---------- Server ----------

function getSession() {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}

function setSession(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* soukromý režim apod. */ }
}

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

// ---------- Přihlášení ----------

function showEditor(value) {
  editor = value;
  $('login-form').hidden = Boolean(editor);
  $('login-info').hidden = !editor;
  $('login-name').textContent = editor ? editor.name : '';
  $('editor-box').hidden = !editor;
  $('list-box').hidden = !editor;
}

let readOnly = false; // server správy otevírací doby nezná → jen prohlížení z veřejných dat
// veřejná data webu: pravidelné otevírací doby a svátky pro náhled (server posílá jen seznam míst)
let publicData = { places: [], holidays: {} };

async function loadPublicData() {
  try {
    const response = await fetch('data/opening-hours.json', { cache: 'no-cache' });
    if (response.ok) publicData = await response.json();
  } catch { /* náhled pak ukáže jen výjimku */ }
}

async function load() {
  let result;
  await loadPublicData();
  try {
    result = await api('/opening-hours');
    readOnly = false;
  } catch (err) {
    if (err.status !== 404) throw err;
    // starší api-server (bez /opening-hours) odpoví „Neznámá adresa“ → aspoň ukázat, co je na webu
    result = { ...publicData, sha: null };
    readOnly = true;
  }
  categories = result.categories;
  places = result.places;
  exceptions = result.exceptions;
  sha = result.sha;
  $('x-save').disabled = readOnly;
  renderPlaceSelect();
  renderList();
  renderPreview();
  if (readOnly) throw new Error('Server správy (api.craz.cz) zatím otevírací doby nezná – je potřeba nasadit novou verzi api-serveru. Do té doby jde výjimky jen prohlížet.');
}

async function start() {
  const status = $('login-status');
  if (!getSession()) {
    showEditor(null);
    setMessage(status, 'Pro úpravy výjimek se přihlaste.');
    return;
  }
  try {
    showEditor((await api('/me')).editor);
    setMessage(status, 'Načítám výjimky…');
    await load();
    setMessage(status, '');
  } catch (err) {
    setMessage(status, err.message, 'error');
  }
}

function setupLogin() {
  $('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const status = $('login-status');
    const password = $('login-password').value;
    if (!password) return;
    setMessage(status, 'Přihlašuji…');
    try {
      const result = await api('/login', { method: 'POST', body: { password } });
      setSession(result.token);
      $('login-password').value = '';
      await start();
    } catch (err) {
      setMessage(status, err.message, 'error');
    }
  });
  $('logout').addEventListener('click', () => {
    setSession('');
    showEditor(null);
    setMessage($('login-status'), 'Odhlášeno.');
  });
}

// ---------- Formulář ----------

/** Zaškrtávací seznam míst po druzích; zaškrtávátko druhu vybere / zruší celý druh. */
function renderPlaceSelect() {
  const checked = new Set(selectedPlaces());
  // druhy bez míst (Služby zatím prázdné) ve výběru nezobrazovat
  $('x-places').innerHTML = categories.filter((c) => places.some((p) => p.category === c.id)).map((c) => `<div class="hours-places__group">
      <label class="admin-check hours-places__category"><input type="checkbox" data-category="${escapeHtml(c.id)}"> <strong>${escapeHtml(c.label)}</strong></label>
      ${places.filter((p) => p.category === c.id).map((p) => `<label class="admin-check"><input type="checkbox" value="${escapeHtml(p.id)}" data-in="${escapeHtml(c.id)}"${checked.has(p.id) ? ' checked' : ''}>
        ${escapeHtml(p.name)}${p.village ? ` (${escapeHtml(p.village)})` : ''}</label>`).join('')}
    </div>`).join('');
  syncPlaceChecks();
}

const selectedPlaces = () => [...$('x-places').querySelectorAll('input[value]:checked')].map((i) => i.value);

function setSelectedPlaces(ids) {
  $('x-places').querySelectorAll('input[value]').forEach((input) => { input.checked = ids.includes(input.value); });
  syncPlaceChecks();
}

/** Stav zaškrtávátek druhů (vše / nic / část) a počet vybraných. */
function syncPlaceChecks() {
  $('x-places').querySelectorAll('input[data-category]').forEach((box) => {
    const items = [...$('x-places').querySelectorAll(`input[data-in="${box.dataset.category}"]`)];
    const on = items.filter((i) => i.checked).length;
    box.checked = on > 0 && on === items.length;
    box.indeterminate = on > 0 && on < items.length;
  });
  const count = selectedPlaces().length;
  $('x-count').textContent = count ? `vybráno: ${count} z ${places.length}` : '';
}

/** Popis míst výjimky: „Všechna místa“, „Pohostinství“, nebo názvy. */
function placesLabel(ids) {
  if (ids.length === places.length) return 'Všechna místa';
  const parts = [];
  let rest = [...ids];
  for (const c of categories) {
    const inCategory = places.filter((p) => p.category === c.id).map((p) => p.id);
    if (inCategory.length > 1 && inCategory.every((id) => rest.includes(id))) {
      parts.push(`${c.label} (vše)`);
      rest = rest.filter((id) => !inCategory.includes(id));
    }
  }
  return [...parts, ...rest.map((id) => places.find((p) => p.id === id)?.name || id)].join(', ');
}

const placesOf = (x) => x.places || (x.place ? [x.place] : []);

function intervalInputs() {
  return [...$('x-intervals').querySelectorAll('.admin-when__row')].map((row) => ({
    from: row.querySelector('[data-from]'),
    to: row.querySelector('[data-to]'),
  }));
}

function syncMode() {
  const hoursMode = document.querySelector('input[name="x-mode"]:checked').value === 'hours';
  $('x-intervals').hidden = !hoursMode;
}

function fillForm(x) {
  editingId = x?.id || null;
  $('form-title').textContent = x ? 'Úprava výjimky' : 'Nová výjimka';
  $('x-cancel').hidden = !x;
  setSelectedPlaces(x ? placesOf(x) : []);
  $('x-from').setIso(x?.from || '');
  $('x-to').setIso(x && x.to !== x.from ? x.to : '');
  $('x-note').value = x?.note || '';
  document.querySelector(`input[name="x-mode"][value="${x?.hours.length ? 'hours' : 'closed'}"]`).checked = true;
  intervalInputs().forEach((inputs, i) => {
    const [from, to] = (x?.hours[i] || '').split('-');
    inputs.from.value = from ? formatTime(from) : '';
    inputs.to.value = to ? formatTime(to) : '';
  });
  syncMode();
  renderPreview();
}

/** Hodnoty formuláře → výjimka; při chybě vyhodí zprávu pro editora. */
function readForm() {
  const selected = selectedPlaces();
  const from = $('x-from').getIso();
  const toValue = $('x-to').getIso();
  if (!selected.length) throw new Error('Vyberte aspoň jedno místo.');
  if (!from) throw new Error(from === null ? 'Datum „od“ zadejte jako d. m. rrrr.' : 'Vyplňte datum.');
  if (toValue === null) throw new Error('Datum „do“ zadejte jako d. m. rrrr.');
  const to = toValue || from;
  if (to < from) throw new Error('Datum „do“ je dřív než „od“.');
  let hours = [];
  if (document.querySelector('input[name="x-mode"]:checked').value === 'hours') {
    for (const { from: f, to: t } of intervalInputs()) {
      if (!f.value.trim() && !t.value.trim()) continue;
      const start = parseTime(f.value);
      const end = parseTime(t.value);
      if (!start || !end || end <= start) throw new Error('Čas otevření musí mít začátek i konec ve tvaru 8:00 (konec po začátku).');
      hours.push(`${start}-${end}`);
    }
    if (!hours.length) throw new Error('Vyplňte otevírací dobu, nebo zvolte „Zavřeno“.');
  }
  const id = editingId || `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return { id, places: selected, from, to, hours, note: $('x-note').value.trim() };
}

async function save(next, message) {
  const status = $('save-status');
  setMessage(status, 'Ukládám…');
  try {
    const result = await api('/opening-hours/exceptions', { method: 'PUT', body: { exceptions: next, sha, message } });
    exceptions = result.exceptions;
    sha = result.sha;
    renderList();
    setMessage(status, result.published
      ? 'Uloženo. Web se přegeneruje, na webu bude asi za 2 minuty.'
      : 'Uloženo. Na web se dostane s nejbližší automatickou aktualizací.', 'ok');
    return true;
  } catch (err) {
    if (err.status === 409) {
      setMessage(status, `${err.message} Načítám aktuální stav – zkuste to prosím znovu.`, 'error');
      await load().catch(() => {});
    } else {
      setMessage(status, err.message, 'error');
    }
    return false;
  }
}

function setupForm() {
  document.querySelectorAll('input[name="x-mode"]').forEach((input) => input.addEventListener('change', syncMode));
  $('x-places').addEventListener('change', (ev) => {
    const category = ev.target.dataset.category;
    if (category) {
      $('x-places').querySelectorAll(`input[data-in="${category}"]`).forEach((i) => { i.checked = ev.target.checked; });
    }
    syncPlaceChecks();
  });
  $('x-all').addEventListener('click', () => setSelectedPlaces(places.map((p) => p.id)));
  $('x-none').addEventListener('click', () => setSelectedPlaces([]));
  $('x-cancel').addEventListener('click', () => { fillForm(null); setMessage($('save-status'), ''); });
  // náhled se překresluje při každé změně formuláře
  $('exception-form').addEventListener('input', renderPreview);
  $('exception-form').addEventListener('change', renderPreview);
  $('x-all').addEventListener('click', renderPreview);
  $('x-none').addEventListener('click', renderPreview);
  $('exception-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    let x;
    try {
      x = readForm();
    } catch (err) {
      setMessage($('save-status'), err.message, 'error');
      return;
    }
    const editing = Boolean(editingId);
    const next = editing ? exceptions.map((e) => (e.id === x.id ? x : e)) : [...exceptions, x];
    $('x-save').disabled = true;
    const ok = await save(next, `Otevírací doby: ${editing ? 'úprava' : 'nová'} výjimka ${placesLabel(x.places)} ${formatRange(x)}`);
    $('x-save').disabled = false;
    // formulář zůstává vyplněný (místa, data, časy) — další podobnou výjimku jde zadat jen úpravou;
    // po uložení nové výjimky je další uložení zase nová výjimka, po úpravě se dál upravuje ta samá
    if (ok) renderPreview();
  });
}

// ---------- Náhled ----------

const PREVIEW_MAX_DAYS = 31;
const intervalsText = (list) => (list === null ? '?' : list.length
  ? list.map((i) => `${formatTime(i.from)}–${formatTime(i.to)}`).join(', ')
  : '—');

/**
 * Tabulka pod formulářem: vybraná místa × dny výjimky. U každého dne běžná otevírací doba
 * (nebo jiná výjimka, která už ten den platí) a co z ní udělá právě zadávaná výjimka.
 */
function renderPreview() {
  const box = $('x-preview');
  if (!box) return;
  const H = window.OpeningHours;
  const selected = selectedPlaces();
  const from = $('x-from').getIso();
  const to = $('x-to').getIso() || from;
  if (!selected.length || !from || !to || to < from) {
    box.innerHTML = '<p class="admin-help">Náhled: vyberte místa a datum, ukáže se otevírací doba v těchto dnech před a po výjimce.</p>';
    return;
  }
  // zadávaná výjimka (i nedovyplněná: neúplné časy se zatím přeskočí)
  let draft = [];
  if (document.querySelector('input[name="x-mode"]:checked').value === 'hours') {
    draft = intervalInputs()
      .map(({ from: f, to: t }) => [parseTime(f.value), parseTime(t.value)])
      .filter(([a, b]) => a && b && b > a)
      .map(([a, b]) => ({ from: a, to: b }));
  }
  const others = exceptions.filter((x) => x.id !== editingId);
  const days = [];
  for (let d = from; d <= to && days.length < PREVIEW_MAX_DAYS; d = H.addDays(d, 1)) days.push(d);
  const fullById = Object.fromEntries((publicData.places || []).map((p) => [p.id, p]));

  const head = days.map((d) => {
    const holiday = publicData.holidays?.[d];
    const weekend = H.weekdayIndex(d) >= 5;
    return `<th class="${holiday || weekend ? 'is-off' : ''}"${holiday ? ` title="${escapeHtml(holiday.join(' · '))}"` : ''}>
        ${H.DAY_SHORT[H.weekdayIndex(d)]} ${H.formatShort(d)}${holiday ? '<small>svátek</small>' : ''}</th>`;
  }).join('');
  const rows = selected.map((id) => {
    const place = fullById[id] || places.find((p) => p.id === id) || { id };
    const cells = days.map((d) => {
      const before = H.hoursOn(others, place, d);
      const beforeText = intervalsText(before.intervals);
      const afterText = intervalsText(draft);
      const changed = beforeText !== afterText;
      return `<td class="${changed ? 'is-changed' : ''}">
          <span class="hours-preview__before${before.exception ? ' is-exception' : ''}">${before.exception
            ? `výjimka${before.exception.note ? ` (${escapeHtml(before.exception.note)})` : ''}: ${escapeHtml(beforeText)}`
            : `běžně ${escapeHtml(beforeText)}`}</span>
          <strong class="hours-preview__after">${escapeHtml(afterText)}</strong>
        </td>`;
    }).join('');
    return `<tr><th scope="row">${escapeHtml(place.name || id)}</th>${cells}</tr>`;
  }).join('');
  const total = Math.round((H.keyToDate(to) - H.keyToDate(from)) / 864e5) + 1;
  box.innerHTML = `<h3 class="hours-preview__title">Náhled</h3>
    <div class="hours-preview__scroll"><table class="hours-preview__table">
      <thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody>
    </table></div>
    ${total > days.length ? `<p class="admin-help">Ukázáno prvních ${days.length} dní z ${total}.</p>` : ''}`;
}

// ---------- Seznam ----------

function exceptionRow(x) {
  return `<div class="admin-row" data-id="${escapeHtml(x.id)}">
      <div class="admin-row__date">${escapeHtml(formatRange(x))}</div>
      <div>
        <div class="admin-row__title">${escapeHtml(placesLabel(placesOf(x)))}: <span class="hours-admin__hours">${escapeHtml(formatHours(x.hours))}</span></div>
        <div class="admin-row__meta">
          ${x.note ? `<span>${escapeHtml(x.note)}</span>` : ''}
          ${x.editedBy ? `<span>upraveno: ${escapeHtml(x.editedBy)}, ${escapeHtml(formatDate(x.editedAt.slice(0, 10)))}</span>` : ''}
        </div>
      </div>
      <div class="admin-actions">
        <button type="button" class="button button--ghost button--small" data-edit="${escapeHtml(x.id)}">Upravit</button>
        <button type="button" class="button button--ghost button--small" data-delete="${escapeHtml(x.id)}">Smazat</button>
      </div>
    </div>`;
}

function renderList() {
  const now = today();
  const sorted = [...exceptions].sort((a, b) => a.from.localeCompare(b.from));
  const current = sorted.filter((x) => x.to >= now);
  const past = sorted.filter((x) => x.to < now).reverse();
  $('exception-list').innerHTML = current.length
    ? current.map(exceptionRow).join('')
    : '<p class="admin-help">Žádné nadcházející výjimky.</p>';
  $('past-box').hidden = !past.length;
  $('past-count').textContent = past.length;
  $('past-list').innerHTML = past.map(exceptionRow).join('');
}

function setupList() {
  $('list-box').addEventListener('click', async (ev) => {
    const editId = ev.target.closest('[data-edit]')?.dataset.edit;
    const deleteId = ev.target.closest('[data-delete]')?.dataset.delete;
    if (editId) {
      fillForm(exceptions.find((x) => x.id === editId));
      $('editor-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (deleteId) {
      const x = exceptions.find((e) => e.id === deleteId);
      const label = placesLabel(placesOf(x));
      if (!confirm(`Smazat výjimku ${label} ${formatRange(x)}?`)) return;
      await save(exceptions.filter((e) => e.id !== deleteId), `Otevírací doby: smazaná výjimka ${label} ${formatRange(x)}`);
      if (editingId === deleteId) fillForm(null);
    }
  });
}

DatePicker.attach($('x-from'));
DatePicker.attach($('x-to'));
// „do“ otevře kalendář na měsíci data „od“
$('x-from').addEventListener('change', () => { $('x-to').dataset.defaultIso = $('x-from').getIso() || ''; });
setupLogin();
setupForm();
setupList();
start();
