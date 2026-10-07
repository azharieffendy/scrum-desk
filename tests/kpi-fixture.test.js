/*
 * Regression test on synthetic JIRA-shaped sprint data
 * (tests/fixtures/kpi-sprint.json): the counting rules must keep giving the
 * expected delivery outcomes.
 * Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kpi = require('../lib/kpi-core.js');
const fixture = require('./fixtures/kpi-sprint.json');

const sprints = fixture.sprints.map(kpi.normalizeSprint);
const target = sprints.find((s) => s.id === fixture.targetSprintId);
const ctx = { sprints, categories: fixture.categories, tz: fixture.tz };

test('fixture: target sprint is present and closed', () => {
  assert.ok(target);
  assert.equal(target.state, 'closed');
  assert.ok(target.closedAt);
});

test('fixture: every synthetic issue keeps its expected outcome', () => {
  for (const raw of fixture.issues) {
    const res = kpi.classifyIssue(kpi.toTimeline(raw, fixture.pointsField), target, ctx);
    assert.equal(res.outcome, fixture.expected[raw.key], raw.key + ': ' + res.reason);
    assert.ok(res.accountId, raw.key + ' should have an assignee');
  }
});

test('fixture: covers done, carry-over and excluded', () => {
  const seen = new Set(Object.values(fixture.expected));
  for (const o of ['done', 'carryover', 'excluded']) assert.ok(seen.has(o), 'missing ' + o);
});

test('fixture: summary totals follow the outcomes', () => {
  const tasks = fixture.issues.map((raw) => kpi.classifyIssue(kpi.toTimeline(raw, fixture.pointsField), target, ctx));
  const rows = kpi.summarize(tasks);
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const count = (o) => Object.values(fixture.expected).filter((x) => x === o).length;
  assert.equal(sum('done'), count('done'));
  assert.equal(sum('carryover'), count('carryover'));
  assert.equal(sum('excluded'), count('excluded'));
});
