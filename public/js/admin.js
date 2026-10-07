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
const pending = new Set(); // ID akcí změněných od načtení (web je ještě nepřegeneroval)

const $ = (id) => document.getElementById(id);

// ---------- Pomocné ----------

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

function formatWhen(e) {
  if (e.allDay) {
    const [y, m, d] = e.start.split('-').map(Number);
    const text = `${d}. ${m}. ${y}`;
    return e.end && e.end !== e.start ? `${text} – ${e.end.split('-').map(Number).reverse().join('. ')}` : text;
  }
  return new Date(e.start).toLocaleString('cs-CZ', {
    timeZone: TIME_ZONE, day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function lastDay(e) {
  if (e.allDay) return e.end || e.start;
  return dayKey(new Date(e.end || e.start));
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
      message,
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

// ---------- Model akce ----------

const baseTitle = (e) => e.originalTitle || e.title;
const seriesKey = (e) => `${e.source}|${baseTitle(e)}`;

function effective(e) {
  const changes = { ...overrides.series[seriesKey(e)], ...overrides.events[e.id] };
  return {
    changes,
    title: changes.title || baseTitle(e),
    categories: changes.categories || e.categories,
    hidden: Boolean(changes.hidden),
    changed: Object.keys(changes).length > 0,
  };
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
    if (upcomingOnly && lastDay(e) < today) return false;
    const eff = effective(e);
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
    const cats = eff.categories.map((id) => categories.find((c) => c.id === id)?.label || id).join(', ');
    const badges = [
      eff.changed && '<span class="admin-badge admin-badge--changed">upraveno</span>',
      eff.hidden && '<span class="admin-badge admin-badge--hidden">skryto</span>',
      pending.has(e.id) && '<span class="admin-badge admin-badge--pending">čeká na přegenerování webu</span>',
    ].filter(Boolean).join(' ');
    const renamed = eff.title !== baseTitle(e) ? `<span>původně: ${escapeHtml(baseTitle(e))}</span>` : '';
    return `<div class="admin-row${eff.hidden ? ' admin-row--hidden' : ''}" data-id="${escapeHtml(e.id)}">
        <div class="admin-row__date">${escapeHtml(formatWhen(e))}</div>
        <div>
          <div class="admin-row__title">${escapeHtml(eff.title)}</div>
          <div class="admin-row__meta">
            <span>${escapeHtml(src.name)}</span><span>${escapeHtml(cats)}</span>${renamed}${badges}
          </div>
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

  if (count > 1) {
    form.querySelector('.admin-scope').hidden = false;
    form.querySelector('.admin-scope-series').textContent = `všechny termíny „${baseTitle(e)}“ (${count}, i budoucí)`;
    form.elements.scope.value = ownChanges ? 'event' : 'series';
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const changes = {};
    const title = form.elements.title.value.trim();
    if (title && title !== baseTitle(e)) changes.title = title;
    if (form.elements.customCategories.checked) {
      const picked = [...form.querySelectorAll('input[name="cat"]:checked')].map((i) => i.value);
      if (!picked.length) {
        setMessage($('admin-message'), 'Vyberte aspoň jednu kategorii, nebo vypněte „Vlastní kategorie“.', 'error');
        return;
      }
      changes.categories = picked;
    }
    if (form.elements.hidden.checked) changes.hidden = true;

    const scope = count > 1 ? form.elements.scope.value : 'event';
    const next = { series: { ...overrides.series }, events: { ...overrides.events } };
    if (scope === 'series') {
      next.series[seriesKey(e)] = changes;
      delete next.events[e.id]; // jinak by úprava jednoho termínu tu hromadnou přebila
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

async function commit(next, e, message, scope) {
  const msg = $('admin-message');
  setMessage(msg, 'Ukládám…');
  try {
    await saveOverrides(next, message);
    const affected = scope === 'series' ? data.events.filter((x) => seriesKey(x) === seriesKey(e)) : [e];
    affected.forEach((x) => pending.add(x.id));
    editingId = null;
    setMessage(msg, 'Uloženo. Web se přegeneruje během pár minut (GitHub → Actions).', 'ok');
    renderList();
  } catch (err) {
    setMessage(msg, err.message, 'error');
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

async function init() {
  setupToken();
  checkToken();

  const response = await fetch('data/events.json', { cache: 'no-cache' });
  data = await response.json();
  sourcesById = Object.fromEntries(data.sources.map((s) => [s.id, s]));
  categories = data.categories;
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
