/*
 * Unit tests for blocker carry-over, aging and the impediment log. Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  blockerEpisodes, blockersOnDay, buildBlockerReport, blockerSheets, standupDates,
} = require('../public/blockers.js');
const XlsxLite = require('../public/xlsx.js');

const members = [
  { id: 'a', name: 'Andi', role: 'Backend', color: '#E85D4A', lead: 'L1' },
  { id: 'b', name: 'Sari', role: 'QA', color: '#2E9E5B', lead: 'L2' },
];
const roster = members.map((m) => ({ ...m }));
const day = (entries, extra = {}) => ({ startedAt: 's', roster, jira: null, entries, ...extra });

test('a blocker repeated with the same text (any case/spacing) is one episode aged in standup days', () => {
  const st = { members, days: {
    '2026-09-01': day({ a: { blockers: 'Waiting for API keys' } }),
    '2026-09-02': day({ a: { blockers: '  waiting   for api KEYS ' } }),
    '2026-09-03': day({ a: { blockers: 'Waiting for API keys' } }),
  } };
  const eps = blockerEpisodes(st);
  assert.equal(eps.length, 1);
  assert.deepEqual([eps[0].since, eps[0].lastSeen, eps[0].age, eps[0].status], ['2026-09-01', '2026-09-03', 3, 'open']);
  assert.equal(eps[0].name, 'Andi');
});

test('the run continues across days the member was away and those days count toward the age', () => {
  const st = { members, days: {
    '2026-09-01': day({ a: { blockers: 'VPN down' } }),
    '2026-09-02': day({ a: { attendance: 'leave' } }),
    '2026-09-03': day({ a: { attendance: 'sick' } }),
    '2026-09-04': day({ a: { blockers: 'VPN down' } }),
  } };
  const [ep] = blockerEpisodes(st);
  assert.equal(ep.status, 'open');
  assert.equal(ep.age, 4);
  assert.equal(ep.reported, 2);
});

test('a standup without the blocker resolves it; days without a standup are ignored', () => {
  const st = { members, days: {
    '2026-09-01': day({ a: { blockers: 'VPN down' } }),
    '2026-09-02': { startedAt: null, entries: {}, jira: { issues: [] } }, // holiday, auto-sync only
    '2026-09-03': day({ a: { blockers: 'VPN down' } }),
    '2026-09-04': day({ a: { today: 'coding' } }),
  } };
  const [ep] = blockerEpisodes(st);
  assert.deepEqual([ep.status, ep.resolvedOn, ep.age], ['resolved', '2026-09-04', 2]);
});

test('carrying keeps the original start date even when the text is reworded', () => {
  const st = { members, days: {
    '2026-09-01': day({ a: { blockers: 'Need DB access' } }),
    '2026-09-02': day({ a: { blockers: 'Need DB access — ticket raised', blockerSince: '2026-09-01' } }),
  } };
  const eps = blockerEpisodes(st);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].since, '2026-09-01');
  assert.equal(eps[0].text, 'Need DB access — ticket raised');
  assert.equal(eps[0].age, 2);
});

test('a different blocker ends the previous one and starts a new episode', () => {
  const st = { members, days: {
    '2026-09-01': day({ a: { blockers: 'Need DB access' } }),
    '2026-09-02': day({ a: { blockers: 'Build server is down' } }),
  } };
  const eps = blockerEpisodes(st);
  assert.equal(eps.length, 2);
  assert.deepEqual([eps[0].status, eps[0].resolvedOn], ['resolved', '2026-09-02']);
  assert.equal(eps[1].status, 'open');
});

test('the board offers the last open blocker going into today, skipping away days', () => {
  const st = { members, days: {
    '2026-09-01': day({ a: { blockers: 'Need DB access' }, b: { blockers: 'Flaky test env' } }),
    '2026-09-02': day({ a: { attendance: 'leave' }, b: { today: 'testing' } }),
    '2026-09-03': day({}),
  } };
  const onBoard = blockersOnDay(blockerEpisodes(st, { through: '2026-09-03', today: '2026-09-03' }), '2026-09-03');
  assert.equal(onBoard.get('a').text, 'Need DB access');
  assert.equal(onBoard.get('a').awaiting, true);
  assert.equal(onBoard.has('b'), false, 'resolved on the 2nd');
});

test('on the current day an unanswered blocker stays open until someone answers it', () => {
  const days = {
    '2026-09-01': day({ a: { blockers: 'Need DB access' } }),
    '2026-09-02': day({ a: { today: 'coding' } }),
  };
  const pending = blockerEpisodes({ members, days }, { today: '2026-09-02' });
  assert.equal(pending[0].status, 'open');
  assert.equal(pending[0].awaiting, true);
  assert.equal(blockersOnDay(pending, '2026-09-02').get('a'), pending[0]);

  days['2026-09-02'].entries.a.blockerResolved = '2026-09-01';
  const answered = blockerEpisodes({ members, days }, { today: '2026-09-02' });
  assert.deepEqual([answered[0].status, answered[0].resolvedOn], ['resolved', '2026-09-02']);

  // the day after, an unanswered empty note counts as resolved
  delete days['2026-09-02'].entries.a.blockerResolved;
  assert.equal(blockerEpisodes({ members, days }, { today: '2026-09-03' })[0].status, 'resolved');
});

test('through limits the days so a past board shows the age it had then', () => {
  const st = { members, days: {
    '2026-09-01': day({ a: { blockers: 'X' } }),
    '2026-09-02': day({ a: { blockers: 'X' } }),
    '2026-09-03': day({ a: { blockers: 'X' } }),
  } };
  const onSecond = blockersOnDay(blockerEpisodes(st, { through: '2026-09-02', today: '2026-09-02' }), '2026-09-02');
  assert.equal(onSecond.get('a').age, 2);
});

test('removed members keep the name from the day roster; days without a roster use the team', () => {
  const st = { members: [members[1]], days: {
    '2026-09-01': { startedAt: 's', roster: [{ id: 'gone', name: 'Budi', role: 'Dev' }], entries: { gone: { blockers: 'Laptop broken' } } },
    '2026-09-02': { startedAt: 's', entries: { b: { blockers: 'No test data' } } },
  } };
  const eps = blockerEpisodes(st);
  assert.deepEqual(eps.map((e) => e.name), ['Budi', 'Sari']);
  assert.deepEqual([eps[0].status, eps[0].left, eps[0].resolvedOn], ['resolved', true, '2026-09-02'], 'off the team from the 2nd');
});

test('days from before the start button count when they have notes', () => {
  const st = { members, days: {
    '2026-08-01': { entries: { a: { blockers: 'Old one' } } },
    '2026-08-02': { entries: {} },
  } };
  assert.deepEqual(standupDates(st), ['2026-08-01']);
  assert.equal(blockerEpisodes(st)[0].status, 'open');
});

test('the report lists open blockers oldest first and filters the log by member, month and team', () => {
  const st = { members, days: {
    '2026-08-28': day({ a: { blockers: 'August thing' } }),
    '2026-08-31': day({ a: { today: 'x' } }),
    '2026-09-01': day({ a: { blockers: 'Need DB access' }, b: { blockers: 'Flaky env' } }),
    '2026-09-02': day({ a: { blockers: 'Need DB access' }, b: { today: 'y' } }),
    '2026-09-03': day({ a: { blockers: 'Need DB access' }, b: { blockers: 'No devices' } }),
  } };
  const all = buildBlockerReport(st, { today: '2026-09-03' });
  assert.deepEqual(all.open.map((e) => [e.name, e.age]), [['Andi', 3], ['Sari', 1]]);
  assert.equal(all.stale, 1);
  assert.equal(all.log.length, 4);

  const sept = buildBlockerReport(st, { month: '2026-09', today: '2026-09-03' });
  assert.deepEqual(sept.log.map((e) => e.text).sort(), ['Flaky env', 'Need DB access', 'No devices']);
  const aug = buildBlockerReport(st, { month: '2026-08', today: '2026-09-03' });
  assert.deepEqual(aug.log.map((e) => e.text), ['August thing']);

  const sari = buildBlockerReport(st, { member: 'b', today: '2026-09-03' });
  assert.ok(sari.log.every((e) => e.memberId === 'b'));
  assert.equal(sari.members.length, 2, 'the member list still offers everyone');

  const team = buildBlockerReport(st, { today: '2026-09-03', memberFilter: (ep) => ep.lead === 'L1' });
  assert.ok(team.log.every((e) => e.memberId === 'a'));
  assert.deepEqual(team.members.map((m) => m.id), ['a']);
});

test('the Excel export has the open blockers and the log', () => {
  const st = { members, days: {
    '2026-09-01': day({ a: { blockers: 'Need <DB> & access' } }),
    '2026-09-02': day({ a: { today: 'done' } }),
    '2026-09-03': day({ b: { blockers: 'Flaky env' } }),
  } };
  const report = buildBlockerReport(st, { today: '2026-09-03' });
  const sheets = blockerSheets(report, { scope: 'All months', generatedAt: '2026-09-03 09:00' });
  assert.deepEqual(sheets.map((s) => s.name), ['Open blockers', 'Blocker log']);
  assert.equal(sheets[0].rows.length, 3 + 1);
  assert.equal(sheets[1].rows.length, 3 + 2);
  const resolvedRow = sheets[1].rows.find((r) => r[0].v === 'Andi');
  assert.deepEqual([resolvedRow[6].v, resolvedRow[7].v], ['Resolved', '2026-09-02']);
  const bytes = XlsxLite.build(sheets);
  assert.ok(Buffer.from(bytes).includes('Need &lt;DB&gt; &amp; access'), 'text is XML-escaped');
});
