/*
 * SQLite persistence for Daily Scrum.
 * File: <DATA_DIR>/daily-scrum.db   (DATA_DIR env, default ./data)
 * Tables: members, days, jira_map, settings, users, sessions, kpi_* (lib/kpi-db.js)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { httpError } = require('./http-utils.js');
const { createKpiDb } = require('./kpi-db.js');
const { createPiDb } = require('./pi-db.js');
const { cleanColorMap } = require('../public/status-colors.js');
const { validateTemplate } = require('./pi-core.js');
const PiPeriods = require('../public/pi-periods.js');
const backupApply = require('./backup-apply.js');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// A restore queued from Settings → Data & backup (or scripts/restore-backup.js) is
// applied here, before the database is opened; a failed one leaves it unchanged.
backupApply.cleanWorkDir(DATA_DIR);
backupApply.applyPendingRestore(DATA_DIR, (msg) => console.log(msg));

const db = new Database(path.join(DATA_DIR, 'daily-scrum.db'));
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT DEFAULT '',
    email TEXT DEFAULT '', color TEXT DEFAULT '#3D51E0', sort INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS days (
    date TEXT PRIMARY KEY, entries TEXT DEFAULT '{}', jira TEXT
  );
  CREATE TABLE IF NOT EXISTS jira_map (
    account_id TEXT PRIMARY KEY, member_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    role TEXT DEFAULT 'admin',
    pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
`);

/* migration for databases created before roles existed */
try { db.prepare("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'").run(); } catch (_) { /* column already exists */ }
/* migration: a user may say which team member they are ("This is me"), used by the PI report */
try { db.prepare('ALTER TABLE users ADD COLUMN member_id TEXT').run(); } catch (_) { /* column already exists */ }
/* migration: a member may belong to a Technical Lead (the TL user's id; '' = no lead) */
try { db.prepare("ALTER TABLE members ADD COLUMN lead TEXT DEFAULT ''").run(); } catch (_) { /* column already exists */ }
/* migration: an admin or Technical Lead may use their own JIRA email + API token instead of the team's */
try { db.prepare('ALTER TABLE users ADD COLUMN jira_email TEXT').run(); } catch (_) { /* column already exists */ }
try { db.prepare('ALTER TABLE users ADD COLUMN jira_token TEXT').run(); } catch (_) { /* column already exists */ }

/* migration: a day only counts as a standup once someone pressed "Start".
 * Days recorded before this existed are started if they hold any notes/attendance. */
const entryHasContent = (e) => Boolean(e && (e.attendance ||
  ['yesterday', 'today', 'blockers'].some((k) => String(e[k] || '').trim())));
const hasColumn = (table, name) => db.pragma('table_info(' + table + ')').some((column) => column.name === name);
/* Each migration runs in one transaction (SQLite DDL is transactional), so a
 * crash half-way leaves the column absent and the migration reruns in full. */
if (!hasColumn('days', 'started_at')) {
  db.transaction(() => {
    db.prepare('ALTER TABLE days ADD COLUMN started_at TEXT').run();
    const mark = db.prepare('UPDATE days SET started_at = ? WHERE date = ?');
    for (const r of db.prepare('SELECT date, entries FROM days').all()) {
      let entries = {};
      try { entries = JSON.parse(r.entries || '{}'); } catch (_) { /* unreadable legacy row */ }
      if (Object.values(entries).some(entryHasContent)) mark.run(r.date + 'T00:00:00.000Z', r.date);
    }
  })();
}
if (!hasColumn('days', 'roster')) {
  db.transaction(() => {
    db.prepare('ALTER TABLE days ADD COLUMN roster TEXT').run();
    const members = db.prepare('SELECT id, name, role, email, color FROM members ORDER BY sort, rowid').all();
    db.prepare('UPDATE days SET roster = ? WHERE started_at IS NOT NULL').run(JSON.stringify(members));
  })();
}

/* A session is stored by the SHA-256 of its cookie token, so a copy of the
 * database cannot be used to sign in. The token is 256 random bits, so a fast
 * unsalted hash is enough. */
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
/* migration: sessions stored the raw token; hash them in place so nobody is signed out */
if (hasColumn('sessions', 'token')) {
  db.transaction(() => {
    const rows = db.prepare('SELECT token, user_id, expires_at FROM sessions').all();
    db.exec('DROP TABLE sessions');
    db.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    const add = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)');
    for (const r of rows) add.run(tokenHash(r.token), r.user_id, r.expires_at);
  })();
}

/* ---------------- settings ---------------- */

function getSetting(k) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : '';
}
function setSetting(k, v) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(k, String(v == null ? '' : v));
}

/** Member IDs shown in the KPI report; [] = everyone. */
const KPI_MEMBERS_MAX = 500;
function cleanKpiMembers(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((id) => typeof id === 'string' && id && id.length <= 100))].slice(0, KPI_MEMBERS_MAX);
}
function getKpiMembers() {
  try { return cleanKpiMembers(JSON.parse(getSetting('kpi_members') || '[]')); } catch (_) { return []; }
}
/** Only when the client sent the list, so an older client can't wipe it. */
function saveSettings(settings) {
  const s = settings || {};
  const periodMonths = s.piPeriodMonths !== undefined ? cleanPiPeriodMonths(s.piPeriodMonths) : null;
  setSetting('jql', String(s.jql || ''));
  if (periodMonths !== null) setSetting('pi_period_months', String(periodMonths));
  if (s.kpiMembers !== undefined) setSetting('kpi_members', JSON.stringify(cleanKpiMembers(s.kpiMembers)));
  if (s.piJql !== undefined) setSetting('pi_jql', cleanPiJql(s.piJql));
  if (s.piPrefix !== undefined) setSetting('pi_prefix', cleanPiPrefix(s.piPrefix));
  saveKpiRuleSettings(s);
}

/* KPI counting rules: which statuses
 * count as delivered, and whether JIRA's Done category does too. */
const KPI_DONE_MAX = 10;
const KPI_DONE_NAME_MAX = 60;
const KPI_NOTHING_COUNTS = 'With no delivery status listed and the Done category off, no task could ever count as ' +
  'delivered. List at least one status or tick "Also count JIRA’s Done category".';

/** Status names as typed: comma-separated (or an array), trimmed, de-duplicated ignoring case. */
function cleanKpiDoneStatuses(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = String(raw == null ? '' : raw).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    if (name.length > KPI_DONE_NAME_MAX) throw httpError(400, 'A status name can be at most ' + KPI_DONE_NAME_MAX + ' characters.');
    seen.add(name.toLowerCase());
    out.push(name);
  }
  if (out.length > KPI_DONE_MAX) throw httpError(400, 'List at most ' + KPI_DONE_MAX + ' delivery statuses.');
  return out;
}
const cleanKpiDoneCategory = (v) => !(v === false || v === 0 || v === '0' || String(v).toLowerCase() === 'false');

/* Per-role rules: a member whose role (any case) has a row is judged by that row while
 * they hold the task; everyone else by the rules above, which act as the default. */
const KPI_ROLE_RULES_MAX = 20;
const KPI_ROLE_NAME_MAX = 60;

/** [{ role, doneStatuses (as typed), doneCategory }]; refuses blank or repeated roles and rows where nothing counts. */
function cleanKpiRoleRules(v) {
  if (v == null || v === '') return [];
  if (!Array.isArray(v)) throw httpError(400, 'Invalid per-role counting rules.');
  if (v.length > KPI_ROLE_RULES_MAX) throw httpError(400, 'Set rules for at most ' + KPI_ROLE_RULES_MAX + ' roles.');
  const seen = new Set();
  return v.map((raw) => {
    const row = raw && typeof raw === 'object' ? raw : {};
    const role = String(row.role == null ? '' : row.role).trim();
    if (!role) throw httpError(400, 'Each per-role rule needs a role.');
    if (role.length > KPI_ROLE_NAME_MAX) throw httpError(400, 'A role can be at most ' + KPI_ROLE_NAME_MAX + ' characters.');
    if (seen.has(role.toLowerCase())) throw httpError(400, 'The role "' + role + '" has two rules.');
    seen.add(role.toLowerCase());
    let doneStatuses; let doneCategory;
    try {
      doneStatuses = cleanKpiDoneStatuses(row.doneStatuses);
      doneCategory = row.doneCategory === undefined ? true : cleanKpiDoneCategory(row.doneCategory);
    } catch (e) { throw httpError(e.status || 400, role + ': ' + e.message); }
    if (!doneStatuses.length && !doneCategory) throw httpError(400, role + ': ' + KPI_NOTHING_COUNTS);
    return { role, doneStatuses, doneCategory };
  });
}

/** { doneStatuses (as typed), doneCategory, roleRules }; never saved = Done category only. */
function getKpiRuleSettings() {
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('kpi_done_statuses');
  let doneStatuses = [];
  try { if (stored) doneStatuses = cleanKpiDoneStatuses(stored.value); } catch (_) { /* unreadable: keep the default */ }
  let roleRules = [];
  try { roleRules = cleanKpiRoleRules(JSON.parse(getSetting('kpi_role_rules') || '[]')); } catch (_) { /* unreadable: none */ }
  return { doneStatuses, doneCategory: getSetting('kpi_done_category') !== '0', roleRules };
}

/** Only the keys the client sent; the pair is checked together (against the stored value of the other). */
function saveKpiRuleSettings(s) {
  // everything is checked before anything is written
  const roleRules = s.kpiRoleRules !== undefined ? cleanKpiRoleRules(s.kpiRoleRules) : null;
  const hasStatuses = s.kpiDoneStatuses !== undefined;
  const hasCategory = s.kpiDoneCategory !== undefined;
  const current = getKpiRuleSettings();
  const doneStatuses = hasStatuses ? cleanKpiDoneStatuses(s.kpiDoneStatuses) : current.doneStatuses;
  const doneCategory = hasCategory ? cleanKpiDoneCategory(s.kpiDoneCategory) : current.doneCategory;
  if ((hasStatuses || hasCategory) && !doneStatuses.length && !doneCategory) throw httpError(400, KPI_NOTHING_COUNTS);
  if (roleRules) setSetting('kpi_role_rules', JSON.stringify(roleRules));
  if (hasStatuses) setSetting('kpi_done_statuses', doneStatuses.join(','));
  if (hasCategory) setSetting('kpi_done_category', doneCategory ? '1' : '0');
}

/** PI query template: '' = the default; anything else must hold every placeholder. */
function cleanPiJql(v) {
  const t = String(v || '').trim();
  const err = t ? validateTemplate(t) : '';
  if (err) throw httpError(400, err);
  return t;
}

/** File-name prefix of the PI workbook, without characters file names can't hold. */
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;
const cleanPiPrefix = (v) => String(v || '').replace(UNSAFE_FILE_CHARS, '').trim().slice(0, 40);

/** Performance report period length in months: one of PiPeriods.LENGTHS. */
function cleanPiPeriodMonths(v) {
  if (!PiPeriods.isLength(v)) throw httpError(400, 'Period length must be ' + PiPeriods.LENGTHS.join(', ') + ' months.');
  return Number(v);
}

/** Status name (lower-case) → palette slot; see public/status-colors.js. */
function getStatusColors() {
  try { return cleanColorMap(JSON.parse(getSetting('status_colors') || '{}')); } catch (_) { return {}; }
}
function setStatusColors(map) {
  const clean = cleanColorMap(map);
  setSetting('status_colors', JSON.stringify(clean));
  notifyChange('colors');
  return clean;
}
/** ISO time of the last successful status sync ('' = never / due now). */
const getStatusColorsSyncedAt = () => getSetting('status_colors_synced_at');
const setStatusColorsSyncedAt = (iso) => setSetting('status_colors_synced_at', iso || '');

function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (_) { return false; }
}

/** Team timezone (saved by the admin's browser) — decides what "today" is for server-side refreshes. */
function getTimezone() {
  const tz = getSetting('timezone');
  return tz && isValidTimezone(tz) ? tz : undefined;
}

const kpiDb = createKpiDb(db, { getSetting, setSetting });
const piDb = createPiDb(db);

/* ---------------- app state ---------------- */

/** Bumped on every full-state save; clients must send the version they loaded. */
function getStateVersion() {
  return Number(getSetting('state_version')) || 0;
}

/* Change listeners (live updates). reason: 'save' (a board save), 'jira'
 * (background JIRA snapshot) or 'colors' (status colour map). */
const changeListeners = new Set();
function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function notifyChange(reason) {
  const change = { reason, version: getStateVersion() };
  for (const fn of changeListeners) {
    try { fn(change); } catch (e) { console.error('[db] change listener failed:', e); }
  }
}

/** Members and the JIRA account → member mapping, without the (large) day history. */
function getMembersAndMapping() {
  const members = db.prepare('SELECT id, name, role, email, color, lead, sort FROM members ORDER BY sort, rowid').all()
    .map((r) => ({ id: r.id, name: r.name, role: r.role || '', email: r.email || '', color: r.color, lead: r.lead || '' }));
  const mapping = {};
  for (const r of db.prepare('SELECT account_id, member_id FROM jira_map').all()) mapping[r.account_id] = r.member_id;
  return { members, mapping };
}

function loadState() {
  const { members, mapping } = getMembersAndMapping();
  const days = {};
  for (const r of db.prepare('SELECT date, entries, jira, started_at, roster FROM days').all()) {
    days[r.date] = {
      entries: JSON.parse(r.entries || '{}'),
      jira: r.jira ? JSON.parse(r.jira) : null,
      startedAt: r.started_at || null,
      roster: r.roster ? JSON.parse(r.roster) : null,
    };
  }
  const rules = getKpiRuleSettings();
  return { members, days, mapping, settings: { jql: getSetting('jql') || '', kpiMembers: getKpiMembers(),
    piJql: getSetting('pi_jql') || '', piPrefix: getSetting('pi_prefix') || '',
    piPeriodMonths: PiPeriods.lengthOr(getSetting('pi_period_months')),
    kpiDoneStatuses: rules.doneStatuses.join(', '), kpiDoneCategory: rules.doneCategory,
    kpiRoleRules: rules.roleRules.map((r) => ({ role: r.role, doneStatuses: r.doneStatuses.join(', '), doneCategory: r.doneCategory })) } };
}

const CRED_KEYS = ['site', 'email', 'token', 'accessCode'];

/** Full credentials — server-side use only, never send to a browser. */
function getCreds() {
  const c = {};
  for (const k of CRED_KEYS) c[k] = getSetting('cred_' + k) || '';
  return c;
}

/** Credentials safe to show an admin: the API token is replaced by a flag. */
function getPublicCreds() {
  const c = getCreds();
  const kpi = kpiDb.getKpiSettings();
  return { site: c.site, email: c.email, accessCode: c.accessCode, hasToken: Boolean(c.token),
    kpiBoardId: kpi.boardId, kpiPointsField: kpi.pointsField };
}

/* ---------------- personal JIRA keys ----------------
 * An admin or Technical Lead may save their own JIRA email + API token.
 * The site, sprint query and KPI settings stay team-wide. */

const KEY_ROLES = ['admin', 'lead'];
const JIRA_EMAIL = /^[^\s@]{1,128}@[^\s@]{1,128}$/;
const JIRA_TOKEN = /^\S{1,512}$/;

const canOwnKey = (user) => Boolean(user) && KEY_ROLES.includes(user.role || 'admin');

function userJiraRow(userId) {
  return db.prepare('SELECT jira_email, jira_token FROM users WHERE id = ?').get(userId) || {};
}

/** The signed-in user's own key, safe for the browser: the token is replaced by a flag. */
function getUserJira(userId) {
  const row = userJiraRow(userId);
  const email = row.jira_email || '';
  const hasToken = Boolean(row.jira_token);
  return { email, hasToken, inUse: Boolean(email && hasToken) };
}

/**
 * Saves a user's own key. token: undefined keeps the saved one, '' clears it.
 * An empty email clears both, so the user falls back to the team key.
 */
function setUserJira(userId, { email, token } = {}) {
  const mail = String(email || '').trim();
  if (mail && !JIRA_EMAIL.test(mail)) throw httpError(400, 'Enter a valid JIRA email.');
  const tok = token === undefined || token === null ? undefined : String(token).trim();
  if (tok && !JIRA_TOKEN.test(tok)) throw httpError(400, 'Invalid API token.');
  if (!mail) {
    db.prepare('UPDATE users SET jira_email = NULL, jira_token = NULL WHERE id = ?').run(userId);
  } else if (tok === undefined) {
    db.prepare('UPDATE users SET jira_email = ? WHERE id = ?').run(mail, userId);
  } else {
    db.prepare('UPDATE users SET jira_email = ?, jira_token = ? WHERE id = ?').run(mail, tok || null, userId);
  }
  return getUserJira(userId);
}

/**
 * Credentials to call JIRA as this user — server-side only. The team site
 * always; the user's own email + token when both are saved, else the team's.
 */
function credsForUser(user) {
  const team = getCreds();
  if (!canOwnKey(user)) return team;
  const row = userJiraRow(user.id);
  if (!(row.jira_email && row.jira_token)) return team;
  return Object.assign({}, team, { email: row.jira_email, token: row.jira_token });
}

const MEMBER_ID = /^[\w-]{1,64}$/;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LEAD_ID = /^\d{1,12}$/;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function validateMembers(members) {
  if (!Array.isArray(members)) throw httpError(400, 'Members must be an array.');
  for (const m of members) {
    if (!m || !MEMBER_ID.test(String(m.id))) throw httpError(400, 'Invalid member id.');
    if (m.lead && !LEAD_ID.test(String(m.lead))) throw httpError(400, 'Invalid Technical Lead.');
  }
}

function replaceMembers(members) {
  db.prepare('DELETE FROM members').run();
  const ins = db.prepare('INSERT INTO members (id, name, role, email, color, lead, sort) VALUES (?,?,?,?,?,?,?)');
  members.forEach((m, i) => {
    const color = HEX_COLOR.test(String(m.color)) ? String(m.color) : '#3D51E0';
    ins.run(String(m.id), String(m.name || ''), String(m.role || ''), String(m.email || ''), color, String(m.lead || ''), i);
  });
}

function replaceMapping(mapping) {
  db.prepare('DELETE FROM jira_map').run();
  const ins = db.prepare('INSERT OR REPLACE INTO jira_map (account_id, member_id) VALUES (?,?)');
  for (const [a, m] of Object.entries(mapping || {})) ins.run(String(a), String(m));
}

function saveCredentials(creds) {
  kpiDb.applyCredentialChange(creds, () => {
    for (const k of CRED_KEYS) if (creds[k] !== undefined) setSetting('cred_' + k, String(creds[k] || ''));
  });
}

function rosterJson(day) {
  if (!day || day.roster == null) return null;
  validateMembers(day.roster);
  return JSON.stringify(day.roster);
}

const syncedAtOf = (jira) => (jira && typeof jira.syncedAt === 'string' ? jira.syncedAt : '');

/** Of two JIRA snapshots, keep the more recently synced one. */
function newerJira(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return syncedAtOf(b) > syncedAtOf(a) ? b : a;
}

/**
 * Full-state save, transactional.
 * Body: { state, creds, baseVersion, loadedAt, timezone }
 *  - baseVersion must match the current version, otherwise 409 (another
 *    admin saved in between — the client reloads instead of overwriting).
 *  - JIRA snapshots written by the server after the client loaded
 *    (loadedAt) are kept, so a stale tab cannot wipe a background refresh.
 *  - creds: a key that is absent is left unchanged; token null clears it.
 * Returns the new version.
 */
function saveAll(body) {
  const st = body.state || {};
  const cr = body.creds || {};
  const loadedAt = typeof body.loadedAt === 'string' ? body.loadedAt : '';

  const members = Array.isArray(st.members) ? st.members : [];
  validateMembers(members);

  let version;
  const tx = db.transaction(() => {
    const current = getStateVersion();
    if (!Number.isInteger(body.baseVersion)) throw httpError(400, 'Missing baseVersion.');
    if (body.baseVersion !== current) {
      throw httpError(409, 'The board was changed by someone else — reload to get the latest version.');
    }

    replaceMembers(members);

    const stored = {};
    for (const r of db.prepare('SELECT date, jira FROM days').all()) {
      stored[r.date] = r.jira ? JSON.parse(r.jira) : null;
    }
    db.prepare('DELETE FROM days').run();
    const insDay = db.prepare('INSERT INTO days (date, entries, jira, started_at, roster) VALUES (?,?,?,?,?)');
    const incoming = st.days || {};
    for (const [d, day] of Object.entries(incoming)) {
      if (!ISO_DATE.test(d)) continue;
      const jira = newerJira(day && day.jira, stored[d]);
      const startedAt = day && typeof day.startedAt === 'string' && day.startedAt ? day.startedAt.slice(0, 40) : null;
      insDay.run(d, JSON.stringify((day && day.entries) || {}), jira ? JSON.stringify(jira) : null, startedAt, rosterJson(day));
    }
    for (const [d, jira] of Object.entries(stored)) {
      const unseenByClient = !Object.prototype.hasOwnProperty.call(incoming, d) && syncedAtOf(jira) > loadedAt;
      if (unseenByClient) insDay.run(d, '{}', JSON.stringify(jira), null, null);
    }

    replaceMapping(st.mapping);

    saveSettings(st.settings);
    if (typeof body.timezone === 'string' && isValidTimezone(body.timezone)) setSetting('timezone', body.timezone);
    saveCredentials(cr);

    version = current + 1;
    setSetting('state_version', version);
  });
  tx();
  notifyChange('save');
  return version;
}

/** Apply only changed board fields and days, keeping each request small as history grows. */
function savePatch(body) {
  const patch = body.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpError(400, 'Missing state patch.');
  const days = patch.days || {};
  const upsert = days.upsert || {};
  const deleted = days.delete || [];
  if (!upsert || typeof upsert !== 'object' || Array.isArray(upsert) || !Array.isArray(deleted)) {
    throw httpError(400, 'Invalid days patch.');
  }
  if (patch.members !== undefined) validateMembers(patch.members);
  if (patch.mapping !== undefined && !isPlainObject(patch.mapping)) throw httpError(400, 'Invalid JIRA mapping.');
  if (patch.settings !== undefined && !isPlainObject(patch.settings)) throw httpError(400, 'Invalid settings.');
  for (const date of [...Object.keys(upsert), ...deleted]) {
    if (!ISO_DATE.test(date)) throw httpError(400, 'Invalid day date.');
  }
  const loadedAt = typeof body.loadedAt === 'string' ? body.loadedAt : '';
  let version;
  db.transaction(() => {
    const current = getStateVersion();
    if (!Number.isInteger(body.baseVersion)) throw httpError(400, 'Missing baseVersion.');
    if (body.baseVersion !== current) throw httpError(409, 'The board was changed by someone else — reload to get the latest version.');

    if (patch.members !== undefined) replaceMembers(patch.members);
    if (patch.mapping !== undefined) replaceMapping(patch.mapping);
    if (patch.settings !== undefined) saveSettings(patch.settings);
    if (typeof body.timezone === 'string' && isValidTimezone(body.timezone)) setSetting('timezone', body.timezone);
    saveCredentials(body.creds || {});

    const existing = db.prepare('SELECT jira FROM days WHERE date = ?');
    const put = db.prepare('INSERT INTO days (date, entries, jira, started_at, roster) VALUES (?,?,?,?,?) ' +
      'ON CONFLICT(date) DO UPDATE SET entries = excluded.entries, jira = excluded.jira, ' +
      'started_at = excluded.started_at, roster = excluded.roster');
    for (const [date, day] of Object.entries(upsert)) {
      if (!day || typeof day !== 'object' || Array.isArray(day)) throw httpError(400, 'Invalid day.');
      const previous = existing.get(date);
      const jira = newerJira(day.jira, previous && previous.jira ? JSON.parse(previous.jira) : null);
      const startedAt = typeof day.startedAt === 'string' && day.startedAt ? day.startedAt.slice(0, 40) : null;
      put.run(date, JSON.stringify(day.entries || {}), jira ? JSON.stringify(jira) : null, startedAt, rosterJson(day));
    }
    for (const date of deleted) {
      if (Object.prototype.hasOwnProperty.call(upsert, date)) throw httpError(400, 'Day cannot be both updated and deleted.');
      const previous = existing.get(date);
      const jira = previous && previous.jira ? JSON.parse(previous.jira) : null;
      if (syncedAtOf(jira) > loadedAt) {
        db.prepare("UPDATE days SET entries = '{}', started_at = NULL, roster = NULL WHERE date = ?").run(date);
      } else {
        db.prepare('DELETE FROM days WHERE date = ?').run(date);
      }
    }

    version = current + 1;
    setSetting('state_version', version);
  })();
  notifyChange('save');
  return version;
}

/** Update only one day's JIRA snapshot (used by the background login refresh). */
function upsertDayJira(dateISO, jira) {
  db.prepare("INSERT INTO days (date, entries, jira) VALUES (?, '{}', ?) " +
    'ON CONFLICT(date) DO UPDATE SET jira = excluded.jira')
    .run(String(dateISO), JSON.stringify(jira));
  notifyChange('jira');
}

/* ---------------- passwords ---------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function passwordMatches(row, password) {
  const hash = crypto.scryptSync(String(password), row.pass_salt, 32);
  const expected = Buffer.from(row.pass_hash, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

/* ---------------- users & sessions ---------------- */

const SESSION_DAYS = 30;
/** admin = everything; lead = a Technical Lead, admin of their own team only; viewer = read-only. */
const USER_ROLES = ['admin', 'lead', 'viewer'];

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function createUser(username, password, role) {
  const { salt, hash } = hashPassword(password);
  const info = db.prepare('INSERT INTO users (username, role, pass_salt, pass_hash, created_at) VALUES (?,?,?,?,?)')
    .run(String(username).toLowerCase(), USER_ROLES.includes(role) ? role : 'viewer', salt, hash, new Date().toISOString());
  return info.lastInsertRowid;
}

function verifyLogin(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').toLowerCase());
  if (!u || !passwordMatches(u, password)) return null;
  return { id: u.id, username: u.username, role: u.role || 'admin', memberId: u.member_id || '' };
}

/** Removes a user's sessions, optionally keeping one (the caller's own). */
function deleteUserSessions(userId, exceptToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptToken ? tokenHash(exceptToken) : '');
}

/** Changes the password and signs the user out everywhere except the current session. */
function changePassword(userId, currentPassword, newPassword, currentToken) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || !passwordMatches(u, currentPassword)) return false;
  const { salt, hash } = hashPassword(newPassword);
  db.transaction(() => {
    db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?').run(salt, hash, userId);
    deleteUserSessions(userId, currentToken);
  })();
  return true;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(tokenHash(token), userId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(
    'SELECT u.id, u.username, u.role, u.member_id FROM sessions s JOIN users u ON u.id = s.user_id ' +
    'WHERE s.token_hash = ? AND s.expires_at > ?'
  ).get(tokenHash(token), Date.now());
  return row ? { id: row.id, username: row.username, role: row.role || 'admin', memberId: row.member_id || '' } : null;
}

/** Links a user to the team member they are ('' unlinks). */
function setUserMember(userId, memberId) {
  const id = String(memberId || '');
  if (id && !MEMBER_ID.test(id)) throw httpError(400, 'Invalid member id.');
  db.prepare('UPDATE users SET member_id = ? WHERE id = ?').run(id || null, userId);
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/* ---------------- user management (admin) ---------------- */

function listUsers() {
  return db.prepare('SELECT id, username, role, member_id, created_at FROM users ORDER BY id').all()
    .map((u) => ({ id: u.id, username: u.username, role: u.role || 'admin', memberId: u.member_id || '', createdAt: u.created_at }));
}

/**
 * Who can lead a team, for the member "Technical Lead" picker: Technical
 * Lead accounts, and admins (an admin may lead a team too and still sees
 * everything). Name = their linked member's name, else the username.
 */
function listLeads() {
  return db.prepare("SELECT u.id, u.username, COALESCE(u.role, 'admin') AS role, m.name FROM users u " +
    "LEFT JOIN members m ON m.id = u.member_id WHERE COALESCE(u.role, 'admin') IN ('lead', 'admin') ORDER BY role DESC, u.id").all()
    .map((r) => ({ id: String(r.id), name: r.name || r.username, role: r.role }));
}

/** Deleting a TL leaves their members without a lead. */
function deleteUser(id) {
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.prepare("UPDATE members SET lead = '' WHERE lead = ?").run(String(id));
  })();
}

/** Admin reset: sets a new password and signs that user out everywhere. */
function resetPassword(id, newPassword) {
  const { salt, hash } = hashPassword(newPassword);
  db.transaction(() => {
    db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?').run(salt, hash, id);
    deleteUserSessions(id);
  })();
}

function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
}

module.exports = {
  DATA_DIR, loadState, getStateVersion, getKpiRuleSettings, cleanKpiDoneStatuses, cleanKpiRoleRules, getMembersAndMapping, onChange, getCreds, getPublicCreds, getTimezone,
  canOwnKey, getUserJira, setUserJira, credsForUser, saveAll, savePatch, upsertDayJira,
  countUsers, createUser, verifyLogin, changePassword,
  createSession, getSessionUser, deleteSession, purgeExpiredSessions,
  listUsers, listLeads, deleteUser, resetPassword, countAdmins, setUserMember, USER_ROLES,
  getStatusColors, setStatusColors, getStatusColorsSyncedAt, setStatusColorsSyncedAt,
  ...kpiDb,
  ...piDb,
  // consistent online copy of the whole database (for the full backup)
  backupTo: (dest) => db.backup(dest),
  close: () => db.close(),
};
