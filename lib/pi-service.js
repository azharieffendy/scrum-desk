/*
 * Performance report (PI) service: GET /api/pi, POST /api/pi (refresh) and GET /api/pi/preview (admins only).
 * One search per person; hours are each ticket's Time Spent (JIRA's Time tracking).
 * A finished period is saved per person (lib/pi-db.js)
 * and served from there until an admin refreshes it (POST /api/pi).
 */
'use strict';

const db = require('./db.js');
const jk = require('./jira-kpi.js');
const pi = require('./pi-core.js');
const periods = require('../public/pi-periods.js');
const { jiraAccess, pickPointsField, knownSprintField } = require('./kpi-service.js');
const { httpError } = require('./http-utils.js');

const BASE_FIELDS = ['issuetype', 'summary', 'assignee', 'reporter', 'priority', 'status', 'resolution',
  'created', 'updated', 'duedate', 'timespent', 'resolutiondate'];

const teamTz = () => db.getTimezone() || 'UTC';
// bump when a saved person's result changes shape, so old entries are fetched again
const PI_CACHE_VERSION = 2;

/** The JQL user value for a member: a mapped JIRA account ID, else their email; '' when neither is safe. */
function assigneeOf(member, mapping) {
  const accounts = Object.entries(mapping || {}).filter(([, id]) => id === member.id).map(([a]) => a).sort();
  const candidates = accounts.concat(member.email ? [member.email.trim().toLowerCase()] : []);
  return candidates.find((v) => pi.JQL_USER.test(v)) || '';
}

/**
 * People on the report: the ticked KPI members (nobody ticked = whole team)
 * plus the signed-in admin's own member, once. Team order is kept.
 * team (a Set of member IDs) is a Technical Lead's own team, which replaces the KPI pick.
 */
function piPeople(st, selfMemberId, team) {
  const picked = new Set(st.settings.kpiMembers || []);
  const chosen = st.members.filter((m) => picked.has(m.id));
  const ids = team ? new Set(team) : new Set((chosen.length ? chosen : st.members).map((m) => m.id));
  if (selfMemberId) ids.add(selfMemberId);
  return st.members.filter((m) => ids.has(m.id))
    .map((m) => ({ id: m.id, name: m.name || m.id, assignee: assigneeOf(m, st.mapping), self: m.id === selfMemberId }));
}

function createPiService(options = {}) {
  const wait = options.wait;
  const now = options.now || Date.now;

  function template() {
    return db.loadState().settings.piJql || pi.DEFAULT_TEMPLATE;
  }

  function periodOrDefault(p) {
    const months = db.loadState().settings.piPeriodMonths;
    const period = p == null || p === '' ? pi.lastFinishedPeriod(now(), teamTz(), months) : p;
    if (!pi.isValidPeriod(period)) {
      throw httpError(400, 'Unknown period — use e.g. 2026 (year), 2026-H2, 2026-P2 (4 months), 2026-Q3, 2026-B5 or 2026-09.');
    }
    return period;
  }

  function jqlFor(person, range) {
    if (!person.assignee) throw new Error('No JIRA account mapped and no email — map them in Settings → JIRA.');
    return pi.fillTemplate(template(), { assignee: person.assignee, ...range });
  }

  async function pointsField(access) {
    let field = db.getKpiSettings().pointsField;
    if (!field) {
      field = pickPointsField(await jk.storyPointFields(access.site, access.auth, { wait }));
      if (field) db.setKpiSetting('pointsField', field);
    }
    return field;
  }

  /** The site's Sprint field (remembered after the first lookup), or '' — tickets then simply carry no sprint. */
  async function sprintField(access) {
    try {
      return await knownSprintField(access.site, access.auth, { wait });
    } catch {
      return '';
    }
  }

  async function personReport(person, ctx) {
    const out = { id: person.id, name: person.name, assignee: person.assignee, self: person.self,
      jql: '', error: null, rows: [], totals: pi.totals([]), cachedAt: null };
    try {
      out.jql = jqlFor(person, ctx.range);
      const sig = JSON.stringify({ v: PI_CACHE_VERSION, site: ctx.access.site, jql: out.jql,
        points: ctx.field || '', sprint: ctx.sprint || '', tz: ctx.tz });
      const hit = ctx.finished && !ctx.refresh ? db.getPiCache(ctx.period, person.id, sig) : null;
      if (hit) return Object.assign(out, { rows: hit.data.rows, totals: pi.totals(hit.data.rows), cachedAt: hit.fetchedAt });
      const raw = await jk.searchIssues(ctx.access.site, ctx.access.auth, out.jql,
        BASE_FIELDS.concat([ctx.field, ctx.sprint].filter(Boolean)), { wait });
      out.rows = raw.map((issue) => pi.toPiRow(issue, ctx.field, ctx.sprint));
      out.totals = pi.totals(out.rows);
      if (ctx.finished) db.setPiCache(ctx.period, person.id, sig, { rows: out.rows }, ctx.fetchedAt);
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }

  function selfInfo(st, selfMemberId) {
    const m = selfMemberId && st.members.find((x) => x.id === selfMemberId);
    return m ? { memberId: m.id, name: m.name } : null;
  }

  async function report(periodParam, selfMemberId, team, creds, refresh) {
    const period = periodOrDefault(periodParam);
    const access = jiraAccess(creds);
    if (!access) throw httpError(400, 'JIRA is not configured — add the site, email and API token in Settings.');
    const err = pi.validateTemplate(template());
    if (err) throw httpError(400, err + ' Fix it in Settings → Performance report.');
    const st = db.loadState();
    const range = pi.periodRange(period);
    let field;
    try {
      field = await pointsField(access);
    } catch (e) {
      throw httpError(502, 'JIRA: ' + e.message);
    }
    const sprint = await sprintField(access);
    const tz = teamTz();
    const fetchedAt = new Date(now()).toISOString();
    // finished = the period's last day is before today in the team's timezone
    const finished = range.end < new Date(now()).toLocaleDateString('sv-SE', { timeZone: tz });
    const ctx = { access, field, sprint, range, period, tz, finished, refresh: Boolean(refresh), fetchedAt };
    const people = [];
    // one person at a time, so a large team doesn't hit JIRA's rate limit all at once
    for (const person of piPeople(st, selfMemberId, team)) people.push(await personReport(person, ctx));
    const saved = people.map((p) => p.cachedAt).filter(Boolean).sort();
    return {
      period, months: periods.lengthOf(period), name: pi.periodName(period), label: pi.periodLabel(period), start: range.start, end: range.end,
      prefix: st.settings.piPrefix || pi.DEFAULT_PREFIX, pointsField: field || null,
      you: selfInfo(st, selfMemberId), generatedAt: fetchedAt, finished, cachedAt: saved[0] || null, people,
    };
  }

  function preview(periodParam, personId, team) {
    const period = periodOrDefault(periodParam);
    const st = db.loadState();
    const m = st.members.find((x) => x.id === personId && (!team || team.has(x.id)));
    if (!m) throw httpError(404, 'No such team member.');
    const person = { id: m.id, name: m.name || m.id, assignee: assigneeOf(m, st.mapping) };
    try {
      return { period, person: person.name, jql: jqlFor(person, pi.periodRange(period)) };
    } catch (e) {
      throw httpError(400, e.message);
    }
  }

  /**
   * { method, path, period, person, admin, memberId, team, creds } → { status, payload }
   * GET serves a finished period from its saved copy; POST /api/pi reads JIRA again and
   * overwrites it, so a link or a prefetch can never replace the saved results.
   */
  async function handleRequest(req) {
    try {
      const refresh = req.method === 'POST' && req.path === '/api/pi';
      if (req.method !== 'GET' && !refresh) return { status: 405, payload: { error: 'GET, or POST to refresh.' } };
      if (!req.admin) return { status: 403, payload: { error: 'Only admins can generate the Performance report.' } };
      if (req.path === '/api/pi/preview') return { status: 200, payload: preview(req.period, req.person, req.team) };
      return { status: 200, payload: await report(req.period, req.memberId, req.team, req.creds, refresh) };
    } catch (e) {
      if (e.status && e.status < 600) return { status: e.status, payload: { error: e.message } };
      throw e;
    }
  }

  return { handleRequest, report };
}

module.exports = { createPiService, piPeople, assigneeOf };
