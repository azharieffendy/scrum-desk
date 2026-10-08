#!/usr/bin/env node
/*
 * Offline tool for Daily Scrum full backups (.dsbackup). Works while the app is down.
 *
 *   node scripts/restore-backup.js inspect    <backup>                 show what the backup holds
 *   node scripts/restore-backup.js restore-db <backup> --data <dir>    queue its database; the next start applies it
 *   node scripts/restore-backup.js extract    <backup> <empty-dir>     unpack app, Docker files, data and app.env
 *
 * The password is read from BACKUP_PASSWORD or asked for (hidden). It is never written anywhere.
 * restore-db and the app share lib/backup-apply.js: the next start checks the queued
 * database again, saves a copy of the current one in <dir>/backups/, then swaps it in.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const format = require('../lib/backup-format.js');

const DB_PATH = 'db/daily-scrum.db';

function fail(message) {
  process.stderr.write('Error: ' + message + '\n');
  process.exit(1);
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  node scripts/restore-backup.js inspect    <backup.dsbackup>',
    '  node scripts/restore-backup.js restore-db <backup.dsbackup> --data <data-dir>',
    '  node scripts/restore-backup.js extract    <backup.dsbackup> <empty-dir>',
    'Password: set BACKUP_PASSWORD, or type it when asked.',
    '',
  ].join('\n'));
  process.exit(2);
}

/** Asks for the password without echoing it. */
function askPassword() {
  if (process.env.BACKUP_PASSWORD) return Promise.resolve(process.env.BACKUP_PASSWORD);
  if (!process.stdin.isTTY) fail('No terminal to ask for the password. Set BACKUP_PASSWORD, or run with -it.');
  return new Promise((resolve) => {
    process.stdout.write('Backup password: ');
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.stdout.write('\n'); process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function open(file) {
  if (!file || !fs.existsSync(file)) fail('Backup file not found: ' + (file || '(none)'));
  const data = fs.readFileSync(file);
  format.readHeader(data); // a file that is not a backup fails before the password is asked
  const password = await askPassword();
  process.stdout.write('Decrypting and verifying checksums…\n');
  const bundle = await format.decrypt(data, password);
  if (bundle.manifest.app !== 'daily-scrum') fail('This backup was not made by Daily Scrum.');
  return bundle;
}

function printSummary({ manifest: m, files }) {
  const lines = [
    'Created:      ' + (m.createdAt || 'unknown') + ' by ' + (m.createdBy || 'unknown'),
    'App version:  ' + (m.appVersion || 'unknown') + (m.gitCommit ? ' (commit ' + m.gitCommit.slice(0, 12) + ')' : ''),
    'Includes:     ' + (Array.isArray(m.included) ? m.included.join(', ') : 'unknown'),
    'Config keys:  ' + (Array.isArray(m.envKeys) && m.envKeys.length ? m.envKeys.join(', ') : 'none'),
    'Files:        ' + files.size + ' (all checksums verified)',
  ];
  if (m.database && m.database.tables) {
    lines.push('Database:     ' + Object.entries(m.database.tables).map(([t, n]) => t + ' ' + n).join(', '));
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function cmdInspect(file) {
  printSummary(await open(file));
}

async function cmdRestoreDb(file, dataDir) {
  if (!dataDir) fail('Give the data folder: --data <dir> (in Docker: --data /app/data).');
  dataDir = path.resolve(dataDir);
  if (!fs.existsSync(dataDir)) fail('Data folder not found: ' + dataDir);
  const apply = require('../lib/backup-apply.js'); // needs better-sqlite3, unlike inspect and extract
  const bundle = await open(file);
  printSummary(bundle);
  const dbData = bundle.files.get(DB_PATH);
  if (!dbData) fail('This backup does not contain a database.');
  const tmp = path.join(apply.workDir(dataDir), 'restore-cli-' + crypto.randomBytes(8).toString('hex') + '.db');
  fs.writeFileSync(tmp, dbData, { mode: 0o600 });
  try {
    const problems = apply.restoreProblems(apply.describeDatabase(tmp));
    if (problems.length) fail(problems.join(' '));
    apply.prepareForRestore(tmp);
    apply.stageRestore(dataDir, tmp, { backupCreatedAt: bundle.manifest.createdAt || null, backupCreatedBy: bundle.manifest.createdBy || null });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  process.stdout.write([
    '',
    'The database is checked and queued in ' + dataDir + '.',
    'Start the app (docker compose up -d) to apply it. Before replacing the current',
    'database the app saves a copy of it in ' + path.join(dataDir, apply.SAFETY_DIR) + '.',
    'Everyone signs in again with the accounts from the backup.',
    '',
  ].join('\n'));
}

/** Writes a file strictly inside root (paths were checked by unpackBundle; this double-checks). */
function writeInside(root, rel, data, mode) {
  const dest = path.resolve(root, rel);
  if (!dest.startsWith(root + path.sep)) fail('Unsafe path in backup: ' + rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data, mode ? { mode } : undefined);
}

async function cmdExtract(file, outDir) {
  if (!outDir) fail('Give an empty folder to unpack into.');
  const root = path.resolve(outDir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) fail('The folder is not empty: ' + root);
  const bundle = await open(file);
  fs.mkdirSync(root, { recursive: true });
  for (const [p, data] of bundle.files) {
    if (p.startsWith('app/')) writeInside(root, p.slice(4), data);
    else if (p === DB_PATH) writeInside(root, 'data/daily-scrum.db', data, 0o600);
    else if (p === 'config/app.env') writeInside(root, 'app.env', data, 0o600);
    else if (p === 'config/env.json') continue;
    else writeInside(root, p, data);
  }
  printSummary(bundle);
  process.stdout.write([
    '',
    'Unpacked into ' + root,
    '  data/daily-scrum.db   the database (the app opens it from ./data)',
    '  app.env               the configured values — it holds secrets; keep it private',
    '  RESTORE.txt           the remaining steps',
    'Next: review app.env, add what you need to docker-compose.yml, then: docker compose up -d --build',
    '',
  ].join('\n'));
}

async function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (cmd === 'inspect') return cmdInspect(file);
  if (cmd === 'restore-db') {
    const i = rest.indexOf('--data');
    return cmdRestoreDb(file, i >= 0 ? rest[i + 1] : null);
  }
  if (cmd === 'extract') return cmdExtract(file, rest[0]);
  return usage();
}

main().catch((e) => fail(e.message));
