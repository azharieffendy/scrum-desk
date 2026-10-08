'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildKpiView, filterKpiTasks, kpiIssueUrl, kpiSheets, kpiMemberReport, taskFindMatch } = require('../public/kpi-report.js');
const XlsxLite = require('../public/xlsx.js');

const members = [
  { id: 'm1', name: 'Member One', color: '#3D51E0', email: 'one@example.test' },
  { id: 'm2', name: 'Member Two', color: '#0F8A5F', email: '' },
];
const mapping = { 'acc-1': 'm1' };

const task = (over) => Object.assign({
  sprintId: 1, key: 'T-1', summary: 'Task', type: 'Story', accountId: 'acc-1',
  assigneeName: 'Someone', assigneeEmail: null, outcome: 'done', doneAt: '2026-09-10T03:00:00.000Z',
  points: 3, reason: 'Done in sprint',
}, over);

const report = (over) => Object.assign({
  month: '2026-09', months: ['2026-08', '2026-09'], computedAt: '2026-09-20T00:00:00.000Z',
  configured: true, refreshing: false,
  sprints: [
    { id: 1, name: 'Sprint 1', state: 'closed', start: '2026-09-01', end: '2026-09-12', status: 'ok', error: null },
    { id: 2, name: 'Sprint 2', state: 'active', start: '2026-09-15', end: '2026-09-26', status: 'error', error: 'JIRA: 500' },
  ],
  tasks: [
    task({ key: 'T-1', outcome: 'done', points: 3 }),
    task({ key: 'T-2', outcome: 'carryover', points: 5, doneAt: null }),
    task({ key: 'T-2', sprintId: 2, outcome: 'open', points: 5, doneAt: null }),
    task({ key: 'T-3', accountId: 'acc-2', assigneeName: 'Member Two', outcome: 'done', points: 2 }),
    task({ key: 'T-4', accountId: 'acc-9', assigneeName: 'Guest Person', outcome: 'excluded', points: 1 }),
    task({ key: 'T-5', accountId: null, assigneeName: null, outcome: 'carryover', points: 0 }),
  ],
}, over);

test('team totals count outcomes and story points', () => {
  const v = buildKpiView(report(), members, mapping);
  assert.equal(v.status, 'ok');
  assert.equal(v.label, 'September 2026');
  assert.deepEqual(v.totals, {
    sprints: 2, done: 2, carryover: 2, open: 1, excluded: 1,
    spDone: 5, spCarryover: 5, spOpen: 5, spTotal: 10, completion: 0.5, // open SP left out of the total
  });
});

test('tasks map to members by account mapping, then email, then name', () => {
  const v = buildKpiView(report(), members, mapping);
  const byName = Object.fromEntries(v.members.map((m) => [m.name, m]));
  assert.equal(byName['Member One'].memberId, 'm1');
  assert.equal(byName['Member One'].done, 1);
  assert.equal(byName['Member One'].carryover, 1);
  assert.equal(byName['Member One'].open, 1);
  assert.equal(byName['Member One'].completion, 0.5);
  assert.equal(byName['Member Two'].memberId, 'm2'); // matched by name
  assert.equal(byName['Member Two'].completion, 1);
  assert.equal(byName['Unassigned'].carryover, 1);
  // Team members first, in team order; others after.
  assert.deepEqual(v.members.map((m) => m.name), ['Member One', 'Member Two', 'Unassigned']);
});

test('a person with only excluded tasks gets no member row', () => {
  const v = buildKpiView(report(), members, mapping);
  assert.ok(!v.members.some((m) => m.name === 'Guest Person'));
});

test('sprint blocks carry status, error and per-member rows', () => {
  const v = buildKpiView(report(), members, mapping);
  assert.equal(v.sprints.length, 2);
  assert.equal(v.sprints[0].rows.length, 3);
  assert.equal(v.sprints[1].status, 'error');
  assert.equal(v.sprints[1].error, 'JIRA: 500');
  assert.deepEqual(v.sprints[1].rows.map((r) => [r.name, r.open]), [['Member One', 1]]);
});

test('detail tasks know their sprint and how often they were carried this month', () => {
  const v = buildKpiView(report(), members, mapping);
  const t2 = v.tasks.filter((t) => t.key === 'T-2');
  assert.deepEqual(t2.map((t) => t.sprintName), ['Sprint 1', 'Sprint 2']);
  assert.ok(t2.every((t) => t.carried === 1));
  assert.equal(v.tasks.find((t) => t.key === 'T-1').carried, 0);
});

test('filterKpiTasks hides excluded by default and filters by member', () => {
  const v = buildKpiView(report(), members, mapping);
  assert.equal(filterKpiTasks(v, {}).length, 5);
  assert.equal(filterKpiTasks(v, { showExcluded: true }).length, 6);
  const one = filterKpiTasks(v, { memberKey: v.members[0].key });
  assert.deepEqual(one.map((t) => t.key), ['T-1', 'T-2', 'T-2']);
});

test('empty states: not configured, no data, no sprints this month', () => {
  assert.equal(buildKpiView(report({ configured: false, months: [], sprints: [], tasks: [] }), members, mapping).status, 'unconfigured');
  assert.equal(buildKpiView(report({ months: [], sprints: [], tasks: [] }), members, mapping).status, 'nodata');
  assert.equal(buildKpiView(report({ month: '2026-07', sprints: [], tasks: [] }), members, mapping).status, 'nosprints');
});

test('completion is null when nothing counted', () => {
  const v = buildKpiView(report({ tasks: [task({ outcome: 'open' })] }), members, mapping);
  assert.equal(v.totals.completion, null);
});

test('kpiIssueUrl builds a browse link only for http(s) sites', () => {
  assert.equal(kpiIssueUrl('team.atlassian.net', 'T-1'), 'https://team.atlassian.net/browse/T-1');
  assert.equal(kpiIssueUrl('https://team.atlassian.net/', 'T-1'), 'https://team.atlassian.net/browse/T-1');
  assert.equal(kpiIssueUrl('javascript:alert(1)', 'T-1'), null);
  assert.equal(kpiIssueUrl('', 'T-1'), null);
});

/* ---------------- Excel ---------------- */

const values = (row) => row.map((c) => (c && typeof c === 'object' ? c.v : c));
const rowStarting = (sheet, first) => sheet.rows.find((r) => values(r)[0] === first);
const sheetText = (sheet) => sheet.rows.map((r) => values(r).join(' | ')).join('\n');

test('Summary sheet: one row per member, a team total and completion as a fraction', () => {
  const [summary] = kpiSheets(buildKpiView(report(), members, mapping), '2026-09-30 10:00');
  assert.equal(values(summary.rows[0])[0], 'KPI report — September 2026');
  assert.deepEqual(values(summary.rows[2]),
    ['Member', 'Delivered', 'Carry-over', 'Open', 'SP delivered', 'SP carried over', 'SP open', 'Completion']);
  assert.deepEqual(values(rowStarting(summary, 'Member One')), ['Member One', 1, 1, 1, 3, 5, 5, 0.5]);
  assert.equal(rowStarting(summary, 'Member One')[7].s, 'pct');
  assert.deepEqual(values(rowStarting(summary, 'Team total')), ['Team total', 2, 2, 1, 5, 5, 5, 0.5]);
});

test('Summary sheet ends with an About note: rules, generated time, oldest data, stale sprints', () => {
  const [summary] = kpiSheets(buildKpiView(report(), members, mapping), '2026-09-30 10:00');
  const text = sheetText(summary);
  const about = text.slice(text.indexOf('About'));
  assert.ok(text.includes('About'));
  assert.match(about, /Delivered = reached a Done-category status/i);
  assert.match(about, /Generated 2026-09-30 10:00/);
  assert.match(about, /Oldest data computed 2026-09-20/);
  assert.match(about, /Sprint 2: last refresh failed \(JIRA: 500\)/);
});

test('completion with nothing counted is a dash, not a number', () => {
  const [summary] = kpiSheets(buildKpiView(report({ tasks: [task({ outcome: 'open' })] }), members, mapping), 'x');
  assert.equal(values(rowStarting(summary, 'Member One'))[7], '—');
});

test('Sprints sheet: sprint × member rows; a sprint without counted tasks still appears', () => {
  const sheets = kpiSheets(buildKpiView(report({ tasks: report().tasks.filter((t) => t.sprintId === 1) }), members, mapping), 'x');
  const sprints = sheets[1];
  const rows = sprints.rows.slice(3).map(values);
  assert.deepEqual(rows.map((r) => [r[0], r[4]]), [
    ['Sprint 1', 'Member One'], ['Sprint 1', 'Member Two'], ['Sprint 1', 'Unassigned'], ['Sprint 2', 'No counted tasks'],
  ]);
  assert.deepEqual(rows[0].slice(1, 4), ['2026-09-01', '2026-09-12', 'closed']);
});

test('Tasks sheet: every task per sprint, excluded included, with outcome and reason', () => {
  const tasks = kpiSheets(buildKpiView(report(), members, mapping), 'x')[2];
  const rows = tasks.rows.slice(3).map(values);
  assert.equal(rows.length, 6);
  assert.deepEqual(values(tasks.rows[2]),
    ['Sprint', 'Key', 'Summary', 'Type', 'Member', 'Outcome', 'Delivered', 'SP', 'Carried this month', 'Reason']);
  const excluded = rows.find((r) => r[1] === 'T-4');
  assert.deepEqual([excluded[4], excluded[5]], ['Guest Person', 'Excluded']);
  const t1 = rows.find((r) => r[1] === 'T-1');
  assert.equal(t1[6], '2026-09-10');
  assert.equal(t1[9], 'Done in sprint');
});

test('a KPI member selection keeps only those members’ tasks, rows and totals', () => {
  const v = buildKpiView(report(), members, mapping, ['m2']);
  assert.deepEqual(v.members.map((m) => m.name), ['Member Two']);
  assert.deepEqual(v.tasks.map((t) => t.key), ['T-3']);
  assert.equal(v.totals.done, 1);
  assert.equal(v.totals.carryover, 0);
  assert.deepEqual(v.sprints[0].rows.map((r) => r.name), ['Member Two']);
  assert.deepEqual(v.selection, { count: 1, of: 2 });
});

test('every ticked KPI member gets a row, even without work this month', () => {
  const v = buildKpiView(report({ tasks: [task({ key: 'T-1' })] }), members, mapping, ['m1', 'm2']);
  assert.deepEqual(v.members.map((m) => [m.name, m.done, m.completion]), [['Member One', 1, 1], ['Member Two', 0, null]]);
  assert.equal(v.members[1].key, 'm:m2');
  // Sprint blocks only list people with work in that sprint.
  assert.deepEqual(v.sprints[0].rows.map((r) => r.name), ['Member One']);
});

test('kpiMemberReport: one member’s totals, per-sprint figures and tasks', () => {
  const v = buildKpiView(report(), members, mapping);
  const m = kpiMemberReport(v, 'm:m1');
  assert.equal(m.row.name, 'Member One');
  assert.deepEqual(m.tasks.map((t) => t.key), ['T-1', 'T-2', 'T-2']);
  assert.deepEqual(m.sprints.map((s) => [s.name, s.done, s.carryover, s.open, s.spDone, s.completion]), [
    ['Sprint 1', 1, 1, 0, 3, 0.5],
    ['Sprint 2', 0, 0, 1, 0, null],
  ]);
  assert.equal(m.sprints[1].status, 'error');
  assert.equal(kpiMemberReport(v, 'm:nobody'), null);
});

test('kpiMemberReport keeps sprints where the member only has excluded tasks', () => {
  const v = buildKpiView(report({ tasks: [task({ outcome: 'excluded' }), task({ key: 'T-9', sprintId: 2 })] }),
    members, mapping, ['m1']);
  const m = kpiMemberReport(v, 'm:m1');
  assert.deepEqual(m.sprints.map((s) => [s.name, s.excluded, s.done]), [['Sprint 1', 1, 0], ['Sprint 2', 0, 1]]);
});

test('kpiSheets adds one sheet per team member after Summary, Sprints and Tasks', () => {
  const sheets = kpiSheets(buildKpiView(report(), members, mapping), '2026-09-30 10:00');
  assert.deepEqual(sheets.map((s) => s.name), ['Summary', 'Sprints', 'Tasks', 'Member One', 'Member Two']);
  assert.ok(XlsxLite.build(sheets).length > 1000);
});

test('member sheet: totals, per-sprint table and every task of that member', () => {
  const sheet = kpiSheets(buildKpiView(report(), members, mapping), 'x')[3];
  assert.equal(values(sheet.rows[0])[0], 'Member One — September 2026');
  const head = sheet.rows.findIndex((r) => values(r)[0] === 'Delivered');
  assert.deepEqual(values(sheet.rows[head + 1]), [1, 1, 1, 3, 5, 5, 0.5]);
  const sprintHead = sheet.rows.findIndex((r) => values(r)[0] === 'Sprint' && values(r)[1] === 'Start');
  assert.deepEqual(values(sheet.rows[sprintHead + 1]), ['Sprint 1', '2026-09-01', '2026-09-12', 'closed', 1, 1, 0, 3, 5, 0.5]);
  assert.deepEqual(values(sheet.rows[sprintHead + 2]).slice(0, 4), ['Sprint 2', '2026-09-15', '2026-09-26', 'active']);
  const taskHead = sheet.rows.findIndex((r) => values(r)[0] === 'Sprint' && values(r)[1] === 'Key');
  const taskRows = sheet.rows.slice(taskHead + 1).map(values);
  assert.deepEqual(taskRows.map((r) => [r[0], r[1], r[3]]),
    [['Sprint 1', 'T-1', 'Delivered'], ['Sprint 1', 'T-2', 'Carry-over'], ['Sprint 2', 'T-2', 'Open']]);
});

test('task keys in the Tasks and member sheets link to the JIRA issue', () => {
  const sheets = kpiSheets(buildKpiView(report(), members, mapping), 'x', undefined, 'team.atlassian.net');
  const keyCells = (sheet) => sheet.rows.map((r) => r && r[1]).filter((c) => c && c.link);
  const tasks = keyCells(sheets[2]);
  assert.equal(tasks.length, 6);
  assert.deepEqual(tasks.find((c) => c.v === 'T-1'), { v: 'T-1', s: 'link', link: 'https://team.atlassian.net/browse/T-1' });
  assert.deepEqual(keyCells(sheets[3]).map((c) => c.link), [
    'https://team.atlassian.net/browse/T-1', 'https://team.atlassian.net/browse/T-2', 'https://team.atlassian.net/browse/T-2',
  ]);
});

test('task keys stay plain text when no usable JIRA site is known', () => {
  for (const site of [undefined, '', 'javascript:alert(1)']) {
    const sheets = kpiSheets(buildKpiView(report(), members, mapping), 'x', undefined, site);
    const cell = sheets[2].rows[3][1];
    assert.equal(cell.link, undefined, String(site));
    assert.equal(cell.s, 'boldText');
  }
});

test('member sheet for a ticked member without work says so', () => {
  const sheets = kpiSheets(buildKpiView(report({ tasks: [task()] }), members, mapping, ['m1', 'm2']), 'x');
  assert.match(sheetText(sheets.find((s) => s.name === 'Member Two')), /No tasks in September 2026/);
});

test('an empty or stale KPI member selection shows everyone', () => {
  for (const pick of [undefined, [], ['gone']]) {
    const v = buildKpiView(report(), members, mapping, pick);
    assert.equal(v.tasks.length, 6, String(pick));
    assert.equal(v.selection, null);
  }
});

test('taskFindMatch finds by key terms or by summary text, ignoring case', () => {
  assert.equal(taskFindMatch('DEMO-4099', 'Fix login', ''), true, 'empty query shows all');
  assert.equal(taskFindMatch('DEMO-4099', 'Fix login', '   '), true);
  assert.equal(taskFindMatch('DEMO-4099', 'Fix login', 'demo-4099'), true);
  assert.equal(taskFindMatch('DEMO-4099', 'Fix login', '4099'), true, 'number alone');
  assert.equal(taskFindMatch('DEMO-4087', 'Fix login', 'DEMO-4099, 4087'), true, 'any of several keys');
  assert.equal(taskFindMatch('DEMO-3000', 'Fix login', 'DEMO-4099, 4087'), false);
  assert.equal(taskFindMatch('DEMO-1', 'Fix the LOGIN page', 'login page'), true, 'summary phrase');
  assert.equal(taskFindMatch('DEMO-1', 'Fix the login page', 'page login'), false, 'summary needs the whole phrase');
  assert.equal(taskFindMatch('DEMO-1', null, 'login'), false, 'key-only when no summary is given');
});

// ---------- configurable counting rules ----------

const rulesApi = require('../public/kpi-report.js');

test('rule wording defaults to Done category only', () => {
  assert.equal(rulesApi.kpiDoneWords({}), 'a Done-category status');
  assert.equal(rulesApi.kpiDoneShort({}), 'Done');
  assert.match(rulesApi.kpiRulesNote({}), /^Rules: Delivered = reached a Done-category status /);
});

test('rule wording follows the configured statuses and category', () => {
  const s = { kpiDoneStatuses: 'Untested, Code Review, untested', kpiDoneCategory: false };
  assert.deepEqual(rulesApi.kpiRules(s), { names: ['Untested', 'Code Review'], category: false });
  assert.equal(rulesApi.kpiDoneWords(s), 'Untested or Code Review');
  assert.equal(rulesApi.kpiDoneShort(s), 'Untested/Code Review');
  assert.match(rulesApi.kpiRulesNote(s), /^Rules: Untested, Code Review count as done\./);
  const onlyCategory = { kpiDoneStatuses: '', kpiDoneCategory: true };
  assert.equal(rulesApi.kpiDoneWords(onlyCategory), 'a Done-category status');
  assert.match(rulesApi.kpiRulesNote(onlyCategory), /^Rules: Delivered = reached a Done-category status /);
});

test('tooltips follow the signed-in settings', () => {
  globalThis.state = { settings: { kpiDoneStatuses: 'QA Passed', kpiDoneCategory: false } };
  try {
    assert.match(rulesApi.KPI_TIPS.done, /first reached QA Passed inside the sprint/);
    assert.match(rulesApi.KPI_TIPS.carryover, /still not QA Passed when/);
  } finally { delete globalThis.state; }
  assert.match(rulesApi.KPI_TIPS.done, /first reached a Done-category status/);
});

test('the workbook rules note uses the given settings', () => {
  const [summary] = kpiSheets(buildKpiView(report(), members, mapping), 'x', 'Asia/Jakarta', '', { kpiDoneStatuses: 'QA Passed', kpiDoneCategory: true });
  assert.ok(JSON.stringify(summary).includes('Rules: QA Passed counts as done.'));
});

test('kpiRulesError mirrors the server checks', () => {
  assert.equal(rulesApi.kpiRulesError('Untested', false), '');
  assert.equal(rulesApi.kpiRulesError('', true), '');
  assert.match(rulesApi.kpiRulesError(' , ', false), /no task could ever count/);
  assert.match(rulesApi.kpiRulesError('x'.repeat(61), true), /at most 60 characters/);
  assert.match(rulesApi.kpiRulesError(Array.from({ length: 11 }, (_, i) => 'S' + i).join(','), true), /at most 10/);
});

test('kpiTrendView windows the trend by month or takes the latest sprints', () => {
  const sprint = (id, month, over) => Object.assign({
    id, name: 'Sprint ' + id, state: 'closed', start: month + '-01T02:00:00.000Z', month,
    done: 2, carryover: 1, open: 0, excluded: 0, spDone: 5, spCarryover: 3, spOpen: 0, completion: 2 / 3,
  }, over);
  const trend = { sprints: [
    sprint(1, '2026-08'), sprint(2, '2026-08'), sprint(3, '2026-09', { state: 'active', open: 4, spOpen: 8, completion: null }),
  ] };
  const all = rulesApi.kpiTrendView(trend, { count: 0 });
  assert.deepEqual(all.sprints.map((s) => s.id), [1, 2, 3], '0 charts everything');
  assert.equal(all.total, 3);
  assert.equal(all.windowed, false);
  assert.equal(all.avgCompletion, 2 / 3);
  const last = rulesApi.kpiTrendView(trend, { count: 2 });
  assert.deepEqual(last.sprints.map((s) => s.id), [2, 3], 'the newest sprints are charted');
  assert.equal(last.avgCompletion, 2 / 3, 'the active sprint has no completion and is left out of the average');
  assert.equal(last.spDone, 10);
  assert.equal(last.spCarryover, 6);
  const uptoAug = rulesApi.kpiTrendView(trend, { count: 0, month: '2026-08' });
  assert.deepEqual(uptoAug.sprints.map((s) => s.id), [1, 2], 'the pool stops at the selected month');
  assert.equal(uptoAug.windowed, true);
  assert.deepEqual([...uptoAug.monthIds], [1, 2], 'selected-month sprints are highlighted');
  const recent = rulesApi.kpiTrendView(trend, { count: 0, month: '2026-08', mode: 'recent' });
  assert.deepEqual(recent.sprints.map((s) => s.id), [1, 2, 3], 'recent mode ignores the month window');
  assert.deepEqual([...recent.monthIds], [1, 2], 'the selected month stays ringed in recent mode too');
  const before = rulesApi.kpiTrendView(trend, { count: 6, month: '2026-07' });
  assert.deepEqual(before.sprints, [], 'a month before the data has an empty window');
  assert.deepEqual([...before.monthIds], []);
  const fallback = rulesApi.kpiTrendView(trend);
  assert.deepEqual(fallback.sprints.map((s) => s.id), [1, 2, 3], 'no opts: everything fits in the default 12');
  const none = rulesApi.kpiTrendView({ sprints: [] }, { count: 12 });
  assert.equal(none.avgCompletion, null);
  assert.equal(none.spDone, 0);
});
