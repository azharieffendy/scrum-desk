/*
 * The first-run setup code is brute-force limited per IP. Uses its own
 * server because the lockout would also block the real setup in server.test.js.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = 'http://127.0.0.1:' + PORT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-desk-setup-'));
let proc;

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, SETUP_CODE: 'right-code' }),
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/auth/status'); return; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

after(async () => {
  await new Promise((resolve) => { proc.once('exit', resolve); proc.kill(); });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const setup = (setupCode) => fetch(BASE + '/api/auth/setup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'lead', password: 'Test-password-1', setupCode }),
});

test('setup is locked after 10 wrong codes, even for the right one', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await setup('wrong')).status, 403);
  assert.equal((await setup('wrong')).status, 429);
  assert.equal((await setup('right-code')).status, 429);
});
