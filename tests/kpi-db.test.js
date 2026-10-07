/*
 * Stored KPI data in lib/db.js, against a temporary database. Run: npm test
 */
'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-scrum-kpidb-'));
process.env.DATA_DIR = dataDir;
const db = require('../lib/db.js');

after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => db.clearKpi());

const sprint = (id, month, state, extra = {}) => Object.assign({
  id, name: 'S' + id, state, boardId: 5, month,
  start: month + '-01T02:00:00.000Z', end: month + '-14T10:00:00.000Z',
  closedAt: state === 'closed' ? month + '-14T10:00:00.000Z' : null,
}, extra);

const task = (key, outcome, extra = {}) => Object.assign({
  key, summary: 'Task ' + key, type: 'Story', points: 3, outcome, at: null,
  accountId: 'u1', name: 'User One', email: 'u1@example.com', reason: 'because',
}, extra);

const timeline = (key, updated) => ({ key, updated, summary: key, status: [], assignees: [], sprints: [], initialSprints: [] });

const result = (tasks, extra = {}) => Object.assign({
  state: 'closed', rulesSignature: 'sig', computedAt: '2026-09-20T00:00:00.000Z', tasks, timelines: [], lastError: null,
}, extra);

const patch = (creds) => db.savePatch({ baseVersion: db.getStateVersion(), patch: {}, creds });

test('upserting board sprints twice keeps one row each and updates JIRA state', () => {
  db.upsertKpiSprints([sprint(101, '2026-09', 'active')]);
  db.upsertKpiSprints([sprint(101, '2026-09', 'closed'), sprint(102, '2026-09', 'active')]);
  const rows = db.listKpiSprints();
  assert.deepEqual(rows.map((s) => [s.id, s.state]), [[101, 'closed'], [102, 'active']]);
  assert.equal(rows[0].computedAt, null);
  assert.equal(rows[0].closedAt, '2026-09-14T10:00:00.000Z');
});

test('upserting sprint metadata keeps the computed result', () => {
  db.upsertKpiSprints([sprint(101, '2026-09', 'active')]);
  db.saveKpiSprintResult(101, result([task('A-1', 'open')], { state: 'active' }));
  db.upsertKpiSprints([sprint(101, '2026-09', 'closed')]);
  const s = db.listKpiSprints()[0];
  assert.equal(s.state, 'closed');
  assert.equal(s.computedState, 'active');
  assert.equal(s.computedAt, '2026-09-20T00:00:00.000Z');
  assert.equal(db.getKpiTasks([101]).length, 1);
});

test("saving a sprint again replaces its tasks instead of appending", () => {
  db.upsertKpiSprints([sprint(101, '2026-09', 'active')]);
  db.saveKpiSprintResult(101, result([task('A-1', 'open'), task('A-2', 'open')], { state: 'active' }));
  db.saveKpiSprintResult(101, result([task('A-1', 'done', { at: '2026-09-05T03:00:00.000Z' })]));
  const tasks = db.getKpiTasks([101]);
  assert.deepEqual(tasks.map((t) => [t.key, t.outcome, t.doneAt]), [['A-1', 'done', '2026-09-05T03:00:00.000Z']]);
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['accountId', 'assigneeEmail', 'assigneeName', 'doneAt', 'key',
    'outcome', 'points', 'reason', 'sprintId', 'summary', 'type']);
  assert.deepEqual(db.getKpiTaskKeys(101), ['A-1']);
});

test('a sprint result stores issue timelines and clears the previous error', () => {
  db.upsertKpiSprints([sprint(101, '2026-09', 'closed')]);
  db.setKpiSprintError(101, 'JIRA timed out');
  assert.equal(db.listKpiSprints()[0].lastError, 'JIRA timed out');
  db.saveKpiSprintResult(101, result([task('A-1', 'done')], { timelines: [timeline('A-1', '2026-09-05T03:00:00.000Z')] }));
  assert.equal(db.listKpiSprints()[0].lastError, null);
  assert.equal(db.getIssueTimeline('A-1').updated, '2026-09-05T03:00:00.000Z');
  assert.equal(db.getIssueTimeline('NOPE-1'), null);
  db.saveKpiSprintResult(101, result([task('A-1', 'done')], { timelines: [timeline('A-1', '2026-09-06T03:00:00.000Z')] }));
  assert.equal(db.getIssueTimeline('A-1').updated, '2026-09-06T03:00:00.000Z');
});

test('staleKpiSprints lists computed sprints from other or missing rules', () => {
  db.upsertKpiSprints([sprint(101, '2026-09', 'closed'), sprint(102, '2026-09', 'closed'),
    sprint(103, '2026-09', 'active'), sprint(104, '2026-09', 'closed')]);
  db.saveKpiSprintResult(101, result([], { rulesSignature: 'old' }));
  db.saveKpiSprintResult(102, result([], { rulesSignature: 'now' }));
  db.saveKpiSprintResult(104, result([])); // no signature: computed before rules were stored
  assert.deepEqual(db.staleKpiSprints('now').map((s) => s.id).sort(), [101, 104]);
  assert.equal(db.listKpiSprints().find((s) => s.id === 102).rulesSignature, 'now');
});

test('months: computed months for the picker; refresh covers current + non-closed', () => {
  db.upsertKpiSprints([sprint(90, '2026-07', 'closed'), sprint(100, '2026-08', 'closed'), sprint(101, '2026-09', 'active')]);
  db.saveKpiSprintResult(90, result([]));
  db.saveKpiSprintResult(100, result([], { state: 'active' })); // cached while active, closed since
  assert.deepEqual(db.kpiMonths(), ['2026-07', '2026-08']);
  assert.deepEqual(db.kpiMonthsToRefresh('2026-09'), ['2026-08', '2026-09']);
});

test('kpi_meta stores JSON values', () => {
  db.setKpiMeta('status_categories', { 1: 'new', 10002: 'done' });
  assert.deepEqual(db.getKpiMeta('status_categories'), { 1: 'new', 10002: 'done' });
  assert.equal(db.getKpiMeta('missing'), null);
});

test('clearKpi empties all KPI tables', () => {
  db.upsertKpiSprints([sprint(101, '2026-09', 'closed')]);
  db.saveKpiSprintResult(101, result([task('A-1', 'done')], { timelines: [timeline('A-1', 'x')] }));
  db.setKpiMeta('status_categories', {});
  db.clearKpi();
  assert.deepEqual(db.listKpiSprints(), []);
  assert.deepEqual(db.getKpiTasks([101]), []);
  assert.equal(db.getIssueTimeline('A-1'), null);
  assert.equal(db.getKpiMeta('status_categories'), null);
});

test('KPI settings are saved with the credentials and shown to admins', () => {
  patch({ site: 'team', kpiBoardId: '5', kpiPointsField: 'customfield_10032' });
  assert.deepEqual(db.getKpiSettings(), { boardId: '5', pointsField: 'customfield_10032', sprintField: '', jql: '' });
  const pub = db.getPublicCreds();
  assert.equal(pub.kpiBoardId, '5');
  assert.equal(pub.kpiPointsField, 'customfield_10032');
});

test('changing the points field, board or site clears the KPI cache; the same values do not', () => {
  const seed = () => { db.upsertKpiSprints([sprint(101, '2026-09', 'closed')]); db.saveKpiSprintResult(101, result([task('A-1', 'done')])); };
  patch({ site: 'team', kpiBoardId: '5', kpiPointsField: 'customfield_10032' });
  seed();
  patch({ site: 'team', kpiBoardId: '5', kpiPointsField: 'customfield_10032' });
  assert.equal(db.getKpiTasks([101]).length, 1, 'unchanged settings keep the cache');
  patch({ email: 'someone@example.com' });
  assert.equal(db.getKpiTasks([101]).length, 1, 'other credential changes keep the cache');
  for (const change of [{ kpiPointsField: 'customfield_10016' }, { kpiBoardId: '7' }, { site: 'other' }]) {
    seed();
    patch(change);
    assert.equal(db.getKpiTasks([101]).length, 0, 'cleared by ' + JSON.stringify(change));
  }
});

test('auto-detected KPI settings are stored without clearing the cache', () => {
  patch({ kpiBoardId: '', kpiPointsField: '' });
  db.upsertKpiSprints([sprint(101, '2026-09', 'closed')]);
  db.saveKpiSprintResult(101, result([task('A-1', 'done')]));
  db.setKpiSetting('boardId', 5);
  db.setKpiSetting('pointsField', 'customfield_10032');
  assert.deepEqual(db.getKpiSettings().boardId, '5');
  assert.equal(db.getKpiTasks([101]).length, 1);
});

test('invalid KPI settings are rejected with 400', () => {
  for (const bad of [{ kpiBoardId: 'abc' }, { kpiBoardId: '-1' }, { kpiPointsField: 'x y' }, { kpiPointsField: 'a'.repeat(65) }]) {
    assert.throws(() => patch(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});
