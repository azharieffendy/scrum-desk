/*
 * Database side of the full backup: checking a database file, staging a
 * restore, and applying it when the app starts — before lib/db.js opens the
 * database, so nothing is holding it. No HTTP; shared with scripts/restore-backup.js.
 *
 * Files in DATA_DIR:
 *   scrum-desk.db                the live database (daily-scrum.db before the rename; moved on start)
 *   restore-pending.db/.json     a checked restore waiting for the next start (.json is written last and is the trigger)
 *   restore-result.json          what the last start did with a pending restore
 *   backups/before-restore-*.db  the safety copy taken before a restore replaces the database
 *   .backup-work/                temporary files while a backup is made or checked (emptied at start)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_NAME = 'scrum-desk.db';
const LEGACY_DB_NAME = 'daily-scrum.db';
const PENDING_DB = 'restore-pending.db';
const PENDING_INFO = 'restore-pending.json';
const RESULT = 'restore-result.json';
const WORK_DIR = '.backup-work';
const SAFETY_DIR = 'backups';
const REQUIRED_TABLES = ['users', 'settings', 'members', 'days'];

const loadSqlite = () => require('better-sqlite3');

const fileSha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

const rmQuiet = (file) => { try { fs.rmSync(file, { force: true, recursive: true }); } catch (_) { /* already gone */ } };

/** The work folder for temporary backup files, created on demand. */
function workDir(dataDir) {
  const dir = path.join(dataDir, WORK_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Empties the work folder (left-overs of a backup or check interrupted by a restart). */
function cleanWorkDir(dataDir) {
  rmQuiet(path.join(dataDir, WORK_DIR));
}

/**
 * Opens a database file read-only and describes it: integrity, every table with
 * its columns and row count, and the accounts (usernames and roles, never hashes).
 */
function describeDatabase(file) {
  const Database = loadSqlite();
  let conn;
  try {
    conn = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = conn.pragma('integrity_check', { simple: true });
    const tables = {};
    for (const { name } of conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const q = '"' + name.replace(/"/g, '""') + '"';
      tables[name] = {
        rows: conn.prepare('SELECT COUNT(*) AS c FROM ' + q).get().c,
        columns: conn.pragma('table_info(' + q + ')').map((c) => c.name),
      };
    }
    const users = tables.users && tables.users.columns.includes('username')
      ? conn.prepare('SELECT username, ' + (tables.users.columns.includes('role') ? "COALESCE(role, 'admin')" : "'admin'") + ' AS role FROM users ORDER BY id').all()
      : [];
    return { ok: integrity === 'ok', integrity, tables, users };
  } catch (e) {
    return { ok: false, integrity: 'unreadable: ' + e.message, tables: {}, users: [] };
  } finally {
    if (conn) conn.close();
  }
}

/** Why a described database cannot be restored, or [] when it can. */
function restoreProblems(desc) {
  const problems = [];
  if (!desc.ok) problems.push('The database in the backup failed its integrity check (' + desc.integrity + ').');
  const missing = REQUIRED_TABLES.filter((t) => !desc.tables[t]);
  if (missing.length) problems.push('The database in the backup is missing tables: ' + missing.join(', ') + '.');
  if (desc.ok && !missing.length && !desc.users.some((u) => u.role === 'admin')) {
    problems.push('The backup has no admin account, so nobody could manage the app after restoring it.');
  }
  return problems;
}

/**
 * Readies a checked copy for restoring: signs everyone out (sessions from the
 * backup's time must not come back to life) and uses a plain rollback journal.
 */
function prepareForRestore(file) {
  const Database = loadSqlite();
  const conn = new Database(file, { fileMustExist: true });
  try {
    conn.pragma('journal_mode = DELETE');
    if (conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) conn.prepare('DELETE FROM sessions').run();
  } finally {
    conn.close();
  }
}

/** Queues a prepared database file to replace the live one at the next start. Moves the file. */
function stageRestore(dataDir, file, info) {
  const pendingDb = path.join(dataDir, PENDING_DB);
  rmQuiet(path.join(dataDir, PENDING_INFO)); // an older queued restore is replaced, never mixed
  fs.renameSync(file, pendingDb);
  writeJsonAtomic(path.join(dataDir, PENDING_INFO), Object.assign({}, info, { sha256: fileSha256(pendingDb), stagedAt: new Date().toISOString() }));
}

/** True when a restore is queued for the next start. */
const hasPendingRestore = (dataDir) => fs.existsSync(path.join(dataDir, PENDING_INFO)) && fs.existsSync(path.join(dataDir, PENDING_DB));

const JOURNALS = ['-wal', '-shm', '-journal'];

/** A copy of the current database could not be saved; the restore waits rather than lose it. */
class SafetyCopyError extends Error {}

/**
 * Saves the live database before it is replaced: a consistent, checked copy
 * (VACUUM INTO also folds in any WAL content) — or, when the database is too
 * damaged for that, which is a common reason to restore, a byte-for-byte copy
 * of the file and its journals. Returns { file, raw }.
 */
function safetyCopy(dataDir, live) {
  const dest = path.join(dataDir, SAFETY_DIR, 'before-restore-' + stamp() + '.db');
  const raw = dest + '.raw';
  const files = (base) => ['', ...JOURNALS].map((ext) => base + ext);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // copied as-is first: opening a damaged database can make SQLite drop its journal files
    for (const ext of ['', ...JOURNALS]) if (fs.existsSync(live + ext)) fs.copyFileSync(live + ext, raw + ext);
  } catch (e) {
    files(raw).forEach(rmQuiet);
    throw new SafetyCopyError('a copy of the current database could not be saved (' + e.message + ')');
  }
  try {
    const Database = loadSqlite();
    const conn = new Database(live, { fileMustExist: true });
    try { conn.prepare('VACUUM INTO ?').run(dest); } finally { conn.close(); }
    if (!describeDatabase(dest).ok) throw new Error('the clean copy failed its check');
    files(raw).forEach(rmQuiet);
    return { file: dest, raw: false };
  } catch (_) {
    files(dest).forEach(rmQuiet);
    for (const ext of ['', ...JOURNALS]) if (fs.existsSync(raw + ext)) fs.renameSync(raw + ext, dest + ext);
    return { file: dest, raw: true };
  }
}

/**
 * Applies a queued restore. Runs at start-up before the database is opened.
 * Order keeps the data safe at every step: check the queued file, copy and check
 * the current database, and only then swap the files. Any failure leaves the
 * current database in place and is reported in restore-result.json.
 */
function applyPendingRestore(dataDir, log = () => {}) {
  const pendingDb = path.join(dataDir, PENDING_DB);
  const pendingInfo = path.join(dataDir, PENDING_INFO);
  if (!fs.existsSync(pendingInfo)) {
    rmQuiet(pendingDb); // a half-queued restore (no trigger file) never applies
    return null;
  }
  const info = readJsonFile(pendingInfo) || {};
  const live = path.join(dataDir, DB_NAME);
  const result = { at: new Date().toISOString(), backupCreatedAt: info.backupCreatedAt || null, backupCreatedBy: info.backupCreatedBy || null };
  try {
    if (!fs.existsSync(pendingDb) && fs.existsSync(live) && fileSha256(live) === info.sha256) {
      // stopped right after the swap last time: the restore is already in place
      result.ok = true;
      rmQuiet(pendingInfo);
      writeJsonAtomic(path.join(dataDir, RESULT), result);
      return result;
    }
    if (!fs.existsSync(pendingDb)) throw new Error('the queued database file is missing');
    if (fileSha256(pendingDb) !== info.sha256) throw new Error('the queued database changed after it was checked');
    const problems = restoreProblems(describeDatabase(pendingDb));
    if (problems.length) throw new Error(problems.join(' '));
    if (fs.existsSync(live)) {
      const copy = safetyCopy(dataDir, live);
      result.safetyCopy = path.join(SAFETY_DIR, path.basename(copy.file));
      if (copy.raw) result.safetyCopyRaw = true;
    }
    // the old database's journal files belong to it, not to the restored one
    for (const ext of JOURNALS) rmQuiet(live + ext);
    fs.renameSync(pendingDb, live);
    result.ok = true;
    log('[backup] Restored the database from the backup of ' + (info.backupCreatedAt || 'an unknown date') +
      (result.safetyCopy ? '; the previous database is saved as ' + result.safetyCopy +
        (result.safetyCopyRaw ? ' (it could not be read cleanly, so it was copied as-is)' : '') : '') + '.');
  } catch (e) {
    result.ok = false;
    if (e instanceof SafetyCopyError) {
      // nothing is wrong with the checked restore: keep it queued (disk full, permissions…)
      result.queued = true;
      result.error = e.message + '. The restore stays queued and is tried again at the next start.';
      log('[backup] The queued restore was NOT applied yet; the current database is unchanged. Reason: ' + result.error);
      writeJsonAtomic(path.join(dataDir, RESULT), result);
      return result;
    }
    result.error = e.message;
    if (fs.existsSync(pendingDb)) {
      const kept = path.join(dataDir, 'restore-failed-' + stamp() + '.db');
      try { fs.renameSync(pendingDb, kept); result.keptAs = path.basename(kept); } catch (_) { rmQuiet(pendingDb); }
    }
    log('[backup] The queued restore was NOT applied; the current database is unchanged. Reason: ' + e.message);
  }
  rmQuiet(pendingInfo);
  writeJsonAtomic(path.join(dataDir, RESULT), result);
  return result;
}

/** What the last start did with a queued restore, or null. */
const lastRestoreResult = (dataDir) => readJsonFile(path.join(dataDir, RESULT));

/**
 * Moves a database saved under the name used before the rename to Scrum Desk.
 * The -wal/-shm files move first, so an interrupted move is finished on the next start
 * without losing recent writes. Leaves both alone when a new-name database already exists.
 */
function migrateLegacyDbName(dataDir, log = () => {}) {
  const legacy = path.join(dataDir, LEGACY_DB_NAME);
  const live = path.join(dataDir, DB_NAME);
  if (!fs.existsSync(legacy)) return false;
  if (fs.existsSync(live)) {
    log('Both ' + DB_NAME + ' and the old ' + LEGACY_DB_NAME + ' are in ' + dataDir + '; using ' + DB_NAME + '.');
    return false;
  }
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(legacy + suffix)) fs.renameSync(legacy + suffix, live + suffix);
  }
  fs.renameSync(legacy, live);
  log('Renamed the database ' + LEGACY_DB_NAME + ' to ' + DB_NAME + '.');
  return true;
}

module.exports = {
  DB_NAME, LEGACY_DB_NAME, migrateLegacyDbName, PENDING_DB, PENDING_INFO, RESULT, WORK_DIR, SAFETY_DIR,
  workDir, cleanWorkDir, describeDatabase, restoreProblems, prepareForRestore, stageRestore,
  hasPendingRestore, applyPendingRestore, lastRestoreResult, fileSha256,
};
