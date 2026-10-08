/*
 * KPI service (lib/kpi-service.js): /api/kpi handling, refetch rule, cache,
 * partial failure — against a temporary database and a fake JIRA. No network.
 * Run: npm test
 */
'use strict';

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-desk-kpisrv-'));
process.env.DATA_DIR = dataDir;
for (const k of ['JIRA_SITE', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete process.env[k];
const db = require('../lib/db.js');
const kpi = require('../lib/kpi-core.js');
const { createKpiService } = require('../lib/kpi-service.js');

const SITE = 'https://team.atlassian.net';
const NOW = Date.parse('2026-09-20T05:00:00Z');
const realFetch = globalThis.fetch;

after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

let routes; let calls; let jira;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });
}
const on = (match, reply) => routes.unshift({ match, reply: typeof reply === 'function' ? reply : () => reply });
const called = (re) => calls.filter((c) => re.test(c)).length;

const DAY = 86400000;
// the Sprint field on searched issues carries boardId (the agile API's originBoardId is not there)
const sprintRaw = (id, state, startDate, completeDate, boardId = 5) => ({
  id, name: 'Sprint ' + id, state, boardId, startDate,
  endDate: new Date(Date.parse(startDate) + 11 * DAY).toISOString(), completeDate,
});

function issue(key, { sprintId, state, statusId, statusName, cat, updated, histories = [], total }) {
  return {
    key,
    fields: {
      summary: 'Summary ' + key, updated, created: '2026-08-01T00:00:00.000+0000',
      status: { id: statusId, name: statusName, statusCategory: { key: cat } },
      assignee: { accountId: 'acc-1', displayName: 'User One', emailAddress: 'u1@example.com' },
      issuetype: { name: 'Story', subtask: false }, customfield_10032: 3,
      customfield_10020: [{ id: sprintId, state }],
    },
    changelog: { startAt: 0, maxResults: histories.length, total: total == null ? histories.length : total, histories },
  };
}
const toDone = (at) => ({ id: '1', created: at, items: [{ field: 'status', from: '1', fromString: 'To Do', to: '10001', toString: 'Done' }] });

function defaultJira() {
  return {
    sprints: [
      sprintRaw(100, 'closed', '2026-08-17T02:00:00.000Z', '2026-08-28T10:00:00.000Z'),
      sprintRaw(101, 'closed', '2026-09-01T02:00:00.000Z', '2026-09-12T10:00:00.000Z'),
      sprintRaw(102, 'active', '2026-09-15T02:00:00.000Z', null, 41),
    ],
    issues: {
      101: [issue('A-1', { sprintId: 101, state: 'closed', statusId: '10001', statusName: 'Done', cat: 'done',
        updated: '2026-09-05T03:00:00.000+0000', histories: [toDone('2026-09-05T03:00:00.000+0000')] })],
      102: [issue('A-2', { sprintId: 102, state: 'active', statusId: '3', statusName: 'In Progress', cat: 'indeterminate',
        updated: '2026-09-16T03:00:00.000+0000', histories: [], total: 1 })],
    },
  };
}

const TEAM = [
  { id: 'm1', name: 'User One', email: 'U1@example.com' },
  { id: 'm2', name: 'User Two', email: 'u2@example.com' },
];
const setTeam = (patch) => db.savePatch({ baseVersion: db.getStateVersion(), patch });

/** Fake POST /search/jql: a sprint's issues when the changelog is expanded, else sprint discovery. */
function search(body) {
  const one = /^sprint = (\d+) /.exec(body.jql);
  if (one) return { issues: jira.issues[one[1]] || [], isLast: true };
  return { issues: [{ key: 'A-0', fields: { customfield_10020: jira.sprints } }], isLast: true };
}
const searches = (re) => calls.filter((c) => c.startsWith('/rest/api/3/search/jql ') && re.test(c)).length;

beforeEach(() => {
  db.clearKpi();
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { members: TEAM, mapping: { 'acc-1': 'm1' }, settings: { kpiMembers: ['m1'], kpiDoneStatuses: 'Untested', kpiDoneCategory: true, kpiRoleRules: [] } },
    creds: { site: 'team', email: 'lead@example.com', token: 'secret', kpiBoardId: '', kpiPointsField: '' } });
  db.clearKpi();
  jira = defaultJira();
  routes = [];
  calls = [];
  on(/^\/rest\/api\/3\/field$/, [
    { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
    { id: 'customfield_10016', name: 'Story point estimate' },
    { id: 'customfield_10032', name: 'Story Points' },
  ]);
  on(/^\/rest\/api\/3\/search\/jql$/, (p, body) => search(body));
  on(/^\/rest\/api\/3\/status$/, [
    { id: '1', statusCategory: { key: 'new' } }, { id: '3', statusCategory: { key: 'indeterminate' } },
    { id: '10001', statusCategory: { key: 'done' } },
  ]);
  on(/^\/rest\/api\/3\/issue\/[\w-]+\/changelog/, { values: [], isLast: true });
  globalThis.fetch = async (url, init = {}) => {
    const p = String(url).slice(SITE.length);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push(body && body.jql ? p + ' ' + body.jql : p);
    const r = routes.find((x) => x.match.test(p.split('?')[0]));
    if (!r) return json({ errorMessages: ['no route for ' + p] }, 404);
    const out = r.reply(p.split('?')[0], body);
    return out instanceof Response ? out : json(out);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const service = (opts = {}) => createKpiService(Object.assign({ wait: async () => {}, now: () => NOW }, opts));
const get = (svc, month, admin = false) => svc.handleRequest({ method: 'GET', path: '/api/kpi', month, admin });
const refresh = (svc, month, admin = true) => svc.handleRequest({ method: 'POST', path: '/api/kpi/refresh', body: { month }, admin });
const statusOf = (payload, id) => payload.sprints.find((s) => s.id === id).status;
const failSprint = (id, reply) => on(/^\/rest\/api\/3\/search\/jql$/, (p, body) =>
  (body.jql.startsWith('sprint = ' + id + ' ') ? reply() : search(body)));

test('GET without a month returns the current month; invalid months are 400', async () => {
  const svc = service();
  const res = await get(svc, null);
  assert.equal(res.status, 200);
  assert.equal(res.payload.month, '2026-09');
  assert.equal(res.payload.configured, true);
  assert.equal(res.payload.refreshing, false);
  assert.deepEqual(res.payload.tasks, []);
  for (const bad of ['', '2026-13', '2026-9', 'x']) assert.equal((await get(svc, bad)).status, 400, bad);
  assert.equal(calls.length, 0, 'GET never calls JIRA');
});

test('viewers can read but not refresh', async () => {
  const svc = service();
  assert.equal((await get(svc, '2026-09', false)).status, 200);
  assert.equal((await refresh(svc, '2026-09', false)).status, 403);
  assert.equal((await refresh(svc, '2026-99')).status, 400);
  assert.equal((await svc.handleRequest({ method: 'DELETE', path: '/api/kpi', admin: true })).status, 405);
});

test("refresh searches JIRA for the KPI people's sprints on any board, computes the month and caches it", async () => {
  const svc = service();
  const res = await refresh(svc, '2026-09');
  assert.equal(res.status, 200);
  assert.equal(db.getKpiSettings().pointsField, 'customfield_10032', 'exact "Story Points" wins');
  assert.equal(searches(/^\S+ assignee WAS IN \("acc-1", "u1@example\.com"\) AND sprint IS NOT EMPTY AND updated >= "2026-06-03"$/), 1,
    'one discovery search for the ticked member, by mapped account and email');
  assert.equal(searches(/u2@example/), 0, 'members not ticked are not searched');
  assert.deepEqual(res.payload.sprints.map((s) => [s.id, s.status]), [[101, 'ok'], [102, 'ok']]);
  assert.deepEqual(db.listKpiSprints().filter((s) => s.month === '2026-09').map((s) => [s.id, s.boardId]), [[101, 5], [102, 41]]);
  assert.deepEqual(res.payload.tasks.map((t) => [t.sprintId, t.key, t.outcome, t.points]), [[101, 'A-1', 'done', 3], [102, 'A-2', 'open', 3]]);
  assert.deepEqual(res.payload.months, ['2026-09']);
  assert.equal(searches(/^\S+ sprint = 101 AND assignee WAS IN \("acc-1", "u1@example\.com"\) ORDER BY key$/), 1);
  assert.equal(searches(/sprint = 100 /), 0, 'other months are not fetched');
  assert.equal(called(/\/rest\/agile\//), 0, 'no board API calls');
  const again = await get(svc, '2026-09');
  assert.deepEqual(again.payload.tasks, res.payload.tasks);
});

test('nobody ticked searches the whole team; no member email is a 400 without JIRA calls', async () => {
  setTeam({ settings: { kpiMembers: [] } });
  await refresh(service(), '2026-09');
  assert.equal(searches(/assignee WAS IN \("acc-1", "u1@example\.com", "u2@example\.com"\) AND sprint IS NOT EMPTY/), 1);
  setTeam({ members: [{ id: 'm3', name: 'No Mail', email: '' }], mapping: {} });
  calls = [];
  const res = await refresh(service(), '2026-09');
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /JIRA email/);
  assert.equal(calls.length, 0);
});

test('changing the KPI people drops cached results', async () => {
  const svc = service();
  await refresh(svc, '2026-09');
  setTeam({ settings: { kpiMembers: ['m2'] } });
  calls = [];
  await refresh(svc, '2026-09');
  assert.equal(searches(/^\S+ sprint = 101 AND assignee WAS IN \("u2@example\.com"\)/), 1, 'closed sprint refetched for the new people');
});

test('changing the KPI people keeps cached results when the JIRA discovery fails', async () => {
  const svc = service();
  await refresh(svc, '2026-09');
  const before = (await get(svc, '2026-09')).payload.tasks.length;
  assert.ok(before > 0);
  setTeam({ settings: { kpiMembers: ['m2'] } });
  on(/^\/rest\/api\/3\/search\/jql$/, () => json({ errorMessages: ['down'] }, 500));
  const res = await refresh(svc, '2026-09');
  assert.equal(res.status, 502);
  assert.equal((await get(svc, '2026-09')).payload.tasks.length, before, 'old results still viewable');
});

test('second refresh: closed sprint served from cache, active sprint refetched, unchanged issue skips changelog', async () => {
  const svc = service();
  await refresh(svc, '2026-09');
  assert.equal(called(/\/issue\/A-2\/changelog/), 1, 'truncated changelog fetched once');
  calls = [];
  await refresh(svc, '2026-09');
  assert.equal(searches(/sprint = 101 /), 0, 'closed + computed closed → not refetched');
  assert.equal(searches(/sprint = 102 /), 1, 'active → refetched');
  assert.equal(called(/\/changelog/), 0, 'same updated → cached timeline');
});

test('a sprint cached while active is refetched once after it closes', async () => {
  const svc = service();
  await refresh(svc, '2026-09');
  jira.sprints[2] = sprintRaw(102, 'closed', '2026-09-15T02:00:00.000Z', '2026-09-19T10:00:00.000Z', 41);
  jira.issues[102][0].fields.customfield_10020 = [{ id: 102, state: 'closed' }];
  calls = [];
  const res = await refresh(svc, '2026-09');
  assert.equal(searches(/sprint = 102 /), 1);
  assert.equal(res.payload.tasks.find((t) => t.key === 'A-2').outcome, 'carryover');
  assert.equal(db.listKpiSprints().find((s) => s.id === 102).computedState, 'closed');
  calls = [];
  await refresh(svc, '2026-09');
  assert.equal(searches(/sprint = 10[12] /), 0, 'both closed and computed closed');
});

test('one failing sprint keeps the others and reports its error', async () => {
  const svc = service();
  failSprint(101, () => json({ errorMessages: ['boom'] }, 500));
  const res = await refresh(svc, '2026-09');
  assert.equal(res.status, 200);
  assert.equal(statusOf(res.payload, 101), 'error');
  assert.match(res.payload.sprints.find((s) => s.id === 101).error, /500|boom/);
  assert.equal(statusOf(res.payload, 102), 'ok');
});

test('HTTP 429 is retried after Retry-After', async () => {
  const waits = [];
  const svc = service({ wait: async (ms) => { waits.push(ms); } });
  let first = true;
  failSprint(101, () => {
    if (first) { first = false; return json({}, 429, { 'Retry-After': '2' }); }
    return { issues: jira.issues[101], isLast: true };
  });
  const res = await refresh(svc, '2026-09');
  assert.equal(statusOf(res.payload, 101), 'ok');
  assert.deepEqual(waits, [2000]);
});

test('a second refresh while one is running gets 409', async () => {
  const svc = service();
  const firstRun = refresh(svc, '2026-09');
  const second = await refresh(svc, '2026-09');
  assert.equal(second.status, 409);
  assert.equal((await get(svc, '2026-09')).payload.refreshing, true);
  assert.equal((await firstRun).status, 200);
  assert.equal((await get(svc, '2026-09')).payload.refreshing, false);
});

test('time budget: sprints not started in time are pending', async () => {
  const svc = service({ budgetMs: 0 });
  const res = await refresh(svc, '2026-09');
  assert.deepEqual(res.payload.sprints.map((s) => s.status), ['pending', 'pending']);
  assert.equal(searches(/sprint = /), 0);
});

test('older rules are recomputed from stored timelines without JIRA', async () => {
  const svc = service();
  await refresh(svc, '2026-09');
  const s = db.listKpiSprints().find((x) => x.id === 101);
  const stored = db.getKpiTasks([101]).map((t) => ({ key: t.key, outcome: 'bogus', points: 0 }));
  db.saveKpiSprintResult(101, { state: 'closed', rulesSignature: 'old', computedAt: s.computedAt, tasks: stored, timelines: [] });
  calls = [];
  const res = await get(svc, '2026-09');
  assert.equal(calls.length, 0);
  assert.equal(res.payload.tasks.find((t) => t.key === 'A-1').outcome, 'done');
  assert.equal(db.listKpiSprints().find((x) => x.id === 101).rulesSignature,
    kpi.fingerprint(kpi.normalizeRules({ doneStatuses: ['Untested'], doneCategory: true })));
});

test('changing the counting rules recomputes stored sprints without JIRA', async () => {
  const svc = service();
  await refresh(svc, '2026-09');
  assert.equal((await get(svc, '2026-09')).payload.tasks.find((t) => t.key === 'A-1').outcome, 'done');
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { kpiDoneStatuses: 'Code Review', kpiDoneCategory: false } } });
  calls = [];
  const res = await get(svc, '2026-09');
  assert.equal(calls.length, 0);
  assert.notEqual(res.payload.tasks.find((t) => t.key === 'A-1').outcome, 'done');
  const sig = kpi.fingerprint(kpi.normalizeRules({ doneStatuses: ['Code Review'], doneCategory: false }));
  assert.ok(db.listKpiSprints().every((x) => !x.computedAt || x.rulesSignature === sig));
});

test('per-role rules: a role rule or a role change on the team recomputes locally; other settings stay', async () => {
  const svc = service();
  await refresh(svc, '2026-09');
  const outcome = async () => (await get(svc, '2026-09')).payload.tasks.find((t) => t.key === 'A-1').outcome;
  assert.equal(await outcome(), 'done');
  const team = (role) => TEAM.map((m) => (m.id === 'm1' ? { ...m, role } : m));
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { members: team('Developer'),
    settings: { kpiRoleRules: [{ role: 'developer', doneStatuses: 'Code Review', doneCategory: false }] } } });
  calls = [];
  assert.notEqual(await outcome(), 'done', 'User One is judged by the developer rule');
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { members: team('Designer') } });
  assert.equal(await outcome(), 'done', 'no rule for the new role: the default rule again');
  assert.equal(calls.length, 0, 'no JIRA calls');
  const st = db.loadState().settings;
  assert.deepEqual([st.kpiDoneStatuses, st.kpiDoneCategory, st.kpiMembers], ['Untested', true, ['m1']]);
  assert.deepEqual(st.kpiRoleRules, [{ role: 'developer', doneStatuses: 'Code Review', doneCategory: false }]);
});

test('a refresh stores the rules it started with when settings change mid-run', async () => {
  const svc = service();
  const before = kpi.fingerprint(kpi.normalizeRules({ doneStatuses: ['Untested'], doneCategory: true }));
  on(/^\/rest\/api\/3\/status$/, () => {
    db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { kpiDoneCategory: false } } });
    return [{ id: '1', statusCategory: { key: 'new' } }, { id: '3', statusCategory: { key: 'indeterminate' } },
      { id: '10001', statusCategory: { key: 'done' } }];
  });
  await refresh(svc, '2026-09');
  const computed = db.listKpiSprints().filter((x) => x.computedAt);
  assert.ok(computed.length);
  assert.ok(computed.every((x) => x.rulesSignature === before));
  // the next read sees the new rules and recomputes locally
  calls = [];
  const res = await get(svc, '2026-09');
  assert.equal(calls.length, 0);
  assert.notEqual(res.payload.tasks.find((t) => t.key === 'A-1').outcome, 'done');
});

test('JIRA errors during setup become 502, missing credentials 400', async () => {
  const svc = service();
  on(/^\/rest\/api\/3\/field$/, () => json({}, 401));
  const res = await refresh(svc, '2026-09');
  assert.equal(res.status, 502);
  assert.equal((await get(svc, '2026-09')).payload.refreshing, false);
  db.savePatch({ baseVersion: db.getStateVersion(), patch: {}, creds: { token: null } });
  const res2 = await refresh(service(), '2026-09');
  assert.equal(res2.status, 400);
  assert.equal((await get(svc, '2026-09')).payload.configured, false);
});

const fields = (svc, admin = true, method = 'GET') => svc.handleRequest({ method, path: '/api/kpi/fields', admin });

test('fields lists story point fields for admins and suggests "Story Points"', async () => {
  const res = await fields(service());
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload, {
    fields: [{ id: 'customfield_10016', name: 'Story point estimate' }, { id: 'customfield_10032', name: 'Story Points' }],
    suggested: 'customfield_10032',
  });
  assert.equal((await fields(service(), false)).status, 403);
  assert.equal((await fields(service(), true, 'POST')).status, 405);
});

test('fields: JIRA errors become 502, missing credentials 400', async () => {
  on(/^\/rest\/api\/3\/field$/, () => json({}, 500));
  assert.equal((await fields(service())).status, 502);
  db.savePatch({ baseVersion: db.getStateVersion(), patch: {}, creds: { token: null } });
  assert.equal((await fields(service())).status, 400);
});

const trendOf = (svc, opts = {}) => svc.handleRequest({
  method: opts.method || 'GET', path: '/api/kpi/trend', admin: Boolean(opts.admin), team: opts.team || null,
});

test('GET /api/kpi/trend totals each cached sprint without calling JIRA', async () => {
  const svc = service();
  const empty = await trendOf(svc);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.payload.sprints, []);
  assert.equal(calls.length, 0, 'an empty cache needs no JIRA either');
  await refresh(svc, '2026-09');
  calls.length = 0;
  const res = await trendOf(svc);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0, 'the trend reads the KPI cache only');
  assert.equal(res.payload.configured, true);
  assert.ok(res.payload.months.includes('2026-09'));
  assert.deepEqual(res.payload.sprints.map((s) => s.id), [101, 102], 'oldest sprint first');
  const closed = res.payload.sprints[0];
  assert.equal(closed.name, 'Sprint 101');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.month, '2026-09');
  assert.deepEqual([closed.done, closed.carryover, closed.open], [1, 0, 0]);
  assert.equal(closed.spDone, 3);
  assert.equal(closed.completion, 1);
  const active = res.payload.sprints[1];
  assert.equal(active.state, 'active');
  assert.equal(active.open, 1);
  assert.equal(active.completion, null, 'an active sprint with only open work has no completion');
});

test('POST /api/kpi/trend is refused', async () => {
  assert.equal((await trendOf(service(), { method: 'POST' })).status, 405);
});

test('a lead team set narrows the trend to that team’s tasks and sprints', async () => {
  const svc = service();
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { kpiMembers: [] } } });
  const other = issue('A-9', { sprintId: 101, state: 'closed', statusId: '10001', statusName: 'Done', cat: 'done',
    updated: '2026-09-06T03:00:00.000+0000', histories: [toDone('2026-09-06T03:00:00.000+0000')] });
  other.fields.assignee = { accountId: 'acc-2', displayName: 'User Two', emailAddress: 'u2@example.com' };
  other.fields.customfield_10032 = 5;
  jira.issues[101] = [jira.issues[101][0], other];
  await refresh(svc, '2026-09');
  const everyone = await trendOf(svc);
  assert.equal(everyone.payload.sprints.find((s) => s.id === 101).done, 2, 'both team members count');
  const mine = await trendOf(svc, { team: new Set(['m1']) });
  const row = mine.payload.sprints.find((s) => s.id === 101);
  assert.equal(row.done, 1, "only User One's task counts");
  assert.equal(row.spDone, 3);
  assert.deepEqual(mine.payload.sprints.map((s) => s.id), [101, 102]);
  const hers = await trendOf(svc, { team: new Set(['m2']) });
  assert.deepEqual(hers.payload.sprints.map((s) => s.id), [101], 'sprints without that team’s tasks are dropped');
  assert.equal(hers.payload.sprints[0].spDone, 5);
});
