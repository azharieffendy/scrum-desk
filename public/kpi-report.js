/*
 * KPI tab: per-member sprint delivery for one month, from GET /api/kpi.
 * The pure helpers (buildKpiView, filterKpiTasks, kpiIssueUrl) are exported
 * for Node tests; the view functions use the app's browser globals.
 * Counting rules are configured in Settings → Sprint delivery.
 */
'use strict';

const kpiLabelOf = typeof monthLabel === 'function' ? monthLabel : require('./monthly-report.js').monthLabel;

const KPI_OUTCOMES = {
  done: 'Delivered',
  carryover: 'Carry-over',
  open: 'Open',
  excluded: 'Excluded',
};
const KPI_UNASSIGNED = 'Unassigned';

/* ---------------- counting rules (Settings → Sprint delivery (KPI)) ---------------- */

const KPI_DONE_DEFAULT = '';
const KPI_DONE_MAX = 10;
const KPI_DONE_NAME_MAX = 60;

const kpiSettingsNow = () => (typeof state !== 'undefined' && state && state.settings) || {};

/** Delivery status names as typed (trimmed, de-duplicated ignoring case). */
function kpiDoneNames(text) {
  const seen = new Set();
  return String(text == null ? '' : text).split(',').map((n) => n.trim())
    .filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

/** { names, category } from the settings (the signed-in user's state by default); unset = Done category. */
function kpiRules(settings) {
  const s = settings || kpiSettingsNow();
  return {
    names: kpiDoneNames(s.kpiDoneStatuses === undefined ? KPI_DONE_DEFAULT : s.kpiDoneStatuses),
    category: s.kpiDoneCategory !== false,
  };
}

/** '' when the pair can be saved, else why not — the same checks as saveSettings in lib/db.js. */
function kpiRulesError(statusesText, category) {
  const names = kpiDoneNames(statusesText);
  if (names.some((n) => n.length > KPI_DONE_NAME_MAX)) return 'A status name can be at most ' + KPI_DONE_NAME_MAX + ' characters.';
  if (names.length > KPI_DONE_MAX) return 'List at most ' + KPI_DONE_MAX + ' delivery statuses.';
  if (!names.length && !category) {
    return 'With no delivery status listed and the Done category off, no task could ever count as delivered.';
  }
  return '';
}

const KPI_ROLE_RULES_MAX = 20;
const KPI_ROLE_NAME_MAX = 60;

/** Per-role rows from the settings: [{ role, doneStatuses (text), doneCategory }]. */
function kpiRoleRules(settings) {
  const s = settings || kpiSettingsNow();
  return Array.isArray(s.kpiRoleRules) ? s.kpiRoleRules : [];
}

/** '' when the per-role rows can be saved, else why not — the same checks as cleanKpiRoleRules in lib/db.js. */
function kpiRoleRulesError(rows) {
  if (rows.length > KPI_ROLE_RULES_MAX) return 'Set rules for at most ' + KPI_ROLE_RULES_MAX + ' roles.';
  const seen = new Set();
  for (const r of rows) {
    const role = String(r.role == null ? '' : r.role).trim();
    if (!role) return 'Each per-role rule needs a role.';
    if (role.length > KPI_ROLE_NAME_MAX) return 'A role can be at most ' + KPI_ROLE_NAME_MAX + ' characters.';
    if (seen.has(role.toLowerCase())) return 'The role "' + role + '" has two rules.';
    seen.add(role.toLowerCase());
    const err = kpiRulesError(r.doneStatuses, r.doneCategory !== false);
    if (err) return role + ': ' + err;
  }
  return '';
}

/** Settings shaped like the default pair, for one per-role row (so kpiDoneWords etc. can describe it). */
const kpiRowSettings = (row) => ({ kpiDoneStatuses: row.doneStatuses, kpiDoneCategory: row.doneCategory });

/** '' with no per-role rules; else each role's rule, then everyone else's. */
function kpiRoleNote(settings) {
  const rows = kpiRoleRules(settings);
  if (!rows.length) return '';
  return 'Per role (a move counts by the rules of whoever held the task just before it): ' +
    rows.map((r) => r.role + ' = ' + kpiDoneWords(kpiRowSettings(r))).join('; ') +
    '; everyone else = ' + kpiDoneWords(settings) + '.';
}

/** Plain wording for the selected delivery statuses. */
function kpiDoneWords(settings) {
  const r = kpiRules(settings);
  const parts = r.names.concat(r.category ? ['a Done-category status'] : []);
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' or ' + parts[parts.length - 1] : parts.join('');
}

/** Short wording for the selected delivery statuses. */
function kpiDoneShort(settings) {
  const r = kpiRules(settings);
  return r.names.concat(r.category ? ['Done'] : []).join('/');
}

/**
 * Tooltip text for every KPI number and column — the counting rules in plain words (lib/kpi-core.js).
 * The entries that name the delivery statuses are getters, so they follow Settings → Sprint delivery (KPI).
 */
const KPI_TIPS = {
  completion: 'Completion = Delivered ÷ (Delivered + Carry-over).\n' +
    'The share of the work due in closed sprints that was actually finished.\n' +
    'Open and Excluded tasks are left out, so an active sprint does not pull the rate down before it ends.\n' +
    'Example: 8 delivered and 2 carried over → 8 ÷ 10 = 80%.',
  get done() {
    return 'Delivered: the task first reached ' + kpiDoneWords() + ' inside the sprint (between its start and close).\n' +
      (kpiRoleNote() ? kpiRoleNote() + '\n' : '') +
      'A task finished between sprints, right after being carried over, is credited to the next sprint it goes into.\n' +
      'A task is delivered only once, in the first sprint it is credited to; later sprints show it as Excluded.\n' +
      'Credited to whoever was assigned just before it moved to that status.';
  },
  get carryover() {
    return 'Carry-over: the task was still not ' + kpiDoneShort() + ' when the sprint closed.\n' +
      'It counts once in every sprint it slipped out of, so a task that slipped twice is 2 carry-overs.\n' +
      'Delivered does NOT include carry-over. If the task is finished later, it is also counted as Delivered in the sprint that finished it.\n' +
      'Credited to whoever was assigned when the sprint closed.';
  },
  open: 'Open: the task is in a sprint that is still active and is not delivered yet.\n' +
    'Left out of Completion and the SP totals until the sprint closes; then it becomes Delivered or Carry-over.',
  get excluded() {
    return 'Excluded: in this sprint but not counted, because it was already delivered in an earlier sprint, ' +
      'or reached ' + kpiDoneShort() + ' before this sprint started and outside any sprint. Turn on “Show excluded” to list them.';
  },
  spDone: 'SP delivered: story points of the Delivered tasks only. Carried-over points are NOT included.\n' +
    'The “/ total” after it is SP delivered + SP carried over: all points that were due in the closed sprints. Open work is left out.',
  spCarryover: 'SP carried over: story points of the Carry-over tasks, counted once for each sprint the task slipped out of.\n' +
    'Not part of SP delivered. A task carried over and finished later shows its points here (in the sprint it slipped from) ' +
    'and in SP delivered (in the sprint that finished it).',
  outcome: 'How this task counted in this sprint: Delivered, Carry-over, Open or Excluded.\n' +
    'The grey line under the summary says exactly why.',
  get deliveredAt() {
    return 'The day the task first reached ' + kpiDoneWords() + ', in the team timezone. Empty when it has not yet.';
  },
  points: 'Story points from JIRA’s story points field (Settings → Sprint delivery (KPI)). Unestimated tasks count as 0.',
  sprint: 'The sprint this row is about. A task that slipped from one sprint to the next has one row per sprint.',
  dates: 'Sprint start → end date. A sprint belongs to the month it started, even when it ends in the next month.',
};

function kpiCounts() {
  return { done: 0, carryover: 0, open: 0, excluded: 0, spDone: 0, spCarryover: 0, spOpen: 0 };
}

function kpiAdd(c, t) {
  if (c[t.outcome] !== undefined) c[t.outcome] += 1;
  const pts = Number(t.points) || 0;
  if (t.outcome === 'done') c.spDone += pts;
  else if (t.outcome === 'carryover') c.spCarryover += pts;
  else if (t.outcome === 'open') c.spOpen += pts;
}

/** Completion = delivered ÷ (delivered + carry-over); null when nothing counted. */
function kpiCompletion(c) {
  const counted = c.done + c.carryover;
  return counted ? c.done / counted : null;
}

/** Same order as matchMember: account mapping, then email, then normalised name. */
function kpiMemberFor(t, members, mapping) {
  const byId = (id) => members.find((m) => m.id === id) || null;
  if (t.accountId && mapping[t.accountId]) {
    const m = byId(mapping[t.accountId]);
    if (m) return m;
  }
  if (t.assigneeEmail) {
    const email = t.assigneeEmail.toLowerCase();
    const m = members.find((x) => (x.email || '').toLowerCase() === email);
    if (m) return m;
  }
  if (t.assigneeName) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const m = members.find((x) => norm(x.name) === norm(t.assigneeName));
    if (m) return m;
  }
  return null;
}

function kpiPerson(t, members, mapping) {
  const m = kpiMemberFor(t, members, mapping);
  if (m) return kpiMemberPerson(m);
  if (!t.accountId && !t.assigneeName) return { key: 'none', memberId: null, name: KPI_UNASSIGNED, color: null };
  return { key: 'a:' + (t.accountId || t.assigneeName), memberId: null, name: t.assigneeName || t.accountId, color: null };
}

function kpiMemberPerson(m) {
  return { key: 'm:' + m.id, memberId: m.id, name: m.name, color: m.color || null };
}

/**
 * Rows for people with counted work (only-excluded people are left out): team order, then others by name.
 * always: members who get a row even with nothing counted (the ticked KPI members).
 */
function kpiRows(tasks, members, always) {
  const rows = new Map();
  const keep = new Set();
  for (const m of always || []) {
    const p = kpiMemberPerson(m);
    rows.set(p.key, Object.assign(p, kpiCounts()));
    keep.add(p.key);
  }
  for (const t of tasks) {
    if (!rows.has(t.person.key)) rows.set(t.person.key, Object.assign({}, t.person, kpiCounts()));
    kpiAdd(rows.get(t.person.key), t);
  }
  const order = (r) => {
    const i = members.findIndex((m) => m.id === r.memberId);
    return i === -1 ? members.length + (r.key === 'none' ? 1 : 0) : i;
  };
  return [...rows.values()]
    .filter((r) => keep.has(r.key) || r.done + r.carryover + r.open > 0)
    .map((r) => Object.assign(r, { completion: kpiCompletion(r) }))
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

function kpiStatus(report) {
  if (report.sprints.length) return 'ok';
  if (!report.configured) return 'unconfigured';
  return report.months.length ? 'nosprints' : 'nodata';
}

/**
 * GET /api/kpi payload + the team → everything the KPI tab shows.
 * members: state.members; mapping: state.mapping (JIRA account ID → member ID);
 * picked: state.settings.kpiMembers — member IDs to report on ([] or none still on the team = everyone).
 */
function buildKpiView(report, members, mapping, picked) {
  members = members || [];
  mapping = mapping || {};
  const chosen = new Set((picked || []).filter((id) => members.some((m) => m.id === id)));
  const sprintName = new Map(report.sprints.map((s) => [s.id, s.name]));
  const carried = new Map();
  for (const t of report.tasks) if (t.outcome === 'carryover') carried.set(t.key, (carried.get(t.key) || 0) + 1);
  const tasks = report.tasks.map((t) => Object.assign({}, t, {
    person: kpiPerson(t, members, mapping),
    sprintName: sprintName.get(t.sprintId) || '',
    carried: carried.get(t.key) || 0,
  })).filter((t) => !chosen.size || chosen.has(t.person.memberId));

  const totals = kpiCounts();
  for (const t of tasks) kpiAdd(totals, t);
  return {
    month: report.month,
    label: kpiLabelOf(report.month),
    months: report.months || [],
    computedAt: report.computedAt,
    refreshing: Boolean(report.refreshing),
    status: kpiStatus(report),
    selection: chosen.size ? { count: chosen.size, of: members.length } : null,
    totals: Object.assign({ sprints: report.sprints.length }, totals, {
      spTotal: totals.spDone + totals.spCarryover, // open work is left out until its sprint closes
      completion: kpiCompletion(totals),
    }),
    members: kpiRows(tasks, members, members.filter((m) => chosen.has(m.id))),
    sprints: report.sprints.map((s) => Object.assign({}, s, {
      rows: kpiRows(tasks.filter((t) => t.sprintId === s.id), members),
    })),
    tasks,
  };
}

/**
 * One person's report from a buildKpiView() result: their member row, their tasks, and one
 * entry per sprint they had any task in (counts + completion), in report order. null when the
 * key has no member row.
 */
function kpiMemberReport(view, key) {
  const row = view.members.find((r) => r.key === key);
  if (!row) return null;
  const tasks = view.tasks.filter((t) => t.person.key === key);
  const sprints = [];
  for (const s of view.sprints) {
    const own = tasks.filter((t) => t.sprintId === s.id);
    if (!own.length) continue;
    const c = kpiCounts();
    for (const t of own) kpiAdd(c, t);
    sprints.push(Object.assign({
      id: s.id, name: s.name, state: s.state, start: s.start, end: s.end, status: s.status, error: s.error,
    }, c, { completion: kpiCompletion(c) }));
  }
  return { row, tasks, sprints };
}

/**
 * The delivery-trend slice to chart. opts: count (sprints; 0 = all), month (YYYY-MM) and
 * mode: 'month' pools only sprints up to and including that month (the default), 'recent'
 * always takes the latest ones. monthIds marks the selected month's sprints for highlight.
 */
function kpiTrendView(trend, opts) {
  const o = opts || {};
  const all = (trend && trend.sprints) || [];
  const n = o.count === 0 ? Infinity : Math.max(1, Number(o.count) || 12);
  let pool = all;
  if (o.month && o.mode !== 'recent') pool = all.filter((s) => !s.month || s.month <= o.month);
  const sprints = pool.slice(-n);
  const monthIds = new Set(o.month ? sprints.filter((s) => s.month === o.month).map((s) => s.id) : []);
  const counted = sprints.filter((s) => s.completion !== null && s.completion !== undefined);
  return {
    sprints,
    total: all.length,
    windowed: pool.length < all.length,
    monthIds,
    avgCompletion: counted.length ? counted.reduce((a, s) => a + s.completion, 0) / counted.length : null,
    spDone: sprints.reduce((a, s) => a + (Number(s.spDone) || 0), 0),
    spCarryover: sprints.reduce((a, s) => a + (Number(s.spCarryover) || 0), 0),
  };
}

/** Detail list: excluded tasks hidden unless asked for; optional one-person filter. */
function filterKpiTasks(view, opts) {
  const o = opts || {};
  return view.tasks.filter((t) => (o.showExcluded || t.outcome !== 'excluded')
    && (!o.memberKey || t.person.key === o.memberKey));
}

/** https://<site>/browse/<key>, or null when the site isn't a plain http(s) host. */
function kpiIssueUrl(site, key) {
  let s = String(site || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
    s = 'https://' + s;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin + '/browse/' + encodeURIComponent(key);
  } catch (_) { return null; }
}

/* ---------------- Excel ---------------- */

/** The workbook's "About" note, naming the delivery statuses in use. */
function kpiRulesNote(settings) {
  const names = kpiRules(settings).names;
  const counts = names.length ? names.join(', ') + (names.length > 1 ? ' count' : ' counts') + ' as done. ' : '';
  const roles = kpiRoleNote(settings);
  return 'Rules: ' + counts + 'Delivered = reached ' + kpiDoneWords(settings) + ' inside the sprint. ' + (roles ? roles + ' ' : '') +
    'Carry-over = still open when the sprint closed (counted in each sprint it slipped). Open = active sprint, not delivered yet. ' +
    'Excluded tasks (already delivered in an earlier sprint or outside any sprint) are left out. ' +
    'Completion = delivered ÷ (delivered + carry-over). A sprint belongs to the month it started.';
}
const KPI_OUTCOME_STYLE = { done: 'present', carryover: 'late', open: 'leave', excluded: 'text' };

/** Calendar day of an ISO time: in the given time zone, else as stored (UTC). */
function kpiDay(iso, tz) {
  if (!iso) return '';
  return tz ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: tz }) : String(iso).slice(0, 10);
}

function kpiXlsxRate(rate, bold) {
  return rate === null ? { v: '—', s: bold ? 'boldNum' : 'num' } : { v: rate, s: bold ? 'boldPct' : 'pct' };
}

function kpiStaleNotes(view) {
  return view.sprints.filter((s) => s.status !== 'ok').map((s) => s.name + ': ' + (s.status === 'error'
    ? 'last refresh failed' + (s.error ? ' (' + s.error + ')' : '') + ' — figures may be out of date'
    : 'not computed yet'));
}

/**
 * Worksheets for XlsxLite.build(): Summary (+ About note), Sprints, Tasks.
 * view: buildKpiView() result; tz: optional IANA zone for delivery dates;
 * site: optional JIRA site, which turns task keys into links to the issue.
 */
/** settings: whose counting rules the About note names (default: the signed-in user's state). */
function kpiSheets(view, generatedAt, tz, site, settings) {
  const when = generatedAt || new Date().toISOString().slice(0, 16).replace('T', ' ');
  const t = view.totals;
  const note = (v) => [{ v, s: 'note' }];
  const counts = (r, bold) => [r.done, r.carryover, r.open, r.spDone, r.spCarryover, r.spOpen]
    .map((v) => ({ v, s: bold ? 'boldNum' : 'num' }));

  const summary = {
    name: 'Summary',
    cols: [26, 11, 11, 9, 13, 15, 10, 12],
    freeze: { row: 3 },
    rows: [
      [{ v: 'KPI report — ' + view.label, s: 'title' }],
      note(t.sprints + ' sprint' + (t.sprints === 1 ? '' : 's') + ' · completion = delivered ÷ (delivered + carry-over)'),
      ['Member', 'Delivered', 'Carry-over', 'Open', 'SP delivered', 'SP carried over', 'SP open', 'Completion']
        .map((v) => ({ v, s: 'header' })),
      ...view.members.map((r) => [{ v: r.name, s: 'text' }, ...counts(r), kpiXlsxRate(r.completion)]),
      [{ v: 'Team total', s: 'boldText' }, ...counts(t, true), kpiXlsxRate(t.completion, true)],
      [],
      [{ v: 'About', s: 'boldText' }],
      note(kpiRulesNote(settings)),
      note('Generated ' + when),
      note('Oldest data computed ' + (view.computedAt ? view.computedAt.slice(0, 16).replace('T', ' ') + ' UTC' : '—')),
      ...kpiStaleNotes(view).map(note),
    ],
  };

  const sprintRows = [];
  for (const s of view.sprints) {
    const head = [s.name, kpiDay(s.start, tz), kpiDay(s.end, tz), s.state || ''].map((v) => ({ v, s: 'text' }));
    const status = { v: s.status === 'error' ? 'refresh failed' : s.status === 'pending' ? 'not computed' : '', s: 'text' };
    if (!s.rows.length) sprintRows.push([...head, { v: 'No counted tasks', s: 'text' }, ...Array(6).fill(''), status]);
    for (const r of s.rows) {
      sprintRows.push([...head, { v: r.name, s: 'boldText' },
        ...[r.done, r.carryover, r.open, r.spDone, r.spCarryover].map((v) => ({ v, s: 'num' })),
        kpiXlsxRate(r.completion), status]);
    }
  }
  const sprints = {
    name: 'Sprints',
    cols: [22, 11, 11, 9, 24, 10, 10, 8, 12, 14, 12, 16],
    freeze: { row: 3, col: 1 },
    rows: [
      [{ v: 'Sprints — ' + view.label, s: 'title' }],
      note('One row per member per sprint'),
      ['Sprint', 'Start', 'End', 'State', 'Member', 'Delivered', 'Carry-over', 'Open', 'SP delivered', 'SP carried over',
        'Completion', 'Status'].map((v) => ({ v, s: 'header' })),
      ...sprintRows,
    ],
  };

  const tasks = {
    name: 'Tasks',
    cols: [22, 12, 44, 12, 22, 12, 12, 7, 12, 50],
    freeze: { row: 3, col: 2 },
    rows: [
      [{ v: 'Tasks — ' + view.label, s: 'title' }],
      note('One row per task per sprint, excluded tasks included'),
      ['Sprint', 'Key', 'Summary', 'Type', 'Member', 'Outcome', 'Delivered', 'SP', 'Carried this month', 'Reason']
        .map((v) => ({ v, s: 'header' })),
      ...view.tasks.map((k) => [
        { v: k.sprintName, s: 'text' }, kpiXlsxKey(k.key, site), { v: k.summary || '', s: 'text' },
        { v: k.type || '', s: 'text' }, { v: k.person.name, s: 'text' },
        { v: KPI_OUTCOMES[k.outcome] || k.outcome, s: KPI_OUTCOME_STYLE[k.outcome] || 'text' },
        { v: kpiDay(k.doneAt, tz), s: 'text' }, { v: Number(k.points) || 0, s: 'num' },
        { v: k.carried, s: 'num' }, { v: k.reason || '', s: 'text' },
      ]),
    ],
  };

  const memberSheets = view.members.filter((r) => r.memberId)
    .map((r) => kpiMemberSheet(view, kpiMemberReport(view, r.key), tz, site));
  return [summary, sprints, tasks, ...memberSheets];
}

/** A task key cell: a link to the JIRA issue when the site is usable, bold text otherwise. */
function kpiXlsxKey(key, site) {
  const link = kpiIssueUrl(site, key);
  return link ? { v: key, s: 'link', link } : { v: key, s: 'boldText' };
}

/** One member's sheet: totals, a per-sprint table and all their tasks (excluded included). */
function kpiMemberSheet(view, m, tz, site) {
  const note = (v) => [{ v, s: 'note' }];
  const header = (labels) => labels.map((v) => ({ v, s: 'header' }));
  const num = (v) => ({ v, s: 'num' });
  const r = m.row;
  const rows = [
    [{ v: r.name + ' — ' + view.label, s: 'title' }],
    note('KPI member report · completion = delivered ÷ (delivered + carry-over)'),
    header(['Delivered', 'Carry-over', 'Open', 'SP delivered', 'SP carried over', 'SP open', 'Completion']),
    [...[r.done, r.carryover, r.open, r.spDone, r.spCarryover, r.spOpen].map(num), kpiXlsxRate(r.completion)],
    [],
  ];
  if (!m.tasks.length) {
    rows.push(note('No tasks in ' + view.label + '.'));
  } else {
    rows.push([{ v: 'Per sprint', s: 'boldText' }],
      header(['Sprint', 'Start', 'End', 'State', 'Delivered', 'Carry-over', 'Open', 'SP delivered', 'SP carried over', 'Completion']),
      ...m.sprints.map((s) => [
        ...[s.name, kpiDay(s.start, tz), kpiDay(s.end, tz), s.state || ''].map((v) => ({ v, s: 'text' })),
        ...[s.done, s.carryover, s.open, s.spDone, s.spCarryover].map(num), kpiXlsxRate(s.completion),
      ]),
      [],
      [{ v: 'Tasks', s: 'boldText' }],
      header(['Sprint', 'Key', 'Type', 'Outcome', 'Delivered', 'SP', 'Carried this month', 'Summary', 'Reason']),
      ...m.tasks.map((k) => [
        { v: k.sprintName, s: 'text' }, kpiXlsxKey(k.key, site), { v: k.type || '', s: 'text' },
        { v: KPI_OUTCOMES[k.outcome] || k.outcome, s: KPI_OUTCOME_STYLE[k.outcome] || 'text' },
        { v: kpiDay(k.doneAt, tz), s: 'text' }, num(Number(k.points) || 0), num(k.carried),
        { v: k.summary || '', s: 'text' }, { v: k.reason || '', s: 'text' },
      ]));
  }
  return { name: r.name, cols: [22, 12, 12, 12, 12, 12, 12, 44, 50, 12], rows };
}

/* ---------------- browser view ---------------- */

const kpiUi = { reports: {}, loading: null, error: null, memberKey: '', showExcluded: false, refreshing: false, find: '', taskMember: '', outcome: '',
  roleDrafts: 0, // per-role rows added on screen but not given a role yet (saved once they have one)
  trend: { data: null, error: null, loading: false, seq: 0 },
  trendCount: 12, // how many sprints the trend charts (0 = all)
  trendMode: 'month' }; // 'month': sprints up to the selected month; 'recent': the latest sprints

/** Admins and Technical Leads refresh the KPI data; a lead only gets their own team back. */
function isKpiAdmin() { return auth.role === 'admin' || auth.role === 'lead'; }

/** Drops cached months so the next render fetches fresh data. */
function resetKpi() { kpiUi.reports = {}; kpiUi.error = null; resetKpiTrend(); }

/** Drops the trend so the next KPI render reads it again (new rules or a fresh refresh).
 *  Bumping seq abandons any fetch in flight, so its stale result is discarded. */
function resetKpiTrend() {
  kpiUi.trend.seq++;
  kpiUi.trend.data = null;
  kpiUi.trend.error = null;
  kpiUi.trend.loading = false;
}

/**
 * Settings → Sprint delivery (KPI) counting rules. Checked here first: every save sends the whole board in one
 * transaction, so a pair the server refuses would roll back (and keep failing) every later save.
 */
function saveKpiRules() {
  const text = document.querySelector('[data-setting="kpiDoneStatuses"]').value;
  const category = document.querySelector('[data-setting="kpiDoneCategory"]').checked;
  const rows = [...document.querySelectorAll('[data-role-rule]')].map((el) => ({
    role: el.querySelector('[data-role-field="role"]').value.trim(),
    doneStatuses: kpiDoneNames(el.querySelector('[data-role-field="statuses"]').value).join(', '),
    doneCategory: el.querySelector('[data-role-field="category"]').checked,
  }));
  const named = rows.filter((r) => r.role); // a row without a role stays a draft on screen
  const err = kpiRulesError(text, category) || kpiRoleRulesError(named);
  if (err) { toast(err + ' Not saved.', 'error'); render(); return; }
  kpiUi.roleDrafts = rows.length - named.length;
  state.settings.kpiDoneStatuses = kpiDoneNames(text).join(', ');
  state.settings.kpiDoneCategory = category;
  state.settings.kpiRoleRules = named;
  saveState({ quiet: true });
  // the server recomputes on the next GET /api/kpi; drop months fetched under the old rules once saved
  resetKpi();
  persistNow().then(resetKpi);
}

async function kpiFetch(url, init) {
  const res = await fetch(url, init);
  if (res.status === 401) { showAuthScreen('login'); throw new Error('Session expired — sign in again'); }
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok || !data || data.error) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

async function loadKpi(month) {
  if (kpiUi.loading === month) return;
  kpiUi.loading = month;
  kpiUi.error = null;
  try {
    kpiUi.reports[month] = await kpiFetch('/api/kpi?month=' + encodeURIComponent(month));
  } catch (e) {
    kpiUi.error = { month, message: e.message };
  } finally {
    kpiUi.loading = null;
    if (ui.view === 'kpi') render();
  }
}

/** The trend across all computed sprints, from the server's KPI cache (no JIRA). Fetched once. */
async function loadKpiTrend() {
  if (kpiUi.trend.data || kpiUi.trend.loading) return;
  const seq = ++kpiUi.trend.seq;
  kpiUi.trend.loading = true;
  try {
    const data = await kpiFetch('/api/kpi/trend');
    if (seq === kpiUi.trend.seq) kpiUi.trend.data = data; // a reset in between wins
  } catch (e) {
    if (seq === kpiUi.trend.seq) kpiUi.trend.error = e.message;
  } finally {
    if (seq === kpiUi.trend.seq) {
      kpiUi.trend.loading = false;
      if (ui.view === 'kpi') render();
    }
  }
}

async function refreshKpi() {
  if (kpiUi.refreshing || !isKpiAdmin()) return;
  const month = ui.month;
  kpiUi.refreshing = true;
  render();
  try {
    const data = await kpiFetch('/api/kpi/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month }),
    });
    kpiUi.reports[month] = data;
    resetKpiTrend(); // sprint results changed: chart them again on the next render
    const pending = data.sprints.filter((s) => s.status === 'pending').length;
    toast(pending ? pending + ' sprint' + (pending === 1 ? '' : 's') + ' still pending — refresh again' : 'KPI report refreshed',
      pending ? '' : 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    kpiUi.refreshing = false;
    if (ui.view === 'kpi') render();
  }
}

function kpiPct(rate) { return rate === null ? '—' : Math.round(rate * 100) + '%'; }
function kpiSp(n) { return String(Math.round(n * 10) / 10); }
function kpiDate(iso) { return iso ? new Date(iso).toLocaleDateString('sv-SE') : ''; }
function kpiStamp(iso) { return iso ? new Date(iso).toLocaleString() : 'never'; }

function kpiToolbar(report) {
  const month = ui.month;
  const admin = isKpiAdmin() && report && report.configured;
  const busy = kpiUi.refreshing || (report && report.refreshing);
  const months = report && report.months.length ? report.months.slice().reverse() : [];
  return `
  <section class="page-head">
    <div class="page-head-main">
      <div class="page-title-row">
        <h1 class="page-title">${esc(kpiLabelOf(month))}</h1>
        ${month === todayISO().slice(0, 7) ? '<span class="chip">This month</span>'
          : '<button class="btn btn-ghost btn-sm" data-action="month-current">This month</button>'}
        <div class="date-nav">
          <button class="btn btn-ghost btn-icon" data-action="month-prev" title="Previous month" aria-label="Previous month">&lsaquo;</button>
          <input type="month" id="monthInput" value="${esc(month)}" aria-label="KPI month">
          <button class="btn btn-ghost btn-icon" data-action="month-next" title="Next month" aria-label="Next month">&rsaquo;</button>
        </div>
        ${months.length > 1 ? `<label class="jump-select"><span class="sr-only">Jump to a month with data</span>
          <select id="kpiJump"><option value="">Jump to&hellip;</option>${months.map((m) => `<option value="${esc(m)}"${m === month ? ' disabled' : ''}>${esc(kpiLabelOf(m))}</option>`).join('')}</select></label>` : ''}
      </div>
      <p class="page-meta">${report ? `<span>Last computed ${esc(kpiStamp(report.computedAt))}</span>` : ''}</p>
    </div>
    <div class="toolbar-right">
      ${report && report.sprints.length ? '<button class="btn btn-ghost" data-action="kpi-download">Download Excel</button>' : ''}
      ${admin ? `<button class="btn btn-primary" data-action="kpi-refresh"${busy ? ' disabled' : ''}>${busy ? 'Refreshing&hellip;' : 'Refresh from JIRA'}</button>` : ''}
    </div>
  </section>`;
}

/** Stacked delivered / carry-over / open bar. */
function kpiBar(d, c, o, cls) {
  const t = d + c + o || 1;
  const w = (x) => ((x / t) * 100).toFixed(1) + '%';
  return `<span class="kbar${cls ? ' ' + cls : ''}" aria-hidden="true"><i class="kb-d" style="width:${w(d)}"></i><i class="kb-c" style="width:${w(c)}"></i><i class="kb-o" style="width:${w(o)}"></i></span>`;
}

const kpiTone = (rate) => (rate == null || rate >= 0.85 ? '' : rate >= 0.7 ? ' warn' : ' bad');

function kpiEmpty(icon, title, text, withRefresh) {
  return `
  <div class="empty-wrap"><section class="panel empty">
    <div class="empty-ico">${icon}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    ${withRefresh && isKpiAdmin() ? '<button class="btn btn-primary" data-action="kpi-refresh">&#8635; Refresh from JIRA</button>' : ''}
  </section></div>`;
}

/* ---------------- delivery trend (across sprints) ---------------- */

/** Inline SVG line chart: completion % (left axis) and SP delivered (right axis), oldest left. */
function kpiTrendChart(view) {
  const sprints = view.sprints;
  const W = 760; const H = 262; const ML = 46; const MR = 52; const MT = 16; const MB = 52;
  const PW = W - ML - MR; const PH = H - MT - MB;
  const x = (i) => (sprints.length === 1 ? ML + PW / 2 : ML + (i * PW) / (sprints.length - 1));
  const yPct = (rate) => MT + (1 - rate) * PH; // completion arrives as 0..1
  const spMax = Math.max(10, Math.ceil(Math.max(0, ...sprints.map((s) => Number(s.spDone) || 0)) / 10) * 10);
  const ySp = (v) => MT + (1 - v / spMax) * PH;
  const fx = (v) => String(Math.round(v * 10) / 10);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monName = (month) => MON[Number(String(month).slice(5, 7)) - 1] || month;
  // compact label parts that keep the sprint number: "DB2 Sprint 168" → team "DB2", num "168"
  // (the prefix may itself contain digits, hence .*? before the trailing number)
  const labelParts = (name) => {
    const str = String(name || '');
    const m = /^(.*?)(\d{1,5})\s*$/.exec(str);
    if (m) {
      const full = m[1].trim().replace(/\s+sprint$/i, '').trim();
      const team = full.slice(0, 5);
      return { team: team.length < full.length ? team.trimEnd() + '…' : team, num: m[2] };
    }
    return { team: '', num: str.length > 11 ? str.slice(0, 10) + '…' : str };
  };

  const grid = [0, 0.5, 1].map((v) => `
    <line x1="${ML}" x2="${ML + PW}" y1="${yPct(v)}" y2="${yPct(v)}" class="kpt-grid${v ? '' : ' kpt-grid-zero'}"></line>
    <text x="${ML - 8}" y="${yPct(v) + 4}" class="kpt-label" text-anchor="end">${v * 100}%</text>`).join('');

  const spPts = sprints.map((s, i) => [x(i), ySp(Number(s.spDone) || 0)]);
  const donePts = sprints.map((s, i) => (s.completion == null ? null : [x(i), yPct(s.completion)]))
    .filter(Boolean);
  const poly = (ptsArr, cls) => (ptsArr.length > 1
    ? `<polyline class="kpt-line ${cls}" points="${ptsArr.map((p) => fx(p[0]) + ',' + fx(p[1])).join(' ')}"></polyline>` : '');

  const dots = sprints.map((s, i) => {
    const cx = fx(x(i)); const spY = fx(ySp(Number(s.spDone) || 0));
    const doneY = s.completion == null ? null : fx(yPct(s.completion));
    const open = s.state !== 'closed'; // active sprints get hollow points
    const hot = view.monthIds && view.monthIds.has(s.id) ? ' kpt-hot' : ''; // the selected month's sprints
    const r = open ? '4.5' : '4';
    const tip = `${s.name || 'Sprint ' + s.id}: ${kpiPct(s.completion == null ? null : s.completion)} completion · ` +
      `${kpiSp(Number(s.spDone) || 0)} SP delivered · ${s.carryover} carry-over · ${s.done} delivered` +
      (open ? ' · active sprint' : '') + (s.month ? ` · ${kpiLabelOf(s.month)}` : '');
    const click = s.month ? ` data-action="kpi-month" data-month="${esc(s.month)}"` : '';
    return `
    <g class="kpt-dot"${click}>
      <title>${esc(tip)}</title>
      <circle class="kpt-hit" cx="${cx}" cy="${spY}" r="12"></circle>
      <circle class="kpt-pt kpt-sp${open ? ' kpt-open' : ''}${hot}" cx="${cx}" cy="${spY}" r="${r}"></circle>
      ${doneY === null ? '' : `<circle class="kpt-hit" cx="${cx}" cy="${doneY}" r="12"></circle>
      <circle class="kpt-pt kpt-done${open ? ' kpt-open' : ''}${hot}" cx="${cx}" cy="${doneY}" r="${r}"></circle>`}
    </g>`;
  }).join('');

  // consecutive sprints of different months get a separator; each month gets a caption
  const groups = [];
  for (const s of sprints) {
    const last = groups[groups.length - 1];
    if (last && last.month === s.month) last.sprints.push(s);
    else groups.push({ month: s.month || '', sprints: [s] });
  }
  const seps = groups.slice(1).map((g) => {
    const i = sprints.indexOf(g.sprints[0]);
    const mx = (x(i - 1) + x(i)) / 2;
    return `<line x1="${fx(mx)}" x2="${fx(mx)}" y1="${MT}" y2="${MT + PH}" class="kpt-msep"></line>`;
  }).join('');
  const manyYears = new Set(groups.map((g) => g.month.slice(0, 4))).size > 1;
  const monthLabels = groups.map((g) => {
    const a = sprints.indexOf(g.sprints[0]); const b = sprints.indexOf(g.sprints[g.sprints.length - 1]);
    const label = monName(g.month) + (manyYears ? ' ' + g.month.slice(0, 4) : '');
    return `<text x="${fx((x(a) + x(b)) / 2)}" y="${H - 2}" class="kpt-mlabel" text-anchor="middle">${esc(label)}<title>${esc(kpiLabelOf(g.month))}</title></text>`;
  }).join('');

  // two stacked lines (team over number) keep neighbours apart; with a single team the
  // team line would repeat on every sprint, so the numbers alone are shown
  const parts = sprints.map((s) => labelParts(s.name || 'Sprint ' + s.id));
  const oneTeam = new Set(parts.map((p) => p.team)).size <= 1;
  const labels = sprints.map((s, i) => {
    const show = sprints.length <= 14 || i % 2 === (sprints.length - 1) % 2;
    if (!show) return '';
    const p = parts[i];
    const name = s.name || 'Sprint ' + s.id;
    const x0 = fx(x(i));
    const stacked = p.team && !oneTeam;
    const body = stacked
      ? `<tspan x="${x0}">${esc(p.team)}</tspan><tspan x="${x0}" dy="11">${esc(p.num)}</tspan>`
      : `<tspan x="${x0}">${esc(p.num)}</tspan>`;
    return `<text x="${x0}" y="${stacked ? H - 25 : H - 14}" class="kpt-label" text-anchor="middle">${body}<title>${esc(name)}</title></text>`;
  }).join('');

  const names = sprints.map((s) => s.name || 'Sprint ' + s.id).join(', ');
  return `
  <svg class="kpt-svg" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Delivery trend over ${sprints.length} sprints (${esc(names)}): completion percentage and story points delivered, oldest on the left.">
    ${grid}
    ${seps}
    <text x="${W - MR + 8}" y="${ySp(spMax) + 4}" class="kpt-label" text-anchor="start">${fx(spMax)} SP</text>
    ${poly(spPts, 'kpt-line-sp')}
    ${poly(donePts, 'kpt-line-done')}
    ${dots}
    ${labels}
    ${monthLabels}
  </svg>`;
}

/** The whole panel; hidden until the trend loads and pointless before the first computed sprint. */
function kpiTrendPanel() {
  const t = kpiUi.trend;
  if (!t.data && !t.error && !t.loading) loadKpiTrend();
  if (!t.data && t.error) {
    return `
    <section class="panel empty-inline kpi-trend" aria-label="Delivery trend failed to load">
      <p>Could not load the delivery trend: ${esc(t.error)}</p>
      <button class="btn btn-ghost btn-sm" data-action="kpi-trend-retry">Try again</button>
    </section>`;
  }
  if (!t.data) return '';
  const view = kpiTrendView(t.data, { count: kpiUi.trendCount, month: ui.month, mode: kpiUi.trendMode });
  if (!view.sprints.length) return ''; // the selected month is before every computed sprint
  const shown = view.sprints.length;
  const hot = view.monthIds.size ? `
        <span><i class="kpt-sw kpt-sw-hot"></i>${esc(kpiLabelOf(ui.month))}</span>` : '';
  const scope = kpiUi.trendMode === 'recent' || !view.windowed
    ? `the ${shown} charted sprint${shown === 1 ? '' : 's'}`
    : `the ${shown} sprints up to ${esc(kpiLabelOf(ui.month))}`;
  return `
  <section class="panel kpi-trend" aria-label="Delivery trend across sprints">
    <div class="kpi-trend-head">
      <h3>Delivery trend</h3>
      <span class="muted kpi-trend-sub">${view.total} computed sprint${view.total === 1 ? '' : 's'} · click a point to open its month</span>
      <div class="seg" role="group" aria-label="Trend window">
        <button type="button" class="seg-btn${kpiUi.trendMode !== 'recent' ? ' active' : ''}" data-action="kpi-trend-mode" data-mode="month" aria-pressed="${kpiUi.trendMode !== 'recent'}">Up to ${esc(kpiLabelOf(ui.month))}</button>
        <button type="button" class="seg-btn${kpiUi.trendMode === 'recent' ? ' active' : ''}" data-action="kpi-trend-mode" data-mode="recent" aria-pressed="${kpiUi.trendMode === 'recent'}">All recent</button>
      </div>
      <div class="seg" role="group" aria-label="How many sprints to chart">
        ${[[6, 'Last 6'], [12, 'Last 12'], [0, 'All']].map(([n, label]) =>
          `<button type="button" class="seg-btn${kpiUi.trendCount === n ? ' active' : ''}" data-action="kpi-trend-count" data-count="${n}" aria-pressed="${kpiUi.trendCount === n}">${label}</button>`).join('')}
      </div>
    </div>
    ${kpiTrendChart(view)}
    <div class="kpi-trend-foot">
      <div class="kpi-trend-legend" aria-hidden="true">
        <span><i class="kpt-sw kpt-sw-done"></i>Completion</span>
        <span><i class="kpt-sw kpt-sw-sp"></i>SP delivered</span>
        <span><i class="kpt-sw kpt-sw-open"></i>active sprint</span>${hot}
      </div>
      <span class="muted kpi-trend-note">Average completion ${kpiPct(view.avgCompletion)} · ${kpiSp(view.spDone)} SP delivered in ${scope}</span>
    </div>
  </section>`;
}

function viewKpi() {
  if (storageMode === 'local') {
    return kpiEmpty('&#128202;', 'Available in server mode only', 'The KPI report reads sprint history from JIRA on the server. Run the app with its server to use it.');
  }
  if (!isValidMonth(ui.month)) ui.month = todayISO().slice(0, 7);
  const report = kpiUi.reports[ui.month];
  if (!report) {
    const err = kpiUi.error && kpiUi.error.month === ui.month ? kpiUi.error : null;
    if (!err) loadKpi(ui.month);
    return kpiToolbar(null) + (err
      ? `<section class="panel empty-inline"><p>Could not load the KPI report: ${esc(err.message)}</p>
          <button class="btn btn-ghost btn-sm" data-action="kpi-reload">Try again</button></section>`
      : '<section class="panel empty-inline"><p>Loading KPI report&hellip;</p></section>');
  }
  const v = buildKpiView(report, state.members, state.mapping, state.settings.kpiMembers);
  if (v.status === 'unconfigured') {
    return kpiToolbar(report) + kpiEmpty('&#128273;', 'JIRA is not configured', 'Add the JIRA site, email and API token in Settings to build the KPI report.');
  }
  if (v.status === 'nodata') {
    return kpiToolbar(report) + kpiEmpty('&#128202;', 'No KPI data yet', isKpiAdmin()
      ? 'Refresh to read this month’s sprints from JIRA.' : 'An admin needs to refresh the KPI report from JIRA.', true);
  }
  if (v.status === 'nosprints') {
    return kpiToolbar(report) + kpiEmpty('&#128197;', 'No sprints this month', 'No sprint started in ' + v.label + '.', true);
  }
  const m = kpiUi.memberKey ? kpiMemberReport(v, kpiUi.memberKey) : null;
  if (!m) kpiUi.memberKey = ''; // that person has no row this month
  if (m) return kpiToolbar(report) + kpiMemberSwitch(v) + kpiMemberHero(v, m) + kpiMemberSprintsPanel(m) + kpiTasksPanel(v);
  return kpiToolbar(report) + kpiMemberSwitch(v) + kpiHero(v) + kpiTrendPanel() + kpiMembersPanel(v) + kpiSprintsPanel(v) + kpiTasksPanel(v);
}

/** On a person's report: back to the whole team, or switch person. The whole-team page uses the cards instead. */
function kpiMemberSwitch(v) {
  if (!kpiUi.memberKey) return '';
  return `
  <nav class="kpi-person-nav" aria-label="Person">
    <button class="linklike" data-action="kpi-member" data-key="">&larr; Whole team</button>
    <span class="muted" aria-hidden="true">/</span>
    <label><span class="sr-only">Show the KPI report for</span>
      <select id="kpiPerson">${v.members.map((r) => `<option value="${esc(r.key)}"${r.key === kpiUi.memberKey ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
  </nav>`;
}

function kpiStats(t) {
  const spTotal = t.spDone + t.spCarryover; // open work is left out until its sprint closes
  return `
    <div class="report-stats">
      <div class="rstat rstat-main">${statLabel('Completion', KPI_TIPS.completion)}<b>${kpiPct(t.completion)}</b></div>
      <div class="rstat kpi-done">${statLabel('Delivered', KPI_TIPS.done)}<b>${t.done}</b></div>
      <div class="rstat kpi-carryover">${statLabel('Carry-over', KPI_TIPS.carryover)}<b>${t.carryover}</b></div>
      <div class="rstat kpi-open">${statLabel('Open', KPI_TIPS.open)}<b>${t.open}</b></div>
      <div class="rstat">${statLabel('SP delivered', KPI_TIPS.spDone)}<b>${kpiSp(t.spDone)}<small> / ${kpiSp(spTotal)}</small></b></div>
    </div>`;
}

function kpiHero(v) {
  const t = v.totals;
  return `
  <section class="report-hero panel">
    <div class="report-title">
      <h2>Whole team</h2>
      <p class="panel-sub">${t.sprints} sprint${t.sprints === 1 ? '' : 's'} started this month${tipIcon(KPI_TIPS.completion, 'how completion is counted')}</p>
      ${v.selection ? `<p class="panel-sub kpi-selection">Only ${v.selection.count} of ${v.selection.of} team members · change in <button class="linklike" data-action="view" data-view="settings" data-tab="kpi">Settings</button></p>` : ''}
    </div>
    ${kpiStats(t)}
  </section>`;
}

function kpiMemberHero(v, m) {
  const r = m.row;
  const n = m.sprints.length;
  return `
  <section class="panel kpi-mhero">
    <div class="kpi-mhero-who">
      ${r.color ? `<span class="avatar avatar-lg" style="background:${safeColor(r.color)}">${esc(initials(r.name))}</span>` : ''}
      <div><h2>${esc(r.name)}</h2><p class="muted">${esc(v.label)} · ${n ? `worked in ${n} sprint${n === 1 ? '' : 's'}` : 'no tasks this month'}</p></div>
    </div>
    <div class="kpi-mhero-nums">
      <div class="kpi-mhero-main">${statLabel('Completion', KPI_TIPS.completion)}<b class="kpi-card-pct${kpiTone(r.completion)}">${kpiPct(r.completion)}</b></div>
      <div class="kpi-mhero-sub">
        <span><b>${r.done}</b> delivered · <b class="c-carry">${r.carryover}</b> carry-over · <b>${r.open}</b> open</span>
        <span><b>${kpiSp(r.spDone)}</b> of ${kpiSp(r.spDone + r.spCarryover)} SP delivered</span>
      </div>
    </div>
  </section>`;
}

function kpiMemberSprintsPanel(m) {
  if (!m.sprints.length) return '';
  return `
  <section class="panel ks-list">
    <h3>Per sprint</h3>
    <div class="ks-rows">
      ${m.sprints.map((s) => `
      <div class="ks-row">
        <span class="ks-name"><strong>${esc(s.name)}</strong> ${kpiSprintBadge(s)}</span>
        <span class="muted">${esc(kpiDate(s.start))} &rarr; ${esc(kpiDate(s.end))}</span>
        ${kpiBar(s.done, s.carryover, s.open)}
        <span class="muted ks-counts">${s.done} delivered · ${s.carryover} carry-over · ${s.open} open · ${kpiSp(s.spDone)} SP</span>
        <b class="ks-pct">${kpiPct(s.completion)}</b>
      </div>`).join('')}
    </div>
  </section>`;
}

/** One card per member: completion first, then story points, then a bar per sprint of the month. */
function kpiMembersPanel(v) {
  const sel = kpiUi.memberKey;
  return `
  <section class="kpi-cards" aria-label="Per member — click a card to open that person's report">
    ${v.members.map((r) => {
      const per = v.sprints.map((s) => {
        const row = (s.rows || []).find((x) => x.key === r.key);
        return row ? { name: s.name, c: row.completion } : null;
      }).filter(Boolean);
      const rate = r.completion;
      const tone = rate == null ? '' : rate >= 0.85 ? '' : rate >= 0.7 ? ' warn' : ' bad';
      return `
      <button type="button" class="kpi-card${sel === r.key ? ' selected' : ''}" data-action="kpi-member" data-key="${esc(r.key)}" aria-pressed="${sel === r.key}">
        <span class="kpi-card-who">${r.color ? `<span class="avatar avatar-sm" style="background:${safeColor(r.color)}">${esc(initials(r.name))}</span>` : ''}
          <span><strong>${esc(r.name)}</strong>${r.memberId || r.key === 'none' ? '' : '<small>not on team</small>'}</span><span class="kpi-card-go" aria-hidden="true">›</span></span>
        <span class="kpi-card-main"><b class="kpi-card-pct${tone}">${kpiPct(rate)}</b><span>${kpiSp(r.spDone)} SP delivered · ${kpiSp(r.spCarryover)} SP carried over</span></span>
        ${per.length > 1 ? `<span class="kpi-card-sprints" aria-hidden="true">${per.map((p) => `<span title="${esc(p.name)}: ${kpiPct(p.c)}"><i style="height:${Math.max(4, Math.round((p.c || 0) * 32))}px"></i><small>${esc(p.name)}</small></span>`).join('')}</span>` : ''}
        <span class="kpi-card-counts">${r.done} delivered · ${r.carryover} carry-over · ${r.open} open</span>
      </button>`;
    }).join('')}
  </section>`;
}

function kpiSprintBadge(s) {
  if (s.status === 'error') return `<span class="rbadge kpi-stale" title="${esc(s.error || '')}">stale — last refresh failed</span>`;
  if (s.status === 'pending') return '<span class="rbadge kpi-stale">not computed yet</span>';
  return '';
}

/** One card per sprint of the month: team completion, a stacked bar, and per-person rows on demand. */
function kpiSprintsPanel(v) {
  if (!v.sprints.length) return '';
  return `
  <section class="ks-cards" aria-label="Per sprint — sprints are counted in the month they started">
    ${v.sprints.map((s) => {
      const t = s.rows.reduce((a, r) => ({ d: a.d + r.done, c: a.c + r.carryover, o: a.o + r.open }), { d: 0, c: 0, o: 0 });
      const rate = t.d + t.c ? t.d / (t.d + t.c) : null;
      const warn = s.status === 'error' ? 'Last refresh failed. Numbers may be out of date.' : s.status === 'pending' ? 'Not computed yet.' : '';
      return `
    <article class="panel ks-card">
      ${warn || s.error ? `<div class="ks-warn">${esc(warn)}${s.error ? ' <span>' + esc(s.error) + '</span>' : ''}</div>` : ''}
      <div class="ks-top">
        <div><div class="ks-title"><strong>${esc(s.name)}</strong><span class="chip">${esc(s.state || 'unknown')}</span></div>
          <span class="muted">${esc(kpiDate(s.start))} &rarr; ${esc(kpiDate(s.end))}</span></div>
        <b class="ks-big${kpiTone(rate)}">${kpiPct(rate)}</b>
      </div>
      ${kpiBar(t.d, t.c, t.o)}
      ${s.rows.length ? `
      <details class="ks-members">
        <summary><span class="muted">${t.d} delivered · ${t.c} carry-over · ${t.o} open</span><span class="ks-toggle">Members</span></summary>
        ${s.rows.map((r) => `
        <div class="ks-mrow"><span class="ks-mname">${r.color ? `<span class="dot" style="background:${safeColor(r.color)}"></span>` : ''}${esc(r.name)}</span>${kpiBar(r.done, r.carryover, r.open, 'thin')}<b>${kpiPct(r.completion)}</b></div>`).join('')}
      </details>` : '<p class="muted kpi-none">No counted tasks.</p>'}
    </article>`;
    }).join('')}
  </section>`;
}

function kpiTaskKey(key) {
  const url = kpiIssueUrl(creds.site, key);
  return url ? `<a class="tk" href="${esc(url)}" target="_blank" rel="noopener">${esc(key)}</a>` : `<span class="tk">${esc(key)}</span>`;
}

/**
 * Find box match, shared by the KPI and PI ticket tables. A key matches when any space/comma
 * separated term is in it ("DEMO-4099, 4087"); the summary when it contains the whole query.
 * Case-insensitive; an empty query matches everything.
 */
function taskFindMatch(key, summary, query) {
  const q = String(query || '').trim().toUpperCase();
  if (!q) return true;
  const k = String(key || '').toUpperCase();
  if (q.split(/[\s,;]+/).some((t) => t && k.includes(t))) return true;
  return summary != null && String(summary).toUpperCase().includes(q);
}

function kpiFindCount(shown, total) {
  return shown === total ? `${total} task${total === 1 ? '' : 's'}` : `${shown} of ${total} tasks`;
}

/** A task row is shown when it matches the find box, the member picker and the outcome filter (empty = all). */
function kpiTaskShown(key, summary, personKey, query, member, outcome, want) {
  return taskFindMatch(key, summary, query) && (!member || personKey === member) && (!want || outcome === want);
}

/** The people with tasks in the list, in the report's member order, for the member picker. */
function kpiTaskPeople(v, list) {
  const order = new Map(v.members.map((m, i) => [m.key, i]));
  const people = new Map();
  for (const t of list) if (!people.has(t.person.key)) people.set(t.person.key, t.person.name);
  return [...people].map(([key, name]) => ({ key, name }))
    .sort((a, b) => (order.has(a.key) ? order.get(a.key) : Infinity) - (order.has(b.key) ? order.get(b.key) : Infinity));
}

function kpiNoneText(query, member) {
  return query ? `No task or key matches “${query}”${member ? ' for this member' : ''}.` : 'No tasks for this member.';
}

/** Filters the KPI task table in place, so the find box keeps focus while typing. */
function applyKpiTaskFilters() {
  const panel = document.querySelector('.kpi-tasks-panel');
  if (!panel) return;
  const query = kpiUi.find;
  const member = kpiUi.taskMember;
  const want = kpiUi.outcome || '';
  const rows = panel.querySelectorAll('tbody tr[data-key]');
  const counts = { '': 0 };
  let shown = 0;
  rows.forEach((tr) => {
    const base = kpiTaskShown(tr.dataset.key, tr.dataset.summary, tr.dataset.person, query, member);
    if (base) { counts[''] += 1; counts[tr.dataset.outcome] = (counts[tr.dataset.outcome] || 0) + 1; }
    const hit = base && (!want || tr.dataset.outcome === want);
    tr.hidden = !hit;
    if (hit) shown++;
  });
  panel.querySelectorAll('[data-oc]').forEach((el) => { el.textContent = counts[el.dataset.oc] || 0; });
  panel.querySelector('.kpi-find-count').textContent = kpiFindCount(shown, rows.length);
  const none = panel.querySelector('.kpi-find-none');
  if (none) {
    none.hidden = shown > 0 || !rows.length;
    none.textContent = want && !query ? 'No ' + (KPI_OUTCOMES[want] || want).toLowerCase() + ' tasks.' : kpiNoneText(query, member);
  }
}

function applyKpiFind(query) {
  kpiUi.find = query;
  applyKpiTaskFilters();
}

function applyKpiTaskMember(key) {
  kpiUi.taskMember = key;
  applyKpiTaskFilters();
}

function kpiTaskMemberPicker(people, sel) {
  return `<select id="kpiTaskMember" class="kpi-task-member" aria-label="Filter tasks by member">
          <option value="">All members</option>
          ${people.map((p) => `<option value="${esc(p.key)}"${p.key === sel ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>`;
}

function kpiTasksPanel(v) {
  const list = filterKpiTasks(v, { memberKey: kpiUi.memberKey, showExcluded: kpiUi.showExcluded });
  const who = kpiUi.memberKey && v.members.find((m) => m.key === kpiUi.memberKey);
  const q = kpiUi.find || '';
  // the picker only makes sense on the whole-team page; a member who left the list is dropped
  const people = kpiUi.memberKey ? [] : kpiTaskPeople(v, list);
  if (!people.some((p) => p.key === kpiUi.taskMember)) kpiUi.taskMember = '';
  const member = kpiUi.taskMember;
  const outs = ['done', 'carryover', 'open'].concat(kpiUi.showExcluded ? ['excluded'] : []);
  if (!outs.includes(kpiUi.outcome)) kpiUi.outcome = '';
  const want = kpiUi.outcome;
  const color = new Map(v.members.map((m) => [m.key, m.color]));
  const base = list.filter((t) => kpiTaskShown(t.key, t.summary, t.person.key, q, member));
  const shown = base.filter((t) => !want || t.outcome === want).length;
  const count = (o) => (o ? base.filter((t) => t.outcome === o).length : base.length);
  return `
  <section class="panel kpi-tasks-panel">
    <div class="kpi-tasks-head">
      <div class="kpi-tasks-title">
        <h3>Tasks${who ? ' · ' + esc(who.name) : ''}</h3>
        <span class="muted"><span class="kpi-find-count">${kpiFindCount(shown, list.length)}</span></span>
      </div>
      <div class="seg kpi-outcomes" role="group" aria-label="Outcome">
        ${[['', 'All']].concat(outs.map((o) => [o, KPI_OUTCOMES[o] || o])).map(([o, label]) =>
          `<button type="button" class="seg-btn${o ? ' oc-' + o : ''}" data-action="kpi-outcome" data-outcome="${o}" aria-pressed="${want === o}">${esc(label)} <span data-oc="${o}">${count(o)}</span></button>`).join('')}
      </div>
      <div class="kpi-filters">
        <label class="task-find"><span aria-hidden="true">&#128269;</span>
          <input type="search" id="kpiFind" value="${esc(q)}" placeholder="Filter by task or key" aria-label="Filter tasks by summary or key" autocomplete="off" spellcheck="false">
        </label>
        ${people.length > 1 ? kpiTaskMemberPicker(people, member) : ''}
        <button class="btn btn-ghost btn-sm${kpiUi.showExcluded ? ' active' : ''}" data-action="kpi-excluded" aria-pressed="${kpiUi.showExcluded}">
          ${kpiUi.showExcluded ? '&#10003; ' : ''}Show excluded</button>${tipIcon(KPI_TIPS.excluded, 'Excluded')}
      </div>
    </div>
    ${list.length ? `
    <div class="table-scroll">
      <table class="rtable kpi-tasks">
        <thead><tr><th class="left">Task</th><th class="left">Summary</th>${thTip('Sprint', KPI_TIPS.sprint, 'left')}${thTip('Outcome', KPI_TIPS.outcome, 'left')}${thTip('Delivered', KPI_TIPS.deliveredAt, 'left')}${thTip('SP', KPI_TIPS.points)}<th class="left">Member</th></tr></thead>
        <tbody>
          ${list.map((t) => {
            const c = color.get(t.person.key);
            return `
          <tr data-key="${esc(t.key)}" data-summary="${esc(t.summary)}" data-person="${esc(t.person.key)}" data-outcome="${esc(t.outcome)}"${kpiTaskShown(t.key, t.summary, t.person.key, q, member, t.outcome, want) ? '' : ' hidden'}>
            <td class="left">${kpiTaskKey(t.key)}</td>
            <td class="left note">${esc(t.summary)}${t.carried ? ` <span class="rbadge kpi-carryover">carried ${t.carried}× this month</span>` : ''}
              ${t.reason ? `<div class="muted kpi-reason">${esc(t.reason)}</div>` : ''}</td>
            <td class="left muted">${esc(t.sprintName)}</td>
            <td class="left"><span class="rbadge kpi-${esc(t.outcome)}">${esc(KPI_OUTCOMES[t.outcome] || t.outcome)}</span></td>
            <td class="left muted">${esc(kpiDate(t.doneAt)) || '—'}</td>
            <td><b>${kpiSp(Number(t.points) || 0)}</b></td>
            <td class="left"><span class="kt-who">${c ? `<span class="dot" style="background:${safeColor(c)}"></span>` : ''}${esc(t.person.name)}</span></td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p class="muted kpi-none kpi-find-none"${shown ? ' hidden' : ''}>${esc(want && !q ? 'No ' + (KPI_OUTCOMES[want] || want).toLowerCase() + ' tasks.' : kpiNoneText(q, member))}</p>` : '<p class="muted kpi-none">No tasks to show.</p>'}
  </section>`;
}

function downloadKpiXlsx() {
  const report = kpiUi.reports[ui.month];
  if (!report) return;
  try {
    const view = buildKpiView(report, state.members, state.mapping, state.settings.kpiMembers);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const bytes = XlsxLite.build(kpiSheets(view, new Date().toLocaleString('sv-SE').slice(0, 16), tz, creds.site));
    const blob = new Blob([bytes], { type: XlsxLite.MIME });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kpi-report-' + report.month + '.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Excel report downloaded', 'success');
  } catch (err) {
    console.error('KPI Excel export failed', err);
    toast('Could not create the Excel file', 'error');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildKpiView, filterKpiTasks, kpiIssueUrl, kpiSheets, kpiMemberReport, taskFindMatch, kpiTrendView, KPI_OUTCOMES,
    KPI_TIPS, kpiRules, kpiRulesError, kpiDoneWords, kpiDoneShort, kpiRulesNote,
    kpiRoleRules, kpiRoleRulesError, kpiRoleNote };
}
