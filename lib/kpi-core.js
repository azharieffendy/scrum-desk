/*
 * KPI counting rules: sprint delivery vs carry-over. Pure functions, no I/O.
 *
 * Raw JIRA issues are first reduced to a small "timeline" (toTimeline), which
 * is what the database stores. Everything else works on timelines only, so
 * a rule change can be recomputed locally without calling JIRA again.
 * Bump KPI_RULES_VERSION on any change to a code rule; the configurable
 * delivery criteria are covered by fingerprint().
 */
'use strict';

const crypto = require('crypto');

// 3: the generic default counts only JIRA's Done category.
const KPI_RULES_VERSION = 3;

/**
 * Settings → rules. labels keep the typed spelling (first one wins) for texts;
 * doneStatuses is the lower-cased, sorted list used for matching.
 */
function normalizeRules(input) {
  const src = input || {};
  const list = Array.isArray(src.doneStatuses) ? src.doneStatuses : [];
  const seen = new Set();
  const labels = [];
  for (const raw of list) {
    const label = String(raw == null ? '' : raw).trim();
    if (label && !seen.has(label.toLowerCase())) { seen.add(label.toLowerCase()); labels.push(label); }
  }
  return { doneStatuses: [...seen].sort(), labels, doneCategory: src.doneCategory === undefined ? true : Boolean(src.doneCategory) };
}

/** Generic default: JIRA's Done category. */
const DEFAULT_RULES = Object.freeze(normalizeRules({ doneStatuses: [], doneCategory: true }));

/**
 * Stored with each computed sprint; a different value means the sprint is recomputed.
 * Keyed on the labels as typed, in order: they are written into the stored reasons
 * (for example, "Not Ready for QA/Done when …"), so a spelling or order change refreshes those too.
 */
function fingerprint(rules) {
  const r = normalizeRules(rules && { doneStatuses: rules.labels || rules.doneStatuses, doneCategory: rules.doneCategory });
  return KPI_RULES_VERSION + '|' + r.labels.join(',') + '|' + (r.doneCategory ? '1' : '0');
}

/**
 * Per-role rules → { rules, rulesFor, signature }. settings = getKpiRuleSettings() output;
 * memberFor(person) → team member or null (team-scope's memberForPerson). A person whose
 * member's role (any case) has a row is judged by it; everyone else by the default rules.
 * With role rules the signature also covers the members and mapping, so a role, name,
 * email or mapping change recomputes the stored sprints.
 */
function roleRulesPlan(settings, members, mapping, memberFor) {
  const rules = normalizeRules(settings);
  const base = fingerprint(rules);
  const byRole = new Map((settings.roleRules || []).map((r) => [r.role.trim().toLowerCase(), normalizeRules(r)]));
  if (!byRole.size) return { rules, rulesFor: null, signature: base };
  const roleOf = (m) => byRole.get(String(m.role || '').trim().toLowerCase()) || null;
  const rulesFor = (who) => {
    const m = who ? memberFor(who) : null;
    return m ? roleOf(m) : null;
  };
  const who = members.map((m) => [m.id, m.name, m.email, roleOf(m) ? fingerprint(roleOf(m)) : '']);
  const map = Object.keys(mapping || {}).sort().map((k) => [k, mapping[k]]);
  const hash = crypto.createHash('sha1').update(JSON.stringify([who, map])).digest('hex').slice(0, 12);
  return { rules, rulesFor, signature: base + '|roles:' + hash };
}

/** The delivery statuses as reason texts name them. */
const doneLabel = (rules) => rules.labels.concat(rules.doneCategory ? ['Done'] : []).join('/');

// ---------- time helpers ----------

/** JIRA times look like 2026-09-14T17:00:00.000+0700; returns UTC ISO or null. */
function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const isoOf = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const dateIn = (t, tz) => new Date(t).toLocaleDateString('sv-SE', { timeZone: tz || 'UTC' });

// ---------- raw JIRA → stored shapes ----------

function normalizeSprint(raw) {
  const end = parseTime(raw.endDate);
  return {
    id: raw.id,
    name: raw.name || '',
    state: raw.state || '',
    // the agile API gives originBoardId; the Sprint field on searched issues gives boardId
    boardId: raw.originBoardId != null ? raw.originBoardId : (raw.boardId != null ? raw.boardId : null),
    start: parseTime(raw.startDate),
    end,
    closedAt: raw.completeDate ? parseTime(raw.completeDate) : (raw.state === 'closed' ? end : null),
  };
}

const sprintIds = (value) => String(value || '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);

function person(accountId, name, email) {
  if (!accountId && !name) return null;
  return { accountId: accountId || null, name: name || null, email: email || null };
}

function currentSprintIds(f) {
  const list = [].concat(f.sprint || [], f.closedSprints || []);
  return [...new Set(list.map((s) => s && s.id).filter(Boolean))];
}

/** Reduces a raw issue (fields + changelog) to the stored timeline. */
function toTimeline(issue, pointsField) {
  const f = issue.fields || {};
  const histories = ((issue.changelog && issue.changelog.histories) || []).slice()
    .sort((a, b) => (ms(parseTime(a.created)) - ms(parseTime(b.created))) || (Number(a.id) - Number(b.id)));
  const status = [];
  const assignees = [];
  const sprints = [];
  let initialStatusName = null;
  for (const h of histories) {
    const at = parseTime(h.created);
    for (const item of h.items || []) {
      const field = String(item.field || '').toLowerCase();
      if (field === 'status') {
        if (!status.length) initialStatusName = item.fromString || null;
        status.push({ at, fromId: item.from || null, toId: item.to || null, toName: item.toString || '' });
      } else if (field === 'assignee') {
        assignees.push({ at,
          from: person(item.from || item.tmpFromAccountId, item.fromString),
          to: person(item.to || item.tmpToAccountId, item.toString) });
      } else if (field === 'sprint') {
        sprints.push({ at, from: sprintIds(item.from), to: sprintIds(item.to) });
      }
    }
  }
  const st = f.status || {};
  const points = Number(f[pointsField]);
  const a = f.assignee;
  return {
    key: issue.key,
    summary: f.summary || '(no summary)',
    type: f.issuetype ? f.issuetype.name : '',
    created: parseTime(f.created),
    updated: parseTime(f.updated),
    points: Number.isFinite(points) ? points : 0,
    assignee: a ? person(a.accountId, a.displayName || a.name, a.emailAddress) : null,
    initialStatus: status.length
      ? { id: status[0].fromId, name: initialStatusName }
      : { id: st.id || null, name: st.name || '' },
    status,
    assignees,
    initialSprints: sprints.length ? sprints[0].from : currentSprintIds(f),
    sprints,
  };
}

// ---------- rules ----------

/** A delivery status by name (any case), or (when the rules say so) any status whose ID is in the Done category. */
function isDoneStatus(id, name, categories, rules = DEFAULT_RULES) {
  if (rules.doneStatuses.includes(String(name || '').toLowerCase())) return true;
  return rules.doneCategory && Boolean(id) && (categories || {})[String(id)] === 'done';
}

/** rules: one rules object for everyone, or a function person → rules (per-role rules). */
const pickerOf = (rules) => (typeof rules === 'function' ? (who) => rules(who) || DEFAULT_RULES : () => rules || DEFAULT_RULES);

/**
 * First moment the task reached a delivery status: { t, name, who } or null. Each move is
 * judged by the rules of who held the task just before it, and credited to them.
 */
function firstDelivery(tl, categories, rules = DEFAULT_RULES) {
  const rulesOf = pickerOf(rules);
  const init = tl.initialStatus || {};
  const created = Number.isFinite(ms(tl.created)) ? ms(tl.created) : -Infinity;
  const creator = assigneeAt(tl, created);
  if (isDoneStatus(init.id, init.name, categories, rulesOf(creator))) return { t: created, name: init.name, who: creator };
  for (const s of tl.status) {
    const t = ms(s.at);
    const who = assigneeAt(tl, t - 1);
    if (isDoneStatus(s.toId, s.toName, categories, rulesOf(who))) return { t, name: s.toName, who };
  }
  return null;
}

/** Sprint IDs the task belonged to at time t. */
function sprintsAt(tl, t) {
  let set = tl.initialSprints;
  for (const c of tl.sprints) if (ms(c.at) <= t) set = c.to;
  return new Set(set);
}

function everInSprints(tl) {
  const all = new Set(tl.initialSprints);
  for (const c of tl.sprints) c.to.forEach((id) => all.add(id));
  return all;
}

const startOf = (s) => ms(s.start);
const closeOf = (s) => (s.closedAt ? ms(s.closedAt) : Infinity);

/**
 * The sprint the task's first delivery is credited to, or null:
 * inside the window of a sprint it was in → that sprint; between the close
 * of a sprint it was carried over from and the start of the next sprint it
 * is in → that next sprint; otherwise null.
 */
function creditedSprint(tl, sprints, categories, rules = DEFAULT_RULES, d = firstDelivery(tl, categories, rules)) {
  if (!d) return null;
  const known = sprints.filter((s) => s.start).slice().sort((a, b) => startOf(a) - startOf(b));
  const inAtT = sprintsAt(tl, d.t);
  const inside = known.find((s) => startOf(s) <= d.t && d.t <= closeOf(s) && inAtT.has(s.id));
  if (inside) return inside.id;
  const ever = everInSprints(tl);
  const next = known.find((s) => startOf(s) > d.t && ever.has(s.id));
  if (!next) return null;
  const carried = known.some((s) => s.closedAt && closeOf(s) <= d.t && sprintsAt(tl, closeOf(s)).has(s.id));
  return carried ? next.id : null;
}

/** Assignee at time t, rebuilt from the changelog; current assignee as fallback. */
function assigneeAt(tl, t) {
  let who;
  const before = tl.assignees.filter((c) => ms(c.at) <= t);
  if (before.length) who = before[before.length - 1].to;
  else if (tl.assignees.length) who = tl.assignees[0].from;
  else who = tl.assignee;
  if (!who) return null;
  const cur = tl.assignee;
  const email = cur && cur.accountId && cur.accountId === who.accountId ? cur.email : null;
  return { accountId: who.accountId, name: who.name, email };
}

/**
 * Outcome of one task in one sprint.
 * ctx = { sprints (all board sprints, normalized), categories (status ID → category key), tz,
 *         rules (normalizeRules output; DEFAULT_RULES when absent),
 *         rulesFor (optional: person → their role's rules; null/undefined = ctx.rules) }.
 */
function classifyIssue(tl, sprint, ctx) {
  const { sprints, categories, tz } = ctx;
  const base = ctx.rules || DEFAULT_RULES;
  const rulesOf = ctx.rulesFor ? (who) => ctx.rulesFor(who) || base : () => base;
  const d = firstDelivery(tl, categories, rulesOf);
  const creditedId = creditedSprint(tl, sprints, categories, rulesOf, d);
  const credited = sprints.find((s) => s.id === creditedId) || null;
  const day = (t) => dateIn(t, tz);
  const result = (outcome, t, who, reason) => ({
    key: tl.key, summary: tl.summary, type: tl.type, points: tl.points,
    outcome, at: isoOf(t),
    accountId: who ? who.accountId : null, name: who ? who.name : null, email: who ? who.email : null,
    reason,
  });

  if (creditedId === sprint.id) {
    const when = d.t < startOf(sprint)
      ? 'between sprints, after being carried over into ' + sprint.name
      : 'during ' + sprint.name;
    return result('done', d.t, d.who, 'Reached ' + d.name + ' on ' + day(d.t) + ' ' + when + '.');
  }
  if (credited && startOf(credited) < startOf(sprint)) {
    return result('excluded', d.t, d.who,
      'Already delivered in ' + credited.name + ' (' + d.name + ' on ' + day(d.t) + '); counted there once.');
  }
  if (!credited && d && d.t < startOf(sprint)) {
    return result('excluded', d.t, d.who,
      'Reached ' + d.name + ' on ' + day(d.t) + ', before this sprint and outside any sprint window.');
  }
  if (sprint.closedAt) {
    const closed = closeOf(sprint);
    const late = d && d.t > closed ? ' Reached ' + d.name + ' later, on ' + day(d.t) + '.' : '';
    const holder = assigneeAt(tl, closed);
    return result('carryover', closed, holder,
      'Not ' + doneLabel(rulesOf(holder)) + ' when ' + sprint.name + ' closed on ' + day(closed) + '.' + late);
  }
  return result('open', NaN, tl.assignee, 'Not delivered yet; ' + sprint.name + ' is still active.');
}

/** "YYYY-MM" of the sprint's start date in the team timezone. */
function monthOf(sprint, tz) {
  return dateIn(ms(sprint.start), tz).slice(0, 7);
}

/**
 * Team totals per computed sprint, oldest first: the raw material for the
 * delivery trend. Sprints without a computed result are left out; a computed
 * sprint with no tasks keeps a zero row. Tasks for unknown sprints are dropped.
 */
function sprintTrend(sprints, tasks) {
  const totals = new Map();
  for (const t of tasks || []) {
    if (!totals.has(t.sprintId)) {
      totals.set(t.sprintId, { done: 0, carryover: 0, open: 0, excluded: 0, spDone: 0, spCarryover: 0, spOpen: 0 });
    }
    const r = totals.get(t.sprintId);
    if (r[t.outcome] !== undefined) r[t.outcome] += 1;
    const pts = Number(t.points) || 0;
    if (t.outcome === 'done') r.spDone += pts;
    else if (t.outcome === 'carryover') r.spCarryover += pts;
    else if (t.outcome === 'open') r.spOpen += pts;
  }
  return (sprints || []).filter((s) => s.computedAt)
    .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')) || (a.id - b.id))
    .map((s) => {
      const r = totals.get(s.id) || { done: 0, carryover: 0, open: 0, excluded: 0, spDone: 0, spCarryover: 0, spOpen: 0 };
      // completion only exists once the sprint closes: an active sprint's rate would read
      // as final (1 done task of none counted yet scores 100%) and pollute the trend line
      const counted = s.closedAt ? r.done + r.carryover : 0;
      return Object.assign(
        { id: s.id, name: s.name, state: s.state, start: s.start, end: s.end, closedAt: s.closedAt,
          month: s.month, computedAt: s.computedAt },
        r, { completion: counted ? r.done / counted : null });
    });
}

/**
 * Per-account totals. Excluded and open tasks are counted but left out of
 * completion (done ÷ (done + carry-over)) and the SP delivered/carried totals.
 */
function summarize(tasks) {
  const rows = new Map();
  for (const t of tasks) {
    const id = t.accountId || null;
    if (!rows.has(id)) {
      rows.set(id, { accountId: id, name: null, email: null,
        done: 0, carryover: 0, open: 0, excluded: 0, spDone: 0, spCarryover: 0, spOpen: 0, completion: null });
    }
    const r = rows.get(id);
    r.name = r.name || t.name || null;
    r.email = r.email || t.email || null;
    if (r[t.outcome] !== undefined) r[t.outcome] += 1;
    const pts = Number(t.points) || 0;
    if (t.outcome === 'done') r.spDone += pts;
    else if (t.outcome === 'carryover') r.spCarryover += pts;
    else if (t.outcome === 'open') r.spOpen += pts;
  }
  for (const r of rows.values()) {
    const counted = r.done + r.carryover;
    r.completion = counted ? r.done / counted : null;
  }
  return [...rows.values()];
}

module.exports = {
  KPI_RULES_VERSION, DEFAULT_RULES, normalizeRules, fingerprint, roleRulesPlan,
  parseTime, normalizeSprint, toTimeline,
  isDoneStatus, creditedSprint, assigneeAt, classifyIssue, monthOf, summarize, sprintTrend,
};
