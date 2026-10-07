/*
 * Technical Lead scoping. A user with role 'lead' sees and edits only their
 * own team: the members whose `lead` is that user's id, plus the member the
 * user linked as "This is me". Everything here is pure — server.js loads the
 * full state, narrows it for GET, and widens a TL's patch back into a full
 * patch for db.savePatch.
 */
'use strict';

const { httpError } = require('./http-utils.js');

const isLead = (user) => Boolean(user) && user.role === 'lead';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const entryHasContent = (e) => Boolean(e && (e.attendance ||
  ['yesterday', 'today', 'blockers'].some((k) => String(e[k] || '').trim())));

/** Member IDs a TL may see and edit. */
function scopedMemberIds(members, user) {
  const lead = String(user.id);
  const ids = new Set();
  for (const m of members || []) {
    if (String(m.lead || '') === lead || (user.memberId && m.id === user.memberId)) ids.add(m.id);
  }
  return ids;
}

/** The member a JIRA person belongs to: mapping by account ID, then email, then name. */
function memberForPerson(person, members, mapping) {
  const byId = (id) => members.find((m) => m.id === id) || null;
  if (person.accountId && mapping[person.accountId]) {
    const m = byId(mapping[person.accountId]);
    if (m) return m;
  }
  if (person.email) {
    const email = String(person.email).toLowerCase();
    const m = members.find((x) => (x.email || '').toLowerCase() === email);
    if (m) return m;
  }
  if (person.name) {
    const m = members.find((x) => norm(x.name) === norm(person.name));
    if (m) return m;
  }
  return null;
}

/** Sprint issues of the scoped members, plus unassigned ones. */
function scopeIssues(issues, ids, members, mapping) {
  return (issues || []).filter((t) => {
    if (!t.assignee) return true;
    const m = memberForPerson(t.assignee, members, mapping);
    return Boolean(m && ids.has(m.id));
  });
}

/** KPI tasks of the scoped members (task fields: accountId, assigneeEmail, assigneeName). */
function scopeKpiTasks(tasks, ids, members, mapping) {
  return (tasks || []).filter((t) => {
    const m = memberForPerson({ accountId: t.accountId, email: t.assigneeEmail, name: t.assigneeName }, members, mapping);
    return Boolean(m && ids.has(m.id));
  });
}

/**
 * A KPI month report narrowed to the scoped members: their tasks, and only the
 * sprints they have tasks in — plus sprints not computed yet (status pending or
 * error), so a TL can still see and refresh them.
 */
function scopeKpiReport(report, ids, members, mapping) {
  const tasks = scopeKpiTasks(report.tasks, ids, members, mapping);
  const withTasks = new Set(tasks.map((t) => t.sprintId));
  const sprints = (report.sprints || []).filter((s) => withTasks.has(s.id) || s.status !== 'ok');
  const computed = sprints.map((s) => s.computedAt).filter(Boolean).sort();
  return Object.assign({}, report, { sprints, tasks, computedAt: computed[0] || null });
}

const pick = (obj, ids) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (ids.has(k)) out[k] = v;
  return out;
};

/** The full board narrowed to what a TL may see; global settings are left out. */
function scopeState(st, user) {
  const ids = scopedMemberIds(st.members, user);
  const days = {};
  for (const [date, day] of Object.entries(st.days || {})) {
    days[date] = {
      entries: pick(day.entries, ids),
      jira: day.jira ? Object.assign({}, day.jira, { issues: scopeIssues(day.jira.issues, ids, st.members, st.mapping) }) : null,
      startedAt: day.startedAt || null,
      roster: Array.isArray(day.roster) ? day.roster.filter((m) => ids.has(m.id)) : null,
    };
  }
  const mapping = {};
  for (const [account, memberId] of Object.entries(st.mapping || {})) if (ids.has(memberId)) mapping[account] = memberId;
  return {
    members: st.members.filter((m) => ids.has(m.id)),
    days,
    mapping,
    // the KPI counting rules are shown to leads too, so their KPI tab explains the rules in use
    settings: { jql: '', kpiMembers: [], piJql: '', piPrefix: (st.settings || {}).piPrefix || '',
      piPeriodMonths: (st.settings || {}).piPeriodMonths,
      kpiDoneStatuses: (st.settings || {}).kpiDoneStatuses, kpiDoneCategory: (st.settings || {}).kpiDoneCategory,
      kpiRoleRules: (st.settings || {}).kpiRoleRules },
  };
}

const snapshot = (m) => ({ id: m.id, name: m.name, role: m.role || '', email: m.email || '', color: m.color, lead: m.lead || '' });

/**
 * A TL's member list merged into the whole team: other teams are kept in
 * place, the TL's members are replaced or removed, new ones are appended and
 * always led by the TL. The TL's own card keeps the lead an admin gave it.
 */
function mergeMembers(current, incoming, ids, user) {
  const lead = String(user.id);
  const sent = new Map(incoming.map((m) => [String(m && m.id), m]));
  const known = new Set(current.map((m) => m.id));
  const own = (m, prev) => Object.assign({}, m, { lead: prev && prev.id === user.memberId ? (prev.lead || '') : lead });
  const out = [];
  for (const m of current) {
    if (!ids.has(m.id)) out.push(m);
    else if (sent.has(m.id)) out.push(own(sent.get(m.id), m));
  }
  for (const m of incoming) if (m && !known.has(String(m.id))) out.push(own(m, null));
  return out;
}

const emailOf = (m) => String((m && m.email) || '').trim().toLowerCase();

/**
 * Tickets, KPI tasks and the Performance report find a person's member by
 * email or name, so a TL's member that takes another team's email or name
 * would pull that person's JIRA data into the TL's team. Only a change the TL
 * makes is refused; a clash an admin set up does not block the TL's saves.
 */
function assertNoIdentityClaim(current, members, owned) {
  const others = members.filter((m) => !owned.has(m.id));
  const emails = new Set(others.map(emailOf).filter(Boolean));
  const names = new Set(others.map((m) => norm(m.name)).filter(Boolean));
  const prev = new Map(current.map((m) => [m.id, m]));
  for (const m of members) {
    if (!owned.has(m.id)) continue;
    const old = prev.get(m.id);
    const email = emailOf(m);
    if (email && emails.has(email) && email !== emailOf(old)) {
      throw httpError(403, 'The email ' + email + ' belongs to a member of another team.');
    }
    const name = norm(m.name);
    if (name && names.has(name) && name !== norm(old && old.name)) {
      throw httpError(403, 'A member of another team is already called ' + String(m.name).trim() + ' — ask an admin.');
    }
  }
}

/** JIRA people on the board's sprint snapshots, by account ID. */
function knownAccounts(days) {
  const people = new Map();
  for (const day of Object.values(days || {})) {
    for (const t of (day && day.jira && day.jira.issues) || []) {
      if (t.assignee && t.assignee.accountId) people.set(t.assignee.accountId, t.assignee);
    }
  }
  return people;
}

/**
 * A TL may map a JIRA account to their member only when the account is on the
 * board's snapshots (the only accounts their mapping screen offers) and is not
 * another team's member by email or name.
 */
function mayClaimAccount(account, people, others) {
  const person = people.get(account);
  return Boolean(person) && !memberForPerson(person, others, {});
}

/** One day of a TL's patch widened back to the whole team. null day = the TL deleted it. */
function mergeDay(cur, day, owned, members) {
  const base = cur || { entries: {}, startedAt: null, roster: null };
  const entries = {};
  for (const [id, e] of Object.entries(base.entries || {})) if (!owned.has(id)) entries[id] = e;
  const othersWrote = Object.values(entries).some(entryHasContent);
  for (const [id, e] of Object.entries((day && day.entries) || {})) if (owned.has(id)) entries[id] = e;

  const wantsStarted = Boolean(day && day.startedAt);
  // a TL starts a day for everyone, but only cancels it when nobody else wrote anything
  const startedAt = wantsStarted ? (base.startedAt || day.startedAt) : (othersWrote ? base.startedAt : null);
  let roster = null;
  if (startedAt) {
    const from = Array.isArray(base.roster) ? base.roster : members.map(snapshot);
    const mine = day && Array.isArray(day.roster) ? day.roster.filter((m) => m && owned.has(m.id)) : from.filter((m) => owned.has(m.id));
    roster = from.filter((m) => !owned.has(m.id)).concat(mine);
  }
  return { entries, jira: null, startedAt, roster };
}

/**
 * A TL's save body → a full-team patch body for db.savePatch. Only members,
 * mapping and days are taken; settings, credentials and the timezone are
 * admin-only, and JIRA snapshots come from the server-side sync instead.
 */
function widenPatch(st, body, user) {
  const patch = body.patch || {};
  const before = scopedMemberIds(st.members, user);
  const out = {};
  let members = st.members;
  if (patch.members !== undefined) {
    members = mergeMembers(st.members, Array.isArray(patch.members) ? patch.members : [], before, user);
    out.members = members;
  }
  const after = scopedMemberIds(members, user);
  const owned = new Set([...before, ...after]);
  if (patch.members !== undefined) assertNoIdentityClaim(st.members, members, after);

  if (patch.mapping !== undefined) {
    const current = st.mapping || {};
    const people = knownAccounts(st.days);
    const others = members.filter((m) => !after.has(m.id));
    const mapping = {};
    for (const [a, id] of Object.entries(current)) if (!owned.has(id)) mapping[a] = id;
    for (const [a, raw] of Object.entries(patch.mapping || {})) {
      const id = String(raw);
      if (!after.has(id) || hasOwn(mapping, a)) continue;
      if (current[a] === id || mayClaimAccount(a, people, others)) mapping[a] = id;
    }
    out.mapping = mapping;
  }

  const days = (patch.days || {});
  const upsert = {};
  const deleted = [];
  for (const [date, day] of Object.entries(days.upsert || {})) upsert[date] = mergeDay(st.days[date], day, owned, members);
  for (const date of Array.isArray(days.delete) ? days.delete : []) {
    if (!st.days[date]) continue;
    const merged = mergeDay(st.days[date], null, owned, members);
    if (merged.startedAt || Object.keys(merged.entries).length) upsert[date] = merged;
    else deleted.push(date);
  }
  out.days = { upsert, delete: deleted };
  return { patch: out, baseVersion: body.baseVersion, loadedAt: body.loadedAt };
}

module.exports = { isLead, scopedMemberIds, memberForPerson, scopeIssues, scopeKpiTasks, scopeKpiReport, scopeState, widenPatch };
