/*
 * Integration tests: start the real server against a temporary database
 * and exercise the HTTP API. Run: npm test
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const SETUP_CODE = 'test-setup-code';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-scrum-test-'));
let proc;

async function api(method, pathname, { body, cookie, raw, headers } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}, headers),
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/auth/status'); return; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // blank JIRA_* so a developer's real JIRA credentials are never used by the test server
    // TRUST_PROXY lets a test pick its client address through X-Forwarded-For
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, SETUP_CODE, TRUST_PROXY: '1',
      JIRA_SITE: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' }),
    stdio: 'ignore',
  });
  await waitForServer();
});

after(async () => {
  // wait for the server to exit so Windows releases the database file
  await new Promise((resolve) => { proc.once('exit', resolve); proc.kill(); });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let adminCookie;
let viewerCookie;

test('setup requires the setup code', async () => {
  const wrong = await api('POST', '/api/auth/setup', { body: { username: 'lead', password: 'Test-password-1', setupCode: 'nope' } });
  assert.equal(wrong.status, 403);

  const ok = await api('POST', '/api/auth/setup', { body: { username: 'lead', password: 'Test-password-1', setupCode: SETUP_CODE } });
  assert.equal(ok.status, 200);
  adminCookie = ok.cookie;

  const weak = await api('POST', '/api/auth/users', { cookie: adminCookie,
    body: { username: 'weakuser', password: 'short12', role: 'viewer' } });
  assert.equal(weak.status, 400);

  const again = await api('POST', '/api/auth/setup', { body: { username: 'x2x', password: 'Test-password-1', setupCode: SETUP_CODE } });
  assert.equal(again.status, 403);
});

test('browser writes from another origin are refused while same-origin writes work', async () => {
  const bad = await api('POST', '/api/auth/logout', { cookie: adminCookie,
    headers: { Origin: 'https://other.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(bad.status, 403);
  const sibling = await api('POST', '/api/auth/logout', { cookie: adminCookie,
    headers: { Origin: 'http://127.0.0.1:3999', 'Sec-Fetch-Site': 'same-site' } });
  assert.equal(sibling.status, 403);
  const stillSignedIn = await api('GET', '/api/auth/status', { cookie: adminCookie });
  assert.equal(stillSignedIn.data.authenticated, true);
  const same = await api('PUT', '/api/auth/jira', { cookie: adminCookie,
    headers: { Origin: BASE, 'Sec-Fetch-Site': 'same-origin' }, body: { email: '' } });
  assert.equal(same.status, 200);
});

test('admin sees credential flags but never the API token', async () => {
  const s0 = await api('GET', '/api/state', { cookie: adminCookie });
  const put = await api('PUT', '/api/state', {
    cookie: adminCookie,
    body: { state: s0.data.state, baseVersion: s0.data.version, loadedAt: s0.data.loadedAt,
      creds: { site: 'team', email: 'a@b.c', token: 'SECRET-TOKEN' } },
  });
  assert.equal(put.status, 200);

  const s1 = await api('GET', '/api/state', { cookie: adminCookie });
  assert.equal(s1.data.creds.hasToken, true);
  assert.equal(s1.data.creds.token, undefined);
  assert.ok(!JSON.stringify(s1.data).includes('SECRET-TOKEN'));
});

test('viewers get no credentials and cannot save', async () => {
  const created = await api('POST', '/api/auth/users', { cookie: adminCookie, body: { username: 'viewer', password: 'Test-password-2', role: 'viewer' } });
  assert.equal(created.status, 200);
  const login = await api('POST', '/api/auth/login', { body: { username: 'viewer', password: 'Test-password-2' } });
  viewerCookie = login.cookie;

  const s = await api('GET', '/api/state', { cookie: viewerCookie });
  assert.equal(s.status, 200);
  assert.equal(s.data.creds, null);

  const put = await api('PUT', '/api/state', { cookie: viewerCookie, body: { state: s.data.state, baseVersion: s.data.version } });
  assert.equal(put.status, 403);
});

test('KPI routes: signed-in users read, only admins refresh, months are validated', async () => {
  assert.equal((await api('GET', '/api/kpi')).status, 401);
  const read = await api('GET', '/api/kpi', { cookie: viewerCookie });
  assert.equal(read.status, 200);
  assert.match(read.data.month, /^\d{4}-\d{2}$/);
  assert.ok(Array.isArray(read.data.sprints) && Array.isArray(read.data.tasks));
  assert.equal((await api('GET', '/api/kpi?month=2026-13', { cookie: viewerCookie })).status, 400);
  assert.equal((await api('GET', '/api/kpi?month=', { cookie: viewerCookie })).status, 400);
  assert.equal((await api('POST', '/api/kpi/refresh', { cookie: viewerCookie, body: { month: '2026-09' } })).status, 403);
  assert.equal((await api('POST', '/api/kpi/refresh', { cookie: adminCookie, body: { month: 'nope' } })).status, 400);
  assert.equal((await api('GET', '/api/kpi/fields')).status, 401);
  assert.equal((await api('GET', '/api/kpi/fields', { cookie: viewerCookie })).status, 403);
});

test('status colours: everyone reads them with the state, only admins change them', async () => {
  const s = await api('GET', '/api/state', { cookie: viewerCookie });
  assert.deepEqual(s.data.statusColors, {});
  assert.equal((await api('PUT', '/api/status-colors', { body: { colors: {} } })).status, 401);
  assert.equal((await api('PUT', '/api/status-colors', { cookie: viewerCookie, body: { colors: { done: 1 } } })).status, 403);
  assert.equal((await api('PUT', '/api/status-colors', { cookie: adminCookie, body: { colors: { done: 99 } } })).status, 400);
  const ok = await api('PUT', '/api/status-colors', { cookie: adminCookie, body: { colors: { Done: 20 } } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await api('GET', '/api/state', { cookie: viewerCookie })).data.statusColors, { done: 20 });
});

test('a save based on a stale version is rejected with 409', async () => {
  const s = await api('GET', '/api/state', { cookie: adminCookie });
  const body = { state: s.data.state, baseVersion: s.data.version, loadedAt: s.data.loadedAt };
  assert.equal((await api('PUT', '/api/state', { cookie: adminCookie, body })).status, 200);
  assert.equal((await api('PUT', '/api/state', { cookie: adminCookie, body })).status, 409);
});

test('a changed-day patch retains untouched history', async () => {
  const before = await api('GET', '/api/state', { cookie: adminCookie });
  const first = await api('PUT', '/api/state', { cookie: adminCookie, body: {
    baseVersion: before.data.version, patch: { days: { upsert: {
      '2026-09-01': { startedAt: 's', roster: [], entries: {}, jira: null },
    }, delete: [] } },
  } });
  assert.equal(first.status, 200);
  const second = await api('PUT', '/api/state', { cookie: adminCookie, body: {
    baseVersion: first.data.version, patch: { days: { upsert: {
      '2026-09-02': { startedAt: 's', roster: [], entries: {}, jira: null },
    }, delete: [] } },
  } });
  assert.equal(second.status, 200);
  const after = await api('GET', '/api/state', { cookie: adminCookie });
  assert.ok(after.data.state.days['2026-09-01']);
  assert.ok(after.data.state.days['2026-09-02']);
});

test('a save response carries the new version but no loadedAt', async () => {
  const s = await api('GET', '/api/state', { cookie: adminCookie });
  const put = await api('PUT', '/api/state', { cookie: adminCookie, body: {
    baseVersion: s.data.version, loadedAt: s.data.loadedAt, patch: { settings: { jql: 'project = X' } } } });
  assert.equal(put.status, 200);
  assert.equal(put.data.version, s.data.version + 1);
  assert.equal(put.data.loadedAt, undefined);
});

test('the live event stream needs a session', async () => {
  assert.equal((await api('GET', '/api/events')).status, 401);
});

test("the live event stream announces another person's save", async () => {
  const s = await api('GET', '/api/state', { cookie: adminCookie });
  const controller = new AbortController();
  const res = await fetch(BASE + '/api/events', { headers: { Cookie: adminCookie }, signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const readUntil = async (pattern) => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  };
  await readUntil(/"reason":"hello"/);
  const put = await api('PUT', '/api/state', { cookie: adminCookie, body: {
    baseVersion: s.data.version, loadedAt: s.data.loadedAt, patch: { settings: { jql: 'project = LIVE' } } } });
  await readUntil(/"reason":"save"/);
  controller.abort();
  assert.ok(text.includes(JSON.stringify({ version: put.data.version, reason: 'save' })));
  assert.ok(!text.includes('project = LIVE'), 'events never carry board data');
});

test('responses carry security headers', async () => {
  const res = await fetch(BASE + '/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('invalid member ids are rejected', async () => {
  const s = await api('GET', '/api/state', { cookie: adminCookie });
  const state = Object.assign({}, s.data.state, { members: [{ id: '"><img src=x onerror=alert(1)>', name: 'x' }] });
  const put = await api('PUT', '/api/state', { cookie: adminCookie, body: { state, baseVersion: s.data.version } });
  assert.equal(put.status, 400);
});

test('oversized bodies are rejected with 413', async () => {
  const res = await api('PUT', '/api/state', { cookie: adminCookie, raw: 'x'.repeat(8 * 1024 * 1024 + 10) });
  assert.equal(res.status, 413);
});

test('a new password needs 10+ characters with lower, upper, a number and a symbol', async () => {
  const create = (password) => api('POST', '/api/auth/users', { cookie: adminCookie, body: { username: 'policy', password, role: 'viewer' } });
  for (const weak of ['Short-1', 'all-lower-pass-1', 'ALL-UPPER-PASS-1', 'No-Number-Pass', 'NoSymbolPass1']) {
    const res = await create(weak);
    assert.equal(res.status, 400, weak);
  }
  const res = await create('no-upper-pass-1');
  assert.match(res.data.error, /uppercase/);

  const users = await api('GET', '/api/auth/users', { cookie: adminCookie });
  const viewer = users.data.users.find((u) => u.username === 'viewer');
  assert.equal((await api('POST', '/api/auth/users/reset', { cookie: adminCookie, body: { id: viewer.id, newPassword: 'test-password-3' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/password', { cookie: adminCookie, body: { current: 'Test-password-1', next: 'Test-password' } })).status, 400);
});

test('changing the password signs out other sessions', async () => {
  const second = await api('POST', '/api/auth/login', { body: { username: 'lead', password: 'Test-password-1' } });
  const changed = await api('POST', '/api/auth/password', { cookie: adminCookie, body: { current: 'Test-password-1', next: 'Test-password-9' } });
  assert.equal(changed.status, 200);
  assert.equal((await api('GET', '/api/state', { cookie: second.cookie })).status, 401);
  assert.equal((await api('GET', '/api/state', { cookie: adminCookie })).status, 200);
});

test('an admin password reset signs that user out', async () => {
  const users = await api('GET', '/api/auth/users', { cookie: adminCookie });
  const viewer = users.data.users.find((u) => u.username === 'viewer');
  const reset = await api('POST', '/api/auth/users/reset', { cookie: adminCookie, body: { id: viewer.id, newPassword: 'Test-password-3' } });
  assert.equal(reset.status, 200);
  assert.equal((await api('GET', '/api/state', { cookie: viewerCookie })).status, 401);
});

test('JIRA proxy refuses non-Atlassian sites', async () => {
  const res = await api('POST', '/api/jira', {
    cookie: adminCookie,
    body: { action: 'test', site: 'http://169.254.169.254', email: 'a@b.c', token: 't' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /atlassian\.net/);
});

test('login is rate limited per username', async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await api('POST', '/api/auth/login', { body: { username: 'ghost', password: 'wrong00' } });
  assert.equal(last.status, 429);
});

test("someone else's failed sign-ins do not lock a user out", async () => {
  const from = (ip, password) => api('POST', '/api/auth/login', {
    headers: { 'X-Forwarded-For': ip }, body: { username: 'lead', password } });
  let last;
  for (let i = 0; i < 9; i++) last = await from('10.0.0.66', 'wrong-guess');
  assert.equal(last.status, 429, 'the guessing address is slowed down');
  assert.equal((await from('10.0.0.66', 'Test-password-9')).status, 429);
  assert.equal((await from('10.0.0.7', 'Test-password-9')).status, 200, 'the real user can still sign in from elsewhere');
});
