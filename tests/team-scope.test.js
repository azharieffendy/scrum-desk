/*
 * Technical Lead scoping (lib/team-scope.js): what a lead sees, and how a
 * lead's save is widened back into the whole board. Pure functions. Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const scope = require('../lib/team-scope.js');

const LEAD = { id: 7, role: 'lead', memberId: 'me' };

const fullState = () => ({
  members: [
    { id: 'me', name: 'Lead Self', lead: '1', color: '#111' },
    { id: 'a1', name: 'Andi', lead: '7', email: 'andi@x.com', color: '#222' },
    { id: 'b1', name: 'Budi', lead: '9', email: 'budi@x.com', color: '#333' },
    { id: 'n1', name: 'Nora', lead: '', color: '#444' },
  ],
  mapping: { 'acc-a': 'a1', 'acc-b': 'b1' },
  settings: { jql: 'project = X', kpiMembers: ['b1'], piJql: 'q', piPrefix: 'SEM', piPeriodMonths: 3,
    kpiDoneStatuses: 'Untested, Code Review', kpiDoneCategory: false, kpiRoleRules: [{ role: 'QA', doneStatuses: '', doneCategory: true }] },
  days: {
    '2026-09-30': {
      startedAt: '2026-09-30T02:00:00Z',
      entries: { a1: { today: 'a work' }, b1: { today: 'b work' } },
      roster: [{ id: 'me', name: 'Lead Self' }, { id: 'a1', name: 'Andi' }, { id: 'b1', name: 'Budi' }, { id: 'n1', name: 'Nora' }],
      jira: { syncedAt: 's', sprint: { name: 'S1' }, issues: [
        { key: 'X-1', assignee: { accountId: 'acc-a', name: 'Andi' } },
        { key: 'X-2', assignee: { accountId: 'acc-b', name: 'Budi' } },
        { key: 'X-3', assignee: null },
      ] },
    },
  },
});

test('isLead only matches the lead role', () => {
  assert.equal(scope.isLead(LEAD), true);
  assert.equal(scope.isLead({ id: 1, role: 'admin' }), false);
  assert.equal(scope.isLead(null), false);
});

test("a lead's scope is their members plus their own linked card", () => {
  const ids = scope.scopedMemberIds(fullState().members, LEAD);
  assert.deepEqual([...ids].sort(), ['a1', 'me']);
});

test('scopeState hides other teams, their entries, tickets, mappings and the global settings', () => {
  const out = scope.scopeState(fullState(), LEAD);
  assert.deepEqual(out.members.map((m) => m.id), ['me', 'a1']);
  const day = out.days['2026-09-30'];
  assert.deepEqual(Object.keys(day.entries), ['a1']);
  assert.deepEqual(day.roster.map((m) => m.id), ['me', 'a1']);
  assert.deepEqual(day.jira.issues.map((t) => t.key), ['X-1', 'X-3']);
  assert.deepEqual(out.mapping, { 'acc-a': 'a1' });
  // the KPI counting rules and the report period length stay visible, so a lead's KPI tab explains the rules in use
  assert.deepEqual(out.settings, { jql: '', kpiMembers: [], piJql: '', piPrefix: 'SEM', piPeriodMonths: 3,
    kpiDoneStatuses: 'Untested, Code Review', kpiDoneCategory: false, kpiRoleRules: [{ role: 'QA', doneStatuses: '', doneCategory: true }] });
});

test("a lead's member edits keep other teams and pin new members to the lead", () => {
  const st = fullState();
  const body = { baseVersion: 3, patch: { members: [
    { id: 'me', name: 'Lead Self', lead: '' },
    { id: 'a1', name: 'Andi Renamed', lead: '9' }, // cannot hand a member to another lead
    { id: 'c1', name: 'Citra' },
  ] } };
  const out = scope.widenPatch(st, body, LEAD);
  const byId = Object.fromEntries(out.patch.members.map((m) => [m.id, m]));
  assert.deepEqual(out.patch.members.map((m) => m.id), ['me', 'a1', 'b1', 'n1', 'c1']);
  assert.equal(byId.a1.name, 'Andi Renamed');
  assert.equal(byId.a1.lead, '7');
  assert.equal(byId.c1.lead, '7');
  assert.equal(byId.me.lead, '1', "the lead's own card keeps the lead an admin gave it");
  assert.equal(byId.b1.name, 'Budi');
  assert.equal(out.baseVersion, 3);
  assert.equal(out.patch.settings, undefined);
});

test("a lead cannot take over another team's member by sending its id", () => {
  const st = fullState();
  const out = scope.widenPatch(st, { patch: { members: [
    { id: 'me', name: 'Lead Self' }, { id: 'a1', name: 'Andi' }, { id: 'b1', name: 'Stolen' },
  ] } }, LEAD);
  const b1 = out.patch.members.find((m) => m.id === 'b1');
  assert.equal(b1.name, 'Budi');
  assert.equal(b1.lead, '9');
});

test("a lead removing a member only removes one of their own", () => {
  const out = scope.widenPatch(fullState(), { patch: { members: [{ id: 'me', name: 'Lead Self' }] } }, LEAD);
  assert.deepEqual(out.patch.members.map((m) => m.id), ['me', 'b1', 'n1']);
});

test("a lead's day save keeps other teams' notes and drops JIRA data", () => {
  const st = fullState();
  const out = scope.widenPatch(st, { patch: { days: { upsert: { '2026-09-30': {
    startedAt: '2026-09-30T02:00:00Z',
    entries: { a1: { today: 'a edited' }, b1: { today: 'hijack' } },
    roster: [{ id: 'me', name: 'Lead Self' }, { id: 'a1', name: 'Andi' }],
    jira: { syncedAt: 'later', issues: [] },
  } }, delete: [] } } }, LEAD);
  const day = out.patch.days.upsert['2026-09-30'];
  assert.equal(day.entries.a1.today, 'a edited');
  assert.equal(day.entries.b1.today, 'b work');
  assert.equal(day.jira, null);
  assert.deepEqual(day.roster.map((m) => m.id).sort(), ['a1', 'b1', 'me', 'n1']);
});

test('a lead cannot cancel a day another team already wrote in', () => {
  const st = fullState();
  const out = scope.widenPatch(st, { patch: { days: { upsert: {
    '2026-09-30': { startedAt: null, entries: {}, roster: null, jira: null },
  }, delete: [] } } }, LEAD);
  const day = out.patch.days.upsert['2026-09-30'];
  assert.equal(day.startedAt, '2026-09-30T02:00:00Z');
  assert.deepEqual(Object.keys(day.entries), ['b1']);
});

test("a lead's delete of a day only clears their part while others wrote in it", () => {
  const out = scope.widenPatch(fullState(), { patch: { days: { upsert: {}, delete: ['2026-09-30'] } } }, LEAD);
  assert.deepEqual(out.patch.days.delete, []);
  assert.deepEqual(Object.keys(out.patch.days.upsert['2026-09-30'].entries), ['b1']);
});

test('a day only the lead wrote in can be cancelled and deleted', () => {
  const st = fullState();
  st.days['2026-09-30'].entries = { a1: { today: 'x' } };
  const cancelled = scope.widenPatch(st, { patch: { days: { upsert: {
    '2026-09-30': { startedAt: null, entries: {}, roster: null },
  } } } }, LEAD);
  assert.equal(cancelled.patch.days.upsert['2026-09-30'].startedAt, null);
  const deleted = scope.widenPatch(st, { patch: { days: { delete: ['2026-09-30'] } } }, LEAD);
  assert.deepEqual(deleted.patch.days.delete, ['2026-09-30']);
});

test("a lead's mapping only adds their own members and keeps everyone else's", () => {
  const st = fullState();
  st.days['2026-09-30'].jira.issues.push({ key: 'X-7', assignee: { accountId: 'acc-a2', name: 'Andi' } });
  const out = scope.widenPatch(st, { patch: { mapping: {
    'acc-a2': 'a1', 'acc-b': 'a1', 'acc-x': 'b1',
  } } }, LEAD);
  assert.deepEqual(out.patch.mapping, { 'acc-b': 'b1', 'acc-a2': 'a1' });
});

const membersPatch = (extra) => ({ patch: { members: [
  { id: 'me', name: 'Lead Self' }, { id: 'a1', name: 'Andi', email: 'andi@x.com' }, ...extra,
] } });
const refusal = (fn) => {
  try { fn(); } catch (e) { return e; }
  return null;
};

test("a lead cannot give their member another team's email", () => {
  const added = refusal(() => scope.widenPatch(fullState(), membersPatch([{ id: 'c1', name: 'Spy', email: ' BUDI@x.com ' }]), LEAD));
  assert.equal(added && added.status, 403);
  const edited = refusal(() => scope.widenPatch(fullState(), { patch: { members: [
    { id: 'me', name: 'Lead Self' }, { id: 'a1', name: 'Andi', email: 'budi@x.com' },
  ] } }, LEAD));
  assert.equal(edited && edited.status, 403);
});

test("a lead cannot give their member another team's name", () => {
  const e = refusal(() => scope.widenPatch(fullState(), { patch: { members: [
    { id: 'me', name: 'Lead Self' }, { id: 'a1', name: 'nora', email: 'andi@x.com' },
  ] } }, LEAD));
  assert.equal(e && e.status, 403);
});

test('a clash an admin made does not block the lead from saving', () => {
  const st = fullState();
  st.members[1].email = 'budi@x.com';
  const out = scope.widenPatch(st, { patch: { members: [
    { id: 'me', name: 'Lead Self' }, { id: 'a1', name: 'Andi', email: 'budi@x.com', role: 'Dev' },
  ] } }, LEAD);
  assert.equal(out.patch.members.find((m) => m.id === 'a1').role, 'Dev');
});

test("a lead can only map JIRA accounts seen on the board that are not another team's", () => {
  const st = fullState();
  st.days['2026-09-30'].jira.issues.push(
    { key: 'X-4', assignee: { accountId: 'acc-n', name: 'Nora' } },
    { key: 'X-5', assignee: { accountId: 'acc-b2', email: 'BUDI@x.com', name: 'B' } },
    { key: 'X-6', assignee: { accountId: 'acc-a2', email: 'andi@x.com', name: 'Andi' } },
  );
  const out = scope.widenPatch(st, { patch: { mapping: {
    'acc-a': 'a1', 'acc-a2': 'a1', 'acc-n': 'a1', 'acc-b2': 'a1', 'acc-unseen': 'a1',
  } } }, LEAD);
  assert.deepEqual(out.patch.mapping, { 'acc-b': 'b1', 'acc-a': 'a1', 'acc-a2': 'a1' });
});

test('KPI tasks and sprint issues are narrowed to the scope', () => {
  const st = fullState();
  const ids = scope.scopedMemberIds(st.members, LEAD);
  const tasks = [
    { key: 'K-1', accountId: 'acc-a' },
    { key: 'K-2', assigneeEmail: 'BUDI@x.com' },
    { key: 'K-3', assigneeName: 'andi' },
    { key: 'K-4' },
  ];
  assert.deepEqual(scope.scopeKpiTasks(tasks, ids, st.members, st.mapping).map((t) => t.key), ['K-1', 'K-3']);
});

test('a lead KPI report keeps only sprints with their tasks, plus ones not computed yet', () => {
  const st = fullState();
  const ids = scope.scopedMemberIds(st.members, LEAD);
  const report = {
    month: '2026-09', months: ['2026-09'], computedAt: '2026-09-01T00:00:00Z',
    sprints: [
      { id: 1, name: 'Mine', status: 'ok', computedAt: '2026-09-10T00:00:00Z' },
      { id: 2, name: 'Other team', status: 'ok', computedAt: '2026-09-01T00:00:00Z' },
      { id: 3, name: 'Pending', status: 'pending', computedAt: null },
    ],
    tasks: [{ sprintId: 1, key: 'K-1', accountId: 'acc-a' }, { sprintId: 2, key: 'K-2', assigneeEmail: 'budi@x.com' }],
  };
  const out = scope.scopeKpiReport(report, ids, st.members, st.mapping);
  assert.deepEqual(out.sprints.map((s) => s.name), ['Mine', 'Pending']);
  assert.deepEqual(out.tasks.map((t) => t.key), ['K-1']);
  assert.equal(out.computedAt, '2026-09-10T00:00:00Z', 'oldest stamp of the kept sprints only');
  assert.equal(out.month, '2026-09');
  assert.equal(report.sprints.length, 3, 'the input is not mutated');
});
