/*
 * Performance report (PI) — pure logic: periods (public/pi-periods.js), the per-person
 * JQL template, and raw JIRA issue → report row.
 */
'use strict';

const { parseTime } = require('./kpi-core.js');
const periods = require('../public/pi-periods.js');

const PLACEHOLDERS = ['{assignee}', '{start}'];
// JQL user values are quoted as-is, so anything that could break out of the quotes is refused
const JQL_USER = /^[^"'\\\s()]{1,128}$/;
const MAX_TEMPLATE = 4000;

// Generic across visible projects. {afterEnd} is exclusive, so the final day is included.
const DEFAULT_TEMPLATE = "assignee = '{assignee}' AND statusCategory = Done AND resolutionDate >= '{start}' AND resolutionDate < '{afterEnd}' ORDER BY created DESC";
const DEFAULT_PREFIX = 'TEAM';

const isValidPeriod = (p) => typeof p === 'string' && periods.isValid(p);

/** '2026-P2' → { start: '2026-05-01', end: '2026-08-31', afterEnd: '2026-09-01' } (plain dates). */
const periodRange = (p) => periods.range(p);

/** Period of the given length (default 4 months) containing the ms time, in the team timezone. */
function periodOf(t, tz, months) {
  return periods.ofDay(new Date(t).toLocaleDateString('sv-SE', { timeZone: tz || 'UTC' }), months);
}

const shiftPeriod = (p, by) => periods.shift(p, by);

/** The report is sent after a period ends, so the default is the one before today's. */
function lastFinishedPeriod(t, tz, months) {
  return shiftPeriod(periodOf(t, tz, months), -1);
}

/** '2026-P2' → 'MAY AUGUST' (file name words); periodLabel → 'May – Aug 2026'. */
const periodName = (p) => periods.words(p);
const periodLabel = (p) => periods.label(p);

/** '' when usable, else the reason. */
function validateTemplate(t) {
  if (typeof t !== 'string' || !t.trim()) return 'The report query is empty.';
  if (t.length > MAX_TEMPLATE) return 'The report query is too long (max ' + MAX_TEMPLATE + ' characters).';
  const missing = PLACEHOLDERS.filter((ph) => !t.includes(ph));
  if (!t.includes('{end}') && !t.includes('{afterEnd}')) missing.push('{end} or {afterEnd}');
  return missing.length ? 'The report query must contain ' + missing.join(', ') + '.' : '';
}

/** A template may use the last day, the exclusive next day, or both. */
function fillTemplate(t, { assignee, start, end, afterEnd }) {
  const err = validateTemplate(t);
  if (err) throw new Error(err);
  if (!JQL_USER.test(String(assignee || ''))) throw new Error('Unsafe or empty JIRA user value.');
  if (t.includes('{afterEnd}') && !afterEnd) throw new Error('The report query uses {afterEnd}, but no date was given for it.');
  return t.split('{assignee}').join(assignee).split('{start}').join(start).split('{end}').join(end)
    .split('{afterEnd}').join(afterEnd);
}

const name = (u) => (u && u.displayName) || '';
const accountId = (u) => (u && u.accountId) || '';
const named = (o) => (o && o.name) || '';
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The latest sprint (by start date, then ID) in a Sprint field value, as { name, start }; null when none. */
function lastSprint(value) {
  const list = [].concat(value || []).filter((s) => s && typeof s === 'object' && s.name);
  if (!list.length) return null;
  const startOf = (s) => parseTime(s.startDate) || '';
  const last = list.reduce((a, b) => {
    const sa = startOf(a); const sb = startOf(b);
    if (sa !== sb) return sb > sa ? b : a;
    return Number(b.id) > Number(a.id) ? b : a;
  });
  return { name: String(last.name), start: startOf(last) || null };
}

/**
 * Raw JIRA search issue → one row of the person sheet (dates as ISO strings, due date as YYYY-MM-DD).
 * sprintField: the site's Sprint field; the row keeps the ticket's latest sprint.
 */
function toPiRow(issue, pointsField, sprintField) {
  const f = issue.fields || {};
  const sprint = sprintField ? lastSprint(f[sprintField]) : null;
  return {
    type: named(f.issuetype),
    key: issue.key || '',
    id: issue.id ? String(issue.id) : '',
    summary: f.summary || '',
    assignee: name(f.assignee),
    assigneeId: accountId(f.assignee),
    reporter: name(f.reporter),
    reporterId: accountId(f.reporter),
    priority: named(f.priority),
    status: named(f.status),
    resolution: named(f.resolution),
    created: parseTime(f.created),
    updated: parseTime(f.updated),
    due: /^\d{4}-\d{2}-\d{2}$/.test(f.duedate || '') ? f.duedate : null,
    timeSpent: num(f.timespent),
    resolved: parseTime(f.resolutiondate),
    points: pointsField ? num(f[pointsField]) : null,
    sprint: sprint ? sprint.name : '',
    sprintStart: sprint ? sprint.start : null,
  };
}

/** Totals block: Time Spent (JIRA's Time tracking) in seconds and hours, story points, ticket count. */
function totals(rows) {
  const seconds = rows.reduce((s, r) => s + (r.timeSpent || 0), 0);
  const points = rows.reduce((s, r) => s + (r.points || 0), 0);
  return { seconds, hours: seconds / 3600, points, count: rows.length };
}

module.exports = {
  DEFAULT_TEMPLATE, DEFAULT_PREFIX, JQL_USER, MAX_TEMPLATE,
  isValidPeriod, periodRange, periodOf, shiftPeriod, lastFinishedPeriod, periodName, periodLabel,
  validateTemplate, fillTemplate, toPiRow, totals,
};
