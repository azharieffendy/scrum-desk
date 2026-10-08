/* ================================================================
   Performance report (admins and leads, server mode): every ticket each
   person finished in a calendar period — 1 to 12 months, set in
   Settings → Performance report (public/pi-periods.js; 4 months by default) —
   fetched live from JIRA, and the workbook the lead sends: a Summary
   sheet plus one JIRA-export-style sheet per person.
   ================================================================ */
'use strict';

const PI_COLUMNS = ['Issue Type', 'Issue key', 'Issue id', 'Summary', 'Assignee', 'Assignee Id', 'Reporter',
  'Reporter Id', 'Priority', 'Status', 'Resolution', 'Created', 'Updated', 'Due date', 'Time Spent', 'Resolved',
  'Custom field (Story Points)', 'Sprint'];
const PI_WIDTHS = [12, 12, 10, 50, 18, 26, 18, 26, 10, 10, 11, 15, 15, 17, 16, 15, 14, 22];
const PI_TOTALS_LABEL_COL = 13; // labels in column N, values in O
const EXCEL_EPOCH_DAYS = 25569; // days from 1899-12-30 to 1970-01-01
const DAY_MS = 86400000;
/** Same text as DEFAULT_TEMPLATE in lib/pi-core.js (a test keeps them equal). Saved as '' = default. */
const PI_DEFAULT_TEMPLATE = "assignee = '{assignee}' AND statusCategory = Done AND resolutionDate >= '{start}' AND resolutionDate < '{afterEnd}' ORDER BY created DESC";
const PI_DEFAULT_PREFIX = 'TEAM';
const PI_PLACEHOLDERS = ['{assignee}', '{start}'];
const PI_PERIODS = typeof PiPeriods !== 'undefined' ? PiPeriods : require('./pi-periods.js');

/** Tooltip text for the Performance report numbers and ticket columns. */
const PI_TIPS = {
  points: 'Story points: the sum of the story points of every ticket on this report (everyone shown).\n' +
    'From JIRA’s story points field (found automatically, or set in Settings → Sprint delivery (KPI)). Unestimated tickets count as 0.\n' +
    'The Performance report lists finished tickets only, so there is no Carry-over or Open here: every point is delivered work. ' +
    'Delivered / Carry-over per sprint are on the Sprint delivery tab.',
  hours: 'Hours logged: the Time Spent of these tickets, added up — from each ticket’s JIRA Time tracking, ' +
    'by anyone who logged on the ticket, whenever it was logged.',
  bars: 'Each card is one person. The bars compare people: the longest bar is the highest in the team for this period.\n' +
    'People are the members ticked in Settings → Sprint delivery (KPI) (nobody ticked = whole team), plus you.',
  sprint: 'The latest sprint the ticket was in, from JIRA’s Sprint field. “–” when it was never in a sprint.\n' +
    'Sort by Sprint ↑ to group tickets from the oldest sprint to the newest.',
  status: 'The ticket’s status in JIRA right now.',
  resolved: 'When JIRA set the resolution (resolution date), shown in your browser’s timezone.\n' +
    'Sort by Date ↑ to list from the earliest; unresolved tickets use their created date.',
  ticketHours: 'The ticket’s Time Spent in hours, from its JIRA Time tracking. “–” when no time was logged.',
  ticketPoints: 'The ticket’s story points. “–” when it was not estimated.',
  sort: 'Date ↑: earliest resolved first (created date when not resolved).\n' +
    'Sprint ↑: oldest sprint first, by sprint start date; same sprint by date; tickets with no sprint last.\n' +
    'The Excel file lists each person’s tickets in the same order.',
  saved: 'This period is over, so its tickets and hours no longer change: the result was saved when it was first read ' +
    'from JIRA and is shown from there, without asking JIRA again.\n' +
    'Use Refresh from JIRA if tickets were edited afterwards (e.g. a late worklog or a re-opened ticket).',
};

/** Which tickets count, for the "Tickets done" tooltip. */
function piCountTip() {
  const own = typeof state !== 'undefined' && state.settings && state.settings.piJql;
  const base = 'Tickets done: the tickets JIRA returns for each person’s report query in this period, added up.\n';
  return base + (own
    ? 'Your team uses its own report query (Settings → Performance report), so what counts as “done” is whatever that query selects.'
    : 'With the built-in query, a ticket counts when it is assigned to the person, is in the Done category, ' +
      'and was resolved inside the period, including the final day. ' +
      'Change it in Settings → Performance report.');
}
const PI_MAX_TEMPLATE = 4000;
const piIssueUrl = typeof kpiIssueUrl === 'function' ? kpiIssueUrl : require('./kpi-report.js').kpiIssueUrl;

/* ---------------- pure helpers (unit-tested) ---------------- */

/** '' when the template can be saved, else the reason (mirrors validateTemplate on the server). */
function piTemplateError(t) {
  if (!t.trim()) return 'The report query is empty.';
  if (t.length > PI_MAX_TEMPLATE) return 'The report query is too long (max ' + PI_MAX_TEMPLATE + ' characters).';
  const missing = PI_PLACEHOLDERS.filter((ph) => !t.includes(ph));
  if (!t.includes('{end}') && !t.includes('{afterEnd}')) missing.push('{end} or {afterEnd}');
  return missing.length ? 'The report query must contain ' + missing.join(', ') + '.' : '';
}

/** What to store for a template the admin typed: '' when it is the default. */
function piTemplateToSave(t) {
  return t.trim() === PI_DEFAULT_TEMPLATE ? '' : t.trim();
}

/** ISO instant → Excel serial of its wall-clock time in tz; null when absent. */
function piSerial(iso, tz) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).forEach((p) => { parts[p.type] = Number(p.value); });
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall / DAY_MS + EXCEL_EPOCH_DAYS;
}

/** 'YYYY-MM-DD' → Excel serial of that day; null when absent. */
function piDaySerial(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
  return Date.parse(day + 'T00:00:00Z') / DAY_MS + EXCEL_EPOCH_DAYS;
}

/** 'TEAM - JIRA - MAY AUGUST 2026.xlsx' */
function piFileName(report) {
  return (report.prefix || PI_DEFAULT_PREFIX) + ' - JIRA - ' + report.name + ' ' + report.period.slice(0, 4) + '.xlsx';
}

function piRowCells(r, tz, site) {
  const date = (iso) => ({ v: piSerial(iso, tz), s: 'date' });
  const url = piIssueUrl(site, r.key);
  return [
    r.type, url ? { v: r.key, s: 'link', link: url } : r.key, r.id ? Number(r.id) || r.id : '', r.summary,
    r.assignee, r.assigneeId, r.reporter, r.reporterId, r.priority, r.status, r.resolution,
    date(r.created), date(r.updated), { v: piDaySerial(r.due), s: 'day' },
    r.timeSpent, date(r.resolved), r.points, r.sprint || '',
  ];
}

function piTotalsRow(label, value) {
  const row = new Array(PI_TOTALS_LABEL_COL).fill(null);
  return row.concat([{ v: label, s: 'boldText' }, { v: value, s: 'boldNum' }]);
}

function piPersonSheet(p, tz, site, sort) {
  const t = p.totals;
  return {
    name: p.name,
    cols: PI_WIDTHS,
    freeze: { row: 1 },
    rows: [
      PI_COLUMNS.map((h) => ({ v: h, s: 'header' })),
      ...piSortedRows(p.rows, sort).map((r) => piRowCells(r, tz, site)),
      [],
      piTotalsRow('TOTAL TIME SPENT', t.seconds),
      piTotalsRow('TOTAL HOURS', t.hours),
      piTotalsRow('Total Story Point', t.points),
      piTotalsRow('Total Task', t.count),
    ],
  };
}

/**
 * Sheets for XlsxLite.build: Summary (name, hours logged — no header),
 * then one per person with the tickets in the table's sort order.
 */
function piSheets(report, tz, site, sort) {
  const summary = { name: 'Summary', cols: [24, 12], rows: report.people.map((p) => [p.name, p.totals.hours]) };
  return [summary, ...report.people.map((p) => piPersonSheet(p, tz, site, sort))];
}

/* ---------------- tab ---------------- */

const piUi = { period: '', reports: {}, loading: null, error: null, open: '', find: '', sort: 'date' };

function isPiAvailable() { return storageMode === 'server' && (auth.role === 'admin' || auth.role === 'lead'); }

/** The period length in months set in Settings → Performance report (4 when never set). */
function piPeriodMonths() {
  return PI_PERIODS.lengthOr(typeof state !== 'undefined' && state.settings ? state.settings.piPeriodMonths : null);
}

/** Default period (the last finished one of the set length), computed in the browser's timezone. */
function piDefaultPeriod() {
  return PI_PERIODS.lastFinished(new Date().toLocaleDateString('sv-SE'), piPeriodMonths());
}

/** The period shown: the one picked, unless the length setting changed since; else the default. */
function piCurrentPeriod() {
  const p = piUi.period;
  return PI_PERIODS.isValid(p) && PI_PERIODS.lengthOf(p) === piPeriodMonths() ? p : piDefaultPeriod();
}

const piShift = (period, by) => PI_PERIODS.shift(period, by);
const piLabel = (period) => PI_PERIODS.label(period);

/** refresh: read JIRA again even for a finished period the server has saved. */
async function loadPi(period, refresh) {
  if (piUi.loading) return;
  piUi.loading = period;
  piUi.error = null;
  render();
  try {
    // a refresh overwrites the server's saved copy, so it is a POST rather than a GET
    piUi.reports[period] = await kpiFetch('/api/pi?period=' + encodeURIComponent(period), refresh ? { method: 'POST' } : undefined);
    const failed = piUi.reports[period].people.filter((p) => p.error).length;
    if (failed) toast(failed + ' person' + (failed === 1 ? '' : 's') + ' could not be loaded — see the list', 'error');
  } catch (e) {
    piUi.error = { period, message: e.message };
  } finally {
    piUi.loading = null;
    if (ui.view === 'pi') render();
  }
}

/** Arrows step one period; a segmented control picks a period of the year (a 12-month length shows just the year). */
function piPeriodNav() {
  const p = piUi.period;
  const { year, months } = PI_PERIODS.parse(p);
  const segs = months === 12 ? '' : `<div class="seg" role="group" aria-label="Period of ${year}">${PI_PERIODS.ofYear(year, months).map((id) =>
    `<button type="button" class="seg-btn" data-action="pi-period" data-period="${esc(id)}" aria-pressed="${id === p}">${esc(PI_PERIODS.shortLabel(id))}</button>`).join('')}</div>`;
  return `
  <div class="date-nav">
    <button class="btn btn-ghost btn-icon" data-action="pi-period" data-period="${esc(piShift(p, -1))}" title="Previous period" aria-label="Previous period">&lsaquo;</button>
    <button class="btn btn-ghost btn-icon" data-action="pi-period" data-period="${esc(piShift(p, 1))}" title="Next period" aria-label="Next period">&rsaquo;</button>
  </div>${segs}`;
}

function piToolbar(report) {
  const busy = piUi.loading === piUi.period;
  return `
  <section class="page-head">
    <div class="page-head-main">
      <div class="page-title-row"><h1 class="page-title">${esc(piLabel(piUi.period))}</h1>${piPeriodNav()}</div>
      <p class="page-meta">${report ? `<span>${esc(report.start)} &rarr; ${esc(report.end)}</span><span aria-hidden="true">·</span>` : ''}${piStamp(report)}</p>
    </div>
    <div class="toolbar-right">
      ${report && report.people.length ? '<button class="btn btn-ghost" data-action="pi-download">Download Excel</button>' : ''}
      <button class="btn btn-primary" data-action="pi-generate"${busy ? ' disabled' : ''}>${busy ? 'Fetching&hellip;' : !report ? 'Generate from JIRA' : report.cachedAt ? 'Refresh from JIRA' : 'Fetch again'}</button>
    </div>
  </section>`;
}

/** "Saved" for a finished period served from the server's copy, else when it was read from JIRA. */
function piStamp(report) {
  if (!report) return '';
  if (report.cachedAt) return `<span class="muted kpi-stamp">Saved: ${esc(kpiStamp(report.cachedAt))} ${tipIcon(PI_TIPS.saved, 'saved result')}</span>`;
  return `<span class="muted kpi-stamp">Fetched: ${esc(kpiStamp(report.generatedAt))}</span>`;
}

function piYouNote(report) {
  if (report.you) return `<p class="pi-note">Includes you (${esc(report.you.name)}) along with the members ticked for KPI.</p>`;
  return `<p class="pi-note">Link your account to a team member in <button class="linklike" data-action="view" data-view="settings" data-tab="account">Settings → Account</button> to include yourself.</p>`;
}

function piTotals(report) {
  return report.people.reduce((t, p) => ({ count: t.count + p.totals.count, hours: t.hours + p.totals.hours,
    points: t.points + p.totals.points }), { count: 0, hours: 0, points: 0 });
}

function piHero(report) {
  const t = piTotals(report);
  const n = report.people.length;
  return `
  <section class="report-hero panel pi-hero">
    <div class="report-title">
      <h2>Team totals</h2>
      <p class="panel-sub">${n} ${n === 1 ? 'person' : 'people'}</p>
      ${piYouNote(report)}
    </div>
    <div class="report-stats">
      <div class="rstat rstat-main">${statLabel('Story points', PI_TIPS.points)}<b>${kpiSp(t.points)}</b></div>
      <div class="rstat kpi-done">${statLabel('Tickets done', piCountTip())}<b>${t.count}</b></div>
      <div class="rstat">${statLabel('Hours logged', PI_TIPS.hours)}<b>${kpiSp(t.hours)}</b></div>
    </div>
  </section>`;
}

const piInitials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function piRankRow(p, i, maxPoints) {
  const m = memberById(p.id);
  const color = m && m.color ? safeColor(m.color) : 'var(--accent)';
  const open = piUi.open === p.id;
  const pct = maxPoints > 0 ? Math.round((p.totals.points / maxPoints) * 100) : 0;
  return `
  <div class="pi-rank-row${open ? ' open' : ''}${p.self ? ' self' : ''}">
    <span class="muted">${i + 1}</span>
    <span class="pi-rank-who"><span class="avatar avatar-sm" style="background:${color}">${esc(piInitials(p.name))}</span><strong>${esc(p.name)}</strong>${p.self ? '<span class="chip pi-you">you</span>' : ''}</span>
    ${p.error ? `<span class="pi-error">&#9888; ${esc(p.error)}</span>` : `<span class="pi-rank-track"><i style="width:${pct}%"></i></span>
    <span class="num"><b>${kpiSp(p.totals.points)}</b></span><span class="num muted">${kpiSp(p.totals.hours)}</span><span class="num muted">${p.totals.count}</span>`}
    <span class="num">${p.rows.length ? `<button class="btn btn-ghost btn-sm" data-action="pi-open" data-id="${esc(p.id)}" aria-expanded="${open}">${open ? 'Hide' : 'Tickets'}</button>` : ''}</span>
  </div>`;
}

function piPeoplePanel(report) {
  const maxPoints = report.people.reduce((max, p) => Math.max(max, p.totals.points), 0);
  const open = report.people.find((p) => p.id === piUi.open && p.rows.length);
  return `
  <section class="panel pi-rank" aria-label="Per person, most story points first">
    <div class="pi-rank-row pi-rank-head"><span>#</span><span>Person</span><span>Story points${tipIcon(PI_TIPS.bars, 'the bars')}</span><span class="num">SP</span><span class="num">Hours</span><span class="num">Tickets</span><span></span></div>
    ${report.people.slice().sort((x, y) => (y.totals.points || 0) - (x.totals.points || 0)).map((p, i) => piRankRow(p, i, maxPoints) + (open && open.id === p.id ? piTicketPanel(open) : '')).join('')}
  </section>
  ${report.pointsField ? '' : '<p class="muted pi-note">No story points field found on this JIRA site — the story point column is empty.</p>'}`;
}

/** Report tickets are found by key only (taskFindMatch lives in kpi-report.js, loaded first). */
const piKeyMatch = (key, query) => taskFindMatch(key, null, query);

function piFindCount(shown, total) {
  return shown === total ? `${total} ticket${total === 1 ? '' : 's'}` : `${shown} of ${total} tickets`;
}

/** Filters the open ticket table in place, so the find box keeps focus while typing. Sprint headings hide with their rows. */
function applyPiFind(query) {
  piUi.find = query;
  const panel = document.querySelector('.pi-ticket-panel');
  if (!panel) return;
  let shown = 0, total = 0, head = null, any = false;
  panel.querySelectorAll('tbody tr').forEach((tr) => {
    if (tr.classList.contains('pi-group')) { if (head) head.hidden = !any; head = tr; any = false; return; }
    total++;
    const hit = piKeyMatch(tr.dataset.key, query);
    tr.hidden = !hit;
    if (hit) { shown++; any = true; }
  });
  if (head) head.hidden = !any;
  panel.querySelector('.pi-find-count').textContent = piFindCount(shown, total);
  const none = panel.querySelector('.pi-find-none');
  none.hidden = shown > 0;
  none.querySelector('span').textContent = query;
}

const PI_SORTS = { date: 'Date ↑', sprint: 'Sprint ↑' };

/** A ticket's date for sorting: when it was resolved, else created. */
const piRowDate = (r) => r.resolved || r.created || '';

function piByDate(a, b) {
  const da = piRowDate(a); const db = piRowDate(b);
  if (da !== db) return !da ? 1 : !db ? -1 : da < db ? -1 : 1;
  return a.key.localeCompare(b.key, undefined, { numeric: true });
}

/** Oldest sprint first (by start, then name); tickets without a sprint go last. Same sprint: by date. */
function piBySprint(a, b) {
  if (!a.sprint !== !b.sprint) return a.sprint ? -1 : 1;
  const sa = a.sprintStart || ''; const sb = b.sprintStart || '';
  if (sa !== sb) return !sa ? 1 : !sb ? -1 : sa < sb ? -1 : 1;
  return (a.sprint || '').localeCompare(b.sprint || '', undefined, { numeric: true }) || piByDate(a, b);
}

/** A sorted copy of the rows; the report itself keeps JIRA's order. */
function piSortedRows(rows, sort) {
  return rows.slice().sort(sort === 'sprint' ? piBySprint : piByDate);
}

function applyPiSort(sort) {
  piUi.sort = PI_SORTS[sort] ? sort : 'date';
  render();
  const el = document.querySelector('.pi-ticket-panel [data-action="pi-sort"][data-sort="' + piUi.sort + '"]');
  if (el) el.focus();
}

/** A ticket's Time Spent (JIRA's Time tracking) in hours. */
function piTicketHours(r) {
  return r.timeSpent ? kpiSp(r.timeSpent / 3600) : '<span class="muted">–</span>';
}

/** A person's tickets, opened inline under their row. Sorting by sprint groups the rows under sprint headings. */
function piTicketPanel(p) {
  const q = piUi.find || '';
  const shown = p.rows.filter((r) => piKeyMatch(r.key, q)).length;
  const bySprint = piUi.sort === 'sprint';
  let body = '';
  let group = null;
  for (const r of piSortedRows(p.rows, piUi.sort)) {
    if (bySprint && (r.sprint || '') !== group) {
      group = r.sprint || '';
      const list = p.rows.filter((x) => (x.sprint || '') === group);
      const sp = list.reduce((n, x) => n + (Number(x.points) || 0), 0);
      const h = list.reduce((n, x) => n + (x.timeSpent || 0), 0) / 3600;
      const hit = list.some((x) => piKeyMatch(x.key, q));
      body += `<tr class="pi-group"${hit ? '' : ' hidden'}><th colspan="6" scope="colgroup"><span>${group ? esc(group) : 'No sprint'}</span><span>${kpiSp(sp)} SP · ${kpiSp(h)} h</span></th></tr>`;
    }
    body += `
        <tr data-key="${esc(r.key)}"${piKeyMatch(r.key, q) ? '' : ' hidden'}><td class="left">${kpiTaskKey(r.key)}</td>
          <td class="left pi-sum">${r.type ? `<span class="pi-type">${esc(r.type)}</span>` : ''}${esc(r.summary)}</td>
          <td class="left muted">${r.sprint ? esc(r.sprint) : '–'}</td><td class="left muted">${esc(kpiDate(r.resolved))}</td>
          <td>${piTicketHours(r)}</td><td>${r.points != null ? `<b>${kpiSp(r.points)}</b>` : '<span class="muted">–</span>'}</td></tr>`;
  }
  return `
  <div class="pi-ticket-panel pi-inline" aria-label="Tickets of ${esc(p.name)}">
    <div class="pi-ticket-head">
      <div class="seg" role="group" aria-label="Sort tickets">${[['date', 'Date'], ['sprint', 'Sprint']].map(([v, label]) =>
        `<button type="button" class="seg-btn" data-action="pi-sort" data-sort="${v}" aria-pressed="${piUi.sort === v}">${label}</button>`).join('')}</div>${tipIcon(PI_TIPS.sort, 'sorting')}
      <label class="task-find"><span aria-hidden="true">&#128269;</span>
        <input type="search" id="piFind" value="${esc(q)}" placeholder="Find by key, e.g. ABC-123, 124" aria-label="Find tickets by key" autocomplete="off" spellcheck="false">
      </label>
      <span class="muted pi-ticket-totals"><span class="pi-find-count">${piFindCount(shown, p.rows.length)}</span> · ${kpiSp(p.totals.points)} SP · ${kpiSp(p.totals.hours)} h</span>
    </div>
    <div class="table-scroll"><table class="rtable pi-tickets">
      <thead><tr><th class="left">Key</th><th class="left">Summary</th>${thTip('Sprint', PI_TIPS.sprint, 'left')}${thTip('Resolved', PI_TIPS.resolved, 'left')}${thTip('Hours', PI_TIPS.ticketHours)}${thTip('SP', PI_TIPS.ticketPoints)}</tr></thead>
      <tbody>${body}
      </tbody>
    </table></div>
    <p class="muted pi-find-none"${shown ? ' hidden' : ''}>No ticket key matches “<span>${esc(q)}</span>”.</p>
  </div>`;
}

function viewPi() {
  if (!isPiAvailable()) {
    return kpiEmpty('&#128202;', 'Admins only, server mode', 'The Performance report reads JIRA on the server and is generated by an admin.');
  }
  piUi.period = piCurrentPeriod();
  return piDefaultQueryWarnHtml() + viewPiBody();
}

function viewPiBody() {
  const report = piUi.reports[piUi.period];
  if (report) return piToolbar(report) + piHero(report) + piPeoplePanel(report);
  const err = piUi.error && piUi.error.period === piUi.period ? piUi.error : null;
  if (err) {
    return piToolbar(null) + `<section class="panel empty-inline"><p>Could not build the Performance report: ${esc(err.message)}</p></section>`;
  }
  if (piUi.loading === piUi.period) return piToolbar(null) + '<section class="panel empty-inline"><p>Fetching tickets from JIRA&hellip;</p></section>';
  return piToolbar(null) + `
  <div class="empty-wrap"><section class="panel empty">
    <div class="empty-ico">&#128203;</div>
    <h3>Performance report · ${esc(piLabel(piUi.period))}</h3>
    <p>Every ticket each person finished in the period, with time spent and story points. The query is set in Settings → Performance report.</p>
    <button class="btn btn-primary" data-action="pi-generate">&#8635; Generate from JIRA</button>
  </section></div>`;
}

function downloadPiXlsx() {
  const report = piUi.reports[piUi.period];
  if (!report) return;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const bytes = XlsxLite.build(piSheets(report, tz, creds.site, piUi.sort));
    const blob = new Blob([bytes], { type: XlsxLite.MIME });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = piFileName(report);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Performance report downloaded', 'success');
  } catch (err) {
    console.error('Performance report Excel export failed', err);
    toast('Could not create the Excel file', 'error');
  }
}

/* ---------------- Settings → Performance report and Account ---------------- */

const piPreviewUi = { memberId: '', result: null, error: null };

function reportsPanel() {
  const tpl = state.settings.piJql || PI_DEFAULT_TEMPLATE;
  const months = piPeriodMonths();
  const period = piCurrentPeriod();
  const lengths = PI_PERIODS.LENGTHS.map((n) => `<option value="${n}"${n === months ? ' selected' : ''}>${esc(PI_PERIODS.lengthLabel(n))}</option>`).join('');
  const options = state.members.map((m) => `<option value="${esc(m.id)}"${m.id === piPreviewUi.memberId ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  const out = piPreviewUi.error
    ? `<p class="pi-error">${esc(piPreviewUi.error)}</p>`
    : piPreviewUi.result ? `<pre class="pi-jql">${esc(piPreviewUi.result.jql)}</pre>` : '';
  return `
  <section class="panel">
    <h3>Performance report</h3>
    <label class="field"><span>Period length</span>
      <select id="piPeriodMonths" data-setting="piPeriodMonths">${lengths}</select></label>
    <p class="panel-sub">The year is split into periods of this length, starting in January; the report page steps through them. Saved results of each period are kept, so switching back loses nothing.</p>
    <p class="panel-sub">The Performance report tab runs this query once per person for the chosen period.
      <code>{assignee}</code> becomes the person's JIRA account (or email), <code>{start}</code> the first day, <code>{end}</code> the final day: <code>&lt;= '{end}'</code> always includes the whole final day, also for date-time fields such as resolutionDate. <code>{afterEnd}</code> is the day after the period, if you prefer <code>&lt; '{afterEnd}'</code>. People: the members ticked in Settings → Sprint delivery (KPI), plus you.</p>
    <label class="field"><span>Query template (JQL)</span>
      <textarea id="piJql" data-setting="piJql" rows="7" spellcheck="false" class="pi-template">${esc(tpl)}</textarea></label>
    <div class="row-gap">
      <button class="linklike" data-action="pi-reset-jql" style="font-size:12.5px">reset to default</button>
    </div>
    <label class="field"><span>File name prefix</span>
      <input data-setting="piPrefix" placeholder="TEAM" maxlength="40" value="${esc(state.settings.piPrefix || '')}" autocomplete="off"></label>
    <p class="panel-sub">Download name: <b>${esc((state.settings.piPrefix || PI_DEFAULT_PREFIX) + ' - JIRA - ' + piPeriodWords(period) + '.xlsx')}</b></p>
  </section>
  <section class="panel">
    <h3>Preview the query</h3>
    <p class="panel-sub">Shows the saved query filled in for one person and ${esc(piLabel(period))} — paste it into JIRA's issue search to check the count.</p>
    <label class="field"><span>Team member</span>
      <select id="piPreviewMember"><option value="">Choose a member…</option>${options}</select></label>
    <div class="row-gap">
      <button class="btn btn-ghost btn-sm" data-action="pi-preview">Preview JQL</button>
    </div>
    ${out}
  </section>`;
}

/** e.g. 2026-P2 → 'MAY AUGUST 2026' (same words as periodName on the server). */
function piPeriodWords(period) {
  return PI_PERIODS.words(period) + ' ' + period.slice(0, 4);
}

function savePiTemplate(el) {
  const err = piTemplateError(el.value);
  if (err) { toast(err + ' Not saved.', 'error'); return; }
  state.settings.piJql = piTemplateToSave(el.value);
  piPreviewUi.result = null;
  saveState({ quiet: true });
}

function resetPiTemplate() {
  state.settings.piJql = '';
  piPreviewUi.result = null;
  saveState({ quiet: true });
  render();
  toast('Report query reset to default');
}

async function previewPiJql() {
  const sel = document.getElementById('piPreviewMember');
  piPreviewUi.memberId = sel ? sel.value : '';
  if (!piPreviewUi.memberId) { toast('Choose a team member first', 'error'); return; }
  piPreviewUi.result = null;
  piPreviewUi.error = null;
  try {
    piPreviewUi.result = await kpiFetch('/api/pi/preview?person=' + encodeURIComponent(piPreviewUi.memberId) +
      '&period=' + encodeURIComponent(piCurrentPeriod()));
  } catch (e) {
    piPreviewUi.error = e.message;
  }
  render();
}

/** Account: which team member this sign-in is (adds you to the Performance report). */
function piMeField() {
  if (storageMode !== 'server' || !state.members.length) return '';
  const options = state.members.map((m) => `<option value="${esc(m.id)}"${m.id === auth.memberId ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  return `
    <label class="field"><span>This is me</span>
      <select id="meMember" data-me-member><option value="">Not on the team</option>${options}</select></label>
    <p class="panel-sub">Your team member — the Performance report includes you along with the members ticked for KPI.</p>`;
}

async function linkMeMember(memberId) {
  try {
    const data = await kpiFetch('/api/auth/member', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId }),
    });
    auth.memberId = data.memberId;
    piUi.reports = {};
    toast(memberId ? 'Linked to your team member' : 'Unlinked', 'success');
  } catch (e) {
    toast(e.message, 'error');
    render();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { piSheets, piSerial, piDaySerial, piFileName, piShift, piTemplateError, piTemplateToSave,
    piPeriodWords, piLabel, PI_COLUMNS, PI_DEFAULT_TEMPLATE };
}
