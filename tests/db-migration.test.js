/*
 * Upgrading a database from before the "Start standup" button. Run: npm test
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-desk-mig-'));
after(() => { require('../lib/db.js').close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('legacy days with notes become started, JIRA-only days do not', () => {
  const old = new Database(path.join(dataDir, 'scrum-desk.db'));
  old.exec("CREATE TABLE days (date TEXT PRIMARY KEY, entries TEXT DEFAULT '{}', jira TEXT)");
  old.exec("CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT DEFAULT '', email TEXT DEFAULT '', color TEXT DEFAULT '#3D51E0', sort INTEGER DEFAULT 0)");
  old.prepare('INSERT INTO members (id, name, role) VALUES (?,?,?)').run('m1', 'Member One', 'QA');
  const ins = old.prepare('INSERT INTO days (date, entries, jira) VALUES (?,?,?)');
  ins.run('2026-08-03', JSON.stringify({ m1: { today: 'deploy' } }), null);
  ins.run('2026-08-04', JSON.stringify({ m1: { attendance: 'sick' } }), null);
  ins.run('2026-08-08', '{}', JSON.stringify({ syncedAt: 'x', issues: [] }));
  ins.run('2026-08-10', JSON.stringify({ m1: { today: '   ' } }), null);
  old.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TEXT)');
  old.prepare('INSERT INTO users (username, pass_salt, pass_hash) VALUES (?,?,?)').run('lead', 's', 'h');
  // sessions from before tokens were hashed: the raw cookie value is the key
  old.exec('CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
  old.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run('legacy-raw-token', 1, Date.now() + 86400000);
  // KPI cache from before configurable rules: rules_version, no rules_signature
  old.exec(`CREATE TABLE kpi_sprints (sprint_id INTEGER PRIMARY KEY, board_id INTEGER, name TEXT DEFAULT '', month TEXT,
    state TEXT DEFAULT '', start_at TEXT, end_at TEXT, closed_at TEXT,
    computed_at TEXT, computed_state TEXT, rules_version INTEGER, last_error TEXT)`);
  old.prepare("INSERT INTO kpi_sprints (sprint_id, name, month, state, computed_at, rules_version) VALUES (?,?,?,?,?,?)")
    .run(101, 'S1', '2026-09', 'closed', '2026-09-15T00:00:00.000Z', 1);
  old.close();

  process.env.DATA_DIR = dataDir;
  const db = require('../lib/db.js');
  const days = db.loadState().days;
  assert.equal(days['2026-08-03'].startedAt, '2026-08-03T00:00:00.000Z');
  assert.ok(days['2026-08-04'].startedAt);
  assert.equal(days['2026-08-08'].startedAt, null);
  assert.equal(days['2026-08-10'].startedAt, null);
  assert.equal(days['2026-08-03'].roster[0].name, 'Member One');
  assert.equal(days['2026-08-08'].roster, null);
  // users gain role (admin) and an empty team-member link
  const [lead] = db.listUsers();
  assert.equal(lead.role, 'admin');
  assert.equal(lead.memberId, '');
  db.setUserMember(lead.id, 'm1');
  assert.equal(db.listUsers()[0].memberId, 'm1');
  // rules_version is dropped; the cached sprint has no signature, so it is stale
  const cols = new Database(path.join(dataDir, 'scrum-desk.db'), { readonly: true });
  const names = cols.pragma('table_info(kpi_sprints)').map((c) => c.name);
  cols.close();
  assert.ok(names.includes('rules_signature'));
  assert.ok(!names.includes('rules_version'));
  assert.deepEqual(db.staleKpiSprints('any').map((x) => x.id), [101]);
  // a session from before hashing still signs in, but its raw token is no longer stored
  assert.equal(db.getSessionUser('legacy-raw-token').username, 'lead');
  const raw = new Database(path.join(dataDir, 'scrum-desk.db'), { readonly: true });
  const stored = raw.prepare('SELECT token_hash AS token FROM sessions').all().map((r) => r.token);
  raw.close();
  assert.equal(stored.length, 1);
  assert.ok(!stored.includes('legacy-raw-token'));
});
