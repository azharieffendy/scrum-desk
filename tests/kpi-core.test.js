/*
 * Unit tests for the KPI counting rules (lib/kpi-core.js). Run: npm test
 * Issues are built in the raw JIRA Agile shape (fields + changelog) and go
 * through toTimeline(), exactly like the real refresh does.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kpi = require('../lib/kpi-core.js');

const TZ = 'Asia/Jakarta';
const POINTS = 'customfield_10016';

// status name → [id, category]. 'UNTESTED' is a second status with the same name in another case.
const STATUS = {
  'To Do': ['1', 'new'],
  'In Progress': ['3', 'indeterminate'],
  'Untested': ['10001', 'indeterminate'],
  'UNTESTED': ['10004', 'indeterminate'],
  'In Testing': ['10002', 'indeterminate'],
  'Done': ['10003', 'done'],
  'Resolved': ['10005', 'done'],
};
const CATEGORIES = Object.fromEntries(Object.values(STATUS));
const USERS = {
  u1: { accountId: 'u1', displayName: 'Andi', emailAddress: 'andi@example.com' },
  u2: { accountId: 'u2', displayName: 'Sari', emailAddress: 'sari@example.com' },
};

// Sprints in the raw Agile shape. Times are Jakarta (+07:00).
const RAW_SPRINTS = [
  { id: 101, name: 'S1', state: 'closed', originBoardId: 7,
    startDate: '2026-09-01T09:00:00.000+07:00', endDate: '2026-09-14T17:00:00.000+07:00', completeDate: '2026-09-14T17:00:00.000+07:00' },
  { id: 102, name: 'S2', state: 'closed', originBoardId: 7,
    startDate: '2026-09-15T09:00:00.000+07:00', endDate: '2026-09-28T17:00:00.000+07:00', completeDate: '2026-09-28T17:00:00.000+07:00' },
  { id: 103, name: 'S3', state: 'active', originBoardId: 7,
    startDate: '2026-09-29T09:00:00.000+07:00', endDate: '2026-10-12T17:00:00.000+07:00' },
];
const SPRINTS = RAW_SPRINTS.map(kpi.normalizeSprint);
const [S1, S2, S3] = SPRINTS;
const ctx = { sprints: SPRINTS, categories: CATEGORIES, tz: TZ,
  rules: kpi.normalizeRules({ doneStatuses: ['Untested'], doneCategory: true }) };

/**
 * Builds a raw JIRA issue. `events` are [time, kind, value] with kind
 * 'status' (status name), 'sprint' (comma-separated sprint IDs, '' = backlog)
 * or 'assignee' (user key or null). Times without a zone are Jakarta.
 */
function raw(key, { status = 'To Do', sprints = '', assignee = 'u1', points, type = 'Task', created = '2026-08-25T09:00', events = [] } = {}) {
  const t = (s) => s + ':00.000+0700';
  const cur = { status, sprints, assignee };
  const histories = events.map(([at, kind, value], i) => {
    let item;
    if (kind === 'status') {
      item = { field: 'status', fieldtype: 'jira', from: STATUS[cur.status][0], fromString: cur.status, to: STATUS[value][0], toString: value };
      cur.status = value;
    } else if (kind === 'sprint') {
      item = { field: 'Sprint', fieldtype: 'custom', from: cur.sprints, fromString: '', to: value, toString: '' };
      cur.sprints = value;
    } else {
      item = { field: 'assignee', fieldtype: 'jira', from: cur.assignee, fromString: cur.assignee && USERS[cur.assignee].displayName,
        to: value, toString: value && USERS[value].displayName };
      cur.assignee = value;
    }
    return { id: String(i + 1), created: t(at), items: [item] };
  });
  const ids = cur.sprints ? cur.sprints.split(',').map((s) => Number(s.trim())) : [];
  const byId = Object.fromEntries(RAW_SPRINTS.map((s) => [s.id, s]));
  const fields = {
    summary: key + ' summary',
    status: { id: STATUS[cur.status][0], name: cur.status, statusCategory: { key: STATUS[cur.status][1] } },
    assignee: cur.assignee ? USERS[cur.assignee] : null,
    issuetype: { name: type },
    created: t(created),
    updated: histories.length ? histories[histories.length - 1].created : t(created),
    sprint: ids.map((id) => byId[id]).find((s) => s && s.state === 'active') || null,
    closedSprints: ids.map((id) => byId[id]).filter((s) => s && s.state === 'closed'),
  };
  if (points !== undefined) fields[POINTS] = points;
  return { key, fields, changelog: { startAt: 0, maxResults: 100, total: histories.length, histories } };
}

const tl = (issue) => kpi.toTimeline(issue, POINTS);
const classify = (issue, sprint) => kpi.classifyIssue(tl(issue), sprint, ctx);

// ---------- delivered ----------

test('To Do → Done inside the sprint counts as done', () => {
  const r = classify(raw('A-1', { sprints: '101', events: [['2026-09-05T10:00', 'status', 'Done']] }), S1);
  assert.equal(r.outcome, 'done');
  assert.equal(r.at, '2026-09-05T03:00:00.000Z');
  assert.equal(r.accountId, 'u1');
});

test('To Do → Untested counts as done', () => {
  const r = classify(raw('A-2', { sprints: '101', events: [['2026-09-05T10:00', 'status', 'Untested']] }), S1);
  assert.equal(r.outcome, 'done');
});

test('Untested in another case (UNTESTED) counts as done', () => {
  const r = classify(raw('A-3', { sprints: '101', events: [['2026-09-05T10:00', 'status', 'UNTESTED']] }), S1);
  assert.equal(r.outcome, 'done');
});

test('To Do → In Progress → Untested counts as done at the Untested moment', () => {
  const r = classify(raw('A-4', { sprints: '101', events: [
    ['2026-09-03T10:00', 'status', 'In Progress'],
    ['2026-09-06T10:00', 'status', 'Untested'],
  ] }), S1);
  assert.equal(r.outcome, 'done');
  assert.equal(r.at, '2026-09-06T03:00:00.000Z');
});

test('Untested → In Testing (not Done category) still counts as done', () => {
  const r = classify(raw('A-5', { sprints: '101', events: [
    ['2026-09-05T10:00', 'status', 'Untested'],
    ['2026-09-07T10:00', 'status', 'In Testing'],
  ] }), S1);
  assert.equal(r.outcome, 'done');
});

test('any status in the Done category counts, matched by status ID', () => {
  const r = classify(raw('A-6', { sprints: '101', events: [['2026-09-05T10:00', 'status', 'Resolved']] }), S1);
  assert.equal(r.outcome, 'done');
});

test('bounce-back: Untested then sent back inside the sprint is still done', () => {
  const r = classify(raw('A-7', { sprints: '101', events: [
    ['2026-09-05T10:00', 'status', 'Untested'],
    ['2026-09-08T10:00', 'status', 'In Progress'],
  ] }), S1);
  assert.equal(r.outcome, 'done');
});

// ---------- carry-over ----------

test('delivered after the sprint closed (not moved on) is carry-over', () => {
  const r = classify(raw('B-1', { sprints: '101', events: [['2026-09-20T10:00', 'status', 'Done']] }), S1);
  assert.equal(r.outcome, 'carryover');
});

test('carried across 3 sprints: 2 carry-overs then done', () => {
  const issue = raw('B-2', { sprints: '101', events: [
    ['2026-09-14T17:00', 'sprint', '101, 102'],
    ['2026-09-28T17:00', 'sprint', '101, 102, 103'],
    ['2026-10-01T10:00', 'status', 'Untested'],
  ] });
  assert.equal(classify(issue, S1).outcome, 'carryover');
  assert.equal(classify(issue, S2).outcome, 'carryover');
  assert.equal(classify(issue, S3).outcome, 'done');
});

test('carry-over is credited to the assignee when the sprint closed', () => {
  const r = classify(raw('B-3', { sprints: '101', events: [
    ['2026-09-10T10:00', 'assignee', 'u2'],
    ['2026-09-20T10:00', 'assignee', 'u1'],
  ] }), S1);
  assert.equal(r.outcome, 'carryover');
  assert.equal(r.accountId, 'u2');
  assert.equal(r.at, S1.closedAt);
});

// ---------- delivered between sprints ----------

test('delivered between sprints: carry-over in S1, done in S2', () => {
  const issue = raw('C-1', { sprints: '101', events: [
    ['2026-09-14T17:00', 'sprint', '101, 102'],
    ['2026-09-14T20:00', 'status', 'Untested'],
  ] });
  assert.equal(classify(issue, S1).outcome, 'carryover');
  const r = classify(issue, S2);
  assert.equal(r.outcome, 'done');
  assert.equal(r.at, '2026-09-14T13:00:00.000Z');
});

test('delivered between sprints but never put in another sprint: carry-over only', () => {
  const issue = raw('C-2', { sprints: '101', events: [['2026-09-14T20:00', 'status', 'Untested']] });
  assert.equal(kpi.creditedSprint(tl(issue), SPRINTS, CATEGORIES), null);
  assert.equal(classify(issue, S1).outcome, 'carryover');
});

// ---------- excluded ----------

test('done in the backlog before any sprint is excluded', () => {
  const issue = raw('D-1', { events: [
    ['2026-09-10T10:00', 'status', 'Done'],
    ['2026-09-16T10:00', 'sprint', '102'],
  ] });
  assert.equal(classify(issue, S2).outcome, 'excluded');
});

test('Untested in S1, testing continues in S2: done in S1, excluded in S2', () => {
  const issue = raw('D-2', { sprints: '101', events: [
    ['2026-09-10T10:00', 'status', 'Untested'],
    ['2026-09-14T17:00', 'sprint', '101, 102'],
    ['2026-09-16T10:00', 'status', 'In Testing'],
  ] });
  assert.equal(classify(issue, S1).outcome, 'done');
  assert.equal(classify(issue, S2).outcome, 'excluded');
});

test('Untested in S1, sent back, still open at S2 close: excluded in S2', () => {
  const issue = raw('D-3', { sprints: '101', events: [
    ['2026-09-10T10:00', 'status', 'Untested'],
    ['2026-09-12T10:00', 'status', 'In Progress'],
    ['2026-09-14T17:00', 'sprint', '101, 102'],
  ] });
  assert.equal(classify(issue, S1).outcome, 'done');
  assert.equal(classify(issue, S2).outcome, 'excluded');
});

// ---------- active sprint, credit, points ----------

test('active sprint, not delivered yet: open, current assignee', () => {
  const r = classify(raw('E-1', { sprints: '103', assignee: 'u2', events: [['2026-09-30T10:00', 'status', 'In Progress']] }), S3);
  assert.equal(r.outcome, 'open');
  assert.equal(r.accountId, 'u2');
});

test('reassigned after delivery: credit goes to the assignee at delivery', () => {
  const r = classify(raw('E-2', { sprints: '101', events: [
    ['2026-09-05T10:00', 'status', 'Untested'],
    ['2026-09-06T10:00', 'assignee', 'u2'],
  ] }), S1);
  assert.equal(r.accountId, 'u1');
  assert.equal(r.name, 'Andi');
});

test('unassigned task has no account', () => {
  const r = classify(raw('E-3', { sprints: '101', assignee: null }), S1);
  assert.equal(r.outcome, 'carryover');
  assert.equal(r.accountId, null);
});

test('points come from the configured field; missing points are 0', () => {
  assert.equal(classify(raw('E-4', { sprints: '101', points: 5 }), S1).points, 5);
  assert.equal(classify(raw('E-5', { sprints: '101' }), S1).points, 0);
  assert.equal(classify(raw('E-6', { sprints: '101', points: null }), S1).points, 0);
});

test('parent + 2 subtasks are 3 tasks, each with its own outcome and assignee', () => {
  const parent = raw('F-1', { sprints: '101', type: 'Story' });
  const sub1 = raw('F-2', { sprints: '101', type: 'Sub-task', events: [['2026-09-05T10:00', 'status', 'Untested']] });
  const sub2 = raw('F-3', { sprints: '101', type: 'Sub-task', assignee: 'u2', events: [['2026-09-06T10:00', 'status', 'Done']] });
  const out = [parent, sub1, sub2].map((i) => classify(i, S1));
  assert.deepEqual(out.map((r) => r.outcome), ['carryover', 'done', 'done']);
  assert.deepEqual(out.map((r) => r.accountId), ['u1', 'u1', 'u2']);
});

// ---------- timeline ----------

test('changelog order does not matter (JIRA may return newest first)', () => {
  const issue = raw('G-1', { sprints: '101', events: [
    ['2026-09-03T10:00', 'status', 'In Progress'],
    ['2026-09-06T10:00', 'status', 'Untested'],
    ['2026-09-08T10:00', 'status', 'In Progress'],
  ] });
  const reversed = JSON.parse(JSON.stringify(issue));
  reversed.changelog.histories.reverse();
  assert.deepEqual(tl(reversed), tl(issue));
  assert.equal(kpi.classifyIssue(tl(reversed), S1, ctx).at, '2026-09-06T03:00:00.000Z');
});

test('timeline survives a JSON round-trip and classifies the same', () => {
  const issue = raw('G-2', { sprints: '101', points: 3, events: [
    ['2026-09-14T17:00', 'sprint', '101, 102'],
    ['2026-09-14T20:00', 'status', 'Untested'],
  ] });
  const stored = JSON.parse(JSON.stringify(tl(issue)));
  assert.deepEqual(kpi.classifyIssue(stored, S2, ctx), classify(issue, S2));
});

test('timeline keeps key, summary, type, updated and the current assignee', () => {
  const t = tl(raw('G-3', { sprints: '101', type: 'Bug', points: 2 }));
  assert.equal(t.key, 'G-3');
  assert.equal(t.summary, 'G-3 summary');
  assert.equal(t.type, 'Bug');
  assert.equal(t.points, 2);
  assert.equal(t.updated, '2026-08-25T02:00:00.000Z');
  assert.deepEqual(t.assignee, { accountId: 'u1', name: 'Andi', email: 'andi@example.com' });
});

test('reason explains the outcome in plain words', () => {
  const issue = raw('G-4', { sprints: '101', events: [
    ['2026-09-10T10:00', 'status', 'Untested'],
    ['2026-09-14T17:00', 'sprint', '101, 102'],
  ] });
  assert.match(classify(issue, S1).reason, /Untested.*2026-09-10/);
  assert.match(classify(issue, S2).reason, /S1/);
});

// ---------- sprints, months, totals ----------

test('normalizeSprint keeps id, board and UTC times', () => {
  assert.deepEqual(S1, {
    id: 101, name: 'S1', state: 'closed', boardId: 7,
    start: '2026-09-01T02:00:00.000Z', end: '2026-09-14T10:00:00.000Z', closedAt: '2026-09-14T10:00:00.000Z',
  });
  assert.equal(S3.closedAt, null);
});

test('monthOf uses the start date in the team timezone', () => {
  assert.equal(kpi.monthOf(S3, TZ), '2026-09'); // starts 29 Sep, closes in October
  const lateStart = { start: '2026-09-30T20:00:00.000Z' }; // 1 Oct 03:00 in Jakarta
  assert.equal(kpi.monthOf(lateStart, TZ), '2026-10');
  assert.equal(kpi.monthOf(lateStart, 'UTC'), '2026-09');
});

test('summarize: excluded and open are left out of completion and SP totals', () => {
  const tasks = [
    { accountId: 'u1', name: 'Andi', outcome: 'done', points: 3 },
    { accountId: 'u1', name: 'Andi', outcome: 'done', points: 2 },
    { accountId: 'u1', name: 'Andi', outcome: 'carryover', points: 5 },
    { accountId: 'u1', name: 'Andi', outcome: 'excluded', points: 8 },
    { accountId: 'u2', name: 'Sari', outcome: 'open', points: 1 },
    { accountId: null, name: null, outcome: 'carryover', points: 0 },
  ];
  const rows = kpi.summarize(tasks);
  const andi = rows.find((r) => r.accountId === 'u1');
  assert.deepEqual(
    { done: andi.done, carryover: andi.carryover, open: andi.open, excluded: andi.excluded, spDone: andi.spDone, spCarryover: andi.spCarryover },
    { done: 2, carryover: 1, open: 0, excluded: 1, spDone: 5, spCarryover: 5 });
  assert.equal(andi.completion, 2 / 3);
  const sari = rows.find((r) => r.accountId === 'u2');
  assert.equal(sari.open, 1);
  assert.equal(sari.completion, null); // nothing delivered or carried yet
  assert.ok(rows.some((r) => r.accountId === null && r.carryover === 1));
});

test('isDoneStatus: configured status by name or Done category by ID', () => {
  assert.ok(kpi.isDoneStatus('10001', 'Untested', CATEGORIES, ctx.rules));
  assert.ok(kpi.isDoneStatus('99', 'untested', CATEGORIES, ctx.rules));
  assert.ok(!kpi.isDoneStatus('10001', 'Untested', CATEGORIES), 'generic default is Done category only');
  assert.ok(kpi.isDoneStatus('10005', 'Resolved', CATEGORIES));
  assert.ok(!kpi.isDoneStatus('10002', 'In Testing', CATEGORIES));
  assert.ok(!kpi.isDoneStatus('99', 'Done', CATEGORIES)); // unknown ID: name alone is not enough
});

// ---------- configurable rules ----------

const withRules = (input) => ({ ...ctx, rules: kpi.normalizeRules(input) });

test('custom done statuses change outcomes; the Done category can be switched off', () => {
  const testing = raw('R-1', { sprints: '101', events: [['2026-09-05T10:00', 'status', 'In Testing']] });
  const untested = raw('R-2', { sprints: '101', events: [['2026-09-05T10:00', 'status', 'Untested']] });
  const done = raw('R-3', { sprints: '101', events: [['2026-09-05T10:00', 'status', 'Done']] });
  const rules = withRules({ doneStatuses: ['in testing'], doneCategory: false });
  assert.equal(kpi.classifyIssue(tl(testing), S1, rules).outcome, 'done');
  assert.notEqual(kpi.classifyIssue(tl(untested), S1, rules).outcome, 'done');
  assert.notEqual(kpi.classifyIssue(tl(done), S1, rules).outcome, 'done');
  assert.notEqual(classify(testing, S1).outcome, 'done'); // defaults unchanged
});

test('an empty list with the Done category on counts only Done-category statuses', () => {
  const rules = withRules({ doneStatuses: [], doneCategory: true });
  const untested = raw('R-4', { sprints: '101', events: [['2026-09-05T10:00', 'status', 'Untested']] });
  const done = raw('R-5', { sprints: '101', events: [['2026-09-05T10:00', 'status', 'Done']] });
  assert.notEqual(kpi.classifyIssue(tl(untested), S1, rules).outcome, 'done');
  assert.equal(kpi.classifyIssue(tl(done), S1, rules).outcome, 'done');
});

test('normalizeRules: missing list means no custom statuses, missing category means on', () => {
  assert.deepEqual(kpi.normalizeRules({}).doneStatuses, []);
  assert.equal(kpi.normalizeRules({}).doneCategory, true);
  assert.equal(kpi.normalizeRules({ doneStatuses: [], doneCategory: false }).doneCategory, false);
});

test('carry-over reason names the configured statuses', () => {
  const issue = raw('R-6', { sprints: '101', events: [['2026-09-20T10:00', 'status', 'Untested']] });
  assert.match(classify(issue, S1).reason, /^Not Untested\/Done when /);
  const rules = withRules({ doneStatuses: ['Code Review', 'Untested'], doneCategory: false });
  assert.match(kpi.classifyIssue(tl(issue), S1, rules).reason, /^Not Code Review\/Untested when /);
});

test('fingerprint differs per config, and per spelling or order (both appear in the stored reasons)', () => {
  const fp = (doneStatuses, doneCategory = true) => kpi.fingerprint(kpi.normalizeRules({ doneStatuses, doneCategory }));
  const a = fp(['Untested', 'Code Review']);
  assert.equal(a, fp([' Untested', 'Code Review', 'untested']), 'trimming and duplicates do not matter');
  assert.notEqual(a, fp(['Untested', 'Code Review'], false));
  assert.notEqual(a, fp(['Untested']));
  assert.notEqual(a, fp(['untested', 'Code Review']), 'spelling');
  assert.notEqual(a, fp(['Code Review', 'Untested']), 'order');
  assert.equal(fp([]), kpi.fingerprint(kpi.DEFAULT_RULES));
});

// ---------- per-role rules ----------

const { memberForPerson } = require('../lib/team-scope.js');
const ROLE_MEMBERS = [
  { id: 'm1', name: 'Andi', role: 'Software Engineer', email: 'andi@example.com' },
  { id: 'm2', name: 'Sari', role: 'qa', email: 'sari@example.com' },
];
const ROLE_MAPPING = { u1: 'm1', u2: 'm2' };
const ROLE_SETTINGS = { doneStatuses: ['Untested'], doneCategory: true,
  roleRules: [{ role: 'QA', doneStatuses: [], doneCategory: true }] }; // QA: Done only; everyone else: Untested or Done
const rolePlan = (settings = ROLE_SETTINGS, members = ROLE_MEMBERS, mapping = ROLE_MAPPING) =>
  kpi.roleRulesPlan(settings, members, mapping, (who) => memberForPerson(who, members, mapping));
const roleCtx = (plan = rolePlan()) => ({ ...ctx, rules: plan.rules, rulesFor: plan.rulesFor });

test('per role: a QA task counts at Done, not at Untested; an engineer task counts at Untested', () => {
  const qa = raw('P-1', { sprints: '101', assignee: 'u2', events: [
    ['2026-09-05T10:00', 'status', 'Untested'], ['2026-09-10T10:00', 'status', 'Done']] });
  const dev = raw('P-2', { sprints: '101', assignee: 'u1', events: [['2026-09-05T10:00', 'status', 'Untested']] });
  const q = kpi.classifyIssue(tl(qa), S1, roleCtx());
  assert.equal(q.outcome, 'done');
  assert.equal(q.accountId, 'u2');
  assert.equal(q.at, '2026-09-10T03:00:00.000Z', 'the Done move, not the Untested one');
  const d = kpi.classifyIssue(tl(dev), S1, roleCtx());
  assert.equal(d.outcome, 'done');
  assert.equal(d.accountId, 'u1');
  assert.equal(d.at, '2026-09-05T03:00:00.000Z');
});

test('per role: a task still counts once, for whoever delivered it first by their own rule', () => {
  const handed = raw('P-3', { sprints: '101', assignee: 'u1', events: [
    ['2026-09-05T10:00', 'status', 'Untested'], ['2026-09-06T10:00', 'assignee', 'u2'], ['2026-09-08T10:00', 'status', 'Done']] });
  const r = kpi.classifyIssue(tl(handed), S1, roleCtx());
  assert.deepEqual([r.outcome, r.accountId, r.at], ['done', 'u1', '2026-09-05T03:00:00.000Z']);
});

test('per role: a move counts by the rules of who held the task just before it', () => {
  // QA moves it to Untested (does not count for QA), then hands it to the engineer in the same second
  const sameMoment = raw('P-4', { sprints: '101', assignee: 'u2', events: [
    ['2026-09-05T10:00', 'status', 'Untested'], ['2026-09-05T10:00', 'assignee', 'u1'], ['2026-09-07T10:00', 'status', 'Done']] });
  const r = kpi.classifyIssue(tl(sameMoment), S1, roleCtx());
  assert.deepEqual([r.outcome, r.accountId, r.at], ['done', 'u1', '2026-09-07T03:00:00.000Z']);
});

test('per role: carry-over reason names the holder\'s rule; unmatched people use the default', () => {
  const qa = raw('P-5', { sprints: '101,102', assignee: 'u2', events: [['2026-09-05T10:00', 'status', 'Untested']] });
  const r = kpi.classifyIssue(tl(qa), S1, roleCtx());
  assert.equal(r.outcome, 'carryover');
  assert.match(r.reason, /^Not Done when S1 closed/);
  const nobody = rolePlan(ROLE_SETTINGS, [], {}); // Sari is not on the team: default rules
  assert.equal(kpi.classifyIssue(tl(qa), S1, roleCtx(nobody)).outcome, 'done');
});

test('per role: with no role rules the plan is the old behaviour and the old signature', () => {
  const plan = rolePlan({ doneStatuses: ['Untested'], doneCategory: true, roleRules: [] });
  assert.equal(plan.rulesFor, null);
  assert.equal(plan.signature, kpi.fingerprint(ctx.rules));
});

test('per role: the signature changes with the rules, roles, names, emails and mapping', () => {
  const base = rolePlan().signature;
  assert.equal(rolePlan().signature, base, 'stable');
  assert.ok(base.startsWith(kpi.fingerprint(ctx.rules) + '|roles:'));
  const other = (patch) => ROLE_MEMBERS.map((m) => (m.id === 'm2' ? { ...m, ...patch } : m));
  assert.notEqual(rolePlan(ROLE_SETTINGS, other({ role: 'Software Engineer' })).signature, base, 'role');
  assert.notEqual(rolePlan(ROLE_SETTINGS, other({ name: 'Sarah' })).signature, base, 'name');
  assert.notEqual(rolePlan(ROLE_SETTINGS, other({ email: 'x@example.com' })).signature, base, 'email');
  assert.notEqual(rolePlan(ROLE_SETTINGS, ROLE_MEMBERS, { u1: 'm1' }).signature, base, 'mapping');
  assert.notEqual(rolePlan({ ...ROLE_SETTINGS, roleRules: [{ role: 'QA', doneStatuses: ['In Testing'], doneCategory: true }] }).signature, base, 'rule');
});

/* ---------------- sprintTrend (delivery trend) ---------------- */

const TREND_SPRINTS = [
  { id: 201, name: 'Old', state: 'closed', start: '2026-08-03T02:00:00.000Z', end: '2026-08-14T02:00:00.000Z',
    closedAt: '2026-08-14T02:00:00.000Z', month: '2026-08', computedAt: '2026-08-15T00:00:00.000Z' },
  { id: 202, name: 'New', state: 'closed', start: '2026-09-01T02:00:00.000Z', end: '2026-09-12T02:00:00.000Z',
    closedAt: '2026-09-12T02:00:00.000Z', month: '2026-09', computedAt: '2026-09-13T00:00:00.000Z' },
  { id: 203, name: 'Active', state: 'active', start: '2026-09-21T02:00:00.000Z', end: null, closedAt: null,
    month: '2026-09', computedAt: '2026-09-25T00:00:00.000Z' },
  { id: 204, name: 'Never computed', state: 'closed', start: '2026-07-01T02:00:00.000Z', end: '2026-07-12T02:00:00.000Z',
    closedAt: '2026-07-12T02:00:00.000Z', month: '2026-07', computedAt: null },
];

const TREND_TASKS = [
  { sprintId: 201, outcome: 'done', points: 3 },
  { sprintId: 201, outcome: 'done', points: 2 },
  { sprintId: 201, outcome: 'carryover', points: 5 },
  { sprintId: 201, outcome: 'excluded', points: 1 },
  { sprintId: 202, outcome: 'open', points: 8 },
  { sprintId: 202, outcome: 'done', points: 1.5 },
  { sprintId: 203, outcome: 'done', points: 2 },
  { sprintId: 203, outcome: 'open', points: 4 },
  { sprintId: 999, outcome: 'done', points: 4 }, // no sprint row for it
];

test('sprintTrend: team totals per computed sprint, oldest first', () => {
  const trend = kpi.sprintTrend(TREND_SPRINTS, TREND_TASKS);
  assert.deepEqual(trend.map((s) => s.id), [201, 202, 203], 'sprints without a computed result are left out');
  const old = trend[0];
  assert.equal(old.done, 2);
  assert.equal(old.carryover, 1);
  assert.equal(old.excluded, 1);
  assert.equal(old.spDone, 5);
  assert.equal(old.spCarryover, 5);
  assert.equal(old.completion, 2 / 3);
  const fresh = trend[1];
  assert.equal(fresh.done, 1);
  assert.equal(fresh.open, 1);
  assert.equal(fresh.spOpen, 8);
  assert.equal(fresh.spDone, 1.5);
  assert.equal(fresh.completion, 1, 'open tasks are left out of completion');
  const active = trend[2];
  assert.equal(active.done, 1);
  assert.equal(active.open, 1);
  assert.equal(active.completion, null, 'an active sprint has no completion even with delivered tasks, until it closes');
});

test('sprintTrend: a computed sprint with no tasks keeps a zero row; input order does not matter', () => {
  const trend = kpi.sprintTrend(
    [TREND_SPRINTS[1], TREND_SPRINTS[2], TREND_SPRINTS[0]],
    [{ sprintId: 203, outcome: 'open', points: 2 }]);
  assert.deepEqual(trend.map((s) => s.id), [201, 202, 203], 'ordered by start date');
  const empty = trend.find((s) => s.id === 202);
  assert.equal(empty.done + empty.carryover, 0);
  assert.equal(empty.completion, null, 'nothing counted → no completion');
});

test('sprintTrend: empty inputs give an empty trend', () => {
  assert.deepEqual(kpi.sprintTrend([], []), []);
  assert.deepEqual(kpi.sprintTrend(null, null), []);
});
