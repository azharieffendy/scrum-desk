/*
 * KPI tables (sprint results, per-task outcomes, cached issue timelines).
 * Created by lib/db.js with its open database.
 */
'use strict';

const { httpError } = require('./http-utils.js');

const BOARD_ID = /^\d{1,12}$/;
const FIELD_ID = /^[\w.-]{1,64}$/;
const SETTING_KEYS = { boardId: 'kpi_board_id', pointsField: 'kpi_points_field', sprintField: 'kpi_sprint_field' };

function createKpiDb(db, { getSetting, setSetting }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kpi_sprints (
      sprint_id INTEGER PRIMARY KEY, board_id INTEGER, name TEXT DEFAULT '', month TEXT,
      state TEXT DEFAULT '', start_at TEXT, end_at TEXT, closed_at TEXT,
      computed_at TEXT, computed_state TEXT, rules_signature TEXT, last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS kpi_sprints_month ON kpi_sprints (month);
    CREATE TABLE IF NOT EXISTS kpi_tasks (
      sprint_id INTEGER NOT NULL, issue_key TEXT NOT NULL, summary TEXT DEFAULT '', type TEXT DEFAULT '',
      account_id TEXT, assignee_name TEXT, assignee_email TEXT, outcome TEXT NOT NULL,
      done_at TEXT, points REAL DEFAULT 0, reason TEXT DEFAULT '',
      PRIMARY KEY (sprint_id, issue_key)
    );
    CREATE TABLE IF NOT EXISTS kpi_issue_history (
      issue_key TEXT PRIMARY KEY, updated TEXT, fetched_at TEXT, timeline_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kpi_meta (
      key TEXT PRIMARY KEY, value TEXT
    );
  `);

  /* migration: rules_version (code rules only) → rules_signature (code + configured rules, kpi-core fingerprint).
   * No backfill: a NULL signature is stale, so every cached sprint is recomputed once, locally. */
  const columns = () => db.pragma('table_info(kpi_sprints)').map((c) => c.name);
  if (columns().includes('rules_version')) {
    db.transaction(() => {
      if (!columns().includes('rules_signature')) db.prepare('ALTER TABLE kpi_sprints ADD COLUMN rules_signature TEXT').run();
      db.prepare('ALTER TABLE kpi_sprints DROP COLUMN rules_version').run();
    })();
  }

  const sprintRow = (r) => ({
    id: r.sprint_id, name: r.name, state: r.state, boardId: r.board_id,
    start: r.start_at, end: r.end_at, closedAt: r.closed_at, month: r.month,
    computedAt: r.computed_at, computedState: r.computed_state, rulesSignature: r.rules_signature, lastError: r.last_error,
  });

  const taskRow = (r) => ({
    sprintId: r.sprint_id, key: r.issue_key, summary: r.summary, type: r.type,
    accountId: r.account_id, assigneeName: r.assignee_name, assigneeEmail: r.assignee_email,
    outcome: r.outcome, doneAt: r.done_at, points: r.points, reason: r.reason,
  });

  /** Board sprint list from JIRA: updates metadata, never the computed result. */
  function upsertKpiSprints(list) {
    const put = db.prepare(`INSERT INTO kpi_sprints (sprint_id, board_id, name, month, state, start_at, end_at, closed_at)
      VALUES (@id, @boardId, @name, @month, @state, @start, @end, @closedAt)
      ON CONFLICT(sprint_id) DO UPDATE SET board_id = excluded.board_id, name = excluded.name, month = excluded.month,
        state = excluded.state, start_at = excluded.start_at, end_at = excluded.end_at, closed_at = excluded.closed_at`);
    db.transaction(() => {
      for (const s of list) {
        put.run({ id: s.id, boardId: s.boardId == null ? null : s.boardId, name: s.name || '', month: s.month || null,
          state: s.state || '', start: s.start || null, end: s.end || null, closedAt: s.closedAt || null });
      }
    })();
  }

  function listKpiSprints() {
    return db.prepare('SELECT * FROM kpi_sprints ORDER BY start_at, sprint_id').all().map(sprintRow);
  }

  /** Stores one sprint's outcome in one transaction: timelines, its tasks (replaced), the sprint row. */
  function saveKpiSprintResult(id, res) {
    const putTimeline = db.prepare(`INSERT INTO kpi_issue_history (issue_key, updated, fetched_at, timeline_json)
      VALUES (?,?,?,?) ON CONFLICT(issue_key) DO UPDATE SET updated = excluded.updated,
        fetched_at = excluded.fetched_at, timeline_json = excluded.timeline_json`);
    const putTask = db.prepare(`INSERT INTO kpi_tasks (sprint_id, issue_key, summary, type, account_id, assignee_name,
      assignee_email, outcome, done_at, points, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (const tl of res.timelines || []) putTimeline.run(tl.key, tl.updated || null, res.computedAt, JSON.stringify(tl));
      db.prepare('DELETE FROM kpi_tasks WHERE sprint_id = ?').run(id);
      for (const t of res.tasks || []) {
        putTask.run(id, t.key, t.summary || '', t.type || '', t.accountId || null, t.name || null, t.email || null,
          t.outcome, t.at || null, Number(t.points) || 0, t.reason || '');
      }
      db.prepare(`UPDATE kpi_sprints SET computed_at = ?, computed_state = ?, rules_signature = ?, last_error = ?
        WHERE sprint_id = ?`).run(res.computedAt, res.state || null, res.rulesSignature || null, res.lastError || null, id);
    })();
  }

  function setKpiSprintError(id, message) {
    db.prepare('UPDATE kpi_sprints SET last_error = ? WHERE sprint_id = ?').run(String(message || 'Unknown error'), id);
  }

  function getIssueTimeline(key) {
    const r = db.prepare('SELECT timeline_json FROM kpi_issue_history WHERE issue_key = ?').get(key);
    return r ? JSON.parse(r.timeline_json) : null;
  }

  function getKpiTaskKeys(id) {
    return db.prepare('SELECT issue_key FROM kpi_tasks WHERE sprint_id = ? ORDER BY issue_key').all(id).map((r) => r.issue_key);
  }

  function getKpiTasks(ids) {
    const q = db.prepare('SELECT * FROM kpi_tasks WHERE sprint_id = ? ORDER BY issue_key');
    return ids.flatMap((id) => q.all(id).map(taskRow));
  }

  /** Months with at least one computed sprint, oldest first. */
  function kpiMonths() {
    return db.prepare('SELECT DISTINCT month FROM kpi_sprints WHERE computed_at IS NOT NULL AND month IS NOT NULL ORDER BY month')
      .all().map((r) => r.month);
  }

  /** The current month plus months holding a sprint computed before it closed. */
  function kpiMonthsToRefresh(current) {
    const rows = db.prepare(`SELECT DISTINCT month FROM kpi_sprints
      WHERE computed_at IS NOT NULL AND month IS NOT NULL AND IFNULL(computed_state, '') <> 'closed'`).all();
    return [...new Set([current, ...rows.map((r) => r.month)])].sort();
  }

  /** Computed sprints whose stored rules signature is missing or differs from the current one. */
  function staleKpiSprints(signature) {
    return db.prepare(`SELECT * FROM kpi_sprints WHERE computed_at IS NOT NULL
      AND (rules_signature IS NULL OR rules_signature <> ?)`).all(String(signature)).map(sprintRow);
  }

  function getKpiMeta(key) {
    const r = db.prepare('SELECT value FROM kpi_meta WHERE key = ?').get(key);
    return r ? JSON.parse(r.value) : null;
  }

  function setKpiMeta(key, value) {
    db.prepare('INSERT INTO kpi_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  function clearKpi() {
    db.transaction(() => {
      for (const t of ['kpi_tasks', 'kpi_sprints', 'kpi_issue_history', 'kpi_meta']) db.prepare('DELETE FROM ' + t).run();
    })();
  }

  function getKpiSettings() {
    return { boardId: getSetting(SETTING_KEYS.boardId), pointsField: getSetting(SETTING_KEYS.pointsField),
      sprintField: getSetting(SETTING_KEYS.sprintField), jql: getSetting('jql') };
  }

  /** Stores an auto-detected value; unlike an admin edit it keeps the cache. */
  function setKpiSetting(name, value) {
    if (!SETTING_KEYS[name]) throw new Error('Unknown KPI setting: ' + name);
    setSetting(SETTING_KEYS[name], value == null ? '' : String(value));
  }

  /**
   * Applies an admin's credential save (must run inside its transaction).
   * Validates the KPI settings and clears the cache when the site, board or
   * points field changes, since stored results no longer match.
   */
  function applyCredentialChange(creds, saveOthers) {
    const board = creds.kpiBoardId === undefined ? undefined : String(creds.kpiBoardId || '').trim();
    const field = creds.kpiPointsField === undefined ? undefined : String(creds.kpiPointsField || '').trim();
    if (board && !BOARD_ID.test(board)) throw httpError(400, 'KPI board ID must be a number.');
    if (field && !FIELD_ID.test(field)) throw httpError(400, 'Invalid story points field ID.');
    const before = [getSetting('cred_site'), getSetting(SETTING_KEYS.boardId), getSetting(SETTING_KEYS.pointsField)];
    saveOthers();
    if (board !== undefined) setSetting(SETTING_KEYS.boardId, board);
    if (field !== undefined) setSetting(SETTING_KEYS.pointsField, field);
    const after = [getSetting('cred_site'), getSetting(SETTING_KEYS.boardId), getSetting(SETTING_KEYS.pointsField)];
    if (before.some((v, i) => v !== after[i])) {
      clearKpi();
      setSetting(SETTING_KEYS.sprintField, ''); // another site may name its Sprint field differently
    }
  }

  return {
    upsertKpiSprints, listKpiSprints, saveKpiSprintResult, setKpiSprintError, getIssueTimeline,
    getKpiTaskKeys, getKpiTasks, kpiMonths, kpiMonthsToRefresh, staleKpiSprints,
    getKpiMeta, setKpiMeta, clearKpi, getKpiSettings, setKpiSetting, applyCredentialChange,
  };
}

module.exports = { createKpiDb };
