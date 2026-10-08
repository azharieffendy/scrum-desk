'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The UI scripts in index.html load order. Each runs as its own script in
// one shared context, like the browser; init() is left out.
const sources = ['theme.js', 'monthly-report.js', 'kpi-report.js', 'pi-periods.js', 'password-policy.js', 'pi-query.js', 'pi-report.js', 'pi-editor.js', 'status-colors.js', 'live-sync.js', 'own-key.js', 'dialogs.js', 'tooltips.js', 'setup-checklist.js', 'app-core.js', 'app-auth.js', 'app-views.js', 'app.js'].map((name) =>
  fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8').replace(/\ninit\(\);\s*$/, '\n'));

function appContext(fetchImpl = async () => { throw new Error('unexpected fetch'); }) {
  const storage = new Map();
  const classList = { add() {}, remove() {}, contains() { return false; } };
  const nodes = {
    '#app': { innerHTML: '', dataset: {} },
    '#toasts': { appendChild() {} },
    '#sprintChip': { hidden: true, innerHTML: '' },
    '#saveHint': { classList },
    '#logoutBtn': { hidden: true, title: '', textContent: '' },
    '#accountName': { textContent: '' },
  };
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    CSS: { escape: (s) => String(s) },
    document: {
      documentElement: { dataset: {}, style: {} },
      body: { classList },
      querySelector: (selector) => nodes[selector] || null,
      querySelectorAll: () => [],
      getElementById: (id) => nodes['#' + id] || null,
      createElement: () => ({ classList, remove() {}, setAttribute() {}, append() {}, addEventListener() {} }),
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    fetch: fetchImpl,
    setTimeout: () => 1,
    clearTimeout: () => {},
    TextEncoder,
    URL,
    console,
  });
  for (const source of sources) vm.runInContext(source, context);
  return { context, storage };
}

test('cancel clears notes even when the board had a visible textarea', () => {
  const { context } = appContext();
  vm.runInContext(`
    storageMode = 'local';
    state.members = [{ id: 'm1', name: 'Member One', color: '#3D51E0' }];
    ui.date = todayISO();
    state.days[ui.date] = { startedAt: 's', roster: state.members.map(memberSnapshot),
      entries: { m1: { today: 'old note' } }, jira: null };
    onDocInput({ target: { matches: () => true, closest: () => null,
      dataset: { date: ui.date, member: 'm1', field: 'today' }, value: 'latest note' } });
    cancelDay();
  `, context);
  assert.equal(vm.runInContext('state.days[ui.date]', context), undefined);
});

test('conflict reload keeps the server text', async () => {
  const day = new Date().toLocaleDateString('sv-SE');
  const member = { id: 'm1', name: 'Member One', color: '#3D51E0' };
  const serverState = { members: [member], mapping: {}, settings: { jql: '' }, days: {
    [day]: { startedAt: 's', roster: [member], entries: { m1: { today: 'server text' } }, jira: null },
  } };
  const { context } = appContext(async () => ({ ok: true, json: async () =>
    ({ state: serverState, version: 2, loadedAt: '2026-09-30T00:00:00Z' }) }));
  context.serverState = serverState;
  await vm.runInContext(`
    state = clone(serverState);
    ui.date = todayISO();
    state.days[ui.date].entries.m1.today = 'stale text';
    reloadAfterConflict()
  `, context);
  assert.equal(vm.runInContext('state.days[ui.date].entries.m1.today', context), 'server text');
});

/* Live updates: a board where m1 typed locally and someone else saved m2. */
function liveBoard(version, entries) {
  const day = new Date().toLocaleDateString('sv-SE');
  const members = [{ id: 'm1', name: 'Member One', color: '#3D51E0' }, { id: 'm2', name: 'Member Two', color: '#E0513D' }];
  return { state: { members, mapping: {}, settings: { jql: '' },
    days: { [day]: { startedAt: 's', roster: members, entries, jira: null } } }, version, loadedAt: 'now' };
}

test("a live update brings in another person's entry and keeps my unsaved typing", async () => {
  const { context } = appContext(async () => ({ ok: true, json: async () =>
    liveBoard(3, { m1: { today: '' }, m2: { today: 'their update' } }) }));
  context.loaded = liveBoard(2, { m1: { today: '' }, m2: { today: '' } });
  await vm.runInContext(`
    storageMode = 'server';
    applyServerData(loaded);
    ui.date = todayISO();
    state.days[ui.date].entries.m1.today = 'my unsaved text';
    onLiveEvent({ data: JSON.stringify({ version: 3, reason: 'save' }) })
  `, context);
  assert.equal(vm.runInContext('state.days[ui.date].entries.m2.today', context), 'their update');
  assert.equal(vm.runInContext('state.days[ui.date].entries.m1.today', context), 'my unsaved text');
  assert.equal(vm.runInContext('stateVersion', context), 3);
  assert.match(vm.runInContext("document.querySelector('#app').innerHTML", context), /their update/);
});

test('a live event for a version this tab already has fetches nothing', async () => {
  let calls = 0;
  const { context } = appContext(async () => { calls++; return { ok: true, json: async () => liveBoard(2, {}) }; });
  context.loaded = liveBoard(2, {});
  await vm.runInContext(`
    storageMode = 'server';
    applyServerData(loaded);
    onLiveEvent({ data: JSON.stringify({ version: 2, reason: 'save' }) })
  `, context);
  assert.equal(calls, 0);
});

test('a background JIRA refresh is pulled in even though the version did not change', async () => {
  let calls = 0;
  const { context } = appContext(async () => { calls++; return { ok: true, json: async () => liveBoard(2, {}) }; });
  context.loaded = liveBoard(2, {});
  await vm.runInContext(`
    storageMode = 'server';
    applyServerData(loaded);
    onLiveEvent({ data: JSON.stringify({ version: 2, reason: 'jira' }) })
  `, context);
  assert.equal(calls, 1);
});

test('a save that hits a conflict merges the newer board and retries instead of dropping the edit', async () => {
  const puts = [];
  const { context } = appContext(async (url, options) => {
    if (!options || options.method !== 'PUT') {
      return { ok: true, json: async () => liveBoard(3, { m1: { today: '' }, m2: { today: 'their update' } }) };
    }
    const body = JSON.parse(options.body);
    puts.push(body);
    if (body.baseVersion !== 3) return { ok: false, status: 409, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ version: 4 }) };
  });
  context.loaded = liveBoard(2, { m1: { today: '' }, m2: { today: '' } });
  const saved = await vm.runInContext(`
    storageMode = 'server';
    applyServerData(loaded);
    ui.date = todayISO();
    state.days[ui.date].entries.m1.today = 'my edit';
    sendState()
  `, context);
  assert.equal(saved, true);
  assert.equal(puts.length, 2);
  const retried = Object.values(puts[1].patch.days.upsert)[0];
  assert.equal(retried.entries.m1.today, 'my edit');
  assert.equal(retried.entries.m2.today, 'their update', 'the retry must not overwrite their entry');
  assert.equal(vm.runInContext('stateVersion', context), 4);
});

test('failed browser-data migration retains the original local copy', async () => {
  const { context, storage } = appContext(async (url, options) => {
    if (url === '/api/state' && (!options || options.method === 'GET')) return { ok: true, json: async () => ({
      state: { members: [], days: {}, mapping: {}, settings: { jql: '' } }, version: 0, loadedAt: 'now',
    }) };
    return { ok: false, status: 413 };
  });
  storage.set('dailyscrum.state.v1', JSON.stringify({
    members: [{ id: 'm1', name: 'Member One' }], days: {}, mapping: {}, settings: { jql: '' },
  }));
  await assert.rejects(vm.runInContext('bootStorage()', context), /original copy is still in this browser/);
  assert.ok(storage.has('dailyscrum.state.v1'));
  assert.equal(storage.get('dailyscrum.migration-pending.v1'), '1');
});

test('a partial migration resumes without replacing server data', async () => {
  let savedPatch;
  const member = { id: 'm1', name: 'Member One' };
  const existingDay = { startedAt: 's', roster: [member], entries: { m1: { today: 'saved' } }, jira: null };
  const missingDay = { startedAt: 's', roster: [member], entries: { m1: { today: 'remaining' } }, jira: null };
  const { context, storage } = appContext(async (url, options) => {
    if (!options) return { ok: true, json: async () => ({ state: {
      members: [member], days: { '2026-09-01': existingDay }, mapping: {}, settings: { jql: '' },
    }, version: 1, loadedAt: 'now' }) };
    savedPatch = JSON.parse(options.body).patch;
    return { ok: true, json: async () => ({ version: 2, loadedAt: 'later' }) };
  });
  storage.set('dailyscrum.state.v1', JSON.stringify({ members: [member],
    days: { '2026-09-01': existingDay, '2026-09-02': missingDay }, mapping: {}, settings: { jql: '' } }));
  storage.set('dailyscrum.migration-pending.v1', '1');
  await vm.runInContext('bootStorage()', context);
  assert.equal(savedPatch.days.upsert['2026-09-02'].entries.m1.today, 'remaining');
  assert.equal(savedPatch.days.upsert['2026-09-01'], undefined);
  assert.equal(storage.has('dailyscrum.state.v1'), false);
  assert.equal(storage.has('dailyscrum.migration-pending.v1'), false);
});

test('a temporary auth API failure never switches to browser storage', async () => {
  const { context } = appContext(async () => { throw new Error('network unavailable'); });
  await vm.runInContext('boot()', context);
  assert.equal(vm.runInContext('storageMode', context), 'server');
  assert.match(vm.runInContext("document.querySelector('#app').innerHTML", context), /Board unavailable/);
});

test('JIRA sync from a historical view writes to today', async () => {
  const { context } = appContext(async () => ({ ok: true, json: async () => ({
    syncedAt: '2026-09-30T12:00:00Z', sprint: null, issues: [],
  }) }));
  await vm.runInContext(`
    storageMode = 'local';
    ui.date = '2026-09-01';
    state.days[ui.date] = { startedAt: 's', roster: [], entries: {}, jira: null };
    syncJira()
  `, context);
  assert.equal(vm.runInContext("state.days['2026-09-01'].jira", context), null);
  assert.equal(vm.runInContext('state.days[todayISO()].jira.syncedAt', context), '2026-09-30T12:00:00Z');
});

test('a save sends only changed days from a large history', () => {
  const { context } = appContext();
  const issue = { key: 'PAY-1', summary: 'Fix duplicate payments', status: 'In Progress',
    assignee: { accountId: 'a', name: 'Member One' } };
  const previous = { members: [], mapping: {}, settings: { jql: '' }, days: {} };
  for (let d = 1; d <= 30; d++) {
    previous.days['2026-09-' + String(d).padStart(2, '0')] = {
      entries: {}, startedAt: null, jira: { syncedAt: 'x', issues: Array(300).fill(issue) },
    };
  }
  const next = structuredClone(previous);
  next.days['2026-09-30'].entries.m1 = { today: 'changed' };
  context.previous = previous;
  context.next = next;
  const batches = vm.runInContext('statePatchBatches(previous, next, false)', context);
  assert.equal(Object.keys(batches[0].days.upsert).length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(batches[0])) < 1024 * 1024);
});

test("removing a member also removes them from today's started roster", () => {
  const { context } = appContext();
  vm.runInContext(`
    storageMode = 'local';
    state.members = [{ id: 'm1', name: 'Member One', color: '#3D51E0' }, { id: 'm2', name: 'Member Two', color: '#E0513D' }];
    ui.date = todayISO();
    state.days[ui.date] = { startedAt: 's', roster: state.members.map(memberSnapshot), entries: {}, jira: null };
    removeMember('m2');
  `, context);
  assert.equal(vm.runInContext("state.days[ui.date].roster.map((m) => m.id).join()", context), 'm1');
});

test('a save with no changes sends no request', async () => {
  let calls = 0;
  const { context } = appContext(async () => { calls++; return { ok: true, status: 200, json: async () => ({ version: 3 }) }; });
  const saved = await vm.runInContext(`
    storageMode = 'server';
    applyServerData({ state: { members: [], mapping: {}, settings: { jql: '' }, days: {} }, version: 2 });
    sendState()
  `, context);
  assert.equal(saved, true);
  assert.equal(calls, 0);
});

test('a future day cannot be started', () => {
  const { context } = appContext();
  vm.runInContext(`
    storageMode = 'local';
    const d = new Date(); d.setDate(d.getDate() + 1);
    ui.date = d.toLocaleDateString('sv-SE');
    startDay();
  `, context);
  assert.equal(vm.runInContext('isStarted(state.days[ui.date])', context), false);
});

test('an expired session during boot shows the login screen', async () => {
  let loginShown = false;
  const { context } = appContext(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  context.markLogin = () => { loginShown = true; };
  await vm.runInContext(`
    storageMode = 'server';
    showAuthScreen = (mode) => { if (mode === 'login') markLogin(); };
    showUnavailableScreen = () => { throw new Error('should not show Board unavailable'); };
    enterBoard()
  `, context);
  assert.equal(loginShown, true);
});

test('theme switch persists a personal choice without changing board state', () => {
  const { context, storage } = appContext();
  assert.equal(vm.runInContext('document.documentElement.dataset.theme', context), 'light');
  vm.runInContext('clickActions.theme()', context);
  assert.equal(vm.runInContext('document.documentElement.dataset.theme', context), 'dark');
  assert.equal(storage.get('dailyscrum.theme.v1'), 'dark');
  assert.equal(storage.has('dailyscrum.state.v1'), false);
});

const kpiPayload = {
  month: '2026-09', months: ['2026-09'], computedAt: '2026-09-20T00:00:00.000Z', configured: true, refreshing: false,
  sprints: [{ id: 1, name: 'Sprint 1', state: 'closed', start: '2026-09-01', end: '2026-09-12', status: 'ok', error: null }],
  tasks: [
    { sprintId: 1, key: 'T-1', summary: 'First task', accountId: 'acc-1', assigneeName: 'Member One', outcome: 'done', doneAt: '2026-09-10T03:00:00.000Z', points: 3, reason: 'Done in sprint' },
    { sprintId: 1, key: 'T-2', summary: 'Second task', accountId: 'acc-2', assigneeName: 'Member Two', outcome: 'carryover', doneAt: null, points: 2, reason: 'Open at close' },
    { sprintId: 1, key: 'T-3', summary: 'Hidden task', accountId: 'acc-2', assigneeName: 'Member Two', outcome: 'excluded', doneAt: null, points: 1, reason: 'Done before sprint' },
  ],
};

async function kpiBoard(role, fetchImpl) {
  const calls = [];
  const { context } = appContext(async (url, init) => {
    calls.push({ url, init });
    return fetchImpl ? fetchImpl(url, init) : { ok: true, status: 200, json: async () => kpiPayload };
  });
  vm.runInContext(`
    auth = { name: 'x', role: '${role}' };
    state.members = [{ id: 'm1', name: 'Member One', color: '#3D51E0' }, { id: 'm2', name: 'Member Two', color: '#0F8A5F' }];
    creds.site = 'team.atlassian.net';
    ui.month = '2026-09';
    clickActions.view({ dataset: { view: 'kpi' } });
  `, context);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { context, calls, html: () => vm.runInContext("document.querySelector('#app').innerHTML", context) };
}

test('KPI tab loads the month and shows members, tasks and links', async () => {
  const { calls, html } = await kpiBoard('viewer');
  assert.equal(calls[0].url, '/api/kpi?month=2026-09');
  assert.match(html(), /Member One/);
  assert.match(html(), /href="https:\/\/team\.atlassian\.net\/browse\/T-1"/);
  assert.doesNotMatch(html(), /Hidden task/);
  assert.doesNotMatch(html(), /data-action="kpi-refresh"/);
  assert.match(html(), /data-action="kpi-download"/);
});

test('KPI member row filters the task list; excluded toggle shows hidden tasks', async () => {
  const { context, html } = await kpiBoard('viewer');
  vm.runInContext(`clickActions['kpi-member']({ dataset: { key: 'm:m1' } })`, context);
  assert.match(html(), /First task/);
  assert.doesNotMatch(html(), /Second task/);
  vm.runInContext(`clickActions['kpi-member']({ dataset: { key: 'm:m1' } })`, context);
  assert.match(html(), /Second task/);
  vm.runInContext(`clickActions['kpi-excluded']()`, context);
  assert.match(html(), /Hidden task/);
});

test('KPI refresh is for admins and posts the month', async () => {
  const { context, calls, html } = await kpiBoard('admin');
  assert.match(html(), /data-action="kpi-refresh"/);
  await vm.runInContext(`refreshKpi()`, context);
  const post = calls.find((c) => c.url === '/api/kpi/refresh');
  assert.equal(post.init.method, 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { month: '2026-09' });
});

test('KPI tab failing to load shows the error once, not a fetch loop', async () => {
  const { calls, html } = await kpiBoard('viewer', async () => ({ ok: false, status: 502, json: async () => ({ error: 'JIRA down' }) }));
  assert.match(html(), /JIRA down/);
  assert.equal(calls.length, 1);
});

test('a trend reset during a load starts a new load and drops the stale result', async () => {
  const pending = [];
  const { context } = appContext((url) => new Promise((resolve) => pending.push({ url, resolve })));
  const reply = (i, tag) => pending[i].resolve({ ok: true, status: 200, json: async () => ({ tag, sprints: [] }) });
  vm.runInContext(`loadKpiTrend(); resetKpiTrend(); loadKpiTrend();`, context);
  assert.equal(pending.length, 2, 'the reset must not leave the trend stuck as loading');
  reply(1, 'fresh');
  reply(0, 'stale');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(vm.runInContext('kpiUi.trend.data && kpiUi.trend.data.tag', context), 'fresh');
  assert.equal(vm.runInContext('kpiUi.trend.loading', context), false);
});

test('KPI tab in local mode says it needs the server', () => {
  const { context } = appContext();
  vm.runInContext(`storageMode = 'local'; ui.view = 'kpi'; render();`, context);
  assert.match(vm.runInContext("document.querySelector('#app').innerHTML", context), /server mode only/);
});

function kpiSettings(fetchImpl) {
  const calls = [];
  const { context } = appContext(async (url, init) => {
    calls.push({ url, init });
    return fetchImpl(url, init);
  });
  vm.runInContext(`
    storageMode = 'server';
    auth = { name: 'x', role: 'admin' };
    applyServerData({ state: {}, version: 1, creds: { site: 'team.atlassian.net', email: 'lead@example.test',
      hasToken: true, kpiBoardId: '5', kpiPointsField: 'customfield_1' } });
    ui.view = 'settings';
    ui.settingsTab = 'kpi';
    render();
  `, context);
  const html = () => vm.runInContext("document.querySelector('#app').innerHTML", context);
  return { context, calls, html };
}

test('KPI settings show the saved points field (no board: JIRA is searched by member); it is sent only after an edit', () => {
  const { context, html } = kpiSettings(async () => { throw new Error('unexpected fetch'); });
  assert.doesNotMatch(html(), /setKpiBoard/);
  assert.match(html(), /id="setKpiField"[^>]*value="customfield_1"/);
  assert.match(html(), /data-action="kpi-detect-field"/);
  const sent = () => JSON.parse(vm.runInContext('JSON.stringify(credsForServer(false))', context));
  assert.equal(sent().kpiPointsField, undefined);
  vm.runInContext(`
    const extra = { '#setKpiField': { value: ' customfield_2 ' } };
    const orig = document.querySelector;
    document.querySelector = (s) => extra[s] || orig(s);
    gatherCredsFromDom();
    document.querySelector = orig;
  `, context);
  assert.equal(sent().kpiPointsField, 'customfield_2');
  vm.runInContext(`applyServerData({ state: {}, version: 2, creds: { kpiPointsField: 'customfield_2' } })`, context);
  assert.equal(sent().kpiPointsField, undefined);
});

test('Detect fills the points field from the server suggestion', async () => {
  const { context, calls, html } = kpiSettings(async (url) => (url === '/api/kpi/fields'
    ? { ok: true, status: 200, json: async () => ({ fields: [{ id: 'customfield_9', name: 'Story Points' }], suggested: 'customfield_9' }) }
    : { ok: true, status: 200, json: async () => ({ version: 2 }) }));
  await vm.runInContext(`detectKpiField()`, context);
  assert.ok(calls.some((c) => c.url === '/api/kpi/fields'));
  assert.equal(vm.runInContext('credsForServer(false).kpiPointsField', context), 'customfield_9');
  assert.match(html(), /id="setKpiField"[^>]*value="customfield_9"/);
});

test('Detect with no story points field says so and keeps the value', async () => {
  const { context } = kpiSettings(async () => ({ ok: true, status: 200, json: async () => ({ fields: [], suggested: null }) }));
  await vm.runInContext(`detectKpiField()`, context);
  assert.equal(vm.runInContext('creds.kpiPointsField', context), 'customfield_1');
  assert.equal(vm.runInContext('credsForServer(false).kpiPointsField', context), undefined);
});

test('an invalid KPI board or field ID is refused before it can block saves', () => {
  const { context } = kpiSettings(async () => { throw new Error('unexpected fetch'); });
  vm.runInContext(`
    const extra = { '#setKpiBoard': { value: 'board 5' }, '#setKpiField': { value: 'field id!' } };
    const orig = document.querySelector;
    document.querySelector = (s) => extra[s] || orig(s);
    gatherCredsFromDom();
    document.querySelector = orig;
  `, context);
  assert.equal(vm.runInContext('creds.kpiBoardId', context), '5');
  assert.equal(vm.runInContext('credsForServer(false).kpiBoardId', context), undefined);
  assert.equal(vm.runInContext('creds.kpiPointsField', context), 'customfield_1');
});

test('status badges use the saved colour slot and a stage marker', () => {
  const { context } = appContext();
  const html = vm.runInContext(`
    applyServerData({ state: {}, statusColors: { 'in review': 9, bogus: 99 } });
    [JSON.stringify(statusColors),
      ticketRow({ key: 'T-1', summary: 'S', status: 'In Review', statusCategory: 'indeterminate', url: 'https://x.test/T-1' }),
      ticketRow({ key: 'T-2', summary: 'S', status: 'Closed', statusCategory: 'done', url: 'https://x.test/T-2' })]
  `, context);
  assert.equal(html[0], '{"in review":9}');
  assert.match(html[1], /<span class="status st-9" data-cat="indeterminate"/);
  assert.match(html[2], /<span class="status st-(1[89]|2[0-3])" data-cat="done"/); // hash within the done range
});

test('status badges get a distinct per-name colour even when no map was loaded', () => {
  const { context } = appContext();
  const html = vm.runInContext(`
    ['In Progress', 'In Review', 'QA'].map((status) =>
      ticketRow({ key: 'T-1', summary: 'S', status, statusCategory: 'indeterminate', url: 'https://x.test/T-1' }))
  `, context);
  const slots = html.map((h) => Number(/class="status st-(\d+)" data-cat="indeterminate"/.exec(h)[1]));
  for (const slot of slots) assert.ok(slot >= 6 && slot <= 17, String(slot));
  assert.equal(new Set(slots).size, 3, String(slots));
});

test('Settings lists status colours; admins get the picker, viewers only the badges', () => {
  const { context } = appContext();
  const html = vm.runInContext(`
    storageMode = 'server';
    statusColors = { 'in review': 9, done: 18, closed: 18 };
    ui.statusPick = 'in review';
    const admin = statusColorsPanel();
    auth.role = 'viewer';
    [admin, statusColorsPanel()]
  `, context);
  const [admin, viewer] = html;
  assert.match(admin, /<button[^>]*class="status st-9"[^>]*data-action="status-color-pick"[^>]*data-name="in review"/);
  assert.equal((admin.match(/data-action="status-color-set"/g) || []).length, 24);
  assert.match(admin, /data-slot="9"[^>]*aria-pressed="true"/);
  assert.match(admin, /data-action="status-color-reset"/);
  assert.match(admin, /Same colour as closed/);
  assert.doesNotMatch(viewer, /data-action=/);
  assert.match(viewer, /<span class="status st-9" data-cat="indeterminate"/);
});

test('picking a colour sends only that status and applies the saved map', async () => {
  let sent;
  const { context } = appContext(async (url, options) => {
    sent = { url, method: options.method, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ statusColors: { 'in review': 12, done: 18, synced: 19 } }) };
  });
  vm.runInContext(`storageMode = 'server'; statusColors = { 'in review': 9, done: 18 }; ui.statusPick = 'in review';`, context);
  await vm.runInContext(`clickActions['status-color-set']({ dataset: { name: 'in review', slot: '12' } })`, context);
  assert.deepEqual(sent, { url: '/api/status-colors', method: 'PUT', body: { colors: { 'in review': 12 } } });
  assert.equal(vm.runInContext('JSON.stringify(statusColors)', context), '{"in review":12,"done":18,"synced":19}');
  assert.equal(vm.runInContext('ui.statusPick', context), '');
  assert.ok(vm.runInContext(`EDIT_ACTIONS.includes('status-color-set') && EDIT_ACTIONS.includes('status-color-reset')`, context));
});

/* ---------------- Today page layout ---------------- */

function todayBoard(context, entries) {
  vm.runInContext(`
    storageMode = 'local';
    state.members = [
      { id: 'm1', name: 'Ana', color: '#3D51E0' }, { id: 'm2', name: 'Budi', color: '#0F8A5F' },
      { id: 'm3', name: 'Citra', color: '#A53956' }, { id: 'm4', name: 'Dedi', color: '#594D7F' },
    ];
    ui.date = todayISO();
    state.days[ui.date] = { startedAt: 's', roster: state.members.map(memberSnapshot), entries: ${JSON.stringify(entries)}, jira: null };
  `, context);
}

test('Today downloads attendance, notes and matched tickets as an Excel workbook', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { attendance: 'late', yesterday: 'Reviewed code', today: 'Build API', blockers: 'Waiting on access' } });
  vm.runInContext(`state.days[ui.date].jira = { sprint: { name: 'Sprint 14' }, issues: [
    { key: 'S-1', summary: 'Build API', status: 'In Progress', priority: 'High', url: 'https://team.atlassian.net/browse/S-1', assignee: { name: 'Ana' } },
    { key: 'S-2', summary: 'No owner', status: 'To Do', assignee: null }
  ] }`, context);
  const sheets = JSON.parse(vm.runInContext('JSON.stringify(dayReportSheets(ui.date))', context));
  assert.deepEqual(sheets.map((sheet) => sheet.name), ['Daily standup', 'Sprint tickets']);
  const ana = sheets[0].rows.find((row) => row[0] && row[0].v === 'Ana');
  assert.deepEqual(ana.map((cell) => cell.v), ['Ana', '', 'Late', 'Reviewed code', 'Build API', 'Waiting on access', 1]);
  assert.equal(sheets[1].rows.length, 2);
  assert.equal(sheets[1].rows[1][1].v, 'S-1');
  assert.equal(sheets[1].rows[1][1].link, 'https://team.atlassian.net/browse/S-1');

  context.XlsxLite = require('../public/xlsx.js');
  context.Blob = Blob;
  let exportedBlob;
  let filename;
  context.URL = { createObjectURL(blob) { exportedBlob = blob; return 'blob:standup'; }, revokeObjectURL() {} };
  context.document.body.appendChild = () => {};
  context.document.createElement = () => ({ click() { filename = this.download; }, remove() {} });
  vm.runInContext('toast = () => {}; downloadReport(ui.date)', context);
  assert.equal(filename, 'standup-report-' + vm.runInContext('ui.date', context) + '.xlsx');
  assert.equal(exportedBlob.type, context.XlsxLite.MIME);
  assert.ok(exportedBlob.size > 1000);
});

test('Today summary counts who is here, late, away, blocked and without an update', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { blockers: 'API keys' }, m2: { attendance: 'late', blockers: '  ' }, m3: { attendance: 'leave' }, m4: { today: 'Plan' } });
  const s = vm.runInContext('todaySummary(state.members, state.days[ui.date])', context);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { total: 4, here: 3, late: 1, away: 1, blockers: 1, noUpdate: 2 });
  const html = vm.runInContext('viewToday()', context);
  assert.match(html, /id="todaySummary"/);
  assert.match(html, /<b>3<\/b>\/4 here/);
  assert.match(html, /data-action="today-filter" data-filter="blockers"[^>]*>Blockers <span>1<\/span>/);
  assert.match(html, /data-action="today-filter" data-filter="noupdate"[^>]*>No update <span>2<\/span>/);
});

test('the no-update filter shows only present members without yesterday or today notes', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { today: 'Plan' }, m3: { attendance: 'sick' } });
  vm.runInContext("clickActions['today-filter']({ dataset: { filter: 'noupdate' } })", context);
  const html = vm.runInContext('viewToday()', context);
  const grid = html.slice(html.indexOf('class="member-grid"'));
  assert.doesNotMatch(grid, /data-member="m1"/);
  assert.match(grid, /data-member="m2"/);
  assert.doesNotMatch(grid, /data-member="m3"/);
});

test('a card with blockers is flagged and shows the blocker field first', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { blockers: 'API keys' } });
  const card = vm.runInContext("memberCard(state.members[0], state.days[ui.date])", context);
  assert.match(card, /class="member-card has-blocker"/);
  assert.ok(card.indexOf('data-field="blockers"') < card.indexOf('data-field="yesterday"'));
  const plain = vm.runInContext("memberCard(state.members[1], state.days[ui.date])", context);
  assert.doesNotMatch(plain, /has-blocker/);
});

test('the roll call shows everyone with a status pill; editors open a menu and pick, viewers only read it', () => {
  const { context } = appContext();
  todayBoard(context, { m2: { attendance: 'late' } });
  const roll = () => { const h = vm.runInContext('viewToday()', context); return h.slice(h.indexOf('class="roll-call"'), h.indexOf('class="board-tools"')); };
  let html = roll();
  for (const id of ['m1', 'm2', 'm3', 'm4']) assert.match(html, new RegExp(`data-action="att-menu" data-id="${id}" data-src="roll" aria-haspopup="menu" aria-expanded="false"`));
  assert.match(html, /class="roll-person att-late" data-action="att-menu" data-id="m2"/);
  assert.match(html, /<span class="att-pill att-present">.*?Present<span class="att-caret"/);
  assert.match(html, /Tap a status to change it/);
  assert.doesNotMatch(html, /class="att-menu"/);
  assert.doesNotMatch(vm.runInContext('memberCard(state.members[1], state.days[ui.date])', context), /att-select|<select/);

  vm.runInContext("clickActions['att-menu']({ dataset: { id: 'm2', src: 'roll' } })", context);
  html = roll();
  assert.match(html, /data-id="m2" data-src="roll" aria-haspopup="menu" aria-expanded="true"/);
  assert.equal((html.match(/class="att-menu"/g) || []).length, 1);
  const menu = html.slice(html.indexOf('class="att-menu"'));
  for (const k of ['present', 'late', 'leave', 'sick', 'noshow']) assert.match(menu, new RegExp(`data-att="${k}"`));
  assert.match(menu, /aria-checked="true" tabindex="-1" data-action="att-set" data-id="m2" data-src="roll" data-att="late"/);

  // one pick lands on the exact status: no cycling through the others
  vm.runInContext("clickActions['att-set']({ dataset: { id: 'm2', src: 'roll', att: 'noshow' } })", context);
  assert.equal(vm.runInContext("state.days[ui.date].entries.m2.attendance", context), 'noshow');
  assert.equal(vm.runInContext('ui.attMenu', context), null);
  assert.doesNotMatch(roll(), /class="att-menu"/);
  vm.runInContext("clickActions['att-set']({ dataset: { id: 'm1', src: 'card', att: 'bogus' } })", context);
  assert.equal(vm.runInContext("state.days[ui.date].entries.m1", context), undefined);
  assert.equal(vm.runInContext("typeof clickActions['cycle-att']", context), 'undefined');

  vm.runInContext("auth.role = 'viewer'", context);
  html = roll();
  assert.doesNotMatch(html, /data-action="att-menu"|Tap a status|att-caret/);
  assert.match(html, /<span class="roll-person att-present"/);
  vm.runInContext("clickActions['att-menu']({ dataset: { id: 'm1', src: 'roll' } }); clickActions['att-set']({ dataset: { id: 'm1', src: 'roll', att: 'sick' } })", context);
  assert.equal(vm.runInContext('ui.attMenu', context), null);
  assert.equal(vm.runInContext("state.days[ui.date].entries.m1", context), undefined);
});

test('every card shows its status pill, Present included, and opens its own menu', () => {
  const { context } = appContext();
  todayBoard(context, { m2: { attendance: 'late' } });
  const card = (i) => vm.runInContext(`memberCard(state.members[${i}], state.days[ui.date])`, context);
  assert.match(card(0), /data-action="att-menu" data-id="m1" data-src="card"[^>]*><span class="att-pill att-present">/);
  assert.match(card(1), /<span class="att-pill att-late">/);
  vm.runInContext("clickActions['att-menu']({ dataset: { id: 'm1', src: 'card' } })", context);
  assert.match(card(0), /class="att-menu" role="menu"/);
  const html = vm.runInContext('viewToday()', context);
  assert.doesNotMatch(html.slice(html.indexOf('class="roll-call"'), html.indexOf('class="board-tools"')), /class="att-menu"/);
  vm.runInContext("clickActions['att-menu']({ dataset: { id: 'm1', src: 'card' } })", context);
  assert.equal(vm.runInContext('ui.attMenu', context), null);
  vm.runInContext("auth.role = 'viewer'", context);
  assert.match(card(0), /<span class="att-pick" title="Attending the opening"><span class="att-pill att-present">/);
  assert.doesNotMatch(card(0), /data-action="att-menu"/);
});

test('an open attendance menu is forgotten once its pill leaves the page', () => {
  const { context } = appContext();
  todayBoard(context, {});
  vm.runInContext("clickActions['att-menu']({ dataset: { id: 'm1', src: 'card' } })", context);
  vm.runInContext('render()', context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(ui.attMenu)', context)), { id: 'm1', src: 'card' });
  // another view without a click (Back, a live update) drops it, so returning to Today shows it closed
  vm.runInContext("ui.view = 'history'; render(); ui.view = 'today'; render()", context);
  assert.equal(vm.runInContext('ui.attMenu', context), null);
  assert.doesNotMatch(vm.runInContext('viewToday()', context), /class="att-menu"/);
  // a live update that removes the member drops it too
  vm.runInContext("clickActions['att-menu']({ dataset: { id: 'm1', src: 'card' } }); state.members = state.members.filter((m) => m.id !== 'm1'); render()", context);
  assert.equal(vm.runInContext('ui.attMenu', context), null);
});

test('the attendance menu keys: arrows move, a letter picks, Escape closes back to the pill', () => {
  const { context } = appContext();
  todayBoard(context, {});
  const run = (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
  vm.runInContext(`
    var focused = null;
    var items = ['present', 'late', 'leave', 'sick', 'noshow'].map((att) => ({ dataset: { id: 'm1', src: 'card', att }, focus() { focused = this; } }));
    var trigger = { focus() { focused = this; }, setAttribute(k, v) { this[k] = v; } };
    var menuNode = { contains: (el) => items.includes(el), querySelectorAll: () => items, remove() { this.removed = true; } };
    var origQS = document.querySelector, origQSA = document.querySelectorAll;
    document.querySelector = (sel) => sel === '.att-menu' ? (ui.attMenu ? menuNode : null)
      : sel.startsWith('[data-action="att-menu"]') ? trigger : origQS(sel);
    document.querySelectorAll = (sel) => sel === '.att-menu' ? [menuNode] : origQSA(sel);
    Object.defineProperty(document, 'activeElement', { get: () => focused, configurable: true });
    var key = (k, extra) => { const ev = Object.assign({ key: k, prevented: false, preventDefault() { this.prevented = true; } }, extra); return [handleAttMenuKey(ev), ev.prevented]; };
    ui.attMenu = { id: 'm1', src: 'card' }; focused = items[0];
  `, context);
  assert.deepEqual(run("[...key('ArrowUp'), focused.dataset.att]"), [true, true, 'noshow']);
  assert.deepEqual(run("[...key('ArrowDown'), focused.dataset.att]"), [true, true, 'present']);
  assert.deepEqual(run("[...key('End'), focused.dataset.att]"), [true, true, 'noshow']);
  assert.deepEqual(run("key('v', { ctrlKey: true })"), [false, false]);
  assert.deepEqual(run("key('x')"), [false, false]);
  assert.deepEqual(run("key('Escape')"), [true, true]);
  assert.equal(vm.runInContext('ui.attMenu', context), null);
  assert.equal(vm.runInContext('focused === trigger && trigger["aria-expanded"]', context), 'false');
  assert.equal(vm.runInContext('menuNode.removed', context), true);
  vm.runInContext("ui.attMenu = { id: 'm1', src: 'card' }; focused = items[0]", context);
  assert.deepEqual(run("key('V')"), [true, true]);
  assert.equal(vm.runInContext("state.days[ui.date].entries.m1.attendance", context), 'leave');
  assert.equal(vm.runInContext('ui.attMenu', context), null);
  vm.runInContext("ui.attMenu = { id: 'm1', src: 'card' }; focused = null", context);
  assert.deepEqual(run("key('Escape')"), [false, false]);
});

test('away members without notes appear only in the roll call; with notes they keep a card', () => {
  const { context } = appContext();
  todayBoard(context, { m3: { attendance: 'leave' }, m4: { attendance: 'sick', yesterday: 'Fixed login' } });
  const html = vm.runInContext('viewToday()', context);
  const roll = html.slice(html.indexOf('class="roll-call"'), html.indexOf('class="board-tools"'));
  const grid = html.slice(html.indexOf('class="member-grid"'));
  assert.doesNotMatch(grid, /data-member="m3"/);
  assert.match(grid, /data-member="m4"/);
  assert.match(roll, /class="roll-person att-leave"[^>]*data-id="m3"/);
  assert.match(roll, /Citra/);
});

test('the sheet view shows one row per person, away members included, and remembers the choice', () => {
  const { context, storage } = appContext();
  todayBoard(context, { m1: { yesterday: 'Fixed <b>login</b>', blockers: 'API keys' }, m3: { attendance: 'leave' } });
  let html = vm.runInContext('viewToday()', context);
  assert.match(html, /data-action="board-view" data-view="cards" aria-pressed="true"/);
  assert.doesNotMatch(html, /<table class="sheet"/);
  vm.runInContext("clickActions['board-view']({ dataset: { view: 'sheet' } })", context);
  html = vm.runInContext('viewToday()', context);
  assert.match(html, /data-action="board-view" data-view="sheet" aria-pressed="true"/);
  assert.doesNotMatch(html, /class="roll-call"|class="member-grid"|data-action="board-density"/);
  for (const id of ['m1', 'm2', 'm3', 'm4']) assert.match(html, new RegExp(`<tr class="sheet-row[^"]*" data-member="${id}"`));
  assert.match(html, /<tr class="sheet-row att-present has-blocker" data-member="m1"/);
  assert.match(html, /<tr class="sheet-row att-leave is-away" data-member="m3"/);
  assert.match(html, /Fixed &lt;b&gt;login&lt;\/b&gt;/);
  assert.match(html, /<b>3<\/b>\/4 here/);
  assert.match(html, /<button type="button" class="att-trigger" data-action="att-menu" data-id="m3" data-src="sheet"[^>]*><span class="att-pill att-leave">/);
  assert.equal(storage.get('dailyscrum.boardview.v1'), '"sheet"');
});

test('the sheet view keeps filters, edits notes in place and is read-only for viewers', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { blockers: 'API keys' } });
  vm.runInContext("ui.boardView = 'sheet'; clickActions['today-filter']({ dataset: { filter: 'blockers' } })", context);
  let html = vm.runInContext('viewToday()', context);
  assert.match(html, /data-member="m1"/);
  assert.doesNotMatch(html, /data-member="m2"/);
  vm.runInContext("ui.todayFilter = ''", context);
  assert.match(vm.runInContext('viewToday()', context), /data-action="edit-note"[^>]*data-member="m2" data-field="today"/);
  vm.runInContext("ui.editingNote = { date: ui.date, member: 'm2', field: 'today' }", context);
  assert.match(vm.runInContext('viewToday()', context), /<textarea data-entry[^>]*data-member="m2" data-field="today"/);
  vm.runInContext("ui.editingNote = null; auth.role = 'viewer'", context);
  html = vm.runInContext('viewToday()', context);
  assert.doesNotMatch(html, /<textarea|data-action="edit-note"|data-action="att-menu"/);
  assert.match(html, /<span class="att-pick" title="[^"]*"><span class="att-pill att-present">/);
});

test('the blockers filter shows only blocked members and can be cleared', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { blockers: 'API keys' } });
  vm.runInContext("clickActions['today-filter']({ dataset: { filter: 'blockers' } })", context);
  let html = vm.runInContext('viewToday()', context);
  assert.match(html, /data-member="m1"/);
  assert.doesNotMatch(html, /data-member="m2"/);
  assert.match(html, /aria-pressed="true"/);
  vm.runInContext("clickActions['today-filter']({ dataset: { filter: 'blockers' } })", context);
  html = vm.runInContext('viewToday()', context);
  assert.match(html, /data-member="m2"/);
});

function settingsPage(context, role, mode = 'server') {
  vm.runInContext(`
    storageMode = '${mode}';
    auth = { name: 'x', role: '${role}' };
    applyServerData({ state: { members: [{ id: 'm1', name: 'Ana' }] }, version: 1, creds: {} });
    ui.view = 'settings';
  `, context);
  return () => vm.runInContext('viewSettings()', context);
}

const tabIds = (html) => [...html.matchAll(/data-action="settings-tab" data-tab="([\w-]+)"/g)].map((m) => m[1]);

test('settings tabs are grouped under You, Team, and Admin', () => {
  const { context } = appContext();
  const html = settingsPage(context, 'admin')();
  assert.match(html, /role="tablist"/);
  assert.deepEqual(tabIds(html), ['account', 'status-colors', 'team', 'jira', 'kpi', 'reports', 'users', 'data']);
  for (const group of ['You', 'Team', 'Admin']) assert.match(html, new RegExp('class="settings-group"[^>]*>' + group + '<'));
  assert.match(html, /data-tab="team"[^>]*aria-selected="true"/);
  assert.match(html, /<h3>Team members<\/h3>/);
  assert.doesNotMatch(html, /<h3>JIRA Cloud<\/h3>/, 'only the active panel is shown');
});

test('a settings tab click shows that panel; KPI has its own tab', () => {
  const { context } = appContext();
  const view = settingsPage(context, 'admin');
  vm.runInContext("clickActions['settings-tab']({ dataset: { tab: 'kpi' } })", context);
  const html = view();
  assert.match(html, /data-tab="kpi"[^>]*aria-selected="true"/);
  assert.match(html, /id="setKpiField"/);
  assert.match(html, /data-kpi-member="m1"/);
  assert.doesNotMatch(html, /id="setSite"/, 'KPI is no longer inside the JIRA panel');
});

test('viewers only get the tabs they can use, and a hidden tab falls back to the first', () => {
  const { context } = appContext();
  const view = settingsPage(context, 'viewer');
  vm.runInContext("ui.settingsTab = 'users'", context);
  const html = view();
  assert.deepEqual(tabIds(html), ['account', 'status-colors']);
  assert.match(html, /data-tab="account"[^>]*aria-selected="true"/);
  assert.doesNotMatch(html, /<h3>Users<\/h3>/);
});

test('local mode has no KPI or status colour tabs', () => {
  const { context } = appContext();
  const html = settingsPage(context, 'admin', 'local')();
  assert.deepEqual(tabIds(html), ['account', 'team', 'jira', 'users', 'data']);
});

test('a link into settings can open a specific tab', async () => {
  const { context } = appContext();
  settingsPage(context, 'viewer');
  vm.runInContext("ui.view = 'today'", context);
  await vm.runInContext("clickActions['view']({ dataset: { view: 'settings', tab: 'account' } })", context);
  assert.equal(vm.runInContext('ui.settingsTab', context), 'account');
});

test('JIRA Settings keeps edits pending until Save and lets an admin discard them', async () => {
  const { context, storage } = appContext();
  settingsPage(context, 'admin', 'local');
  vm.runInContext("ui.settingsTab = 'jira'; viewSettings()", context);
  const edit = (value) => {
    context.__draftValue = value;
    vm.runInContext("onDocInput({ target: { id: 'setSite', dataset: { jira: 'site' }, value: __draftValue } })", context);
  };
  edit('preview.atlassian.net');
  assert.equal(vm.runInContext('creds.site', context), '', 'typing does not save credentials');
  assert.equal(vm.runInContext('hasUnsavedWork()', context), true, 'leaving the page warns about a draft');
  assert.match(vm.runInContext('viewSettings()', context), /id="jiraSaveBar"[^>]*>[\s\S]*Save changes/);
  vm.runInContext("ui.settingsTab = 'team'; clickActions['jira-discard']()", context);
  assert.equal(vm.runInContext('jiraDraftDirty()', context), false);
  assert.equal(vm.runInContext('creds.site', context), '');

  vm.runInContext("ui.settingsTab = 'jira'; viewSettings()", context);
  edit('saved.atlassian.net');
  await vm.runInContext("clickActions['jira-save']()", context);
  assert.equal(vm.runInContext('creds.site', context), 'saved.atlassian.net');
  assert.equal(vm.runInContext('hasUnsavedWork()', context), false);
  assert.equal(JSON.parse(storage.get('dailyscrum.creds.v1')).site, 'saved.atlassian.net');
});

test('the PI tab is for admins in server mode only', async () => {
  const { context } = appContext();
  settingsPage(context, 'viewer');
  assert.equal(vm.runInContext('isPiAvailable()', context), false);
  await vm.runInContext("clickActions['view']({ dataset: { view: 'pi' } })", context);
  assert.equal(vm.runInContext('ui.view', context), 'settings', 'viewers cannot open PI');
  settingsPage(context, 'admin', 'local');
  assert.equal(vm.runInContext('isPiAvailable()', context), false);
  settingsPage(context, 'admin');
  assert.equal(vm.runInContext('isPiAvailable()', context), true);
});

test('a PI report renders totals, ranked people, failures and the inline ticket list', () => {
  const { context } = appContext();
  settingsPage(context, 'admin');
  vm.runInContext(`
    state.members = [{ id: 'm1', name: 'Taylor Chen', color: '#ff0000' }];
    const row = { key: 'DEMO-1', summary: 'Fix <login>', type: 'Task', status: 'DONE', resolved: '2026-06-02T03:00:00Z', timeSpent: 7200, points: 3 };
    piUi.period = '2026-P2';
    piUi.open = 'm1';
    piUi.reports['2026-P2'] = { label: 'May – Aug 2026', start: '2026-05-01', end: '2026-08-31', pointsField: 'customfield_10032',
      generatedAt: '2026-10-01T00:00:00Z', you: { name: 'Taylor Chen' }, people: [
        { id: 'm1', name: 'Taylor Chen', self: true, rows: [row], totals: { count: 1, hours: 2, points: 3 } },
        { id: 'm2', name: 'Morgan', error: 'JIRA said no', rows: [], totals: { count: 0, hours: 0, points: 0 } }] };`, context);
  const html = vm.runInContext('viewPi()', context);
  assert.match(html, /report-hero/);
  assert.equal((html.match(/<div class="pi-rank-row(?: open| self)*">/g) || []).length, 2);
  assert.match(html, /class="avatar avatar-sm"[^>]*>TC</);
  assert.match(html, /pi-you">you/);
  assert.match(html, /pi-error">[^<]*JIRA said no/);
  assert.match(html, /Fix &lt;login&gt;/, 'summaries are escaped');
  assert.match(html, /pi-ticket-panel pi-inline/);
  assert.match(html, /id="piFind"/, 'the ticket list has a find-by-key box');
});

test('the PI find box keeps only matching keys, by key and not by summary', () => {
  const { context } = appContext();
  settingsPage(context, 'admin');
  vm.runInContext(`
    const r = (key, summary) => ({ key, summary, type: 'Task', status: 'DONE', resolved: null, timeSpent: 0, points: 1 });
    piUi.period = '2026-P2';
    piUi.open = 'm1';
    piUi.find = 'demo-4099, 4087';
    piUi.reports['2026-P2'] = { label: 'May – Aug 2026', start: '2026-05-01', end: '2026-08-31', pointsField: 'f', people: [
      { id: 'm1', name: 'A', rows: [r('DEMO-4099', 'x'), r('DEMO-4087', 'y'), r('DEMO-1', 'DEMO-4099 follow-up')], totals: { count: 3, hours: 0, points: 3 } }] };`, context);
  const html = vm.runInContext('viewPi()', context);
  assert.match(html, /<tr data-key="DEMO-4099">/);
  assert.match(html, /<tr data-key="DEMO-4087">/);
  assert.match(html, /<tr data-key="DEMO-1" hidden>/, 'a summary mention does not count for PI');
  assert.match(html, /2 of 3 tickets/);
  assert.match(html, /value="demo-4099, 4087"/, 'the query survives a re-render');
});

test('the PI ticket list sorts by date or by sprint, ascending', () => {
  const { context } = appContext();
  settingsPage(context, 'admin');
  vm.runInContext(`
    const r = (key, resolved, sprint, sprintStart) => ({ key, summary: key, type: 'Task', status: 'DONE', resolved, created: '2026-05-01T00:00:00Z', sprint, sprintStart, timeSpent: 0, points: 1 });
    piUi.period = '2026-P2';
    piUi.open = 'm1';
    piUi.reports['2026-P2'] = { label: 'May – Aug 2026', start: '2026-05-01', end: '2026-08-31', pointsField: 'f', people: [
      { id: 'm1', name: 'A', totals: { count: 4, hours: 0, points: 4 }, rows: [
        r('DEMO-3', '2026-06-20T00:00:00Z', 'Sprint 10', '2026-06-15T00:00:00Z'),
        r('DEMO-1', '2026-06-01T00:00:00Z', 'Sprint 9', '2026-05-30T00:00:00Z'),
        r('DEMO-4', '2026-05-10T00:00:00Z', '', null),
        r('DEMO-2', '2026-06-05T00:00:00Z', 'Sprint 9', '2026-05-30T00:00:00Z')] }] };`, context);
  const order = () => [...vm.runInContext('viewPi()', context).matchAll(/<tr data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order(), ['DEMO-4', 'DEMO-1', 'DEMO-2', 'DEMO-3'], 'date ascending by default');
  assert.match(vm.runInContext('viewPi()', context), /data-action="pi-sort" data-sort="date" aria-pressed="true"/);
  vm.runInContext("piUi.sort = 'sprint'", context);
  assert.deepEqual(order(), ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4'], 'oldest sprint first, no sprint last');
  assert.match(vm.runInContext('viewPi()', context), /<td class="left muted">Sprint 9<\/td>/);
  const rows = vm.runInContext("piUi.reports['2026-P2'].people[0].rows.map((x) => x.key)", context);
  assert.deepEqual([...rows], ['DEMO-3', 'DEMO-1', 'DEMO-4', 'DEMO-2'], 'the report itself is not reordered');
});

test('PI shows hours from JIRA Time tracking, and a saved finished period offers a refresh', () => {
  const { context } = appContext();
  settingsPage(context, 'admin');
  vm.runInContext(`
    const r = (key, timeSpent) => ({ key, summary: key, type: 'Task', status: 'DONE', resolved: null, sprint: '', timeSpent, points: 1 });
    piUi.period = '2026-P2';
    piUi.open = 'm1';
    piUi.reports['2026-P2'] = { label: 'May – Aug 2026', start: '2026-05-01', end: '2026-08-31', pointsField: 'f',
      generatedAt: '2026-10-02T00:00:00Z', cachedAt: '2026-09-01T00:00:00Z', people: [
      { id: 'm1', name: 'A', totals: { count: 3, hours: 12, points: 3 },
        rows: [r('DEMO-1', 36000), r('DEMO-2', 0), r('DEMO-3', 7200)] }] };`, context);
  const html = vm.runInContext('viewPi()', context);
  assert.match(html, /stat-label">Hours logged<span class="tip".*?<b>12<\/b>/s, 'the hero shows the tickets\' Time Spent');
  assert.match(html, /class="pi-rank-row open"/);
  assert.match(html, /class="num muted">12<\/span>/);
  assert.match(html, /<td>10<\/td>/);
  assert.match(html, /<td>2<\/td>/);
  assert.match(html, /<td><span class="muted">–<\/span><\/td>/, 'no time spent shows a dash');
  assert.match(html, /Saved: /);
  assert.match(html, /Refresh from JIRA/);

  const urls = [];
  context.__urls = urls;
  vm.runInContext(`kpiFetch = async (u, init) => { __urls.push([u, init && init.method]); return piUi.reports['2026-P2']; }`, context);
  vm.runInContext(`clickActions['pi-generate']()`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(urls)), [['/api/pi?period=2026-P2', 'POST']],'a period already shown is read again past the saved copy');
});

test('tooltip marks carry their text escaped, for the bubble and for screen readers', () => {
  const { context } = appContext();
  const html = vm.runInContext(`thTip('SP', 'Points <b> & more')`, context);
  assert.match(html, /<th><span class="th-tip">SP<span class="tip" tabindex="0" data-tip="Points &lt;b&gt; &amp; more">/);
  assert.match(html, /<span class="sr-only">About SP: Points &lt;b&gt; &amp; more<\/span>/);
  assert.match(vm.runInContext(`thTip('X', 't', 'left')`, context), /^<th class="left">/);
});

test('the KPI and PI reports explain every number with a tooltip', () => {
  const { context } = appContext();
  settingsPage(context, 'admin');
  const kpi = vm.runInContext(`kpiStats({ completion: 0.8, done: 8, carryover: 2, open: 1, spDone: 13, spCarryover: 5 })`, context);
  for (const label of ['Completion', 'Delivered', 'Carry-over', 'Open', 'SP delivered']) {
    assert.match(kpi, new RegExp(`<span class="stat-label">${label}<span class="tip"`), label + ' has a tip');
  }
  assert.match(kpi, /Carried-over points are NOT included/, 'SP delivered says it excludes carry-over');
  assert.match(kpi, /Delivered does NOT include carry-over/, 'Delivered tooltip explains carry-over');

  vm.runInContext(`
    piUi.period = '2026-P2';
    piUi.open = 'm1';
    piUi.reports['2026-P2'] = { label: 'May – Aug 2026', start: '2026-05-01', end: '2026-08-31', pointsField: 'f', people: [
      { id: 'm1', name: 'A', totals: { count: 1, hours: 1, points: 2 }, rows: [{ key: 'DEMO-1', summary: 's', type: 'Task', status: 'DONE', resolved: null, sprint: '', timeSpent: 3600, points: 2 }] }] };`, context);
  const pi = vm.runInContext('viewPi()', context);
  for (const label of ['Story points', 'Tickets done', 'Hours logged']) assert.match(pi, new RegExp(`stat-label">${label}<span class="tip"`));
  for (const label of ['Sprint', 'Resolved', 'Hours', 'SP']) assert.match(pi, new RegExp(`th-tip">${label}<span class="tip"`));
  assert.doesNotMatch(pi, /th-tip">Status</);
  assert.match(pi, /no Carry-over or Open here/);
  assert.match(pi, /With the built-in query/, 'describes the default query while none is set');
  vm.runInContext(`state.settings.piJql = 'assignee = {assignee} AND resolved >= {start} AND resolved <= {end}'`, context);
  assert.match(vm.runInContext('viewPi()', context), /uses its own report query/);
});

test('the KPI task list filters by task summary or key', () => {
  const { context } = appContext();
  vm.runInContext(`
    const t = (key, summary) => ({ key, summary, sprintName: 'S1', outcome: 'done', doneAt: null, points: 2, person: { key: 'p', name: 'P' } });
    kpiUi.memberKey = '';
    kpiUi.find = 'login';
    var kpiView = { members: [], tasks: [t('DEMO-1', 'Fix LOGIN page'), t('DEMO-2', 'Add report'), t('LOGIN-7', 'Other')] };`, context);
  const html = vm.runInContext('kpiTasksPanel(kpiView)', context);
  assert.match(html, /id="kpiFind" value="login"/);
  assert.match(html, /<tr data-key="DEMO-1" data-summary="Fix LOGIN page" data-person="p" data-outcome="done">/, 'summary match');
  assert.match(html, /<tr data-key="DEMO-2" data-summary="Add report" data-person="p" data-outcome="done" hidden>/);
  assert.match(html, /<tr data-key="LOGIN-7" data-summary="Other" data-person="p" data-outcome="done">/, 'key match');
  assert.match(html, /2 of 3 tasks/);
  assert.doesNotMatch(html, /id="kpiTaskMember"/, 'no member picker with only one person');
  vm.runInContext("kpiUi.find = 'nothing-here'", context);
  assert.match(vm.runInContext('kpiTasksPanel(kpiView)', context), /kpi-find-none">No task or key matches/);
});

test('the KPI task list filters by member, together with the find box', () => {
  const { context } = appContext();
  vm.runInContext(`
    const t = (key, summary, pk, name) => ({ key, summary, sprintName: 'S1', outcome: 'done', doneAt: null, points: 1, person: { key: pk, name } });
    kpiUi.memberKey = '';
    kpiUi.find = '';
    kpiUi.taskMember = 'b';
    var kpiView = { members: [{ key: 'a', name: 'Ana' }, { key: 'b', name: 'Budi' }],
      tasks: [t('DEMO-1', 'Login', 'b', 'Budi'), t('DEMO-2', 'Report', 'a', 'Ana'), t('DEMO-3', 'Login API', 'a', 'Ana')] };`, context);
  let html = vm.runInContext('kpiTasksPanel(kpiView)', context);
  assert.match(html, /<option value="">All members<\/option>\s*<option value="a">Ana<\/option><option value="b" selected>Budi<\/option>/,
    'people in member order, the picked one selected');
  assert.match(html, /data-key="DEMO-1"[^>]*data-person="b"[^>]*>/);
  assert.match(html, /data-key="DEMO-2"[^>]*data-person="a"[^>]* hidden>/);
  assert.match(html, /1 of 3 tasks/);
  vm.runInContext("kpiUi.taskMember = 'a'; kpiUi.find = 'login'", context);
  html = vm.runInContext('kpiTasksPanel(kpiView)', context);
  assert.match(html, /data-key="DEMO-3"[^>]*data-person="a"[^>]*>/);
  assert.match(html, /1 of 3 tasks/, 'member and find box both apply');
  vm.runInContext("kpiUi.find = ''; kpiUi.taskMember = 'gone'; kpiTasksPanel(kpiView)", context);
  assert.equal(vm.runInContext('kpiUi.taskMember', context), '', 'a member no longer in the list is dropped');
  vm.runInContext("kpiUi.memberKey = 'a'", context);
  assert.doesNotMatch(vm.runInContext('kpiTasksPanel(kpiView)', context), /id="kpiTaskMember"/, 'not on a one-person page');
});

test('picking a member in the KPI task filter does not re-render the page', () => {
  const { context } = appContext();
  vm.runInContext("var renders = 0; render = () => { renders++; }", context);
  vm.runInContext("onDocChange({ target: { id: 'kpiTaskMember', value: 'b', dataset: {} } })", context);
  assert.equal(vm.runInContext('kpiUi.taskMember', context), 'b');
  assert.equal(vm.runInContext('renders', context), 0);
});

test('Settings → Performance report keeps a draft and saves only on explicit save', async () => {
  const { context } = appContext();
  const page = settingsPage(context, 'admin');
  vm.runInContext("ui.settingsTab = 'reports'; var saves = 0; saveState = () => { saves++; }; persistNow = async () => true; toast = () => {};", context);
  const html = page();
  assert.match(html, /statusCategory = Done/, 'default template pre-filled');
  assert.match(html, /TEAM - JIRA - /);

  const change = (setting, value) => vm.runInContext(
    `onDocChange({ target: { id: '${setting === 'piJql' ? 'piJql' : ''}', value: ${JSON.stringify(value)}, dataset: { setting: '${setting}' } } })`, context);
  change('piJql', 'project = X');
  await vm.runInContext('piEditorSave()', context);
  assert.equal(vm.runInContext('saves', context), 0, 'missing placeholders: not saved');
  change('piJql', " assignee = '{assignee}' AND resolved >= '{start}' AND resolved <= '{end}' ");
  assert.equal(vm.runInContext('saves', context), 0, 'typing never saves');
  await vm.runInContext('piEditorSave()', context);
  assert.equal(vm.runInContext('state.settings.piJql', context), "assignee = '{assignee}' AND resolved >= '{start}' AND resolved <= '{end}'");
  change('piJql', vm.runInContext('PI_DEFAULT_TEMPLATE', context));
  await vm.runInContext('piEditorSave()', context);
  assert.equal(vm.runInContext('state.settings.piJql', context), '', 'the default is stored as empty');
  change('piPrefix', ' DEMO ');
  assert.equal(vm.runInContext('state.settings.piPrefix', context), 'DEMO');
  assert.equal(vm.runInContext('saves', context), 3);
});

test('Settings → Performance report sets the period length; the report page then steps through periods of that length', () => {
  const { context } = appContext();
  const page = settingsPage(context, 'admin');
  vm.runInContext("ui.settingsTab = 'reports'; var saves = 0; saveState = () => { saves++; }; persistNow = async () => true; toast = () => {}; render = () => {};", context);
  let html = page();
  assert.match(html, /<h3>Performance report<\/h3>/);
  assert.match(html, /<option value="4" selected>4 months \(Jan – Apr, May – Aug, Sep – Dec\)<\/option>/, 'never set = 4 months');
  assert.equal((html.match(/data-setting="piPeriodMonths"[^]*?<\/select>/)[0].match(/<option/g) || []).length, 6);
  vm.runInContext("piUi.period = '2026-P2'", context);
  vm.runInContext("onDocChange({ target: { id: 'piPeriodMonths', value: '3', dataset: { setting: 'piPeriodMonths' } } })", context);
  assert.equal(vm.runInContext('state.settings.piPeriodMonths', context), 3);
  assert.equal(vm.runInContext('saves', context), 1);
  assert.equal(vm.runInContext('piUi.period', context), '', 'the picked 4-month period is dropped');
  html = page();
  assert.match(html, /<option value="3" selected>/);
  assert.match(html, /JIRA - [A-Z]+ [A-Z]+ \d{4}\.xlsx/, 'download name uses a 3-month period');

  vm.runInContext("piUi.period = '2026-Q3'", context);
  const view = vm.runInContext('viewPi()', context);
  assert.deepEqual([...view.matchAll(/data-action="pi-period" data-period="([^"]+)"/g)].map((m) => m[1]),
    ['2026-Q2', '2026-Q4', '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'], 'previous and next arrows, then the four quarters');
  assert.match(view, /aria-pressed="true">Jul – Sep</);
  assert.match(view, /<h1 class="page-title">Jul – Sep 2026<\/h1>/);
  vm.runInContext("piUi.period = '2026-P2'", context);
  vm.runInContext('viewPi()', context);
  assert.match(vm.runInContext('piUi.period', context), /^\d{4}-Q[1-4]$/, 'a period of another length is replaced by the default');
  vm.runInContext("state.settings.piPeriodMonths = 12; piUi.period = '2026'", context);
  assert.doesNotMatch(vm.runInContext('viewPi()', context), /aria-label="Period of 2026"/, 'a whole-year length shows just the year');
});

test('Account lets a signed-in user pick their team member', () => {
  const { context } = appContext();
  settingsPage(context, 'admin');
  vm.runInContext("auth.memberId = 'm1'; ui.settingsTab = 'account'", context);
  const html = vm.runInContext('viewSettings()', context);
  assert.match(html, /This is me/);
  assert.match(html, /<option value="m1" selected>Ana<\/option>/);
});

function teamBoard(role) {
  const { context } = appContext();
  vm.runInContext(`
    storageMode = 'server';
    auth = { name: 'x', role: '${role}' };
    leads = [{ id: '7', name: 'Tia', role: 'lead' }, { id: '1', name: 'Boss', role: 'admin' }];
    state.members = [
      { id: 'a', name: 'Andi', lead: '7', color: '#3D51E0' },
      { id: 'b', name: 'Budi', lead: '1', color: '#0F8A5F' },
      { id: 'n', name: 'Nora', lead: '', color: '#AA3355' },
      { id: 'g', name: 'Gone', lead: '99', color: '#AA3355' },
    ];
    ui.date = todayISO();
    state.days[ui.date] = { startedAt: 's', roster: state.members.map(memberSnapshot), entries: {}, jira: null };
  `, context);
  return context;
}

test('a Technical Lead edits the board but not the admin settings', () => {
  const context = teamBoard('lead');
  assert.equal(vm.runInContext('canEdit()', context), true);
  assert.equal(vm.runInContext('canAdmin()', context), false);
  assert.deepEqual(vm.runInContext('settingsTabs().map((t) => t.id).join()', context), 'account,status-colors,team');
  assert.equal(vm.runInContext('hasTeamPicker()', context), false, 'a lead only ever has their own team');
  assert.equal(vm.runInContext('isPiAvailable() && isKpiAdmin()', context), true);
});

test('admins see a team picker; "All teams" groups members per lead', () => {
  const context = teamBoard('viewer');
  let html = vm.runInContext('viewToday()', context);
  assert.match(html, /id="teamFilter"/);
  const heads = [...html.matchAll(/team-group-head"><span>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Tia', 'Boss', 'No lead'], 'a lead that no longer exists counts as no lead');

  vm.runInContext(`onDocChange({ target: { id: 'teamFilter', value: '7', dataset: {} } })`, context);
  html = vm.runInContext('viewToday()', context);
  assert.match(html, /Andi/);
  assert.doesNotMatch(html, /Budi|team-group-head/);
  assert.equal(vm.runInContext("membersForDay(ui.date).map((m) => m.id).join()", context), 'a');

  vm.runInContext("ui.team = 'none'", context);
  assert.equal(vm.runInContext("boardMembersFor(ui.date, state.days[ui.date]).map((m) => m.id).join()", context), 'n,g');
});

test('the user list and role picker know the Technical Lead role', () => {
  const context = teamBoard('admin');
  vm.runInContext("usersList = [{ id: 7, username: 'tia', role: 'lead' }]", context);
  const html = vm.runInContext('usersPanel()', context);
  assert.match(html, /Technical Lead — own team only/);
  assert.match(html, /<option value="lead">/);
});

test('an admin or lead without their own JIRA key is stopped before every JIRA action', () => {
  const context = teamBoard('lead');
  vm.runInContext(`myJira = { email: '', hasToken: false, inUse: false, envOverride: false };
    var synced = 0; clickActions.sync = () => { synced++; };`, context);
  const click = (action) => vm.runInContext(`onDocClick({ preventDefault() {},
    target: { closest: () => ({ dataset: { action: '${action}' } }) } })`, context);

  assert.equal(vm.runInContext('needsOwnKey()', context), true);
  click('sync');
  assert.equal(vm.runInContext('synced', context), 0, 'the sync waits for a key');
  assert.equal(vm.runInContext('typeof ownKeyPending', context), 'function');

  vm.runInContext('ownKeyPending(); myJira = { email: \'me@x.com\', hasToken: true, inUse: true, envOverride: false }', context);
  assert.equal(vm.runInContext('synced', context), 1, 'saving the key runs the waiting action');
  click('sync');
  assert.equal(vm.runInContext('synced', context), 2);

  vm.runInContext("myJira = { email: '', hasToken: false, inUse: false, envOverride: true }", context);
  assert.equal(vm.runInContext('needsOwnKey()', context), false, 'server env credentials override personal keys');
});

test('Settings → Account shows the own-key form to admins and leads only', () => {
  const context = teamBoard('lead');
  vm.runInContext("myJira = { email: 'me@x.com', hasToken: true, inUse: true, envOverride: false }", context);
  const html = vm.runInContext('accountPanel()', context);
  assert.match(html, /id="ownKeyForm"/);
  assert.match(html, /your own key/);
  assert.match(html, /saved — leave blank to keep it/);
  vm.runInContext("auth.role = 'viewer'; myJira = null", context);
  assert.doesNotMatch(vm.runInContext('accountPanel()', context), /ownKeyForm/);
});

test('the account menu identifies the user and shows Sign out in server mode only', () => {
  const context = teamBoard('lead');
  vm.runInContext('renderLogoutButton()', context);
  const btn = vm.runInContext("document.querySelector('#logoutBtn')", context);
  assert.equal(btn.hidden, false);
  assert.equal(btn.textContent, 'Sign out');
  assert.equal(vm.runInContext("$('#accountName').textContent", context), 'x');
  vm.runInContext("storageMode = 'local'; renderLogoutButton()", context);
  assert.equal(btn.hidden, true, 'browser-storage mode has no accounts');
});

/* ---------------- dialogs, undo and unsaved work ---------------- */

function twoMembers(context) {
  vm.runInContext(`
    storageMode = 'local';
    state.members = [{ id: 'm1', name: 'Member One', color: '#3D51E0' }, { id: 'm2', name: 'Member Two', color: '#E0513D' }];
    state.mapping = { 'jira-2': 'm2' };
    ui.date = todayISO();
  `, context);
}

test('Undo puts a removed member back in place with their JIRA mapping', () => {
  const { context } = appContext();
  twoMembers(context);
  vm.runInContext("var undoRemove = removeMember('m1')", context);
  assert.equal(vm.runInContext("state.members.map((m) => m.id).join()", context), 'm2');
  vm.runInContext("removeMember('m2').undo()", context);
  assert.equal(vm.runInContext("state.mapping['jira-2']", context), 'm2');
  assert.equal(vm.runInContext('undoRemove.undo()', context), true);
  assert.equal(vm.runInContext("state.members.map((m) => m.id).join()", context), 'm1,m2');
  assert.equal(vm.runInContext('undoRemove.undo()', context), false, 'undo works once');
});

test('Undo brings back a cancelled standup with its notes', () => {
  const { context } = appContext();
  twoMembers(context);
  vm.runInContext(`
    state.days[ui.date] = { startedAt: 's', roster: state.members.map(memberSnapshot),
      entries: { m1: { today: 'note' } }, jira: null };
    var undoCancel = cancelDay();
  `, context);
  assert.equal(vm.runInContext('state.days[ui.date]', context), undefined);
  vm.runInContext('undoCancel.undo()', context);
  assert.equal(vm.runInContext('state.days[ui.date].entries.m1.today', context), 'note');
  assert.equal(vm.runInContext('state.days[ui.date].startedAt', context), 's');
});

test('Undo restores a deleted day unless it has new data meanwhile', () => {
  const { context } = appContext();
  twoMembers(context);
  vm.runInContext(`
    state.days['2026-09-01'] = { startedAt: 's', roster: [], entries: { m1: { today: 'old' } }, jira: null };
    var undoDelete = deleteDay('2026-09-01');
  `, context);
  assert.equal(vm.runInContext("state.days['2026-09-01']", context), undefined);
  vm.runInContext('undoDelete.undo()', context);
  assert.equal(vm.runInContext("state.days['2026-09-01'].entries.m1.today", context), 'old');
  vm.runInContext(`
    undoDelete = deleteDay('2026-09-01');
    state.days['2026-09-01'] = { startedAt: 'new', roster: [], entries: {}, jira: null };
    undoDelete.undo();
  `, context);
  assert.equal(vm.runInContext("state.days['2026-09-01'].startedAt", context), 'new', 'newer data is kept');
});

test('Erase all only runs after the confirm dialog says yes', async () => {
  const { context } = appContext();
  twoMembers(context);
  vm.runInContext('askConfirm = async () => false', context);
  await vm.runInContext('eraseAll()', context);
  assert.equal(vm.runInContext('state.members.length', context), 2);
  vm.runInContext('var lastAsk = null; askConfirm = async (o) => { lastAsk = o; return true; }', context);
  await vm.runInContext('eraseAll()', context);
  assert.equal(vm.runInContext('state.members.length', context), 0);
  assert.equal(vm.runInContext('lastAsk.typeToConfirm', context), 'ERASE');
  assert.equal(vm.runInContext('lastAsk.danger', context), true);
});

test('the confirm dialog asks for the exact word or a long enough value', () => {
  const { context } = appContext();
  assert.match(vm.runInContext("confirmFieldError({ typeToConfirm: 'ERASE' }, 'erase')", context), /ERASE/);
  assert.equal(vm.runInContext("confirmFieldError({ typeToConfirm: 'ERASE' }, ' ERASE ')", context), '');
  assert.match(vm.runInContext("confirmFieldError({ input: { minLength: 6 } }, '12345')", context), /6/);
  assert.equal(vm.runInContext("confirmFieldError({ input: { minLength: 6 } }, '123456')", context), '');
});

function serverAdmin(context, members = []) {
  context.seedMembers = members;
  vm.runInContext(`
    storageMode = 'server';
    auth = { name: 'x', role: 'admin' };
    applyServerData({ state: { members: seedMembers }, version: 1, creds: {} });
  `, context);
}

test('unsaved work is tracked against the last saved board, server mode only', () => {
  const { context } = appContext();
  serverAdmin(context, [{ id: 'm1', name: 'Ana' }]);
  assert.equal(vm.runInContext('hasUnsavedWork()', context), false);
  vm.runInContext("state.members = state.members.concat({ id: 'm2', name: 'Budi' })", context);
  assert.equal(vm.runInContext('hasUnsavedWork()', context), true);
  vm.runInContext("auth.role = 'viewer'", context);
  assert.equal(vm.runInContext('hasUnsavedWork()', context), false, 'viewers cannot have edits');
  vm.runInContext("auth.role = 'admin'; storageMode = 'local'", context);
  assert.equal(vm.runInContext('hasUnsavedWork()', context), false, 'local mode saves at once');
});

test('closing the tab warns only while edits are not saved', () => {
  const { context } = appContext();
  serverAdmin(context);
  const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  context.e1 = ev();
  vm.runInContext('onBeforeUnload(e1)', context);
  assert.equal(context.e1.prevented, false);
  vm.runInContext("state.settings = Object.assign({}, state.settings, { jql: 'project = X' })", context);
  context.e2 = ev();
  vm.runInContext('onBeforeUnload(e2)', context);
  assert.equal(context.e2.prevented, true);
});

/* ---------------- setup checklist ---------------- */

test('the setup checklist follows the README steps and is for admins only', () => {
  const { context } = appContext();
  settingsPage(context, 'admin');
  const done = (id) => vm.runInContext(`setupSteps().find((s) => s.id === '${id}').done`, context);
  assert.deepEqual([...vm.runInContext('setupSteps().map((s) => s.id)', context)],
    ['members', 'emails', 'jira', 'own-key', 'sync', 'pi-query', 'pi-prefix', 'me']);
  assert.equal(done('members'), true);
  assert.equal(done('emails'), false);
  vm.runInContext(`
    state.members = [{ id: 'm1', name: 'Ana', email: 'ana@x.com' }];
    creds = Object.assign({}, creds, { site: 'x.atlassian.net', hasToken: true });
    state.settings = Object.assign({}, state.settings, { piJql: 'assignee = {assignee}', piPrefix: 'TEAM' });
    state.days['2026-09-01'] = { jira: { syncedAt: 's' } };
    auth.memberId = 'm1';
  `, context);
  assert.equal(done('emails'), true);
  assert.equal(done('jira'), true);
  assert.equal(done('sync'), true);
  assert.equal(done('pi-query'), true);
  assert.equal(done('pi-prefix'), false, 'the TEAM prefix still counts as not set');
  assert.equal(done('me'), true);
  assert.match(vm.runInContext('viewToday()', context), /Set up your team/);
  vm.runInContext("auth.role = 'lead'", context);
  assert.doesNotMatch(vm.runInContext('viewToday()', context), /Set up your team/);
});

test('the setup checklist can be hidden in this browser and shown again', () => {
  const { context, storage } = appContext();
  settingsPage(context, 'admin');
  assert.equal(vm.runInContext('showSetupChecklist()', context), true);
  vm.runInContext('hideSetupChecklist(true)', context);
  assert.equal(storage.get('dailyscrum.setup-hidden.v1'), '1');
  assert.equal(vm.runInContext('showSetupChecklist()', context), false);
  assert.match(vm.runInContext('teamPanel()', context), /data-action="setup-show"/);
  vm.runInContext("clickActions['setup-show']()", context);
  assert.equal(vm.runInContext('showSetupChecklist()', context), true);
});

test('local mode leaves out the server-only setup steps', () => {
  const { context } = appContext();
  settingsPage(context, 'admin', 'local');
  assert.deepEqual([...vm.runInContext('setupSteps().map((s) => s.id)', context)],
    ['members', 'emails', 'jira', 'sync', 'me']);
});

test('the PI tab warns admins while the broad default query is in use', () => {
  const { context } = appContext();
  settingsPage(context, 'admin');
  assert.match(vm.runInContext('viewPi()', context), /query across all visible projects/);
  vm.runInContext("state.settings = Object.assign({}, state.settings, { piJql: 'assignee = {assignee}' })", context);
  assert.doesNotMatch(vm.runInContext('viewPi()', context), /query across all visible projects/);
});

/* Compact reading and editing share the same persisted note state. */
test('compact notes escape text and expand into the existing autosaved editor', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { today: '<img src=x onerror=alert(1)> & work' } });
  let card = vm.runInContext('memberCard(state.members[0], state.days[ui.date])', context);
  assert.match(card, /data-action="edit-note"/);
  assert.doesNotMatch(card, /<textarea|<img/);
  assert.match(card, /&lt;img src=x onerror=alert\(1\)&gt; &amp; work/);
  vm.runInContext("ui.editingNote = { date: ui.date, member: 'm1', field: 'today' }", context);
  card = vm.runInContext('memberCard(state.members[0], state.days[ui.date])', context);
  assert.match(card, /<textarea data-entry[^>]*data-member="m1" data-field="today"/);
  vm.runInContext(`onDocInput({ target: { matches: () => true, closest: () => null, dataset: {
    date: ui.date, member: 'm1', field: 'today' }, value: 'Updated plan' } }); ui.editingNote = null;`, context);
  assert.match(vm.runInContext('memberCard(state.members[0], state.days[ui.date])', context), /Updated plan/);
});

test('viewers read plain notes in both density modes and cannot open editors', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { today: 'Ship the fix' } });
  vm.runInContext("auth.role = 'viewer'", context);
  for (const compact of [true, false]) {
    vm.runInContext(`ui.compact = ${compact}`, context);
    const card = vm.runInContext('memberCard(state.members[0], state.days[ui.date])', context);
    assert.match(card, /note-text[^>]*>Ship the fix/);
    assert.doesNotMatch(card, /<textarea|data-action="edit-note"/);
  }
});

test('quiet local settings saves give persistent success feedback', () => {
  const { context } = appContext();
  vm.runInContext("storageMode = 'local'; saveStatus('Unsaved changes'); state.settings.jql = 'project = TEST'; saveState({ quiet: true }); ui.view = 'settings'; render()", context);
  assert.equal(vm.runInContext("$('#saveHint').textContent", context), 'Saved in this browser');
  vm.runInContext("storageMode = 'server'; saveStatus('Not saved'); render()", context);
  assert.equal(vm.runInContext("$('#saveHint').textContent", context), 'Not saved');
});


test('ticket summaries and filters use JIRA categories, preserving member notes and expansion', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { today: 'Keep this plan' } });
  vm.runInContext(`
    state.days[ui.date].jira = { issues: ['new', 'indeterminate', 'done'].map((statusCategory, i) => ({
      key: 'TEST-' + i, summary: 'Ticket ' + i, status: statusCategory, statusCategory,
      assignee: { name: state.members[0].name }
    })) };
    ui.ticketExpansion.set(JSON.stringify([ui.date, 'm1']), true);
  `, context);
  const card = () => vm.runInContext('memberCard(state.members[0], state.days[ui.date])', context);
  assert.match(card(), /class="ticket-bar" title="1 done · 1 in progress · 1 to do"/);
  assert.match(card(), /1 done<span class="sr-only">, 1 in progress, 1 to do<\/span>/);
  for (const [filter, expected] of [['active', ['TEST-0', 'TEST-1']], ['done', ['TEST-2']], ['all', ['TEST-0', 'TEST-1', 'TEST-2']]]) {
    vm.runInContext(`clickActions['ticket-filter']({ dataset: { key: JSON.stringify([ui.date, 'm1']), filter: '${filter}' } })`, context);
    const html = card();
    assert.match(html, /data-initial-open="true" open/);
    assert.match(html, /Keep this plan/);
    for (let i = 0; i < 3; i++) assert.equal(html.includes('TEST-' + i), expected.includes('TEST-' + i));
  }
  vm.runInContext("state.days[ui.date].jira.issues = []; ui.ticketFilters.set(JSON.stringify([ui.date, 'm1']), 'done')", context);
  assert.match(card(), /No sprint tickets matched/);
});

test('Today sprint tickets show To Do, Untested, other active statuses, then Done', () => {
  const { context } = appContext();
  todayBoard(context, {});
  const ticket = (key, status, statusCategory) => ({ key, summary: key, status, statusCategory });
  context.todayTickets = [
    ticket('T-DONE', 'Done', 'done'),
    ticket('T-TESTING', 'Testing', 'indeterminate'),
    ticket('T-UNTESTED', 'Untested', 'indeterminate'),
    ticket('T-TODO', 'To Do', 'new'),
    ticket('T-PROGRESS', 'In Progress', 'indeterminate'),
  ];
  const list = () => vm.runInContext("memberTicketsHtml(state.members[0], todayTickets, 'today-order')", context);
  const keys = (html) => [...html.matchAll(/class="key"[^>]*>(T-[A-Z]+)\s*</g)].map((match) => match[1]);
  assert.deepEqual(keys(list()), ['T-TODO', 'T-UNTESTED', 'T-TESTING', 'T-PROGRESS', 'T-DONE']);
  assert.deepEqual(context.todayTickets.map((item) => item.key), ['T-DONE', 'T-TESTING', 'T-UNTESTED', 'T-TODO', 'T-PROGRESS']);
  vm.runInContext("ui.ticketFilters.set('today-order', 'active')", context);
  assert.deepEqual(keys(list()), ['T-TODO', 'T-UNTESTED', 'T-TESTING', 'T-PROGRESS']);
  vm.runInContext("ui.ticketFilters.set('today-order', 'done')", context);
  assert.deepEqual(keys(list()), ['T-DONE']);
});

test('sprint tickets start collapsed in compact view and expanded otherwise', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { today: 'Plan' } });
  vm.runInContext(`state.days[ui.date].jira = { issues: [{ key: 'TEST-1', summary: 'Ticket', status: 'new',
    statusCategory: 'new', assignee: { name: state.members[0].name } }] }`, context);
  const card = () => vm.runInContext('memberCard(state.members[0], state.days[ui.date])', context);
  vm.runInContext('ui.compact = true', context);
  assert.match(card(), /data-initial-open="false">/);
  vm.runInContext('ui.compact = false', context);
  assert.match(card(), /data-initial-open="true" open/);
  vm.runInContext(`const orig = document.querySelector;
    document.querySelector = (s) => (s === '[data-action="board-density"]' ? { focus() {} } : orig(s));
    ui.ticketExpansion.set(JSON.stringify([ui.date, 'm1']), false); clickActions['board-density']();
    document.querySelector = orig;`, context);
  assert.equal(vm.runInContext('ui.ticketExpansion.size', context), 0);
  assert.match(card(), /data-initial-open="false">/);
});

test('sprint view members are collapsible sections that start expanded', () => {
  const { context } = appContext();
  todayBoard(context, {});
  const section = () => vm.runInContext(`sprintMemberSection(state.members[0], [{ key: 'TEST-1', summary: 'Ticket',
    status: 'new', statusCategory: 'new' }])`, context);
  assert.match(section(), /<details class="panel sprint-member" data-sprint-member="m1" open>\s*<summary class="sprint-member-head">/);
  vm.runInContext("ui.sprintCollapsed.add('m1')", context);
  assert.match(section(), /data-sprint-member="m1">/);
  assert.match(section(), /TEST-1/);
});

test('Sprint board expands done tickets and remembers the List layout', () => {
  const { context, storage } = appContext();
  todayBoard(context, {});
  vm.runInContext("ui.view = 'sprint'; state.days[ui.date].jira = { syncedAt: '2026-10-07T08:00:00Z', sprint: { name: 'Sprint 14' }, issues: [{ key: 'S-1', summary: 'Finished work', status: 'Done', statusCategory: 'done', assignee: { name: 'Ana' }, url: 'https://jira.example/S-1' }] }", context);
  const board = () => vm.runInContext('viewSprint()', context);
  assert.match(board(), /class="panel sprint-board"/);
  assert.match(board(), /data-action="sprint-done" data-id="m1" aria-expanded="false"/);
  vm.runInContext("clickActions['sprint-done']({ dataset: { id: 'm1' } })", context);
  assert.match(board(), /class="sb-done"/);
  vm.runInContext("clickActions['sprint-mode']({ dataset: { mode: 'list' } })", context);
  assert.equal(vm.runInContext('ui.sprintMode', context), 'list');
  assert.equal(storage.get('dailyscrum.sprintMode.v1'), '"list"');
  assert.match(board(), /class="panel sprint-member"/);
});

test('Sprint shows member tickets only, with To do before In progress and Done', () => {
  const { context } = appContext();
  todayBoard(context, {});
  context.sprintIssues = [
    { key: 'S-TODO', summary: 'Plan', status: 'To Do', statusCategory: 'new', assignee: { name: 'Ana' } },
    { key: 'S-PROG', summary: 'Build', status: 'In Progress', statusCategory: 'indeterminate', assignee: { name: 'Ana' } },
    { key: 'S-DONE', summary: 'Ship', status: 'Done', statusCategory: 'done', assignee: { name: 'Ana' } },
    { key: 'S-UNASSIGNED', summary: 'No owner', statusCategory: 'new', assignee: null },
    { key: 'S-OTHER', summary: 'Outside team', statusCategory: 'new', assignee: { name: 'Outsider' } },
  ];
  vm.runInContext(`ui.view = 'sprint'; state.days[ui.date].jira = {
    syncedAt: '2026-10-07T08:00:00Z', sprint: { name: 'Sprint 14' }, issues: sprintIssues
  }`, context);
  const board = vm.runInContext('viewSprint()', context);
  assert.match(board, /<span>Member<\/span><span>To do<\/span><span class="sb-h-prog">In progress<\/span><span class="sb-h-done">Done<\/span>/);
  assert.match(board, /S-TODO/);
  assert.match(board, /S-PROG/);
  assert.ok(board.indexOf('S-TODO') < board.indexOf('S-PROG'));
  assert.match(board, /<b>3<\/b> tickets/);
  assert.doesNotMatch(board, /S-UNASSIGNED|S-OTHER|class="sb-none"/);
  const list = vm.runInContext("ui.sprintMode = 'list'; viewSprint()", context);
  assert.ok(list.indexOf('To do · 1') < list.indexOf('In progress · 1'));
  assert.doesNotMatch(list, /S-UNASSIGNED|S-OTHER/);
});

test('History calendar opens a selected day with its attendance and blocker detail', () => {
  const { context } = appContext();
  todayBoard(context, {});
  vm.runInContext("state.days['2026-10-07'] = { startedAt: 's', roster: state.members.map(memberSnapshot), entries: { m1: { blockers: 'API blocked' }, m2: { attendance: 'leave' } }, jira: null }; ui.histMonth = '2026-10'; ui.histSel = '2026-10-07'", context);
  const html = vm.runInContext('viewHistory()', context);
  assert.match(html, /data-action="hist-select" data-date="2026-10-07"/);
  assert.match(html, /1 blocker/);
  assert.match(html, /API blocked/);
  assert.match(html, /data-action="open-day" data-date="2026-10-07"/);
  assert.match(html, /data-action="copy-day" data-date="2026-10-07"/);
});

test('sprint collapse-all toggles every listed member and relabels itself', () => {
  const { context } = appContext();
  todayBoard(context, {});
  vm.runInContext(`ui.view = 'sprint'; ui.sprintMode = 'list'; state.days[ui.date].jira = { syncedAt: new Date().toISOString(),
    issues: state.members.slice(0, 2).map((m, i) => ({ key: 'TEST-' + i, summary: 'T', status: 'new',
      statusCategory: 'new', assignee: { name: m.name } })) }`, context);
  const button = () => vm.runInContext('viewSprint()', context).match(/<button[^>]*data-action="sprint-collapse-all"[^>]*>[^<]*/)[0];
  assert.match(button(), /data-mode="collapse"[^>]*>Collapse all/);
  vm.runInContext(`clickActions['sprint-collapse-all']({ dataset: { mode: 'collapse', members: 'm1,m2' } })`, context);
  assert.equal(vm.runInContext('[...ui.sprintCollapsed].sort().join()', context), 'm1,m2');
  assert.match(button(), /data-mode="expand"[^>]*>Expand all/);
  vm.runInContext(`clickActions['sprint-collapse-all']({ dataset: { mode: 'expand', members: 'm1,m2' } })`, context);
  assert.equal(vm.runInContext('ui.sprintCollapsed.size', context), 0);
});

test('member removal is explicit in Team settings and absent from Today', () => {
  const { context } = appContext();
  todayBoard(context, { m1: { today: 'Plan' } });
  assert.doesNotMatch(vm.runInContext('viewToday()', context), /data-action="remove-member"/);
  assert.match(vm.runInContext('teamPanel()', context), /data-action="remove-member"[^>]*aria-label="Remove Ana from team"/);
});

test('navigation links validate dates and constrain destinations to the signed-in role', () => {
  const { context } = appContext();
  const route = (query) => JSON.parse(vm.runInContext(`JSON.stringify(navigationFromUrl(${JSON.stringify('http://scrum.test/?' + query)}))`, context));
  vm.runInContext("leads = [{id:'lead1'}]", context);
  assert.deepEqual(route('view=pi&date=2024-02-29&month=2026-08&team=lead1&period=2026-P2&tab=users'), {
    view: 'pi', date: '2024-02-29', month: '2026-08', team: 'lead1', period: '2026-P2', settingsTab: 'users'
  });
  const invalid = route('view=unknown&date=2026-02-30&month=2026-13&team=missing&period=2026-P4&tab=missing');
  assert.equal(invalid.view, 'today');
  assert.equal(invalid.date, vm.runInContext('todayISO()', context));
  assert.equal(invalid.month, vm.runInContext('todayISO().slice(0, 7)', context));
  assert.equal(invalid.team, '');
  assert.equal(invalid.period, '');
  vm.runInContext("auth.role = 'viewer'", context);
  assert.equal(route('view=pi').view, 'today');
  assert.equal(route('view=settings&tab=users').settingsTab, 'account');
  vm.runInContext("auth.role = 'lead'", context);
  assert.equal(route('team=lead1').team, '');
  vm.runInContext("storageMode = 'local'; auth.role = 'admin'", context);
  assert.equal(route('view=pi').view, 'today');
});

test('navigation canonicalizes on boot and Back without growing history on ordinary renders', async () => {
  const { context } = appContext();
  const calls = [];
  context.window.location = { href: 'http://scrum.test/?view=history&date=2026-09-28&extra=keep#anchor' };
  context.window.history = Object.fromEntries(['replaceState', 'pushState'].map((method) => [method, (_state, _title, url) => {
    calls.push(method); context.window.location.href = url;
  }]));
  vm.runInContext('restoreNavigationUrl(); render(); render()', context);
  assert.deepEqual(calls, ['replaceState']);
  assert.match(context.window.location.href, /extra=keep/);
  assert.match(context.window.location.href, /#anchor$/);
  vm.runInContext("ui.view = 'today'; render(); render()", context);
  assert.deepEqual(calls, ['replaceState', 'pushState']);
  context.window.location.href = 'http://scrum.test/?view=report&date=2026-09-28&month=2026-08';
  await vm.runInContext('onNavigationPop()', context);
  assert.equal(vm.runInContext('ui.view', context), 'report');
  assert.equal(vm.runInContext('ui.month', context), '2026-08');
  assert.deepEqual(calls, ['replaceState', 'pushState']);
});

test('Performance draft test ignores a response for a draft edited while JIRA was running', async () => {
  const { context } = appContext();
  todayBoard(context, {});
  vm.runInContext(`render = () => {}; piEditorUi.draft = PI_DEFAULT_TEMPLATE; piEditorUi.base = PI_DEFAULT_TEMPLATE;
    piEditorUi.member = 'm1'; piEditorUi.period = '2026-P2';
    var resolvePiTest; kpiFetch = () => new Promise(resolve => { resolvePiTest = resolve; });`, context);
  const pending = vm.runInContext('piEditorTest()', context);
  vm.runInContext(`piEditorSet(PI_DEFAULT_TEMPLATE + ' '); resolvePiTest({count:70,person:'Ana',period:'2026-P2'});`, context);
  await pending;
  assert.equal(vm.runInContext('piEditorUi.result', context), null);
  assert.equal(vm.runInContext('piEditorUi.testing', context), false);
});
test('Performance membership includes selected KPI people plus the linked member', () => {
  const { context } = appContext(); todayBoard(context, {});
  vm.runInContext("state.settings.kpiMembers = ['m1']; auth.memberId = 'm2'",context);
  assert.equal(vm.runInContext("piMemberList().map(m=>m.id).join(',')",context),'m1,m2');
});
