/* ================================================================
   Scrum Desk — app logic (no framework, no build step)
   Views: Today (board) · Sprint · History · Report · Settings · Login/Setup
   Storage: server SQLite database via /api/state (falls back to
   browser localStorage when no server API exists, e.g. static hosting)
   Roles: admin (edit everything, manage users) · viewer (read-only
   + download reports) — enforced server-side, mirrored in the UI
   Files (classic scripts sharing one global scope, loaded in order):
   app-core.js · app-auth.js · app-views.js · app.js
   ================================================================ */
'use strict';

/* ---------------- tiny helpers ---------------- */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? c : '#1066A0');
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local time
const debounce = (fn, ms) => {
  let t = null;
  const run = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  run.cancel = () => { clearTimeout(t); t = null; };
  run.pending = () => t !== null;
  return run;
};
const fmtDay = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

/* ---------------- constants ---------------- */

const LS_STATE = 'scrumdesk.state.v1';
const LS_CREDS = 'scrumdesk.creds.v1';
const LS_MIGRATION_PENDING = 'scrumdesk.migration-pending.v1';

const PALETTE = ['#1066A0', '#108890', '#678D61', '#AA5019', '#A53956', '#594D7F', '#B24D7A', '#536C54'];

const ATT = {
  present: { label: 'Present', title: 'Attending the opening',           key: 'p' },
  late:    { label: 'Late',    title: 'Late for the opening',            key: 'l' },
  leave:   { label: 'Leave',   title: 'On leave today',                  key: 'v' },
  sick:    { label: 'Sick',    title: 'Sick today',                      key: 's' },
  noshow:  { label: 'No show', title: 'Did not show up for the opening', key: 'n' },
};

const LOGO_SVG = '<svg viewBox="0 0 64 64" width="44" height="44" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#168edf"/><rect x="14" y="13" width="10" height="7" rx="2" fill="#fff"/><rect x="14" y="23" width="10" height="7" rx="2" fill="#fff"/><rect x="14" y="33" width="10" height="7" rx="2" fill="#fff"/><rect x="27" y="23" width="10" height="7" rx="2" fill="#fff" fill-opacity=".7"/><rect x="27" y="33" width="10" height="7" rx="2" fill="#fff" fill-opacity=".7"/><rect x="40" y="33" width="10" height="7" rx="2" fill="#1fc4c7"/><rect x="9" y="44" width="46" height="5" rx="2.5" fill="#fff"/><rect x="14" y="49" width="4" height="7" rx="1.5" fill="#fff" fill-opacity=".7"/><rect x="46" y="49" width="4" height="7" rx="1.5" fill="#fff" fill-opacity=".7"/></svg>';

/* ---------------- state ---------------- */

const DEFAULT_STATE = { members: [], days: {}, mapping: {}, settings: { jql: '' } };
let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
// token: only what the admin typed this session — the server never sends the
// saved token back; hasToken says whether one is stored.
let creds = { site: '', email: '', token: '', accessCode: '', hasToken: false, kpiBoardId: '', kpiPointsField: '' };
let kpiCredsEdited = false; // KPI board/field changed here since the last load or save
let statusColors = {};  // JIRA status name -> palette slot, from the server (status-colors.js)
let stateVersion = 0;   // server version this state is based on (optimistic locking)
let stateLoadedAt = ''; // server time of the last load
let lastSavedState = JSON.parse(JSON.stringify(DEFAULT_STATE));
let auth = { name: '', role: 'admin' };
let usersList = [];
let leads = [];  // who can lead a team: [{ id, name, role }] from the server (empty for a Technical Lead)
let myJira = null; // an admin's/lead's own JIRA key: { email, hasToken, inUse, envOverride }; null for viewers (own-key.js)
let storageMode = 'server'; // 'server' (database) or 'local' (browser localStorage)

// team: '' = everyone, a lead's user id, or 'none' (members without a lead)
const ui = {
  compact: loadJSON('scrumdesk.compact.v1', true) !== false,
  boardView: loadJSON('scrumdesk.boardview.v1', 'cards') === 'sheet' ? 'sheet' : 'cards',
  memberSearch: '', editingNote: null, ticketExpansion: new Map(), ticketFilters: new Map(), sprintCollapsed: new Set(),
  view: 'today', date: todayISO(), month: todayISO().slice(0, 7),
  statusPick: '', todayFilter: '', attMenu: null, settingsTab: '', team: '',
  sprintMode: loadJSON('scrumdesk.sprintMode.v1', 'board') === 'list' ? 'list' : 'board',
  sprintDoneOpen: new Set(), sprintMapOpen: false, histMonth: '', histSel: '', jiraDraft: null,
  blockerMember: '', blockerAll: false,
};

function jiraDraftValues() {
  if (!ui.jiraDraft) ui.jiraDraft = {
    site: creds.site || '', email: creds.email || '', token: creds.token || '', jql: state.settings.jql || '',
  };
  return ui.jiraDraft;
}

function jiraDraftDirty() {
  const d = ui.jiraDraft;
  return Boolean(d && (d.site.trim() !== (creds.site || '') ||
    d.email.trim() !== (creds.email || '') ||
    d.token.trim() !== (creds.token || '') ||
    d.jql.trim() !== (state.settings.jql || '')));
}

/** Admins and Technical Leads write the board; a lead only ever receives their own team. */
function canEdit() { return auth.role !== 'viewer'; }
function isLead() { return auth.role === 'lead'; }
/** JIRA connection, users, KPI/PI settings, backups: admins only. */
function canAdmin() { return canEdit() && !isLead(); }

/** The team picker only exists for admins/viewers once someone can lead a team. */
function hasTeamPicker() { return !isLead() && leads.length > 0; }
/** A member's lead id; old day rosters carry no lead, so fall back to the current member. */
function leadOf(m) {
  if (m && m.lead) return String(m.lead);
  const cur = m && state.members.find((x) => x.id === m.id);
  return cur && cur.lead ? String(cur.lead) : '';
}
/** A lead id that is no longer a lead counts as "no lead". */
function teamKey(m) {
  const id = leadOf(m);
  return id && leads.some((l) => l.id === id) ? id : 'none';
}
/** Members narrowed by the team picker (ui.team). */
function filterByTeam(members) {
  if (!hasTeamPicker() || !ui.team) return members;
  return members.filter((m) => teamKey(m) === ui.team);
}
function leadName(id) {
  const l = leads.find((x) => x.id === id);
  return l ? l.name : 'No lead';
}

/* ---------------- shareable navigation ---------------- */

let navigationReady = false;
let replaceNavigationUrl = false;

function validNavigationDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Read only known UI options; team and settings access follow the signed-in role. */
function navigationFromUrl(href) {
  const params = new URL(href).searchParams;
  const views = ['today', 'sprint', 'history', 'report', 'kpi', 'pi', 'blockers', 'settings'];
  let view = views.includes(params.get('view')) ? params.get('view') : 'today';
  if (view === 'pi' && !isPiAvailable()) view = 'today';
  const team = params.get('team') || '';
  const tabs = settingsTabs();
  const tab = tabs.find((t) => t.id === params.get('tab')) || tabs[0];
  return {
    view,
    date: validNavigationDate(params.get('date')) ? params.get('date') : todayISO(),
    month: isValidMonth(params.get('month') || '') ? params.get('month') : todayISO().slice(0, 7),
    team: hasTeamPicker() && (team === 'none' || leads.some((l) => l.id === team)) ? team : '',
    settingsTab: tab.id,
    period: /^\d{4}-P[123]$/.test(params.get('period') || '') ? params.get('period') : '',
  };
}

function restoreNavigationUrl() {
  if (!window.location || !window.history) return;
  const route = navigationFromUrl(window.location.href);
  const { period, ...board } = route;
  Object.assign(ui, board);
  piUi.period = period;
  ui.editingNote = null;
  navigationReady = true;
  replaceNavigationUrl = true;
}

/** Rendering notes, filters, or live updates does not create history entries. */
function syncNavigationUrl() {
  if (!navigationReady || !window.location || !window.history) return;
  const url = new URL(window.location.href);
  const values = { view: ui.view, date: ui.date, month: ui.month, team: ui.team,
    period: piUi.period, tab: ui.view === 'settings' ? ui.settingsTab : '' };
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  }
  if (url.href !== window.location.href) {
    window.history[replaceNavigationUrl ? 'replaceState' : 'pushState'](null, '', url.href);
  }
  replaceNavigationUrl = false;
}

async function onNavigationPop() {
  if (!navigationReady || document.body.classList.contains('auth-mode')) return;
  // Browser Back need not blur a settings field before replacing its DOM.
  const active = document.activeElement;
  if (active && active.matches && active.matches('[data-set], [data-setting]')) onDocChange({ target: active });
  closeModal();
  closeConfirm(false);
  closeOwnKeyModal();
  ui.attMenu = null; // an open status menu belongs to the page being left
  restoreNavigationUrl();
  render();
  if (ui.view === 'settings' && canAdmin()) { await refreshUsers(); render(); }
}

function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (_) { return fallback; }
}

function entriesHaveContent(day) {
  return Object.values((day && day.entries) || {}).some((e) =>
    ['yesterday', 'today', 'blockers'].some((k) => (e[k] || '').trim()) || e.attendance);
}

/** A day is a standup day only once an admin pressed "Start standup". */
function isStarted(day) {
  return Boolean(day && day.startedAt);
}

/** Browser-storage / imported data from before the start gate: days with notes count as started. */
function normalizeDays(board = state) {
  for (const d of Object.keys(board.days || {})) {
    const day = board.days[d];
    if (day && day.startedAt === undefined) day.startedAt = entriesHaveContent(day) ? d + 'T00:00:00.000Z' : null;
    if (day && day.startedAt && !Array.isArray(day.roster)) day.roster = board.members.map(memberSnapshot);
  }
}

function pruneDays() {
  for (const d of Object.keys(state.days || {})) {
    const day = state.days[d] || {};
    if (!day.jira && !isStarted(day) && !entriesHaveContent(day)) delete state.days[d];
  }
}

let saveMessage = 'All changes saved';

function flashSaved() { saveStatus('All changes saved'); }

function saveStatus(message) {
  saveMessage = message;
  renderSaveStatus();
}

function renderSaveStatus() {
  if (typeof piEditorFeedback === 'function' && piEditorUi.draft !== null) piEditorFeedback();
  const hint = $('#saveHint');
  if (!hint) return;
  let message = !canEdit() ? 'View only' : saveMessage === 'All changes saved' && storageMode === 'local'
    ? 'Saved in this browser' : saveMessage;
  if (canEdit() && saveMessage === 'All changes saved' && storageMode === 'server' &&
      (persistTimer || persistSoon.pending() || persistQueued || saveInFlight)) message = 'Saving…';
  if ((jiraDraftDirty() || (typeof piDraftDirty === 'function' && piDraftDirty())) && message !== 'Not saved') message = 'Unsaved changes';
  if (hint.textContent !== message) hint.textContent = message;
  if (message === 'Not saved') hint.classList.add('save-error'); else hint.classList.remove('save-error');
  if (message === 'Unsaved changes' || message === 'Saving…') hint.classList.add('save-pending'); else hint.classList.remove('save-pending');
}

function getDay(dateISO, create) {
  if (!state.days[dateISO] && create) state.days[dateISO] = { entries: {}, jira: null, startedAt: null };
  return state.days[dateISO] || null;
}

/* ---------------- persistence ---------------- */

let persistTimer = null;

function saveState(opts) {
  pruneDays();
  if (storageMode === 'local') {
    localStorage.setItem(LS_STATE, JSON.stringify(state));
    localStorage.setItem(LS_CREDS, JSON.stringify(creds));
    flashSaved();
    return;
  }
  saveStatus('Saving…');
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 300);
}
function saveCreds() { saveState(); }

/* Credentials as sent to the server: the token only when one was typed
 * (absent = keep the saved one), null to clear it. */
function credsForServer(clearToken) {
  const out = { site: creds.site, email: creds.email, accessCode: creds.accessCode };
  if (clearToken) out.token = null;
  else if (creds.token) out.token = creds.token;
  // KPI settings only when edited: the server may have auto-detected them since the load.
  if (kpiCredsEdited) Object.assign(out, { kpiBoardId: creds.kpiBoardId, kpiPointsField: creds.kpiPointsField });
  return out;
}

const MAX_PATCH_BYTES = 6 * 1024 * 1024;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function statePatchBatches(previous, next, clearToken) {
  const first = { days: { upsert: {}, delete: [] } };
  for (const key of ['members', 'mapping', 'settings']) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) first[key] = clone(next[key]);
  }
  const changes = [];
  for (const [date, day] of Object.entries(next.days || {})) {
    if (JSON.stringify((previous.days || {})[date]) !== JSON.stringify(day)) changes.push({ date, day: clone(day) });
  }
  for (const date of Object.keys(previous.days || {})) {
    if (!Object.prototype.hasOwnProperty.call(next.days || {}, date)) changes.push({ date, deleted: true });
  }

  const batches = [];
  let patch = first;
  const bytes = (p) => new TextEncoder().encode(JSON.stringify({
    patch: p, creds: credsForServer(clearToken), baseVersion: stateVersion,
    loadedAt: stateLoadedAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })).length;
  if (bytes(first) > MAX_PATCH_BYTES) throw new Error('Team settings are too large to save.');
  const encodedLength = (s) => new TextEncoder().encode(s).length;
  let currentBytes = bytes(first);
  for (const change of changes) {
    const addedBytes = change.deleted
      ? encodedLength(JSON.stringify(change.date) + ',')
      : encodedLength(JSON.stringify(change.date) + ':' + JSON.stringify(change.day) + ',');
    if (currentBytes + addedBytes > MAX_PATCH_BYTES) {
      batches.push(patch);
      patch = { days: { upsert: {}, delete: [] } };
      currentBytes = bytes(patch);
      if (currentBytes + addedBytes > MAX_PATCH_BYTES) throw new Error('One day is too large to save. Reduce its JIRA snapshot.');
    }
    if (change.deleted) patch.days.delete.push(change.date);
    else patch.days.upsert[change.date] = change.day;
    currentBytes += addedBytes;
  }
  if (patch !== first || changes.length || Object.keys(first).length > 1) batches.push(patch);
  else if (clearToken || saveExtrasKey() !== lastSavedExtras) batches.push(first); // only credentials or timezone changed
  return batches;
}

/* Credentials and timezone ride along with every save; this key tells
 * whether they changed since the last successful one. */
let lastSavedExtras = '';
function saveExtrasKey() {
  const kpiValues = { kpiBoardId: creds.kpiBoardId, kpiPointsField: creds.kpiPointsField };
  return JSON.stringify([Object.assign(credsForServer(false), kpiValues), Intl.DateTimeFormat().resolvedOptions().timeZone]);
}

function acknowledgePatch(patch) {
  for (const key of ['members', 'mapping', 'settings']) {
    if (patch[key] !== undefined) lastSavedState[key] = clone(patch[key]);
  }
  for (const [date, day] of Object.entries(patch.days.upsert)) lastSavedState.days[date] = clone(day);
  for (const date of patch.days.delete) delete lastSavedState.days[date];
}

/* Saves run one at a time. A save requested while one is in flight is
 * queued (at most one), and sends whatever the state is when it starts,
 * so no edit is ever dropped. */
let persistChain = Promise.resolve();
let persistQueued = false;
let clearTokenOnNextSave = false;

function persistNow() {
  if (storageMode === 'local') return Promise.resolve(true);
  clearTimeout(persistTimer);
  persistTimer = null;
  if (persistQueued) return persistChain;
  persistQueued = true;
  persistChain = persistChain.then(async () => {
    persistQueued = false;
    saveInFlight = true;
    try { return await sendState(); } finally { saveInFlight = false; updateSaveBanner(); renderSaveStatus(); }
  });
  return persistChain;
}

/* A save that loses a race with someone else's merges their board into
 * this one and tries again; only after repeated conflicts does it reload. */
const MAX_SAVE_REBASES = 3;
const SAVE_CONFLICT = 'conflict';

async function sendState() {
  for (let attempt = 0; ; attempt++) {
    const result = await sendStateOnce();
    if (!result || result === true) return result;
    if (attempt < MAX_SAVE_REBASES && await pullServerChanges()) continue;
    saveStatus('Not saved');
    await reloadAfterConflict(result.partial);
    return false;
  }
}

/** One save attempt: true, false (failed, already reported) or { conflict, partial }. */
async function sendStateOnce() {
  const clearToken = clearTokenOnNextSave;
  clearTokenOnNextSave = false;
  let credentialsSaved = false;
  const extras = saveExtrasKey();
  try {
    const batches = statePatchBatches(lastSavedState, state, clearToken);
    for (const [i, patch] of batches.entries()) {
      const sentCreds = credentialsSaved ? {} : credsForServer(clearToken);
      const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch, creds: sentCreds,
          baseVersion: stateVersion, loadedAt: stateLoadedAt,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (res.status === 401) { if (clearToken && !credentialsSaved) clearTokenOnNextSave = true; saveStatus('Not saved'); showAuthScreen('login'); toast('Session expired — sign in again', 'error'); return false; }
      if (res.status === 403) { if (clearToken && !credentialsSaved) clearTokenOnNextSave = true; saveStatus('Not saved'); toast('Your account is view-only', 'error'); return false; }
      if (res.status === 409) { if (clearToken && !credentialsSaved) clearTokenOnNextSave = true; return { conflict: SAVE_CONFLICT, partial: i > 0 }; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      stateVersion = data.version;
      acknowledgePatch(patch);
      if (!credentialsSaved) {
        if (creds.token) creds.hasToken = true;
        if (clearToken) creds.hasToken = false;
        acknowledgeCreds(sentCreds);
        if (sentCreds.kpiBoardId === creds.kpiBoardId && sentCreds.kpiPointsField === creds.kpiPointsField) kpiCredsEdited = false;
        credentialsSaved = true;
        lastSavedExtras = extras;
      }
    }
    flashSaved();
    return true;
  } catch (e) {
    if (clearToken && !credentialsSaved) clearTokenOnNextSave = true;
    saveStatus('Not saved');
    toast('Could not save to server: ' + e.message, 'error');
    return false;
  }
}

/** partial: an earlier batch of this save was already stored before the conflict. */
async function reloadAfterConflict(partial) {
  try {
    persistSoon.cancel();
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyServerData(await res.json());
    render();
    toast(partial
      ? 'Someone else changed the board while a large save was running — only part of your changes were stored. Loaded the latest version; please redo what is missing.'
      : 'Someone else changed the board — loaded the latest version. Please re-check your last edit.', 'error');
  } catch (e) {
    toast('Board changed elsewhere and reloading failed: ' + e.message, 'error');
  }
}

function applyServerData(data) {
  state = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), data.state || {});
  state.settings = state.settings || { jql: '' };
  normalizeDays();
  lastSavedState = clone(state);
  creds = Object.assign({ site: '', email: '', token: '', accessCode: '', hasToken: false, kpiBoardId: '', kpiPointsField: '' },
    data.creds || {});
  kpiCredsEdited = false;
  statusColors = cleanColorMap(data.statusColors);
  leads = Array.isArray(data.leads) ? data.leads : [];
  myJira = data.myJira || null;
  stateVersion = Number(data.version) || 0;
  stateLoadedAt = data.loadedAt || '';
  lastSavedExtras = saveExtrasKey();
  lastServerCreds = publicCreds(creds);
}

/* ---------------- live updates ---------------- */

/* The server announces every change on GET /api/events (version + reason
 * only). This tab then re-reads the board and three-way merges it with its
 * own, so other people's edits appear while unsaved typing here is kept. */
let lastServerCreds = {}; // the server's credentials as this tab last knew them
let liveSource = null;
let liveWanted = null;    // a queued pull: { version, always }

function publicCreds(c) {
  const out = Object.assign({}, c);
  delete out.token;
  return out;
}

/** After a save, the server's credentials are what was sent. */
function acknowledgeCreds(sent) {
  const out = Object.assign({}, lastServerCreds, publicCreds(sent), { hasToken: creds.hasToken });
  if (sent.token === null) out.hasToken = false;
  lastServerCreds = out;
}

/** Fold the server's board into this tab's. Returns true when anything visible changed. */
function mergeServerData(data) {
  const theirs = Object.assign(clone(DEFAULT_STATE), data.state || {});
  theirs.settings = theirs.settings || { jql: '' };
  normalizeDays(theirs);
  const before = JSON.stringify([state, statusColors]);
  const credsUntouched = JSON.stringify(publicCreds(creds)) === JSON.stringify(lastServerCreds);

  state = merge3(lastSavedState, state, theirs);
  lastSavedState = theirs;
  if (data.creds) {
    creds = Object.assign(merge3(lastServerCreds, publicCreds(creds), data.creds), { token: creds.token });
    lastServerCreds = publicCreds(data.creds);
  }
  statusColors = cleanColorMap(data.statusColors);
  if (Array.isArray(data.leads)) leads = data.leads;
  if (data.myJira !== undefined) myJira = data.myJira || null;
  stateVersion = Number(data.version) || 0;
  stateLoadedAt = data.loadedAt || stateLoadedAt;
  if (credsUntouched) lastSavedExtras = saveExtrasKey();
  return JSON.stringify([state, statusColors]) !== before;
}

/** Fetch and merge the latest board. Returns false when it could not be read. */
async function pullServerChanges() {
  if (storageMode !== 'server') return false;
  let data;
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return false;
    data = await res.json();
  } catch (_) {
    return false;
  }
  if (mergeServerData(data)) renderKeepingFocus();
  return true;
}

/** Queue a pull behind any save in flight, so a save never races a merge. */
function queueLiveSync(version, always) {
  const queued = liveWanted !== null;
  liveWanted = {
    version: Math.max(version, queued ? liveWanted.version : 0),
    always: always || (queued && liveWanted.always),
  };
  if (queued) return persistChain;
  persistChain = persistChain.then(async (saved) => {
    const want = liveWanted;
    liveWanted = null;
    if (want.always || want.version > stateVersion) await pullServerChanges();
    return saved;
  });
  return persistChain;
}

function onLiveEvent(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch (_) { return Promise.resolve(); }
  const version = Number(msg.version) || 0;
  // board saves bump the version (ours included, so those are skipped);
  // JIRA snapshots and status colours change data without bumping it
  const always = msg.reason === 'jira' || msg.reason === 'colors';
  if (!always && version <= stateVersion) return Promise.resolve();
  return queueLiveSync(version, always);
}

function startLiveUpdates() {
  if (storageMode !== 'server' || liveSource || typeof EventSource === 'undefined') return;
  liveSource = new EventSource('/api/events');
  liveSource.onmessage = onLiveEvent;
  liveSource.onerror = () => {
    // the browser retries dropped streams itself; a refused one (e.g. signed out) is closed
    if (liveSource && liveSource.readyState === EventSource.CLOSED) liveSource = null;
  };
}

function stopLiveUpdates() {
  if (liveSource) liveSource.close();
  liveSource = null;
}

/** Re-render without losing the caret: refocus the same field and keep text typed but not yet committed. */
function renderKeepingFocus() {
  const active = document.activeElement;
  const selector = active && active !== document.body ? focusSelector(active) : '';
  const typed = selector && isUncommittedText(active) ? active.value : null;
  const caret = selector && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  render();
  if (!selector) return;
  const el = document.querySelector(selector);
  if (!el) return;
  if (typed !== null) el.value = typed;
  el.focus();
  if (caret && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(Math.min(caret[0], el.value.length), Math.min(caret[1], el.value.length)); } catch (_) { /* not a text field */ }
  }
}

function focusSelector(el) {
  const quote = (v) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
  if (el.id) return '#' + quote(el.id);
  const attrs = [...(el.attributes || [])].filter((a) => a.name.startsWith('data-'));
  if (!attrs.length) return '';
  return el.tagName.toLowerCase() + attrs.map((a) => '[' + a.name + '="' + quote(a.value) + '"]').join('');
}

/* Board entries are written to state on every keystroke; other text fields
 * (settings) only on change, so their in-progress value lives in the DOM. */
function isUncommittedText(el) {
  if (!('value' in el) || !('defaultValue' in el)) return false;
  if (el.matches && el.matches('textarea[data-entry]')) return false;
  return el.value !== el.defaultValue;
}

async function bootStorage() {
  if (storageMode === 'server') {
    const res = await fetch('/api/state');
    if (!res.ok) {
      const err = new Error('Could not load the server board (HTTP ' + res.status + ').');
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    applyServerData(data);

    // one-time migration from the old browser-storage version
    const oldLocal = loadJSON(LS_STATE, null);
    const serverDays = (data.state && data.state.days) || {};
    const serverEmpty = !(data.state && (data.state.members || []).length) &&
      !Object.values(serverDays).some((day) => isStarted(day) || entriesHaveContent(day));
    const pendingMigration = localStorage.getItem(LS_MIGRATION_PENDING) === '1';
    if ((serverEmpty || pendingMigration) && oldLocal &&
        ((oldLocal.members || []).length || Object.keys(oldLocal.days || {}).length)) {
      const imported = Object.assign(clone(DEFAULT_STATE), oldLocal);
      state = serverEmpty ? imported : Object.assign(clone(DEFAULT_STATE), data.state || {});
      if (serverEmpty) {
        for (const [date, day] of Object.entries(serverDays)) {
          if (!Object.prototype.hasOwnProperty.call(state.days, date)) state.days[date] = day;
        }
      } else {
        for (const [date, day] of Object.entries(imported.days || {})) {
          if (!Object.prototype.hasOwnProperty.call(state.days, date)) state.days[date] = day;
        }
      }
      state.settings = state.settings || { jql: '' };
      normalizeDays();
      creds = Object.assign({}, creds, loadJSON(LS_CREDS, {}));
      localStorage.setItem(LS_MIGRATION_PENDING, '1');
      if (!await persistNow()) throw new Error('Could not migrate browser data. The original copy is still in this browser.');
      localStorage.removeItem(LS_STATE);
      localStorage.removeItem(LS_CREDS);
      localStorage.removeItem(LS_MIGRATION_PENDING);
      setTimeout(() => toast('Existing browser data migrated to the database', 'success'), 800);
    }
  } else {
    state = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), loadJSON(LS_STATE, {}));
    state.settings = state.settings || { jql: '' };
    normalizeDays();
    creds = Object.assign({}, creds, loadJSON(LS_CREDS, {}));
  }
}
