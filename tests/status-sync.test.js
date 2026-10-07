/*
 * Status colour sync (lib/status-sync.js): daily fetch, stable map,
 * admin overrides — against a temporary database and a fake JIRA.
 * Run: npm test
 */
'use strict';

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-scrum-stsync-'));
process.env.DATA_DIR = dataDir;
for (const k of ['JIRA_SITE', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete process.env[k];
const db = require('../lib/db.js');
const { createStatusSync } = require('../lib/status-sync.js');

const SITE = 'https://team.atlassian.net';
const DAY = 86400000;
const realFetch = globalThis.fetch;
let statuses; let calls; let clock; let failWith;

after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const status = (id, name, key) => ({ id: String(id), name, statusCategory: { key } });

beforeEach(() => {
  db.savePatch({ baseVersion: db.getStateVersion(), patch: {}, creds: { site: 'team', email: 'lead@example.com', token: 'secret' } });
  db.setStatusColors({});
  db.setStatusColorsSyncedAt('');
  clock = Date.parse('2026-10-01T02:00:00Z');
  failWith = null;
  calls = 0;
  statuses = [status(1, 'To Do', 'new'), status(3, 'In Progress', 'indeterminate'), status(10001, 'Done', 'done')];
  globalThis.fetch = async (url) => {
    assert.equal(String(url), SITE + '/rest/api/3/status');
    calls++;
    if (failWith) return new Response('{}', { status: failWith });
    return new Response(JSON.stringify(statuses), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const sync = () => createStatusSync({ now: () => clock, wait: async () => {} });

test('the first sync assigns and saves colours for every status', async () => {
  const res = await sync().syncIfDue();
  assert.equal(res.changed, true);
  assert.deepEqual(db.getStatusColors(), { 'to do': 0, 'in progress': 6, done: 18 });
});

test('sync runs at most once a day and keeps existing slots when a status is added', async () => {
  const s = sync();
  await s.syncIfDue();
  statuses.push(status(4, 'In Review', 'indeterminate'), status(2, 'Backlog', 'new'));
  clock += DAY - 1000;
  assert.equal((await s.syncIfDue()).skipped, true);
  assert.equal(calls, 1);
  clock += 1000;
  assert.equal((await s.syncIfDue()).changed, true);
  assert.deepEqual(db.getStatusColors(), { 'to do': 0, 'in progress': 6, done: 18, backlog: 1, 'in review': 14 });
});

test('an unchanged status list is not saved again', async () => {
  await sync().syncIfDue();
  db.setStatusColorsSyncedAt('');
  const res = await sync().syncIfDue();
  assert.equal(res.changed, false);
});

test('a JIRA failure leaves the map alone and retries on the next run', async () => {
  failWith = 500;
  await assert.rejects(sync().syncIfDue());
  assert.deepEqual(db.getStatusColors(), {});
  failWith = null;
  assert.equal((await sync().syncIfDue()).changed, true);
});

test('no JIRA credentials: nothing to sync', async () => {
  db.savePatch({ baseVersion: db.getStateVersion(), patch: {}, creds: { token: null } });
  assert.equal((await sync().syncIfDue()).skipped, true);
  assert.equal(calls, 0);
});

const put = (s, body, admin = true, method = 'PUT') => s.handleRequest({ method, body, admin });

test('PUT saves admin overrides; viewers get 403; other methods 405', async () => {
  const s = sync();
  const res = await put(s, { colors: { 'In Review': 9, Done: 20 } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload, { statusColors: { 'in review': 9, done: 20 } });
  assert.deepEqual(db.getStatusColors(), { 'in review': 9, done: 20 });
  assert.equal((await put(s, { colors: {} }, false)).status, 403);
  assert.equal((await put(s, {}, true, 'POST')).status, 405);
});

test('PUT merges changed entries into the saved map, so statuses synced meanwhile are kept', async () => {
  const s = sync();
  db.setStatusColors({ 'to do': 0, done: 18 });
  const res = await put(s, { colors: { Done: 21 } });
  assert.deepEqual(res.payload.statusColors, { 'to do': 0, done: 21 });
});

test('PUT rejects bad slots, names and shapes with 400 and saves nothing', async () => {
  const s = sync();
  db.setStatusColors({ done: 18 });
  for (const colors of [{ done: 24 }, { done: -1 }, { done: 1.5 }, { done: '3' }, { '': 1 }, { ['x'.repeat(101)]: 1 },
    { Done: 1, done: 2 }, [1], null, 'x']) {
    assert.equal((await put(s, { colors })).status, 400, JSON.stringify(colors));
  }
  assert.deepEqual(db.getStatusColors(), { done: 18 });
});

test('PUT reset clears overrides and re-assigns automatically from JIRA', async () => {
  const s = sync();
  await s.syncIfDue();
  await put(s, { colors: Object.assign(db.getStatusColors(), { done: 3 }) });
  const res = await put(s, { reset: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload.statusColors, { 'to do': 0, 'in progress': 6, done: 18 });
  assert.equal(calls, 2);
});

test('PUT reset with JIRA down still clears the map and reports 502', async () => {
  const s = sync();
  db.setStatusColors({ done: 3 });
  failWith = 500;
  const res = await put(s, { reset: true });
  assert.equal(res.status, 502);
  assert.deepEqual(db.getStatusColors(), {});
});
