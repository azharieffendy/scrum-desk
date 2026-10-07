/*
 * Technical Lead role over HTTP: start the real server against a temporary
 * database and check that a lead sees and changes only their own team.
 * Run: npm test
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4000 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const SETUP_CODE = 'test-setup-code';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-scrum-lead-'));
let proc;

async function api(method, pathname, { body, cookie } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, SETUP_CODE,
      JIRA_SITE: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' }),
    stdio: 'ignore',
  });
  await waitForServer();
});

after(async () => {
  await new Promise((resolve) => { proc.once('exit', resolve); proc.kill(); });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let adminCookie;
let leadCookie;
let leadId;
let adminId;

async function adminPatch(patch) {
  const s = await api('GET', '/api/state', { cookie: adminCookie });
  return api('PUT', '/api/state', { cookie: adminCookie, body: { baseVersion: s.data.version, loadedAt: s.data.loadedAt, patch } });
}

test('admins and leads are offered as Technical Leads', async () => {
  adminCookie = (await api('POST', '/api/auth/setup', { body: { username: 'boss', password: 'Test-password-1', setupCode: SETUP_CODE } })).cookie;
  const created = await api('POST', '/api/auth/users', { cookie: adminCookie, body: { username: 'techlead', password: 'Test-password-2', role: 'lead' } });
  assert.equal(created.status, 200);

  const s = await api('GET', '/api/state', { cookie: adminCookie });
  const byName = Object.fromEntries(s.data.leads.map((l) => [l.name, l]));
  assert.deepEqual(Object.keys(byName).sort(), ['boss', 'techlead']);
  assert.equal(s.data.leads[0].name, 'techlead', 'leads are listed before admins');
  leadId = byName.techlead.id;
  adminId = byName.boss.id;
  leadCookie = (await api('POST', '/api/auth/login', { body: { username: 'techlead', password: 'Test-password-2' } })).cookie;
  assert.ok(leadCookie);
});

test('a member lead must be a user id', async () => {
  const bad = await adminPatch({ members: [{ id: 'm1', name: 'Andi', lead: 'abc' }] });
  assert.equal(bad.status, 400);
});

test('a lead only sees their own team and no JIRA settings', async () => {
  const ok = await adminPatch({
    members: [
      { id: 'm1', name: 'Andi', lead: leadId, color: '#111' },
      { id: 'm2', name: 'Budi', lead: adminId, color: '#222' },
      { id: 'm3', name: 'Nora', lead: '', color: '#333' },
    ],
    settings: { jql: 'project = SECRET' },
    days: { upsert: { '2026-09-30': { startedAt: '2026-09-30T02:00:00Z', roster: null, jira: null,
      entries: { m1: { today: 'andi' }, m2: { today: 'budi' } } } }, delete: [] },
  });
  assert.equal(ok.status, 200);

  const s = await api('GET', '/api/state', { cookie: leadCookie });
  assert.equal(s.status, 200);
  assert.deepEqual(s.data.state.members.map((m) => m.id), ['m1']);
  assert.deepEqual(Object.keys(s.data.state.days['2026-09-30'].entries), ['m1']);
  assert.equal(s.data.state.settings.jql, '');
  assert.equal(s.data.creds, null);
  assert.deepEqual(s.data.leads, []);
});

test("a lead's save adds to their team without touching other teams", async () => {
  const s = await api('GET', '/api/state', { cookie: leadCookie });
  const put = await api('PUT', '/api/state', { cookie: leadCookie, body: {
    baseVersion: s.data.version, loadedAt: s.data.loadedAt,
    patch: {
      members: [{ id: 'm1', name: 'Andi', color: '#111' }, { id: 'm4', name: 'Citra', color: '#444' }],
      settings: { jql: 'hijack' },
      days: { upsert: { '2026-09-30': { startedAt: '2026-09-30T02:00:00Z', roster: null, jira: null,
        entries: { m1: { today: 'andi edited' }, m2: { today: 'hijack' } } } }, delete: [] },
    },
  } });
  assert.equal(put.status, 200);

  const full = (await api('GET', '/api/state', { cookie: adminCookie })).data.state;
  const byId = Object.fromEntries(full.members.map((m) => [m.id, m]));
  assert.deepEqual(full.members.map((m) => m.id), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(byId.m4.lead, leadId);
  assert.equal(byId.m2.lead, adminId);
  assert.equal(full.settings.jql, 'project = SECRET');
  assert.equal(full.days['2026-09-30'].entries.m1.today, 'andi edited');
  assert.equal(full.days['2026-09-30'].entries.m2.today, 'budi');
});

test("a lead cannot claim another team's member by name or email", async () => {
  await adminPatch({ members: [
    { id: 'm1', name: 'Andi', lead: leadId, color: '#111' },
    { id: 'm2', name: 'Budi', lead: adminId, email: 'budi@corp.com', color: '#222' },
    { id: 'm3', name: 'Nora', lead: '', color: '#333' },
    { id: 'm4', name: 'Citra', lead: leadId, color: '#444' },
  ] });
  for (const spy of [{ id: 'm5', name: 'Spy', email: 'Budi@corp.com' }, { id: 'm5', name: 'budi' }]) {
    const s = await api('GET', '/api/state', { cookie: leadCookie });
    const put = await api('PUT', '/api/state', { cookie: leadCookie, body: {
      baseVersion: s.data.version, loadedAt: s.data.loadedAt, patch: { members: s.data.state.members.concat([spy]) },
    } });
    assert.equal(put.status, 403);
  }
  const full = (await api('GET', '/api/state', { cookie: adminCookie })).data.state;
  assert.deepEqual(full.members.map((m) => m.id), ['m1', 'm2', 'm3', 'm4']);
});

test('a lead cannot replace the whole board or use admin-only routes', async () => {
  const s = await api('GET', '/api/state', { cookie: leadCookie });
  assert.equal((await api('PUT', '/api/state', { cookie: leadCookie, body: { state: s.data.state, baseVersion: s.data.version } })).status, 403);
  assert.equal((await api('GET', '/api/auth/users', { cookie: leadCookie })).status, 403);
  assert.equal((await api('POST', '/api/auth/users', { cookie: leadCookie, body: { username: 'x3x', password: 'Test-password-3', role: 'admin' } })).status, 403);
  assert.equal((await api('POST', '/api/jira', { cookie: leadCookie, body: { action: 'test' } })).status, 403);
  assert.equal((await api('GET', '/api/kpi/fields', { cookie: leadCookie })).status, 403);
});

test('a lead may only link a member of their own team as themselves', async () => {
  assert.equal((await api('POST', '/api/auth/member', { cookie: leadCookie, body: { memberId: 'm2' } })).status, 403);
  assert.equal((await api('POST', '/api/auth/member', { cookie: leadCookie, body: { memberId: 'm1' } })).status, 200);
});

test("deleting a lead leaves their members without a lead", async () => {
  const del = await api('POST', '/api/auth/users/delete', { cookie: adminCookie, body: { id: Number(leadId) } });
  assert.equal(del.status, 200);
  const full = (await api('GET', '/api/state', { cookie: adminCookie })).data;
  const byId = Object.fromEntries(full.state.members.map((m) => [m.id, m]));
  assert.equal(byId.m1.lead, '');
  assert.equal(byId.m4.lead, '');
  assert.equal(byId.m2.lead, adminId);
  assert.deepEqual(full.leads.map((l) => l.name), ['boss']);
});

test('admins and leads manage their own JIRA key; viewers cannot', async () => {
  await api('POST', '/api/auth/users', { cookie: adminCookie, body: { username: 'keylead', password: 'Test-password-2', role: 'lead' } });
  await api('POST', '/api/auth/users', { cookie: adminCookie, body: { username: 'keyviewer', password: 'Test-password-2', role: 'viewer' } });
  const lead = (await api('POST', '/api/auth/login', { body: { username: 'keylead', password: 'Test-password-2' } })).cookie;
  const viewer = (await api('POST', '/api/auth/login', { body: { username: 'keyviewer', password: 'Test-password-2' } })).cookie;

  const none = { email: '', hasToken: false, inUse: false, envOverride: false };
  assert.deepEqual((await api('GET', '/api/state', { cookie: lead })).data.myJira, none);
  assert.deepEqual((await api('GET', '/api/state', { cookie: adminCookie })).data.myJira, none);
  assert.equal((await api('GET', '/api/state', { cookie: viewer })).data.myJira, null);
  assert.equal((await api('PUT', '/api/auth/jira', { cookie: viewer, body: { email: 'v@x.com', token: 't' } })).status, 403);
  assert.equal((await api('GET', '/api/auth/jira')).status, 401);

  assert.equal((await api('PUT', '/api/auth/jira', { cookie: lead, body: { email: 'bad', token: 't' } })).status, 400);
  const saved = await api('PUT', '/api/auth/jira', { cookie: lead, body: { email: 'lead@x.com', token: 'secret-token' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data, { email: 'lead@x.com', hasToken: true, inUse: true, envOverride: false });
  const st = await api('GET', '/api/state', { cookie: lead });
  assert.equal(st.data.myJira.inUse, true);
  assert.equal(JSON.stringify(st.data).includes('secret-token'), false, 'the token is never sent back');

  // no team site yet, so the test cannot reach JIRA
  assert.equal((await api('POST', '/api/auth/jira', { cookie: lead, body: {} })).status, 400);

  const cleared = await api('PUT', '/api/auth/jira', { cookie: lead, body: { email: '' } });
  assert.deepEqual(cleared.data, none);
});
