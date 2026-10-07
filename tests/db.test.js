/*
 * Unit tests for lib/db.js against a temporary database. Run: npm test
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-scrum-db-'));
process.env.DATA_DIR = dataDir;
const db = require('../lib/db.js');

after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const snapshot = (syncedAt) => ({ syncedAt, sprint: null, issues: [] });

test('upsertDayJira stores a snapshot for a new day', () => {
  db.upsertDayJira('2026-09-01', snapshot('2026-09-01T08:00:00.000Z'));
  const day = db.loadState().days['2026-09-01'];
  assert.deepEqual(day.entries, {});
  assert.equal(day.jira.syncedAt, '2026-09-01T08:00:00.000Z');
});

test('saveAll keeps a background snapshot the client had not seen', () => {
  const version = db.getStateVersion();
  const loadedAt = '2026-09-02T07:00:00.000Z';
  // written by the server after the client loaded
  db.upsertDayJira('2026-09-02', snapshot('2026-09-02T08:00:00.000Z'));
  db.saveAll({ state: { members: [], days: {} }, baseVersion: version, loadedAt });
  assert.ok(db.loadState().days['2026-09-02'], 'unseen snapshot must survive');
  assert.equal(db.loadState().days['2026-09-01'], undefined, 'day the client deleted must go');
});

test('saveAll keeps the newer of two snapshots for the same day', () => {
  db.upsertDayJira('2026-09-03', snapshot('2026-09-03T09:00:00.000Z'));
  const s = db.loadState();
  s.days['2026-09-03'] = { entries: { m1: { today: 'x' } }, jira: snapshot('2026-09-03T08:00:00.000Z') };
  db.saveAll({ state: s, baseVersion: db.getStateVersion(), loadedAt: '2026-09-03T10:00:00.000Z' });
  const day = db.loadState().days['2026-09-03'];
  assert.equal(day.jira.syncedAt, '2026-09-03T09:00:00.000Z');
  assert.equal(day.entries.m1.today, 'x');
});

test('startedAt persists, and a JIRA refresh does not change it', () => {
  const s = db.loadState();
  s.days['2026-09-07'] = { entries: {}, jira: null, startedAt: '2026-09-07T01:30:00.000Z' };
  s.days['2026-09-08'] = { entries: {}, jira: snapshot('2026-09-08T08:00:00.000Z'), startedAt: null };
  db.saveAll({ state: s, baseVersion: db.getStateVersion(), loadedAt: '2026-09-08T09:00:00.000Z' });
  db.upsertDayJira('2026-09-07', snapshot('2026-09-07T08:00:00.000Z'));
  db.upsertDayJira('2026-09-09', snapshot('2026-09-09T08:00:00.000Z'));

  const days = db.loadState().days;
  assert.equal(days['2026-09-07'].startedAt, '2026-09-07T01:30:00.000Z');
  assert.equal(days['2026-09-07'].jira.syncedAt, '2026-09-07T08:00:00.000Z');
  assert.equal(days['2026-09-08'].startedAt, null);
  assert.equal(days['2026-09-09'].startedAt, null, 'a background refresh never starts a day');
});

test('a patch saves only changed days and preserves newer background JIRA data', () => {
  const original = db.loadState();
  original.days['2026-06-01'] = { entries: { m1: { today: 'keep this' } }, jira: null, startedAt: 'started' };
  db.saveAll({ state: original, baseVersion: db.getStateVersion() });
  db.upsertDayJira('2026-06-02', snapshot('2026-06-02T09:00:00.000Z'));

  const roster = [{ id: 'm1', name: 'Member One', role: 'QA', email: '', color: '#3D51E0' }];
  const version = db.savePatch({
    baseVersion: db.getStateVersion(), loadedAt: '2026-06-02T08:00:00.000Z',
    patch: { days: { upsert: {
      '2026-06-02': { entries: { m1: { today: 'new note' } },
        jira: snapshot('2026-06-02T08:30:00.000Z'), startedAt: 'started', roster },
    }, delete: [] } },
  });
  const days = db.loadState().days;
  assert.equal(days['2026-06-01'].entries.m1.today, 'keep this');
  assert.equal(days['2026-06-02'].entries.m1.today, 'new note');
  assert.equal(days['2026-06-02'].jira.syncedAt, '2026-06-02T09:00:00.000Z');
  assert.deepEqual(days['2026-06-02'].roster, roster);
  assert.throws(() => db.savePatch({ baseVersion: version - 1, patch: { days: {} } }), (e) => e.status === 409);
});

test('a patch with malformed settings or mapping is rejected with 400', () => {
  for (const patch of [{ settings: 'x' }, { settings: [] }, { mapping: 'x' }, { mapping: [1] }]) {
    assert.throws(() => db.savePatch({ baseVersion: db.getStateVersion(), patch }), (e) => e.status === 400);
  }
});

test('saveAll rejects a stale version with status 409', () => {
  const stale = db.getStateVersion() - 1;
  assert.throws(() => db.saveAll({ state: {}, baseVersion: stale }), (e) => e.status === 409);
});

test('token: absent keeps it, null clears it', () => {
  db.saveAll({ state: {}, baseVersion: db.getStateVersion(), creds: { token: 'abc' } });
  db.saveAll({ state: {}, baseVersion: db.getStateVersion(), creds: { site: 'team' } });
  assert.equal(db.getCreds().token, 'abc');
  assert.equal(db.getPublicCreds().hasToken, true);
  db.saveAll({ state: {}, baseVersion: db.getStateVersion(), creds: { token: null } });
  assert.equal(db.getCreds().token, '');
});

test('saveAll stores a valid timezone only', () => {
  db.saveAll({ state: {}, baseVersion: db.getStateVersion(), timezone: 'Asia/Jakarta' });
  assert.equal(db.getTimezone(), 'Asia/Jakarta');
  db.saveAll({ state: {}, baseVersion: db.getStateVersion(), timezone: 'Not/AZone' });
  assert.equal(db.getTimezone(), 'Asia/Jakarta');
});

test('status colours round-trip, cleaned; empty by default', () => {
  assert.deepEqual(db.getStatusColors(), {});
  db.setStatusColors({ 'In Review': 9, done: 18, bad: 99 });
  assert.deepEqual(db.getStatusColors(), { 'in review': 9, done: 18 });
  db.setStatusColors({});
  assert.deepEqual(db.getStatusColors(), {});
});

test('KPI member selection is saved by patch and full save, and kept when not sent', () => {
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { jql: '', kpiMembers: ['m1', 'm1', 7, 'm2'] } } });
  assert.deepEqual(db.loadState().settings.kpiMembers, ['m1', 'm2']);
  db.saveAll({ state: { members: [], days: {}, settings: { jql: 'x' } }, baseVersion: db.getStateVersion() });
  assert.deepEqual(db.loadState().settings.kpiMembers, ['m1', 'm2'], 'an older client must not wipe it');
  db.saveAll({ state: { members: [], days: {}, settings: { jql: '', kpiMembers: [] } }, baseVersion: db.getStateVersion() });
  assert.deepEqual(db.loadState().settings.kpiMembers, []);
});

test('every saved change notifies listeners with its reason and the board version', () => {
  const seen = [];
  const stop = db.onChange((change) => seen.push(change));
  const version = db.savePatch({ baseVersion: db.getStateVersion(), patch: {} });
  db.saveAll({ state: {}, baseVersion: db.getStateVersion() });
  db.upsertDayJira('2026-09-20', snapshot('2026-09-20T08:00:00.000Z'));
  db.setStatusColors({ done: 18 });
  stop();
  db.savePatch({ baseVersion: db.getStateVersion(), patch: {} });
  assert.deepEqual(seen, [
    { reason: 'save', version }, { reason: 'save', version: version + 1 },
    { reason: 'jira', version: version + 1 }, { reason: 'colors', version: version + 1 },
  ]);
});

test('a rejected save notifies nobody', () => {
  const seen = [];
  const stop = db.onChange((change) => seen.push(change));
  assert.throws(() => db.savePatch({ baseVersion: db.getStateVersion() - 1, patch: {} }), (e) => e.status === 409);
  stop();
  assert.deepEqual(seen, []);
});

test("credsForUser uses an admin's or lead's own key only when both email and token are saved", () => {
  const leadId = db.createUser('keylead', 'secret1', 'lead');
  const viewerId = db.createUser('keyviewer', 'secret1', 'viewer');
  const lead = { id: leadId, role: 'lead' };
  const team = db.getCreds();

  assert.deepEqual(db.credsForUser(lead), team);
  assert.deepEqual(db.getUserJira(leadId), { email: '', hasToken: false, inUse: false });

  db.setUserJira(leadId, { email: 'lead@x.com' });
  assert.deepEqual(db.credsForUser(lead), team, 'an email without a token still uses the team key');

  assert.deepEqual(db.setUserJira(leadId, { email: 'lead@x.com', token: 'tok-1' }), { email: 'lead@x.com', hasToken: true, inUse: true });
  const own = db.credsForUser(lead);
  assert.equal(own.email, 'lead@x.com');
  assert.equal(own.token, 'tok-1');
  assert.equal(own.site, team.site, 'the site stays the team one');

  db.setUserJira(leadId, { email: 'new@x.com' });
  assert.equal(db.credsForUser(lead).token, 'tok-1', 'no token keeps the saved one');

  db.setUserJira(viewerId, { email: 'v@x.com', token: 'tok-v' });
  assert.deepEqual(db.credsForUser({ id: viewerId, role: 'viewer' }), team, 'viewers always use the team key');
  assert.deepEqual(db.credsForUser(null), team);

  db.setUserJira(leadId, { email: '' });
  assert.deepEqual(db.getUserJira(leadId), { email: '', hasToken: false, inUse: false });
  assert.throws(() => db.setUserJira(leadId, { email: 'not-an-email' }), (e) => e.status === 400);
  assert.equal(JSON.stringify(db.listUsers()).includes('tok-'), false, 'tokens never leave the server');
});

test('sessions are stored by a hash of the token, never the token itself', () => {
  const userId = db.createUser('sessionuser', 'secret1', 'viewer');
  const { token } = db.createSession(userId);
  const keep = db.createSession(userId).token;
  assert.equal(db.getSessionUser(token).username, 'sessionuser');

  const Database = require('better-sqlite3');
  const raw = new Database(path.join(dataDir, 'daily-scrum.db'), { readonly: true });
  const stored = raw.prepare('SELECT token_hash AS token FROM sessions WHERE user_id = ?').all(userId).map((r) => r.token);
  raw.close();
  assert.equal(stored.length, 2);
  assert.ok(!stored.includes(token) && !stored.includes(keep), 'the database alone cannot sign anyone in');

  db.deleteSession(token);
  assert.equal(db.getSessionUser(token), null);
  db.resetPassword(userId, 'Another-pass1');
  assert.equal(db.getSessionUser(keep), null, 'a reset still signs the user out everywhere');
});

// ---------- KPI counting rules ----------

const kpiRules = () => db.loadState().settings;
const saveRules = (settings) => db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings } });

test('cleanKpiDoneStatuses: splits, trims, de-dupes ignoring case, keeps the typed spelling', () => {
  assert.deepEqual(db.cleanKpiDoneStatuses(' Untested, code review ,UNTESTED,, '), ['Untested', 'code review']);
  assert.deepEqual(db.cleanKpiDoneStatuses(['Done', ' QA ']), ['Done', 'QA']);
  assert.deepEqual(db.cleanKpiDoneStatuses(''), []);
  assert.throws(() => db.cleanKpiDoneStatuses('x'.repeat(61)), (e) => e.status === 400);
  assert.throws(() => db.cleanKpiDoneStatuses(Array.from({ length: 11 }, (_, i) => 'S' + i)), (e) => e.status === 400);
});

test('KPI rules default to Done category and round-trip through settings', () => {
  assert.deepEqual(db.getKpiRuleSettings(), { doneStatuses: [], doneCategory: true, roleRules: [] });
  saveRules({ kpiDoneStatuses: 'Untested, Code Review', kpiDoneCategory: false });
  assert.equal(kpiRules().kpiDoneStatuses, 'Untested, Code Review');
  assert.equal(kpiRules().kpiDoneCategory, false);
  saveRules({ jql: 'project = X' }); // absent keys leave the stored rules alone
  assert.deepEqual(db.getKpiRuleSettings(), { doneStatuses: ['Untested', 'Code Review'], doneCategory: false, roleRules: [] });
});

test('nothing counting as done is rejected, also when only one key is sent, and nothing is written', () => {
  saveRules({ kpiDoneStatuses: 'Untested', kpiDoneCategory: false, jql: 'project = KEEP' });
  const version = db.getStateVersion();
  assert.throws(() => saveRules({ kpiDoneStatuses: '', jql: 'project = LOST' }), (e) => e.status === 400);
  assert.throws(() => saveRules({ kpiDoneStatuses: '', kpiDoneCategory: false }), (e) => e.status === 400);
  assert.equal(db.getStateVersion(), version);
  assert.equal(kpiRules().jql, 'project = KEEP');
  assert.equal(kpiRules().kpiDoneStatuses, 'Untested');
  saveRules({ kpiDoneStatuses: '', kpiDoneCategory: true }); // empty list is fine with the category on
  assert.deepEqual(db.getKpiRuleSettings(), { doneStatuses: [], doneCategory: true, roleRules: [] });
  saveRules({ kpiDoneStatuses: 'Untested', kpiDoneCategory: true });
});

test('the Done category is off for false, 0, "0" and "false" (any case)', () => {
  for (const off of [false, 0, '0', 'false', 'FALSE']) {
    saveRules({ kpiDoneStatuses: 'Untested', kpiDoneCategory: off });
    assert.equal(db.getKpiRuleSettings().doneCategory, false, JSON.stringify(off));
    saveRules({ kpiDoneCategory: true });
  }
  saveRules({ kpiDoneStatuses: 'Untested', kpiDoneCategory: 'true' });
  assert.equal(db.getKpiRuleSettings().doneCategory, true);
});

test('the browser check (kpiRulesError) accepts and refuses exactly what the server does', () => {
  const { kpiRulesError } = require('../public/kpi-report.js');
  const cases = [
    ['Untested', true], ['Untested', false], ['', true], [' , ', false], ['', false],
    ['x'.repeat(60), true], ['x'.repeat(61), true], ['QA, ' + 'x'.repeat(61), false],
    [Array.from({ length: 10 }, (_, i) => 'S' + i).join(','), false],
    [Array.from({ length: 11 }, (_, i) => 'S' + i).join(','), true],
    [Array.from({ length: 11 }, () => 'Same').join(','), false], // duplicates are dropped before counting
  ];
  for (const [text, category] of cases) {
    let serverError = '';
    try { saveRules({ kpiDoneStatuses: text, kpiDoneCategory: category }); } catch (e) { serverError = e.message; }
    const clientError = kpiRulesError(text, category);
    const label = JSON.stringify([text.slice(0, 20), category]);
    assert.equal(Boolean(clientError), Boolean(serverError), label);
    if (clientError) assert.ok(serverError.startsWith(clientError), label + ': ' + clientError + ' vs ' + serverError);
  }
  saveRules({ kpiDoneStatuses: 'Untested', kpiDoneCategory: true });
});

test('per-role rules round-trip, and a refused save leaves every rule as it was', () => {
  saveRules({ kpiDoneStatuses: 'Untested', kpiDoneCategory: true,
    kpiRoleRules: [{ role: ' QA ', doneStatuses: '', doneCategory: true }, { role: 'Mobile Engineer', doneStatuses: 'Untested, Untested', doneCategory: false }] });
  const want = { doneStatuses: ['Untested'], doneCategory: true, roleRules: [
    { role: 'QA', doneStatuses: [], doneCategory: true }, { role: 'Mobile Engineer', doneStatuses: ['Untested'], doneCategory: false }] };
  assert.deepEqual(db.getKpiRuleSettings(), want);
  assert.deepEqual(db.loadState().settings.kpiRoleRules, [
    { role: 'QA', doneStatuses: '', doneCategory: true }, { role: 'Mobile Engineer', doneStatuses: 'Untested', doneCategory: false }]);
  assert.throws(() => saveRules({ kpiDoneStatuses: 'Code Review', kpiRoleRules: [{ role: 'qa' }, { role: 'QA' }] }), /two rules/);
  assert.throws(() => saveRules({ kpiRoleRules: 'QA' }), /Invalid per-role/);
  assert.deepEqual(db.getKpiRuleSettings(), want, 'nothing was written');
  saveRules({ kpiRoleRules: [] });
  assert.deepEqual(db.getKpiRuleSettings().roleRules, []);
});

test('the browser check (kpiRoleRulesError) accepts and refuses exactly what the server does', () => {
  const { kpiRoleRulesError } = require('../public/kpi-report.js');
  const row = (role, doneStatuses = '', doneCategory = true) => ({ role, doneStatuses, doneCategory });
  const cases = [
    [], [row('QA')], [row('QA', 'Untested', false)], [row('  ')], [row('x'.repeat(60))], [row('x'.repeat(61))],
    [row('QA'), row('qa ')], [row('QA', '', false)], [row('QA', ' , ', false)], [row('QA', 'x'.repeat(61))],
    Array.from({ length: 20 }, (_, i) => row('R' + i)), Array.from({ length: 21 }, (_, i) => row('R' + i)),
  ];
  for (const rows of cases) {
    let serverError = '';
    try { saveRules({ kpiRoleRules: rows }); } catch (e) { serverError = e.message; }
    const clientError = kpiRoleRulesError(rows);
    const label = JSON.stringify(rows).slice(0, 60);
    assert.equal(Boolean(clientError), Boolean(serverError), label);
    if (clientError) assert.ok(serverError.startsWith(clientError), label + ': ' + clientError + ' vs ' + serverError);
  }
  saveRules({ kpiRoleRules: [] });
});
