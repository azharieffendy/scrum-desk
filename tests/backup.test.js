/*
 * Full encrypted backup & restore: the file format, the start-up restore, and
 * the HTTP flow end to end — a backup made on one server restored into a second,
 * isolated server. Every test uses its own temporary data folder.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const format = require('../lib/backup-format.js');
const apply = require('../lib/backup-apply.js');

const FAST_KDF = { N: 2 ** 14, r: 8, p: 1 };
const PASSWORD = 'Backup-pass-123';
const ADMIN_PASSWORD = 'Admin-pass-123';
const SETUP_CODE = 'backup-setup-code';
const SERVER = path.join(__dirname, '..', 'server.js');
const CLI = path.join(__dirname, '..', 'scripts', 'restore-backup.js');
const tmpDirs = [];

function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-desk-backup-' + label + '-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/* ---------------- file format ---------------- */

const sampleBundle = () => format.packBundle({ app: 'scrum-desk', createdAt: '2026-01-01T00:00:00.000Z' },
  [{ path: 'db/scrum-desk.db', data: Buffer.from('database bytes') }, { path: 'app/server.js', data: Buffer.from('// app') }]);

test('a backup decrypts with its password and every file comes back intact', async () => {
  const file = await format.encrypt(sampleBundle(), PASSWORD, FAST_KDF);
  assert.ok(file.subarray(0, 9).equals(format.MAGIC));
  assert.ok(!file.includes(Buffer.from('database bytes')), 'contents are encrypted');
  const out = await format.decrypt(file, PASSWORD);
  assert.equal(out.manifest.app, 'scrum-desk');
  assert.equal(out.manifest.format, format.FORMAT);
  assert.equal(out.files.get('db/scrum-desk.db').toString(), 'database bytes');
  assert.equal(out.files.get('app/server.js').toString(), '// app');
});

test('two backups of the same data use a different salt and IV', async () => {
  const a = format.readHeader(await format.encrypt(sampleBundle(), PASSWORD, FAST_KDF));
  const b = format.readHeader(await format.encrypt(sampleBundle(), PASSWORD, FAST_KDF));
  assert.ok(!a.salt.equals(b.salt));
  assert.ok(!a.iv.equals(b.iv));
});

test('a wrong password is refused', async () => {
  const file = await format.encrypt(sampleBundle(), PASSWORD, FAST_KDF);
  await assert.rejects(format.decrypt(file, 'Wrong-pass-123'), (e) => e.code === 'password' && e.status === 400);
});

test('a damaged backup is refused: changed byte, changed header, truncated, not a backup', async () => {
  const file = await format.encrypt(sampleBundle(), PASSWORD, FAST_KDF);
  const flipped = Buffer.from(file); flipped[file.length - 40] ^= 1;
  await assert.rejects(format.decrypt(flipped, PASSWORD), (e) => e.code === 'password');
  // the header is authenticated: a changed salt fails even though it still parses
  const h = format.readHeader(file);
  const header = Buffer.from(file); header[h.bodyStart - 3] ^= 1;
  await assert.rejects(format.decrypt(header, PASSWORD), (e) => ['password', 'damaged'].includes(e.code));
  await assert.rejects(format.decrypt(file.subarray(0, file.length - 10), PASSWORD), (e) => e.status === 400);
  await assert.rejects(format.decrypt(file.subarray(0, 12), PASSWORD), (e) => e.code === 'damaged');
  await assert.rejects(format.decrypt(Buffer.from('{"app":"scrum-desk"}'), PASSWORD), (e) => e.code === 'damaged');
});

function withHeader(file, edit) {
  const h = format.readHeader(file);
  const json = JSON.parse(file.subarray(13, h.bodyStart).toString());
  const next = Buffer.from(JSON.stringify(edit(json)));
  const len = Buffer.alloc(4); len.writeUInt32BE(next.length);
  return Buffer.concat([format.MAGIC, len, next, file.subarray(h.bodyStart)]);
}

test('an unsupported version is refused with a clear message', async () => {
  const file = await format.encrypt(sampleBundle(), PASSWORD, FAST_KDF);
  await assert.rejects(format.decrypt(withHeader(file, (h) => Object.assign(h, { v: 2 })), PASSWORD), (e) => e.code === 'unsupported');
  // a newer bundle format inside a valid encryption layer
  const newer = await format.encrypt(require('node:zlib').gzipSync(JSON.stringify({ manifest: { format: format.FORMAT + 1 }, files: [] })), PASSWORD, FAST_KDF);
  await assert.rejects(format.decrypt(newer, PASSWORD), (e) => e.code === 'unsupported' && /newer version/.test(e.message));
});

test('a backup asking for an excessive key-derivation cost is refused before deriving', async () => {
  const file = await format.encrypt(sampleBundle(), PASSWORD, FAST_KDF);
  assert.throws(() => format.readHeader(withHeader(file, (h) => Object.assign(h, { N: 2 ** 19 }))), (e) => e.code === 'damaged');
  assert.throws(() => format.readHeader(withHeader(file, (h) => Object.assign(h, { N: 3000 }))), (e) => e.code === 'damaged');
});

test('unsafe or repeated archive paths and bad checksums are refused', () => {
  for (const p of ['../x', '/etc/passwd', 'a/../../b', 'C:/x', 'a\\b', 'a//b', './a', 'a\u0000b', '']) assert.equal(format.isSafePath(p), false, p);
  assert.equal(format.isSafePath('app/lib/db.js'), true);
  assert.throws(() => format.packBundle({}, [{ path: '../evil', data: Buffer.from('x') }]));
  const zlib = require('node:zlib');
  const bundle = (files) => zlib.gzipSync(JSON.stringify({ manifest: { format: 1 }, files }));
  const entry = (p, data) => ({ path: p, size: data.length, sha256: format.sha256(data), data: data.toString('base64') });
  assert.throws(() => format.unpackBundle(bundle([entry('../evil', Buffer.from('x'))])), (e) => e.code === 'damaged');
  assert.throws(() => format.unpackBundle(bundle([entry('a', Buffer.from('x')), entry('a', Buffer.from('x'))])), (e) => e.code === 'damaged');
  const bad = entry('a', Buffer.from('x')); bad.sha256 = format.sha256(Buffer.from('y'));
  assert.throws(() => format.unpackBundle(bundle([bad])), (e) => e.code === 'checksum');
});

/* ---------------- start-up restore ---------------- */

function makeDb(file, { admin = 'boss', note = 'hello' } = {}) {
  const conn = new Database(file);
  conn.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE days (date TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER);`);
  if (admin) conn.prepare("INSERT INTO users (username, role) VALUES (?, 'admin')").run(admin);
  conn.prepare('INSERT INTO settings VALUES (?, ?)').run('note', note);
  conn.prepare('INSERT INTO sessions VALUES (?, 1, 9999999999999)').run('old-session');
  conn.close();
}

const readNote = (file) => {
  const conn = new Database(file, { readonly: true });
  try { return conn.prepare("SELECT value FROM settings WHERE key = 'note'").get().value; } finally { conn.close(); }
};

function queue(dir, note, opts) {
  const staged = path.join(apply.workDir(dir), 'staged.db');
  makeDb(staged, Object.assign({ note }, opts));
  apply.prepareForRestore(staged);
  apply.stageRestore(dir, staged, { backupCreatedAt: '2026-01-01T00:00:00.000Z' });
}

test('a queued restore replaces the database after saving a checked copy of the current one', () => {
  const dir = tmpDir('apply');
  const live = path.join(dir, apply.DB_NAME);
  makeDb(live, { note: 'current' });
  queue(dir, 'from backup');
  const result = apply.applyPendingRestore(dir);
  assert.equal(result.ok, true);
  assert.equal(readNote(live), 'from backup');
  assert.equal(readNote(path.join(dir, result.safetyCopy)), 'current');
  const conn = new Database(live, { readonly: true });
  assert.equal(conn.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0, 'restored sessions are signed out');
  conn.close();
  assert.equal(apply.hasPendingRestore(dir), false);
  assert.equal(apply.lastRestoreResult(dir).ok, true);
  assert.equal(apply.applyPendingRestore(dir), null, 'nothing to do on the next start');
});

test('a queued database that changed after it was checked leaves the current one untouched', () => {
  const dir = tmpDir('tamper');
  const live = path.join(dir, apply.DB_NAME);
  makeDb(live, { note: 'current' });
  queue(dir, 'from backup');
  fs.appendFileSync(path.join(dir, apply.PENDING_DB), 'x');
  const result = apply.applyPendingRestore(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /changed after it was checked/);
  assert.equal(readNote(live), 'current');
  assert.ok(fs.existsSync(path.join(dir, result.keptAs)), 'the refused file is kept for a look');
  assert.equal(fs.existsSync(path.join(dir, apply.PENDING_DB)), false);
});

test('a corrupt current database is still replaced, after a byte-for-byte copy of it is saved', () => {
  const dir = tmpDir('corrupt');
  const live = path.join(dir, apply.DB_NAME);
  const broken = Buffer.from('SQLite format 3\0 but the rest is garbage '.repeat(200));
  fs.writeFileSync(live, broken);
  fs.writeFileSync(live + '-wal', 'old wal');
  queue(dir, 'from backup');
  const result = apply.applyPendingRestore(dir);
  assert.equal(result.ok, true, result.error);
  assert.equal(readNote(live), 'from backup');
  assert.equal(result.safetyCopyRaw, true);
  assert.ok(fs.readFileSync(path.join(dir, result.safetyCopy)).equals(broken), 'the corrupt file is kept as it was');
  assert.equal(fs.readFileSync(path.join(dir, result.safetyCopy + '-wal'), 'utf8'), 'old wal', 'with its journal');
  assert.equal(fs.existsSync(live + '-wal'), false);
  assert.equal(apply.hasPendingRestore(dir), false);
});

test('when no copy of the current database can be saved, the restore stays queued and nothing changes', () => {
  const dir = tmpDir('nocopy');
  const live = path.join(dir, apply.DB_NAME);
  makeDb(live, { note: 'current' });
  queue(dir, 'from backup');
  fs.writeFileSync(path.join(dir, apply.SAFETY_DIR), 'a file where the backups folder should be');
  const result = apply.applyPendingRestore(dir);
  assert.equal(result.ok, false);
  assert.equal(result.queued, true);
  assert.match(result.error, /tried again at the next start/);
  assert.equal(readNote(live), 'current');
  assert.equal(apply.hasPendingRestore(dir), true, 'the checked restore is not thrown away');
  fs.rmSync(path.join(dir, apply.SAFETY_DIR));
  const retry = apply.applyPendingRestore(dir);
  assert.equal(retry.ok, true, retry.error);
  assert.equal(readNote(live), 'from backup');
});

test('a database with no admin account cannot be restored', () => {
  const dir = tmpDir('noadmin');
  const file = path.join(dir, 'x.db');
  makeDb(file, { admin: null });
  assert.match(apply.restoreProblems(apply.describeDatabase(file)).join(' '), /no admin account/);
  fs.writeFileSync(path.join(dir, 'junk.db'), 'not a database');
  assert.equal(apply.describeDatabase(path.join(dir, 'junk.db')).ok, false);
});

/* ---------------- HTTP: export from A, restore into an isolated B ---------------- */

function startServer(dataDir, port) {
  const proc = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, SETUP_CODE, TRUST_PROXY: '1',
      JIRA_SITE: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '', RESTART_MANAGED: '' }),
    stdio: 'ignore',
  });
  const base = 'http://127.0.0.1:' + port;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  const api = async (method, pathname, { body, cookie } = {}) => {
    const res = await fetch(base + pathname, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    const buf = Buffer.from(await res.arrayBuffer());
    let data = null;
    try { data = JSON.parse(buf.toString()); } catch (_) { /* binary */ }
    return { status: res.status, data, buf, headers: res.headers, cookie: setCookie ? setCookie.split(';')[0] : null };
  };
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/api/auth/status'); return; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('server did not start');
  })();
  return { proc, api, ready, exited, stop: async () => { if (proc.exitCode === null) { proc.kill(); await exited; } } };
}

const portBase = 4500 + Math.floor(Math.random() * 400); // clear of lead-server.test.js (4000-4089); files run in parallel
const dirA = tmpDir('server-a');
const dirB = tmpDir('server-b');
let A; let B;
const ck = {};
let backupFile;

before(async () => {
  A = startServer(dirA, portBase);
  B = startServer(dirB, portBase + 1);
  await Promise.all([A.ready, B.ready]);
  const a = await A.api('POST', '/api/auth/setup', { body: { username: 'owner', password: ADMIN_PASSWORD, setupCode: SETUP_CODE } });
  ck.a = a.cookie;
  for (const role of ['viewer', 'lead']) {
    const r = await A.api('POST', '/api/auth/users', { cookie: ck.a, body: { username: role + 'one', password: ADMIN_PASSWORD, role } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ck[role] = (await A.api('POST', '/api/auth/login', { body: { username: role + 'one', password: ADMIN_PASSWORD } })).cookie;
  }
  const s0 = await A.api('GET', '/api/state', { cookie: ck.a });
  const state = Object.assign({}, s0.data.state, {
    members: [{ id: 'm1', name: 'Ada', role: 'Developer', email: '', color: '#3D51E0' }],
    settings: Object.assign({}, s0.data.state.settings, { jql: 'project = BACKUP' }),
  });
  const put = await A.api('PUT', '/api/state', { cookie: ck.a,
    body: { state, baseVersion: s0.data.version, loadedAt: s0.data.loadedAt, creds: { site: 'team', email: 'a@b.c', token: 'SECRET-TOKEN' } } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const b = await B.api('POST', '/api/auth/setup', { body: { username: 'other', password: ADMIN_PASSWORD, setupCode: SETUP_CODE } });
  ck.b = b.cookie;
});

after(async () => { await Promise.all([A && A.stop(), B && B.stop()]); });

test('only admins can use full backup and restore', async () => {
  for (const who of ['viewer', 'lead']) {
    for (const [method, route] of [['POST', 'create'], ['POST', 'inspect'], ['POST', 'restore'], ['GET', 'status']]) {
      const r = await A.api(method, '/api/backup/' + route, { cookie: ck[who], body: method === 'POST' ? { password: PASSWORD } : undefined });
      assert.equal(r.status, 403, who + ' ' + route);
    }
  }
  assert.equal((await A.api('POST', '/api/backup/create', { body: { password: PASSWORD } })).status, 401);
});

test('a weak backup password is refused', async () => {
  const r = await A.api('POST', '/api/backup/create', { cookie: ck.a, body: { password: 'short' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Backup password/);
});

test('a full backup downloads as an encrypted file with the database, configuration and app files', async () => {
  const r = await A.api('POST', '/api/backup/create', { cookie: ck.a, body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="scrum-desk-full-backup-.*\.dsbackup"/);
  backupFile = r.buf;
  assert.ok(!backupFile.includes(Buffer.from('SECRET-TOKEN')));
  const out = await format.decrypt(backupFile, PASSWORD);
  assert.equal(out.manifest.createdBy, 'owner');
  assert.deepEqual(out.manifest.included, ['database', 'configuration', 'application']);
  for (const p of ['db/scrum-desk.db', 'config/env.json', 'RESTORE.txt', 'manifest.json', 'app/server.js', 'app/lib/db.js', 'app/scripts/restore-backup.js', 'app/Dockerfile']) {
    assert.ok(out.files.has(p), p);
  }
  assert.ok(![...out.files.keys()].some((p) => p.includes('node_modules') || p.startsWith('app/data/') || p.startsWith('app/.git')));
  const env = JSON.parse(out.files.get('config/env.json'));
  assert.equal(env.SETUP_CODE, SETUP_CODE);
  assert.equal(env.JIRA_API_TOKEN, undefined, 'blank values are left out');
  assert.equal(env.PATH, undefined, 'only allowlisted variables');
  assert.deepEqual(fs.readdirSync(path.join(dirA, apply.WORK_DIR)), [], 'no temporary files left');
});

const b64 = (buf) => buf.toString('base64');

test('checking a backup with a wrong password or a damaged file changes nothing', async () => {
  const wrong = await B.api('POST', '/api/backup/inspect', { cookie: ck.b, body: { file: b64(backupFile), password: 'Wrong-pass-123' } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /Wrong password/);
  const damaged = Buffer.from(backupFile); damaged[damaged.length - 100] ^= 0xff;
  const bad = await B.api('POST', '/api/backup/inspect', { cookie: ck.b, body: { file: b64(damaged), password: PASSWORD } });
  assert.equal(bad.status, 400);
  const junk = await B.api('POST', '/api/backup/inspect', { cookie: ck.b, body: { file: b64(Buffer.from('hello')), password: PASSWORD } });
  assert.equal(junk.status, 400);
  assert.match(junk.data.error, /not a Scrum Desk full backup/);
  assert.equal((await B.api('POST', '/api/backup/restore', { cookie: ck.b, body: { id: 'nope', confirm: 'RESTORE' } })).status, 409);
  assert.equal((await B.api('GET', '/api/auth/status', { cookie: ck.b })).data.authenticated, true);
  assert.equal(fs.existsSync(path.join(dirB, apply.PENDING_INFO)), false);
});

let review;

test('checking a good backup describes it without changing anything', async () => {
  const r = await B.api('POST', '/api/backup/inspect', { cookie: ck.b, body: { file: b64(backupFile), password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  review = r.data;
  assert.equal(review.createdBy, 'owner');
  assert.ok(review.accounts.some((a) => a.username === 'owner' && a.role === 'admin'));
  assert.ok(review.warnings.some((w) => /other/.test(w) && /removed/.test(w)), 'warns that B\'s own account goes away');
  assert.ok(review.tables.find((t) => t.name === 'members').backup >= 1);
  assert.ok(review.envKeys.includes('SETUP_CODE'));
  assert.ok(!JSON.stringify(review).includes(SETUP_CODE), 'configuration values are never sent back');
  assert.ok(!JSON.stringify(review).includes('SECRET-TOKEN'));
  assert.equal((await B.api('GET', '/api/auth/status', { cookie: ck.b })).data.user.name, 'other');
  assert.equal((await B.api('POST', '/api/backup/restore', { cookie: ck.b, body: { id: review.id } })).status, 400, 'needs RESTORE typed');
});

test('restoring replaces the database, keeps a safety copy and preserves accounts, settings, credentials and team data', async () => {
  const r = await B.api('POST', '/api/backup/restore', { cookie: ck.b, body: { id: review.id, confirm: 'RESTORE' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.restarting, true);
  await B.exited; // the server exits so the restore is applied before the database is reopened
  B = startServer(dirB, portBase + 1);
  await B.ready;

  assert.equal((await B.api('GET', '/api/auth/status', { cookie: ck.b })).data.authenticated, false, 'old sessions are gone');
  assert.equal((await B.api('POST', '/api/auth/login', { body: { username: 'other', password: ADMIN_PASSWORD } })).status, 401);
  const login = await B.api('POST', '/api/auth/login', { body: { username: 'owner', password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200);
  const s = await B.api('GET', '/api/state', { cookie: login.cookie });
  assert.equal(s.data.state.members[0].name, 'Ada');
  assert.equal(s.data.state.settings.jql, 'project = BACKUP');
  assert.equal(s.data.creds.hasToken, true);
  assert.equal(s.data.creds.email, 'a@b.c');
  const users = await B.api('GET', '/api/auth/users', { cookie: login.cookie });
  assert.deepEqual(users.data.users.map((u) => u.username).sort(), ['leadone', 'owner', 'viewerone']);

  const status = await B.api('GET', '/api/backup/status', { cookie: login.cookie });
  assert.equal(status.data.lastRestore.ok, true);
  const safety = path.join(dirB, status.data.lastRestore.safetyCopy);
  assert.ok(fs.existsSync(safety));
  const old = new Database(safety, { readonly: true });
  assert.equal(old.prepare('SELECT username FROM users').get().username, 'other', 'the replaced database is kept');
  old.close();
  assert.equal(fs.existsSync(path.join(dirB, apply.PENDING_DB)), false);
  assert.deepEqual(fs.existsSync(path.join(dirB, apply.WORK_DIR)) ? fs.readdirSync(path.join(dirB, apply.WORK_DIR)) : [], []);
});

/* ---------------- offline recovery tool ---------------- */

test('the recovery tool inspects, extracts and queues a restore while the app is down', async () => {
  const env = Object.assign({}, process.env, { BACKUP_PASSWORD: PASSWORD });
  const file = path.join(tmpDir('cli'), 'b.dsbackup');
  fs.writeFileSync(file, backupFile);

  const inspect = spawnSync(process.execPath, [CLI, 'inspect', file], { env, encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /owner/);
  const wrong = spawnSync(process.execPath, [CLI, 'inspect', file], { env: Object.assign({}, env, { BACKUP_PASSWORD: 'nope' }), encoding: 'utf8' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /Wrong password/);

  const out = path.join(tmpDir('extract'), 'app');
  const extract = spawnSync(process.execPath, [CLI, 'extract', file, out], { env, encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  for (const p of ['server.js', 'Dockerfile', 'data/scrum-desk.db', 'app.env', 'RESTORE.txt']) assert.ok(fs.existsSync(path.join(out, p)), p);
  assert.equal(spawnSync(process.execPath, [CLI, 'extract', file, out], { env }).status, 1, 'never unpacks over existing files');

  const data = tmpDir('cli-data');
  makeDb(path.join(data, apply.DB_NAME), { note: 'before cli' });
  const restore = spawnSync(process.execPath, [CLI, 'restore-db', file, '--data', data], { env, encoding: 'utf8' });
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(apply.hasPendingRestore(data), true);
  const result = apply.applyPendingRestore(data);
  assert.equal(result.ok, true, result.error);
  assert.equal(readNote(path.join(data, result.safetyCopy)), 'before cli');
});

test('a start interrupted right after the swap reports the restore as done', () => {
  const dir = tmpDir('resume');
  const live = path.join(dir, apply.DB_NAME);
  makeDb(live, { note: 'current' });
  queue(dir, 'from backup');
  fs.rmSync(live);
  fs.renameSync(path.join(dir, apply.PENDING_DB), live); // the swap happened, then the process stopped
  const result = apply.applyPendingRestore(dir);
  assert.equal(result.ok, true);
  assert.equal(readNote(live), 'from backup');
  assert.equal(apply.hasPendingRestore(dir), false);
});

/* ---------------- data from before the rename to Scrum Desk ---------------- */

test('a database saved under the old daily-scrum.db name is moved, with its WAL, before it is opened', () => {
  const dir = tmpDir('legacy-name');
  makeDb(path.join(dir, apply.LEGACY_DB_NAME), { note: 'old name' });
  fs.writeFileSync(path.join(dir, apply.LEGACY_DB_NAME + '-wal'), '');
  assert.equal(apply.migrateLegacyDbName(dir), true);
  assert.equal(readNote(path.join(dir, apply.DB_NAME)), 'old name');
  assert.ok(fs.existsSync(path.join(dir, apply.DB_NAME + '-wal')));
  assert.ok(!fs.existsSync(path.join(dir, apply.LEGACY_DB_NAME)));
  assert.equal(apply.migrateLegacyDbName(dir), false, 'nothing left to move');

  makeDb(path.join(dir, apply.LEGACY_DB_NAME), { note: 'stray old copy' });
  const logs = [];
  assert.equal(apply.migrateLegacyDbName(dir, (m) => logs.push(m)), false, 'never replaces a database with the new name');
  assert.equal(readNote(path.join(dir, apply.DB_NAME)), 'old name');
  assert.match(logs[0], /using scrum-desk\.db/);
});

test('backups made before the rename are still recognised, extracted and restored', async () => {
  const src = path.join(tmpDir('legacy-src'), 'old.db');
  makeDb(src, { note: 'from an old backup' });
  const bundle = format.packBundle({ app: 'daily-scrum', createdAt: '2026-01-01T00:00:00.000Z' },
    [{ path: 'db/daily-scrum.db', data: fs.readFileSync(src) }, { path: 'app/server.js', data: Buffer.from('// app') }]);
  const file = path.join(tmpDir('legacy-cli'), 'old.dsbackup');
  fs.writeFileSync(file, await format.encrypt(bundle, PASSWORD, FAST_KDF));
  const env = Object.assign({}, process.env, { BACKUP_PASSWORD: PASSWORD });

  const out = path.join(tmpDir('legacy-extract'), 'app');
  const extract = spawnSync(process.execPath, [CLI, 'extract', file, out], { env, encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  assert.equal(readNote(path.join(out, 'data', 'scrum-desk.db')), 'from an old backup');

  const data = tmpDir('legacy-data');
  makeDb(path.join(data, apply.DB_NAME), { note: 'current' });
  const restore = spawnSync(process.execPath, [CLI, 'restore-db', file, '--data', data], { env, encoding: 'utf8' });
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(apply.applyPendingRestore(data).ok, true);
  assert.equal(readNote(path.join(data, apply.DB_NAME)), 'from an old backup');

  assert.equal(format.isAppBackup({ app: 'something-else' }), false);
});
