/*
 * Full encrypted backup and reviewed database restore (Settings → Data & backup, admins only).
 *
 * A backup holds the database (accounts, settings, JIRA credentials, notes, team and
 * report data), the configured environment values, the application and deployment
 * files, and version info, checksums and restore instructions — encrypted with the
 * admin's password (lib/backup-format.js). The password is never stored or logged.
 *
 * A restore is two steps: inspect (decrypt, verify, describe what would change) and
 * restore (queue the checked database and restart; lib/backup-apply.js swaps it in at
 * start-up after taking a safety copy). Application and Docker files are never written
 * by the app — that is the separate recovery step in RESTORE.txt.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const format = require('./backup-format.js');
const apply = require('./backup-apply.js');
const { httpError } = require('./http-utils.js');

const APP_ROOT = path.join(__dirname, '..');
const APP_FILES = ['server.js', 'package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', '.dockerignore', 'README.md'];
const APP_DIRS = ['lib', 'api', 'public', 'scripts'];
// Inside the Docker image the deployment files are copied to deploy/ (see Dockerfile).
const DEPLOY_DIR = 'deploy';
const APP_MAX_BYTES = 50 * 1024 * 1024;
const APP_FILE_MAX_BYTES = 5 * 1024 * 1024;
// Only these configured values are saved — never the whole environment.
const ENV_KEYS = ['PORT', 'TZ', 'DATA_DIR', 'TRUST_PROXY', 'COOKIE_SECURE', 'SETUP_CODE', 'APP_ACCESS_CODE', 'JIRA_SITE', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
const STAGED_TTL_MS = 30 * 60000;
const PASSWORD_FAILS_MAX = 10;
const PASSWORD_WINDOW_MS = 10 * 60000;
const DB_PATH = format.DB_PATH;

function readAppVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || ''); } catch (_) { return ''; }
}

/** The git commit the app runs from, when it runs from a checkout. */
function readGitCommit() {
  try {
    const head = fs.readFileSync(path.join(APP_ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 40);
    const ref = head.slice(5);
    const loose = path.join(APP_ROOT, '.git', ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim().slice(0, 40);
    const packed = fs.readFileSync(path.join(APP_ROOT, '.git', 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref));
    return packed ? packed.split(' ')[0] : '';
  } catch (_) { return ''; }
}

/** Application and deployment files, as bundle entries under app/. */
function collectAppFiles() {
  const out = [];
  let total = 0;
  const add = (rel, abs) => {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > APP_FILE_MAX_BYTES || total + stat.size > APP_MAX_BYTES) return;
    const p = 'app/' + rel;
    if (!format.isSafePath(p) || out.some((f) => f.path === p)) return;
    total += stat.size;
    out.push({ path: p, data: fs.readFileSync(abs) });
  };
  const walk = (rel) => {
    const abs = path.join(APP_ROOT, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const child = rel + '/' + entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) add(child, path.join(abs, entry.name));
    }
  };
  for (const name of APP_FILES) {
    for (const abs of [path.join(APP_ROOT, name), path.join(APP_ROOT, DEPLOY_DIR, name)]) {
      if (fs.existsSync(abs)) { add(name, abs); break; }
    }
  }
  for (const dir of APP_DIRS) if (fs.existsSync(path.join(APP_ROOT, dir))) walk(dir);
  return out;
}

function configuredEnv() {
  const env = {};
  for (const k of ENV_KEYS) if (process.env[k] !== undefined && process.env[k] !== '') env[k] = String(process.env[k]);
  return env;
}

function restoreInstructions(manifest) {
  return [
    'Scrum Desk full backup',
    '=======================',
    'Created:     ' + manifest.createdAt + ' by ' + manifest.createdBy,
    'App version: ' + (manifest.appVersion || 'unknown') + (manifest.gitCommit ? ' (commit ' + manifest.gitCommit + ')' : ''),
    '',
    'This file is encrypted. The password cannot be recovered: without it the backup cannot be opened.',
    '',
    'Contents (once decrypted)',
    '  db/scrum-desk.db   the database: accounts, settings, JIRA credentials, notes, team and report data',
    '  config/env.json     the configured environment values (also as config/app.env)',
    '  app/                the application source and deployment files (Dockerfile, docker-compose.yml)',
    '  manifest.json       versions, table counts and checksums',
    '',
    '1. Restore only the database, while the app runs',
    '   Settings -> Data & backup -> Restore full backup. Review the summary, then confirm.',
    '   The app saves a copy of the current database in data/backups/ and restarts.',
    '',
    '2. Restore only the database, when the app does not start (Docker)',
    '   From the folder with docker-compose.yml:',
    '     docker compose stop scrum-desk',
    '     docker compose run --rm -it --no-deps -v "$PWD/<backup>.dsbackup:/tmp/restore.dsbackup:ro" \\',
    '       scrum-desk node scripts/restore-backup.js restore-db /tmp/restore.dsbackup --data /app/data',
    '     docker compose up -d',
    '   Without Docker: node scripts/restore-backup.js restore-db <backup>.dsbackup --data ./data, then start the app.',
    '',
    '3. Rebuild everything on a new machine (app, Docker setup and data)',
    '   Needs Node.js 18+ to unpack (no other packages):',
    '     node restore-backup.js extract <backup>.dsbackup ./scrum-desk',
    '   (restore-backup.js is in app/scripts/ of any copy of the app.) Then:',
    '     cd scrum-desk     # holds the app, data/scrum-desk.db and app.env',
    '     review app.env, copy the values you need into docker-compose.yml "environment:"',
    '     docker compose up -d --build',
    '',
  ].join('\n');
}

function createBackupService({ db, dataDir }) {
  let busy = false;
  let staged = null; // { id, file, expires, info, summary }
  let fails = [];

  async function exclusive(fn) {
    if (busy) throw httpError(429, 'Another backup task is running. Try again in a moment.');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  function dropStaged() {
    if (staged) { fs.rmSync(staged.file, { force: true }); clearTimeout(staged.timer); }
    staged = null;
  }

  /** Builds the encrypted backup. Returns { filename, data }. */
  function create({ password, user }) {
    return exclusive(async () => {
      const dir = apply.workDir(dataDir);
      const tmp = path.join(dir, 'backup-' + crypto.randomBytes(8).toString('hex') + '.db');
      try {
        await db.backupTo(tmp);
        const desc = apply.describeDatabase(tmp);
        if (!desc.ok) throw new Error('the copy of the database failed its check (' + desc.integrity + ')');
        const dbData = fs.readFileSync(tmp);
        const env = configuredEnv();
        const manifest = {
          app: format.APP_ID,
          appVersion: readAppVersion(),
          gitCommit: readGitCommit(),
          node: process.version,
          createdAt: new Date().toISOString(),
          createdBy: user.username,
          included: ['database', 'configuration', 'application'],
          envKeys: Object.keys(env),
          database: { path: DB_PATH, sha256: format.sha256(dbData), size: dbData.length, tables: Object.fromEntries(Object.entries(desc.tables).map(([k, v]) => [k, v.rows])) },
        };
        const appFiles = collectAppFiles();
        manifest.appFiles = appFiles.length;
        const files = [
          { path: DB_PATH, data: dbData },
          { path: 'config/env.json', data: Buffer.from(JSON.stringify(env, null, 2)) },
          { path: 'config/app.env', data: Buffer.from(Object.entries(env).map(([k, v]) => k + '=' + v).join('\n') + '\n') },
          { path: 'RESTORE.txt', data: Buffer.from(restoreInstructions(manifest)) },
          { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
          ...appFiles,
        ];
        const data = await format.encrypt(format.packBundle(manifest, files), password);
        const day = manifest.createdAt.slice(0, 16).replace('T', '-').replace(':', '');
        return { filename: 'scrum-desk-full-backup-' + day + '.dsbackup', data };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  }

  function countFail() {
    const now = Date.now();
    fails = fails.filter((t) => now - t < PASSWORD_WINDOW_MS);
    fails.push(now);
  }

  /** Decrypts and verifies an uploaded backup and describes what restoring it would change. */
  function inspect({ file, password }) {
    return exclusive(async () => {
      const now = Date.now();
      if (fails.filter((t) => now - t < PASSWORD_WINDOW_MS).length >= PASSWORD_FAILS_MAX) {
        throw httpError(429, 'Too many wrong backup passwords. Wait a few minutes and try again.');
      }
      dropStaged();
      let bundle;
      try { bundle = await format.decrypt(file, password); }
      catch (e) { if (e.code === 'password') countFail(); throw e; }
      const m = bundle.manifest;
      if (!format.isAppBackup(m)) throw httpError(400, 'This backup was not made by Scrum Desk.');
      const dbData = format.bundleDatabase(bundle);
      if (!dbData) throw httpError(400, 'This backup does not contain a database.');
      if (m.database && m.database.sha256 && m.database.sha256 !== format.sha256(dbData)) {
        throw httpError(400, 'The database in the backup failed its checksum. The backup is damaged.');
      }
      const id = crypto.randomBytes(16).toString('hex');
      const tmp = path.join(apply.workDir(dataDir), 'restore-' + id + '.db');
      fs.writeFileSync(tmp, dbData, { mode: 0o600 });
      try {
        const desc = apply.describeDatabase(tmp);
        const problems = apply.restoreProblems(desc);
        if (problems.length) throw httpError(400, problems.join(' '));
        const summary = summarize(m, desc, bundle);
        staged = { id, file: tmp, info: { backupCreatedAt: m.createdAt || null, backupCreatedBy: m.createdBy || null }, summary };
        staged.timer = setTimeout(dropStaged, STAGED_TTL_MS);
        staged.timer.unref();
        return Object.assign({ id, expiresInMinutes: STAGED_TTL_MS / 60000 }, summary);
      } catch (e) {
        if (!staged || staged.id !== id) fs.rmSync(tmp, { force: true });
        throw e;
      }
    });
  }

  function summarize(m, desc, bundle) {
    const current = apply.describeDatabase(path.join(dataDir, apply.DB_NAME));
    const names = Array.from(new Set([...Object.keys(desc.tables), ...Object.keys(current.tables)])).sort();
    const tables = names.map((name) => ({
      name,
      backup: desc.tables[name] ? desc.tables[name].rows : null,
      current: current.tables[name] ? current.tables[name].rows : null,
    }));
    const warnings = [];
    const appVersion = readAppVersion();
    if (m.appVersion && appVersion && m.appVersion !== appVersion) {
      warnings.push('The backup was made by app version ' + m.appVersion + '; this app is version ' + appVersion + '.');
    }
    const newer = Object.keys(desc.tables).filter((t) => !current.tables[t]);
    if (newer.length) warnings.push('The backup has tables this version does not use (' + newer.join(', ') + '). It may come from a newer version; that data is kept but not shown.');
    const older = Object.keys(current.tables).filter((t) => !desc.tables[t]);
    if (older.length) warnings.push('The backup has no ' + older.join(', ') + ' table' + (older.length > 1 ? 's' : '') + ' (an older version). They start empty and are set up on restart.');
    const missingCols = Object.keys(desc.tables).filter((t) => current.tables[t] &&
      current.tables[t].columns.some((c) => !desc.tables[t].columns.includes(c)));
    if (missingCols.length) warnings.push('Some tables in the backup lack newer columns (' + missingCols.join(', ') + '); they are added on restart.');
    const currentUsers = new Set(current.users.map((u) => u.username));
    const backupUsers = desc.users.map((u) => u.username);
    const lost = [...currentUsers].filter((u) => !backupUsers.includes(u));
    if (lost.length) warnings.push('These current accounts are not in the backup and will be removed: ' + lost.join(', ') + '.');
    const envKeys = Array.isArray(m.envKeys) ? m.envKeys.filter((k) => typeof k === 'string') : [];
    if (envKeys.length) warnings.push('Configuration values (' + envKeys.join(', ') + ') are in the backup but are not changed by this restore; apply them in docker-compose.yml if needed.');
    return {
      createdAt: m.createdAt || null,
      createdBy: m.createdBy || null,
      appVersion: m.appVersion || null,
      gitCommit: m.gitCommit || null,
      currentVersion: appVersion,
      format: m.format,
      included: Array.isArray(m.included) ? m.included : [],
      envKeys,
      appFiles: [...bundle.files.keys()].filter((p) => p.startsWith('app/')).length,
      accounts: desc.users.map((u) => ({ username: u.username, role: u.role })),
      tables,
      warnings,
      replaces: [
        'The whole current database: accounts and passwords, settings, JIRA credentials, notes, team data and report history.',
        'Everyone is signed out and signs in again with the accounts from the backup.',
      ],
      keeps: [
        'A copy of the current database, saved in data/backups/ before it is replaced.',
        'The application files, Docker setup and environment values (restore those separately — see RESTORE.txt in the backup).',
      ],
    };
  }

  /** Queues the inspected database for the next start. The caller restarts the process. */
  function restore({ id }) {
    if (busy) throw httpError(429, 'Another backup task is running. Try again in a moment.');
    if (!staged || staged.id !== id || !fs.existsSync(staged.file)) {
      throw httpError(409, 'The checked backup is no longer available. Check the backup file again.');
    }
    const { file, info, timer } = staged;
    clearTimeout(timer);
    staged = null;
    try {
      apply.prepareForRestore(file);
      const check = apply.restoreProblems(apply.describeDatabase(file));
      if (check.length) throw httpError(400, check.join(' '));
      apply.stageRestore(dataDir, file, info);
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    return { queued: true, backupCreatedAt: info.backupCreatedAt };
  }

  function cancel() { dropStaged(); return { cancelled: true }; }

  function status() {
    return { lastRestore: apply.lastRestoreResult(dataDir), pending: apply.hasPendingRestore(dataDir), managed: isManaged() };
  }

  return { create, inspect, restore, cancel, status };
}

/** True when something restarts the app after it exits (Docker with a restart policy, or RESTART_MANAGED=1). */
function isManaged() {
  return process.env.RESTART_MANAGED === '1' || fs.existsSync('/.dockerenv');
}

module.exports = { createBackupService, isManaged, collectAppFiles, ENV_KEYS };
