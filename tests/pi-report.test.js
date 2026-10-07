/*
 * PI report workbook (public/pi-report.js). Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { piSheets, piSerial, piDaySerial, piFileName, piShift, PI_COLUMNS } = require('../public/pi-report.js');

const TZ = 'Asia/Jakarta';

const row = (key, extra = {}) => Object.assign({
  type: 'Task', key, id: '10500', summary: 'Do ' + key, assignee: 'Andi', assigneeId: 'u1', reporter: 'Sari', reporterId: 'u2',
  priority: 'Medium', status: 'DONE', resolution: 'Done', created: '2026-05-02T02:00:00.000Z', updated: null,
  due: '2026-05-10', timeSpent: 7200, resolved: '2026-05-09T10:00:00.000Z', points: 3,
}, extra);

const REPORT = {
  period: '2026-P2', name: 'MAY AUGUST', prefix: 'TEAM',
  people: [
    { id: 'm1', name: 'Alex', rows: [row('DEMO-1', { sprint: 'Demo Sprint 5' }),
      row('DEMO-2', { timeSpent: null, points: null, due: null })],
      totals: { seconds: 7200, hours: 2, points: 3, count: 2 } },
    { id: 'm2', name: 'Taylor', rows: [], error: 'JIRA said no', totals: { seconds: 0, hours: 0, points: 0, count: 0 } },
  ],
};

test('Excel serials use the wall-clock time in the team timezone', () => {
  // 2026-05-02 09:00 in Jakarta; 1970-01-01 is serial 25569
  assert.equal(piSerial('2026-05-02T02:00:00.000Z', TZ), Date.UTC(2026, 4, 2, 9) / 86400000 + 25569);
  assert.equal(piSerial('2026-05-02T02:00:00.000Z', 'UTC'), Date.UTC(2026, 4, 2, 2) / 86400000 + 25569);
  assert.equal(piSerial(null, TZ), null);
  assert.equal(piDaySerial('1970-01-02'), 25570);
  assert.equal(piDaySerial(null), null);
});

test('file name and period shifting', () => {
  assert.equal(piFileName(REPORT), 'TEAM - JIRA - MAY AUGUST 2026.xlsx');
  assert.equal(piFileName({ ...REPORT, prefix: '' }), 'TEAM - JIRA - MAY AUGUST 2026.xlsx');
  assert.equal(piShift('2026-P1', -1), '2025-P3');
  assert.equal(piShift('2026-P3', 1), '2027-P1');
});

test('Summary comes first: name and hours logged (Time Spent), no header', () => {
  const [summary] = piSheets(REPORT, TZ, 'team.atlassian.net');
  assert.equal(summary.name, 'Summary');
  assert.deepEqual(summary.rows, [['Alex', 2], ['Taylor', 0]]);
});

test('person sheets follow the chosen sort', () => {
  const rows = [row('DEMO-9', { resolved: '2026-07-01T00:00:00.000Z', sprint: 'S1', sprintStart: '2026-05-01T00:00:00.000Z' }),
    row('DEMO-8', { resolved: '2026-06-01T00:00:00.000Z', sprint: 'S2', sprintStart: '2026-06-01T00:00:00.000Z' })];
  const report = { ...REPORT, people: [{ ...REPORT.people[0], rows }] };
  const keys = (sort) => piSheets(report, TZ, '', sort)[1].rows.slice(1, 3).map((r) => r[PI_COLUMNS.indexOf('Issue key')]);
  assert.deepEqual(keys('date'), ['DEMO-8', 'DEMO-9']);
  assert.deepEqual(keys('sprint'), ['DEMO-9', 'DEMO-8']);
});

test('one sheet per person: JIRA header, typed cells, totals block under Due date / Time Spent', () => {
  const sheets = piSheets(REPORT, TZ, 'team.atlassian.net');
  assert.deepEqual(sheets.map((s) => s.name), ['Summary', 'Alex', 'Taylor']);
  for (const s of sheets.slice(1)) assert.deepEqual(s.rows[0].map((c) => c.v), PI_COLUMNS);
  assert.equal(PI_COLUMNS.length, 18);
  assert.deepEqual(PI_COLUMNS.slice(-2), ['Custom field (Story Points)', 'Sprint']);

  const f = sheets[1].rows;
  const first = f[1];
  assert.equal(first[PI_COLUMNS.indexOf('Issue key')].link, 'https://team.atlassian.net/browse/DEMO-1');
  assert.equal(first[PI_COLUMNS.indexOf('Issue id')], 10500);
  const created = first[PI_COLUMNS.indexOf('Created')];
  assert.equal(created.s, 'date');
  assert.equal(created.v, piSerial('2026-05-02T02:00:00.000Z', TZ));
  assert.equal(first[PI_COLUMNS.indexOf('Due date')].s, 'day');
  assert.equal(first[PI_COLUMNS.indexOf('Time Spent')], 7200);
  assert.equal(first[PI_COLUMNS.indexOf('Custom field (Story Points)')], 3);
  assert.equal(first[PI_COLUMNS.indexOf('Sprint')], 'Demo Sprint 5');
  const second = f[2];
  assert.equal(second[PI_COLUMNS.indexOf('Updated')].v, null);
  assert.equal(second[PI_COLUMNS.indexOf('Time Spent')], null);
  assert.equal(second[PI_COLUMNS.indexOf('Sprint')], '');

  assert.deepEqual(f[3], [], 'blank row before the totals');
  const label = PI_COLUMNS.indexOf('Due date');
  const totals = f.slice(4).map((r) => [r[label].v, r[label + 1].v]);
  assert.deepEqual(totals, [['TOTAL TIME SPENT', 7200], ['TOTAL HOURS', 2],['Total Story Point', 3], ['Total Task', 2]]);
  assert.equal(label, 13, 'labels in column N');
});

test('the workbook builds', () => {
  const XlsxLite = require('../public/xlsx.js');
  const bytes = XlsxLite.build(piSheets(REPORT, TZ, ''));
  assert.ok(bytes.length > 1000);
});

test('template helpers match the server rules', () => {
  const { DEFAULT_TEMPLATE, validateTemplate } = require('../lib/pi-core.js');
  const { piTemplateError, piTemplateToSave, piPeriodWords, PI_DEFAULT_TEMPLATE } = require('../public/pi-report.js');
  assert.equal(PI_DEFAULT_TEMPLATE, DEFAULT_TEMPLATE, 'browser copy of the default template');
  for (const t of [DEFAULT_TEMPLATE, '', '   ', 'project = X', "assignee = '{assignee}' AND x >= '{start}'", 'x'.repeat(4001) + '{assignee}{start}{end}']) {
    assert.equal(piTemplateError(t), validateTemplate(t), JSON.stringify(t.slice(0, 40)));
  }
  assert.equal(piTemplateToSave('  ' + DEFAULT_TEMPLATE + '\n'), '');
  assert.equal(piTemplateToSave(" a '{assignee}' "), "a '{assignee}'");
  assert.equal(piPeriodWords('2026-P2'), 'MAY AUGUST 2026');
  assert.equal(piPeriodWords('2025-P3'), 'SEPTEMBER DECEMBER 2025');
});
