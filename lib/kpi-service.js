/*
 * KPI report service: refreshes months from JIRA into the KPI tables and
 * serves GET /api/kpi and POST /api/kpi/refresh.
 * Sprint delivery rules and refresh policy.
 */
'use strict';

const db = require('./db.js');
const core = require('./jira-core.js');
const jk = require('./jira-kpi.js');
const kpi = require('./kpi-core.js');
const scope = require('./team-scope.js');
const { httpError } = require('./http-utils.js');
const { isValidMonth } = require('../public/monthly-report.js');

const DEFAULT_BUDGET_MS = 90 * 1000;
const BACKGROUND_EVERY_MS = 5 * 60 * 1000;
const STORY_POINTS_NAME = /^story points$/i;
// sprint discovery looks at issues updated since this many days before the month starts
const LOOKBACK_DAYS = 90;
// JQL user values are quoted as-is, so anything that could break out of the quotes is dropped
const JQL_USER = /^[^"'\\\s()]{1,128}$/;

/**
 * JIRA site + auth header: environment variables first, then the given
 * credentials (a user's own key, see db.credsForUser), else the team's.
 */
function jiraAccess(creds) {
  const env = process.env;
  const c = creds || db.getCreds();
  const fromEnv = Boolean(env.JIRA_SITE && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
  const site = core.normalizeSite(fromEnv ? env.JIRA_SITE : c.site);
  if (!site || (!fromEnv && !(c.email && c.token))) return null;
  return { site, auth: core.authHeader(fromEnv ? env.JIRA_EMAIL : c.email, fromEnv ? env.JIRA_API_TOKEN : c.token) };
}

/** Prefers the field named exactly "Story Points"; '' when there is none. */
/** The site's Sprint field ID: remembered in settings after the first lookup ('' when the site has none). */
async function knownSprintField(site, auth, opts) {
  let field = db.getKpiSettings().sprintField;
  if (!field) {
    field = await jk.sprintFieldId(site, auth, opts);
    if (field) db.setKpiSetting('sprintField', field);
  }
  return field;
}

function pickPointsField(fields) {
  const pick = fields.find((f) => STORY_POINTS_NAME.test(f.name)) || fields[0];
  return pick ? pick.id : '';
}

const teamTz = () => db.getTimezone() || 'UTC';

/**
 * JQL user values for the KPI: mapped JIRA account IDs and emails of the
 * ticked KPI members (nobody ticked, or none still on the team = the whole team).
 */
function kpiPeople() {
  const st = db.loadState();
  const picked = new Set(st.settings.kpiMembers || []);
  const chosen = st.members.filter((m) => picked.has(m.id));
  const team = chosen.length ? chosen : st.members;
  const ids = new Set(team.map((m) => m.id));
  const values = new Set();
  for (const [account, memberId] of Object.entries(st.mapping || {})) if (ids.has(memberId)) values.add(account);
  for (const m of team) if (m.email) values.add(m.email.trim().toLowerCase());
  return [...values].filter((v) => JQL_USER.test(v)).sort();
}

const assigneeWasIn = (people) => 'assignee WAS IN (' + people.map((p) => '"' + p + '"').join(', ') + ')';

/** "YYYY-MM-DD", LOOKBACK_DAYS before the first day of the earliest month. */
function discoverySince(months) {
  const first = [...months].sort()[0];
  return new Date(Date.parse(first + '-01T00:00:00Z') - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
}

/** A sprint needs JIRA unless it was computed after it closed, without error. */
const needsFetch = (s) => !(s.computedAt && s.computedState === 'closed' && !s.lastError);

function createKpiService(options = {}) {
  const wait = options.wait;
  const now = options.now || Date.now;
  const budgetMs = options.budgetMs == null ? DEFAULT_BUDGET_MS : options.budgetMs;
  let refreshing = false;
  let lastBackground = 0;
  let pending = new Set(); // sprint IDs cut off by the last refresh's time budget

  const currentMonth = () => new Date(now()).toLocaleDateString('sv-SE', { timeZone: teamTz() }).slice(0, 7);
  // Read once at the start of each run and passed along, so a result is always stored
  // under the fingerprint of the rules it was computed with, even if an admin saves new ones meanwhile.
  const currentRules = () => {
    const { members, mapping } = db.getMembersAndMapping();
    return kpi.roleRulesPlan(db.getKpiRuleSettings(), members, mapping, (who) => scope.memberForPerson(who, members, mapping));
  };
  const context = (sprints, plan) => ({ sprints, categories: db.getKpiMeta('status_categories') || {}, tz: teamTz(),
    rules: plan.rules, rulesFor: plan.rulesFor });

  /** Recomputes sprints stored under other rules (code or settings) from their cached timelines (no JIRA). */
  function recomputeStale() {
    const plan = currentRules();
    const { signature } = plan;
    const stale = db.staleKpiSprints(signature);
    if (!stale.length) return 0;
    const ctx = context(db.listKpiSprints(), plan);
    for (const s of stale) {
      const timelines = db.getKpiTaskKeys(s.id).map(db.getIssueTimeline).filter(Boolean);
      db.saveKpiSprintResult(s.id, {
        state: s.computedState, rulesSignature: signature, computedAt: s.computedAt,
        tasks: timelines.map((tl) => kpi.classifyIssue(tl, s, ctx)), timelines: [], lastError: s.lastError,
      });
    }
    return stale.length;
  }

  function sprintStatus(s) {
    if (pending.has(s.id)) return 'pending';
    if (s.lastError) return 'error';
    return s.computedAt ? 'ok' : 'pending';
  }

  function monthReport(month, creds) {
    const sprints = db.listKpiSprints().filter((s) => s.month === month);
    const computed = sprints.map((s) => s.computedAt).filter(Boolean).sort();
    return {
      month,
      months: db.kpiMonths(),
      computedAt: computed[0] || null,
      configured: Boolean(jiraAccess(creds)),
      refreshing,
      sprints: sprints.map((s) => ({
        id: s.id, name: s.name, state: s.state, start: s.start, end: s.end, closedAt: s.closedAt,
        computedAt: s.computedAt, status: sprintStatus(s), error: s.lastError,
      })),
      tasks: db.getKpiTasks(sprints.map((s) => s.id)),
    };
  }

  /** Cached results only hold the people they were fetched for: a different set starts over. */
  function keepScope(people) {
    const scope = { people };
    if (JSON.stringify(db.getKpiMeta('scope')) === JSON.stringify(scope)) return;
    db.clearKpi();
    db.setKpiMeta('scope', scope);
  }

  /**
   * Points field, status categories and every sprint (any board) the KPI
   * people's issues are in, found by searching JIRA for them (JIRA errors → 502).
   */
  async function prepare(access, months) {
    const { site, auth } = access;
    const opts = { wait };
    const own = (message) => Object.assign(httpError(400, message), { own: true });
    try {
      const people = kpiPeople();
      if (!people.length) throw own('No KPI team member has a JIRA email — add one under Settings → Team.');
      const sprintField = await knownSprintField(site, auth, opts);
      if (!sprintField) throw own('This JIRA site has no Sprint field.');
      let pointsField = db.getKpiSettings().pointsField;
      if (!pointsField) {
        pointsField = pickPointsField(await jk.storyPointFields(site, auth, opts));
        if (pointsField) db.setKpiSetting('pointsField', pointsField);
      }
      const plan = currentRules();
      const categories = await jk.statusCategories(site, auth, opts);
      const jql = assigneeWasIn(people) + ' AND sprint IS NOT EMPTY AND updated >= "' + discoverySince(months) + '"';
      const sprints = (await jk.sprintsOfIssues(site, auth, jql, sprintField, opts)).filter((s) => s.start);
      // Only now that JIRA answered: a failed refresh must not wipe results that are still viewable.
      keepScope(people);
      db.setKpiMeta('status_categories', categories);
      const tz = teamTz();
      db.upsertKpiSprints(sprints.map((s) => Object.assign({}, s, { month: kpi.monthOf(s, tz) })));
      return { people, pointsField, sprintField, sprints, signature: plan.signature,
        ctx: { sprints, categories, tz, rules: plan.rules, rulesFor: plan.rulesFor } };
    } catch (e) {
      if (e.own) throw e;
      throw httpError(502, 'JIRA: ' + e.message);
    }
  }

  /** The sprint's issues that a KPI person was ever assigned, straight from a JIRA search. */
  async function refreshSprint(access, sprint, setup) {
    const jql = 'sprint = ' + Number(sprint.id) + ' AND ' + assigneeWasIn(setup.people) + ' ORDER BY key';
    const timelines = await jk.searchTimelines(access.site, access.auth, jql, {
      pointsField: setup.pointsField, sprintField: setup.sprintField, wait, cached: { get: db.getIssueTimeline },
    });
    db.saveKpiSprintResult(sprint.id, {
      state: sprint.state, rulesSignature: setup.signature, computedAt: new Date(now()).toISOString(),
      tasks: timelines.map((tl) => kpi.classifyIssue(tl, sprint, setup.ctx)), timelines, lastError: null,
    });
  }

  /** Fetches the given months' sprints that need JIRA, one sprint at a time within the time budget. */
  async function refreshMonths(months, creds) {
    if (refreshing) throw httpError(409, 'A KPI refresh is already running — try again shortly.');
    const access = jiraAccess(creds);
    if (!access) throw httpError(400, 'JIRA is not configured — add the site, email and API token in Settings.');
    refreshing = true;
    try {
      const deadline = now() + budgetMs;
      const setup = await prepare(access, months);
      const wanted = new Set(months);
      const byId = new Map(setup.sprints.map((s) => [s.id, s]));
      const targets = db.listKpiSprints()
        .filter((s) => wanted.has(s.month) && byId.has(s.id) && needsFetch(s))
        .map((s) => byId.get(s.id));
      pending = new Set();
      for (const sprint of targets) {
        if (now() >= deadline) { pending.add(sprint.id); continue; }
        try {
          await refreshSprint(access, sprint, setup);
        } catch (e) {
          db.setKpiSprintError(sprint.id, e.message);
        }
      }
    } finally {
      refreshing = false;
    }
  }

  /** After the sign-in JIRA sync: current month + months with sprints cached before they closed. */
  function backgroundRefresh(creds) {
    if (refreshing || now() - lastBackground < BACKGROUND_EVERY_MS || !jiraAccess(creds)) return Promise.resolve();
    lastBackground = now();
    return refreshMonths(db.kpiMonthsToRefresh(currentMonth()), creds)
      .catch((e) => console.warn('[kpi] background refresh failed: ' + e.message));
  }

  /** Story points fields for the Settings "Detect" button, with the one refreshes would pick. */
  async function pointsFields(creds) {
    const access = jiraAccess(creds);
    if (!access) throw httpError(400, 'JIRA is not configured — add the site, email and API token in Settings.');
    let fields;
    try {
      fields = await jk.storyPointFields(access.site, access.auth, { wait });
    } catch (e) {
      throw httpError(502, 'JIRA: ' + e.message);
    }
    return { fields, suggested: pickPointsField(fields) || null };
  }

  /** { method, path, month (query, null when absent), body, admin, creds } → { status, payload } */
  async function handleRequest(req) {
    try {
      if (req.path === '/api/kpi/fields') {
        if (req.method !== 'GET') return { status: 405, payload: { error: 'GET only.' } };
        if (!req.admin) return { status: 403, payload: { error: 'Only admins can change KPI settings.' } };
        return { status: 200, payload: await pointsFields(req.creds) };
      }
      if (req.path === '/api/kpi') {
        if (req.method !== 'GET') return { status: 405, payload: { error: 'GET only.' } };
        const month = req.month == null ? currentMonth() : req.month;
        if (!isValidMonth(month)) return { status: 400, payload: { error: 'Month must look like YYYY-MM.' } };
        recomputeStale();
        return { status: 200, payload: monthReport(month, req.creds) };
      }
      if (req.method !== 'POST') return { status: 405, payload: { error: 'POST only.' } };
      if (!req.admin) return { status: 403, payload: { error: 'Only admins can refresh the KPI report.' } };
      const month = (req.body || {}).month;
      if (!isValidMonth(month)) return { status: 400, payload: { error: 'Month must look like YYYY-MM.' } };
      await refreshMonths([month], req.creds);
      return { status: 200, payload: monthReport(month, req.creds) };
    } catch (e) {
      if (e.status && e.status < 600) return { status: e.status, payload: { error: e.message } };
      throw e;
    }
  }

  return { handleRequest, refreshMonths, recomputeStale, backgroundRefresh, monthReport };
}

module.exports = { createKpiService, jiraAccess, pickPointsField, knownSprintField };
