/*
 * Unit tests for the KPI JIRA fetch layer (lib/jira-kpi.js) against a fake
 * fetch. No network. Run: npm test
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/jira-core.js');
const jk = require('../lib/jira-kpi.js');

const SITE = 'https://team.atlassian.net';
const AUTH = 'Basic x';
const realFetch = globalThis.fetch;

let routes; // [{ match: RegExp, reply: (url) => Response | body }]
let calls;  // requested paths

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });
}

beforeEach(() => {
  routes = [];
  calls = [];
  globalThis.fetch = async (url) => {
    const path = String(url).slice(SITE.length);
    calls.push(path);
    const r = routes.find((x) => x.match.test(path));
    if (!r) return json({ errorMessages: ['no route for ' + path] }, 404);
    const out = r.reply(path);
    return out instanceof Response ? out : json(out);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const on = (match, reply) => routes.push({ match, reply: typeof reply === 'function' ? reply : () => reply });
const noWait = { wait: async () => {} };
const param = (path, name) => new URL('http://x' + path).searchParams.get(name);

function rawIssue(key, { updated = '2026-09-10T10:00:00.000+0700', histories = [], total } = {}) {
  return {
    key,
    fields: {
      summary: key, status: { id: '1', name: 'To Do' }, assignee: null, issuetype: { name: 'Task' },
      created: '2026-09-01T10:00:00.000+0700', updated, customfield_10016: 2,
    },
    changelog: { startAt: 0, maxResults: histories.length, total: total === undefined ? histories.length : total, histories },
  };
}

const hist = (id, at, to, toString) => ({ id: String(id), created: at, items: [{ field: 'status', from: '1', fromString: 'To Do', to, toString }] });

// ---------- jiraFetch ----------

test('jiraFetch sets retryAfter and a clear message on HTTP 429', async () => {
  on(/./, () => json({}, 429, { 'Retry-After': '7' }));
  const err = await core.jiraFetch(SITE, AUTH, '/rest/api/3/status').catch((e) => e);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 7);
  assert.match(err.message, /rate limit/i);
});

// ---------- retry ----------

test('withRetry waits Retry-After (capped) and retries on 429', async () => {
  let n = 0;
  const waits = [];
  const out = await jk.withRetry(async () => {
    n += 1;
    if (n < 3) { const e = new Error('429'); e.status = 429; e.retryAfter = n === 1 ? 120 : null; throw e; }
    return 'ok';
  }, { wait: async (ms) => waits.push(ms) });
  assert.equal(out, 'ok');
  assert.deepEqual(waits, [30000, 5000]); // 120 s capped at 30 s; missing header → 5 s default
});

test('withRetry gives up after 3 retries and rethrows', async () => {
  let n = 0;
  const err = await jk.withRetry(async () => { n += 1; const e = new Error('slow down'); e.status = 429; throw e; }, noWait).catch((e) => e);
  assert.equal(n, 4);
  assert.equal(err.message, 'slow down');
});

test('withRetry does not retry other errors', async () => {
  let n = 0;
  await assert.rejects(jk.withRetry(async () => { n += 1; const e = new Error('nope'); e.status = 500; throw e; }, noWait));
  assert.equal(n, 1);
});

// ---------- statuses and fields ----------

test('statusCategories maps status ID to category key', async () => {
  on(/\/rest\/api\/3\/status$/, [{ id: '1', name: 'To Do', statusCategory: { key: 'new' } }, { id: '10003', name: 'Done', statusCategory: { key: 'done' } }]);
  assert.deepEqual(await jk.statusCategories(SITE, AUTH, noWait), { 1: 'new', 10003: 'done' });
});

test('listStatuses returns id, name and category for every status', async () => {
  on(/\/rest\/api\/3\/status$/, [{ id: '1', name: 'To Do', statusCategory: { key: 'new' } }, { id: '3', name: 'In Review' }, null]);
  assert.deepEqual(await jk.listStatuses(SITE, AUTH, noWait), [
    { id: '1', name: 'To Do', category: 'new' }, { id: '3', name: 'In Review', category: '' },
  ]);
});

test('storyPointFields lists fields named like story points', async () => {
  on(/\/rest\/api\/3\/field$/, [
    { id: 'summary', name: 'Summary' },
    { id: 'customfield_10016', name: 'Story point estimate' },
    { id: 'customfield_10028', name: 'Story Points' },
  ]);
  assert.deepEqual(await jk.storyPointFields(SITE, AUTH, noWait), [
    { id: 'customfield_10016', name: 'Story point estimate' },
    { id: 'customfield_10028', name: 'Story Points' },
  ]);
});

// ---------- issues and timelines ----------

/** Records POST bodies; the wrapped fetch still serves the routes. */
function recordBodies() {
  const bodies = [];
  globalThis.fetch = ((inner) => async (url, init) => {
    if (init && init.body) bodies.push(JSON.parse(init.body));
    return inner(url, init);
  })(globalThis.fetch);
  return bodies;
}

test('sprintFieldId finds the Sprint field by schema, or returns empty', async () => {
  on(/\/rest\/api\/3\/field$/, [{ id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }]);
  assert.equal(await jk.sprintFieldId(SITE, AUTH, noWait), 'customfield_10020');
  routes = [];
  on(/\/rest\/api\/3\/field$/, [{ id: 'summary', name: 'Summary' }]);
  assert.equal(await jk.sprintFieldId(SITE, AUTH, noWait), '');
});

test('sprintsOfIssues collects every sprint of every board once, normalized with its board', async () => {
  const bodies = recordBodies();
  on(/\/rest\/api\/3\/search\/jql$/, () => (bodies.length === 1
    ? { nextPageToken: 't2', issues: [{ fields: { customfield_10020: [
      { id: 7, name: 'DB2 Sprint 166', state: 'closed', boardId: 5, startDate: '2026-09-22T01:00:00.000Z', completeDate: '2026-09-29T09:00:00.000Z' },
    ] } }, { fields: { customfield_10020: null } }] }
    : { isLast: true, issues: [{ fields: { customfield_10020: [
      { id: 7, name: 'DB2 Sprint 166', state: 'closed', boardId: 5 },
      { id: 9, name: 'SQ Sprint 131', state: 'active', boardId: 41, startDate: '2026-09-21T01:00:00.000Z' },
    ] } }] }));
  const sprints = await jk.sprintsOfIssues(SITE, AUTH, 'assignee WAS IN ("a@b.c")', 'customfield_10020', noWait);
  assert.deepEqual(sprints.map((s) => [s.id, s.boardId, s.state, s.start]), [
    [7, 5, 'closed', '2026-09-22T01:00:00.000Z'], [9, 41, 'active', '2026-09-21T01:00:00.000Z']]);
  assert.deepEqual(bodies[0], { jql: 'assignee WAS IN ("a@b.c")', maxResults: 100, fields: ['customfield_10020'] });
  assert.equal(bodies[1].nextPageToken, 't2');
});

test('searchTimelines expands the changelog and reads the Sprint field as the issue sprints', async () => {
  const bodies = recordBodies();
  const issue = rawIssue('A-1', { histories: [hist(1, '2026-09-05T10:00:00.000+0700', '10003', 'Done')] });
  issue.fields.customfield_10020 = [{ id: 7, state: 'closed' }, { id: 8, state: 'active' }];
  on(/\/rest\/api\/3\/search\/jql$/, { isLast: true, issues: [issue] });
  const tls = await jk.searchTimelines(SITE, AUTH, 'sprint = 8', {
    pointsField: 'customfield_10016', sprintField: 'customfield_10020', cached: new Map(), wait: noWait.wait,
  });
  assert.equal(bodies[0].expand, 'changelog');
  assert.ok(bodies[0].fields.includes('customfield_10016') && bodies[0].fields.includes('customfield_10020'));
  assert.deepEqual(tls.map((t) => [t.key, t.points, t.status.length, t.initialSprints]), [['A-1', 2, 1, [7, 8]]]);
});

test('searchTimelines fetches the full changelog only when truncated', async () => {
  const short = rawIssue('A-1', { histories: [hist(1, '2026-09-05T10:00:00.000+0700', '10003', 'Done')] });
  const long = rawIssue('A-2', { histories: [hist(1, '2026-09-03T10:00:00.000+0700', '3', 'In Progress')], total: 2 });
  on(/\/rest\/api\/3\/search\/jql$/, { isLast: true, issues: [short, long] });
  on(/\/issue\/A-2\/changelog/, { isLast: true, values: [
    hist(1, '2026-09-03T10:00:00.000+0700', '3', 'In Progress'),
    hist(2, '2026-09-06T10:00:00.000+0700', '10001', 'Untested'),
  ] });
  const tls = await jk.searchTimelines(SITE, AUTH, 'sprint = 5', { pointsField: 'customfield_10016', cached: new Map(), wait: noWait.wait });
  assert.deepEqual(tls.map((t) => [t.key, t.status.length]), [['A-1', 1], ['A-2', 2]]);
  assert.equal(calls.filter((c) => c.includes('/changelog')).length, 1);
  assert.equal(tls[0].points, 2);
});

test('searchTimelines reuses the stored timeline when updated is unchanged', async () => {
  const long = rawIssue('A-2', { histories: [], total: 250 });
  on(/\/rest\/api\/3\/search\/jql$/, { isLast: true, issues: [long] });
  const stored = { key: 'A-2', updated: '2026-09-10T03:00:00.000Z', status: [{ at: 'x' }], marker: true };
  const tls = await jk.searchTimelines(SITE, AUTH, 'sprint = 5', {
    pointsField: 'customfield_10016', cached: new Map([['A-2', stored]]), wait: noWait.wait,
  });
  assert.equal(tls[0], stored);
  assert.equal(calls.filter((c) => c.includes('/changelog')).length, 0);
});

test('searchTimelines re-fetches when the issue changed since it was stored', async () => {
  const long = rawIssue('A-2', { updated: '2026-09-12T10:00:00.000+0700', histories: [], total: 1 });
  on(/\/rest\/api\/3\/search\/jql$/, { isLast: true, issues: [long] });
  on(/\/issue\/A-2\/changelog/, { isLast: true, values: [hist(1, '2026-09-11T10:00:00.000+0700', '10003', 'Done')] });
  const stored = { key: 'A-2', updated: '2026-09-10T03:00:00.000Z', status: [] };
  const tls = await jk.searchTimelines(SITE, AUTH, 'sprint = 5', {
    pointsField: 'customfield_10016', cached: new Map([['A-2', stored]]), wait: noWait.wait,
  });
  assert.equal(tls[0].status.length, 1);
});

test('fullChangelog pages until isLast', async () => {
  on(/\/issue\/A-9\/changelog/, (p) => (param(p, 'startAt') === '0'
    ? { isLast: false, values: [hist(1, '2026-09-03T10:00:00.000+0700', '3', 'In Progress')] }
    : { isLast: true, values: [hist(2, '2026-09-04T10:00:00.000+0700', '10003', 'Done')] }));
  const h = await jk.fullChangelog(SITE, AUTH, 'A-9', noWait);
  assert.deepEqual(h.map((x) => x.id), ['1', '2']);
});

test('issue keys are URL-encoded in changelog paths', async () => {
  on(/./, { isLast: true, values: [] });
  await jk.fullChangelog(SITE, AUTH, 'A-1/../x', noWait);
  assert.ok(calls[0].includes(encodeURIComponent('A-1/../x')));
});
