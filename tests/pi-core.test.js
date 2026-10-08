/*
 * Unit tests for the PI report logic (lib/pi-core.js). Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const pi = require('../lib/pi-core.js');

const TZ = 'Asia/Jakarta';

test('periods: validation, range ends on the plain last day, names', () => {
  assert.ok(pi.isValidPeriod('2026-P2'));
  for (const bad of ['2026-P4', '2026-P0', '26-P1', '2026-p1', '', null, '2026-P1 ']) {
    assert.equal(pi.isValidPeriod(bad), false, String(bad));
  }
  assert.deepEqual(pi.periodRange('2026-P1'), { start: '2026-01-01', end: '2026-04-30', afterEnd: '2026-05-01' });
  assert.deepEqual(pi.periodRange('2026-P2'), { start: '2026-05-01', end: '2026-08-31', afterEnd: '2026-09-01' });
  assert.deepEqual(pi.periodRange('2026-P3'), { start: '2026-09-01', end: '2026-12-31', afterEnd: '2027-01-01' });
  assert.deepEqual(pi.periodRange('2028-P1'), { start: '2028-01-01', end: '2028-04-30', afterEnd: '2028-05-01' });
  assert.equal(pi.periodName('2026-P2'), 'MAY AUGUST');
  assert.equal(pi.periodName('2026-P1'), 'JANUARY APRIL');
  assert.equal(pi.periodName('2026-P3'), 'SEPTEMBER DECEMBER');
  assert.equal(pi.periodLabel('2026-P2'), 'May – Aug 2026');
});

test('periodOf uses the team timezone', () => {
  // 31 Aug 23:30 in Jakarta is 16:30 UTC, still P2
  assert.equal(pi.periodOf(Date.parse('2026-08-31T16:30:00Z'), TZ), '2026-P2');
  // 31 Aug 18:00 UTC is already 1 Sep in Jakarta
  assert.equal(pi.periodOf(Date.parse('2026-08-31T18:00:00Z'), TZ), '2026-P3');
  assert.equal(pi.periodOf(Date.parse('2026-08-31T18:00:00Z'), 'UTC'), '2026-P2');
});

test('shiftPeriod and lastFinishedPeriod cross years', () => {
  assert.equal(pi.shiftPeriod('2026-P1', -1), '2025-P3');
  assert.equal(pi.shiftPeriod('2025-P3', 1), '2026-P1');
  assert.equal(pi.shiftPeriod('2026-P2', 0), '2026-P2');
  assert.equal(pi.lastFinishedPeriod(Date.parse('2026-10-01T03:00:00Z'), TZ), '2026-P2');
  assert.equal(pi.lastFinishedPeriod(Date.parse('2026-01-15T03:00:00Z'), TZ), '2025-P3');
});

test('validateTemplate needs an assignee, start, and a period end', () => {
  assert.equal(pi.validateTemplate(pi.DEFAULT_TEMPLATE), '');
  assert.match(pi.validateTemplate(''), /empty/);
  assert.match(pi.validateTemplate("assignee = '{assignee}' AND resolutionDate >= '{start}'"), /\{end\}/);
  assert.match(pi.validateTemplate('x'.repeat(pi.MAX_TEMPLATE + 1) + '{assignee}{start}{end}'), /too long/);
});

test('fillTemplate fills every occurrence and refuses unsafe users', () => {
  const jql = pi.fillTemplate(pi.DEFAULT_TEMPLATE, { assignee: '557058:abc', ...pi.periodRange('2026-P2') });
  assert.ok(!/\{(assignee|start|end|afterEnd)\}/.test(jql));
  assert.equal(jql.split("assignee = '557058:abc'").length - 1, 1);
  // resolutionDate is a date-time: '<= 2026-08-31' would stop at 31 Aug 00:00 and drop the last day
  assert.ok(jql.includes("resolutionDate < '2026-09-01'"));
  assert.ok(!jql.includes("resolutionDate <= "));
  assert.ok(jql.includes("statusCategory = Done"));
  assert.ok(jql.includes("resolutionDate >= '2026-05-01'"));
  for (const bad of ["x' OR '1'='1", 'a b', 'a)', '']) {
    assert.throws(() => pi.fillTemplate(pi.DEFAULT_TEMPLATE, { assignee: bad, start: 's', end: 'e' }), /Unsafe/);
  }
  assert.throws(() => pi.fillTemplate('no placeholders', { assignee: 'u1', start: 's', end: 'e' }), /must contain/);
});

test('{afterEnd} is optional: a template with only {end} is valid and still covers the full last day', () => {
  const own = "assignee = '{assignee}' AND resolved >= '{start}' AND resolved <= '{end}'";
  assert.equal(pi.validateTemplate(own), '');
  assert.equal(pi.fillTemplate(own, { assignee: 'u1', ...pi.periodRange('2026-P2') }),
    "assignee = 'u1' AND resolved >= '2026-05-01' AND resolved < '2026-09-01'");
  assert.equal(pi.fillTemplate("x < '{afterEnd}' {assignee}{start}{end}", { assignee: 'u1', ...pi.periodRange('2026-P3') }),
    "x < '2027-01-01' u12026-09-012026-12-31");
  assert.throws(() => pi.fillTemplate(pi.DEFAULT_TEMPLATE, { assignee: 'u1', start: '2026-05-01', end: '2026-08-31' }),
    /\{afterEnd\}/, 'a missing date is refused, not filled with junk');
});

test('{end} comparisons include the whole final day, for date and date-time fields alike', () => {
  const range = pi.periodRange('2026-P2');
  const fill = (t) => pi.fillTemplate(t, { assignee: 'u1', ...range });
  // a date-time compared with <= '2026-08-31' would stop at 31 Aug 00:00
  assert.equal(fill("{assignee} {start} resolutionDate <= '{end}'"), "u1 2026-05-01 resolutionDate < '2026-09-01'");
  assert.equal(fill('{assignee} {start} "Start date[Date]" <= "{end}"'), 'u1 2026-05-01 "Start date[Date]" < "2026-09-01"');
  assert.equal(fill('{assignee} {start} resolved<={end}'), 'u1 2026-05-01 resolved < 2026-09-01');
  assert.equal(fill("{assignee} {start} resolved > '{end}'"), "u1 2026-05-01 resolved >= '2026-09-01'");
  // other uses of {end} are left as written
  assert.equal(fill("{assignee} {start} x < '{end}' y >= '{end}' z = '{end}'"),
    "u1 2026-05-01 x < '2026-08-31' y >= '2026-08-31' z = '2026-08-31'");
  // the user's two-group query: both halves cover 31 Aug fully
  const two = "(assignee = '{assignee}' AND \"Start date[Date]\" >= '{start}' AND \"Start date[Date]\" <= '{end}')\n" +
    "OR\n(assignee = '{assignee}' AND resolutionDate >= '{start}' AND resolutionDate <= '{end}')";
  const jql = fill(two);
  assert.equal(jql.split("< '2026-09-01'").length - 1, 2);
  assert.ok(!jql.includes('<='));
  // without an explicit afterEnd the next day is worked out from {end}
  assert.equal(pi.fillTemplate("{assignee} {start} r <= '{end}'", { assignee: 'u1', start: '2028-02-01', end: '2028-02-29' }),
    "u1 2028-02-01 r < '2028-03-01'");
});

test('toPiRow maps every column; missing time and points stay empty', () => {
  const row = pi.toPiRow({
    id: '10500', key: 'DEMO-1',
    fields: {
      issuetype: { name: 'Task' }, summary: 'Build it',
      assignee: { displayName: 'Andi', accountId: 'u1' }, reporter: { displayName: 'Sari', accountId: 'u2' },
      priority: { name: 'Medium' }, status: { name: 'DONE' }, resolution: { name: 'Done' },
      created: '2026-05-02T09:00:00.000+0700', updated: '2026-06-01T10:00:00.000+0700',
      duedate: '2026-05-10', timespent: 7200, resolutiondate: '2026-05-09T17:00:00.000+0700',
      customfield_10032: 3,
    },
  }, 'customfield_10032');
  assert.deepEqual(row, {
    type: 'Task', key: 'DEMO-1', id: '10500', summary: 'Build it',
    assignee: 'Andi', assigneeId: 'u1', reporter: 'Sari', reporterId: 'u2',
    priority: 'Medium', status: 'DONE', resolution: 'Done',
    created: '2026-05-02T02:00:00.000Z', updated: '2026-06-01T03:00:00.000Z', due: '2026-05-10',
    timeSpent: 7200, resolved: '2026-05-09T10:00:00.000Z', points: 3, sprint: '', sprintStart: null,
  });
  const empty = pi.toPiRow({ key: 'DEMO-2', fields: {} }, 'customfield_10032');
  assert.equal(empty.timeSpent, null);
  assert.equal(empty.points, null);
  assert.equal(empty.assignee, '');
  assert.equal(empty.created, null);
  assert.equal(pi.toPiRow({ key: 'DEMO-3', fields: { customfield_1: 5 } }, '').points, null);
});

test('toPiRow keeps the latest sprint a ticket was in', () => {
  const sprints = [
    { id: 7, name: 'Demo Sprint 7', startDate: '2026-05-04T01:00:00.000Z' },
    { id: 9, name: 'Demo Sprint 9', startDate: '2026-06-01T01:00:00.000Z' },
    { id: 8, name: 'Demo Sprint 8', startDate: '2026-05-18T01:00:00.000Z' },
  ];
  const row = pi.toPiRow({ key: 'DEMO-1', fields: { customfield_10020: sprints } }, '', 'customfield_10020');
  assert.equal(row.sprint, 'Demo Sprint 9');
  assert.equal(row.sprintStart, '2026-06-01T01:00:00.000Z');
  const future = pi.toPiRow({ key: 'DEMO-2', fields: { customfield_10020: [{ id: 3, name: 'Next' }, { id: 4, name: 'Later' }] } }, '', 'customfield_10020');
  assert.equal(future.sprint, 'Later', 'no start dates: the highest ID wins');
  assert.equal(future.sprintStart, null);
  const none = pi.toPiRow({ key: 'DEMO-3', fields: { customfield_10020: null } }, '', 'customfield_10020');
  assert.deepEqual([none.sprint, none.sprintStart], ['', null]);
  assert.equal(pi.toPiRow({ key: 'DEMO-4', fields: { customfield_10020: sprints } }, '', '').sprint, '', 'no sprint field');
});

test('totals: Time Spent in seconds and hours, points, count', () => {
  const t = pi.totals([{ timeSpent: 3600, points: 2 }, { timeSpent: null, points: null }, { timeSpent: 1800, points: 1.5 }]);
  assert.deepEqual(t, { seconds: 5400, hours: 1.5, points: 3.5, count: 3 });
  assert.deepEqual(pi.totals([]), { seconds: 0, hours: 0, points: 0, count: 0 });
});

test('periods of every length: ranges, the period of a day, stepping across years and names', () => {
  const periods = require('../public/pi-periods.js');
  assert.deepEqual(periods.range('2026'), { start: '2026-01-01', end: '2026-12-31', afterEnd: '2027-01-01' });
  assert.deepEqual(periods.range('2026-H2'), { start: '2026-07-01', end: '2026-12-31', afterEnd: '2027-01-01' });
  assert.deepEqual(periods.range('2026-Q1'), { start: '2026-01-01', end: '2026-03-31', afterEnd: '2026-04-01' });
  assert.deepEqual(periods.range('2028-B1'), { start: '2028-01-01', end: '2028-02-29', afterEnd: '2028-03-01' });
  assert.deepEqual(periods.range('2026-12'), { start: '2026-12-01', end: '2026-12-31', afterEnd: '2027-01-01' });
  assert.deepEqual(['2026-10-07', '2026-01-01'].map((d) => [1, 2, 3, 4, 6, 12].map((n) => periods.ofDay(d, n))),
    [['2026-10', '2026-B5', '2026-Q4', '2026-P3', '2026-H2', '2026'], ['2026-01', '2026-B1', '2026-Q1', '2026-P1', '2026-H1', '2026']]);
  assert.equal(periods.ofDay('2026-10-07', 5), '2026-P3', 'an unknown length falls back to 4 months');
  assert.equal(periods.shift('2026-01', -1), '2025-12');
  assert.equal(periods.shift('2026-Q4', 1), '2027-Q1');
  assert.equal(periods.shift('2026-B1', -7), '2024-B6');
  assert.equal(periods.shift('2026', -1), '2025');
  assert.equal(periods.lastFinished('2026-01-15', 3), '2025-Q4');
  assert.deepEqual(['2026-Q3', '2026-09', '2026'].map(periods.words), ['JULY SEPTEMBER', 'SEPTEMBER', 'JANUARY DECEMBER']);
  assert.deepEqual(['2026-B5', '2026-09', '2026-H1'].map(periods.label), ['Sep – Oct 2026', 'Sep 2026', 'Jan – Jun 2026']);
  assert.deepEqual(periods.ofYear(2026, 6), ['2026-H1', '2026-H2']);
  for (const bad of ['2026-P4', '2026-Q0', '2026-B7', '2026-H3', '2026-13', '2026-00', '26-Q1', '2026-X1', '', null]) {
    assert.equal(pi.isValidPeriod(bad), false, String(bad));
  }
  assert.equal(pi.lastFinishedPeriod(Date.parse('2026-09-30T18:00:00Z'), 'Asia/Jakarta', 1), '2026-09',
    'October 1st in Jakarta already: September is finished');
});
