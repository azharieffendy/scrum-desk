/* ================================================================
   Monthly report — attendance summary, day-by-day grid and details
   for one calendar month, on screen and as an Excel (.xlsx) file.

   buildMonthlyReport / reportSheets are pure (unit-tested in Node);
   viewReport / downloadMonthlyXlsx use the app's globals (state, ui,
   esc, memberIssues, toast) and run in the browser only.
   ================================================================ */
'use strict';

const REPORT_ATT = {
  present: { label: 'Present', code: 'P' },
  late:    { label: 'Late',    code: 'L' },
  leave:   { label: 'Leave',   code: 'LV' },
  sick:    { label: 'Sick',    code: 'S' },
  noshow:  { label: 'No show', code: 'NS' },
};
const REPORT_ATT_KEYS = Object.keys(REPORT_ATT);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function pad2(n) { return String(n).padStart(2, '0'); }

function isValidMonth(month) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month)); }

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + y;
}

function entryHasContent(e) {
  return Boolean(e && (e.attendance ||
    ['yesterday', 'today', 'blockers'].some((k) => String(e[k] || '').trim())));
}

/* A day counts only when the daily scrum was started for it — days never
 * started (holidays, weekends) had no standup, even with a JIRA snapshot.
 * Data from before the start button (no startedAt key) counts if it has notes. */
function isRecordedDay(day) {
  if (!day) return false;
  if (day.startedAt !== undefined) return Boolean(day.startedAt);
  return Object.values(day.entries || {}).some(entryHasContent);
}

function emptyCounts() {
  return REPORT_ATT_KEYS.reduce((o, k) => { o[k] = 0; return o; }, {});
}

function attendanceRate(counts, recorded) {
  return recorded ? (counts.present + counts.late) / recorded : null;
}

/**
 * @param {{members: object[], days: object}} st  board state
 * @param {string} month  YYYY-MM
 * @param {(iso: string, memberId: string) => object[]} [issuesFor]  JIRA tickets per member/day
 */
function buildMonthlyReport(st, month, issuesFor) {
  if (!isValidMonth(month)) throw new Error('Month must be YYYY-MM.');
  const [y, m] = month.split('-').map(Number);
  const dayCount = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = (st && st.days) || {};
  const members = (st && st.members) || [];
  const tickets = typeof issuesFor === 'function' ? issuesFor : () => [];

  const dates = [];
  for (let d = 1; d <= dayCount; d++) {
    const iso = month + '-' + pad2(d);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    dates.push({ iso, day: d, weekday: WEEKDAYS[dow], isWeekend, recorded: isRecordedDay(days[iso]) });
  }
  const recordedDates = dates.filter((d) => d.recorded);
  const rosterFor = (iso) => {
    const day = days[iso];
    return day && Array.isArray(day.roster) ? day.roster : members;
  };
  const reportMembers = new Map();
  for (const d of recordedDates) {
    for (const mem of rosterFor(d.iso)) reportMembers.set(mem.id, mem);
  }
  if (!recordedDates.length) for (const mem of members) reportMembers.set(mem.id, mem);

  const rows = [...reportMembers.values()].map((mem) => {
    const counts = emptyCounts();
    const statuses = {};
    for (const d of recordedDates) {
      if (!rosterFor(d.iso).some((m) => m.id === mem.id)) continue;
      const e = ((days[d.iso] || {}).entries || {})[mem.id] || {};
      const status = REPORT_ATT[e.attendance] ? e.attendance : 'present';
      statuses[d.iso] = status;
      counts[status]++;
    }
    const recorded = Object.keys(statuses).length;
    return {
      id: mem.id, name: mem.name || '', role: mem.role || '', color: mem.color,
      statuses, counts, recorded, rate: attendanceRate(counts, recorded),
    };
  });

  const totals = emptyCounts();
  for (const r of rows) for (const k of REPORT_ATT_KEYS) totals[k] += r.counts[k];
  const memberDays = rows.reduce((sum, row) => sum + row.recorded, 0);

  const details = recordedDates.map((d) => {
    const day = days[d.iso] || {};
    const counts = emptyCounts();
    const entries = rosterFor(d.iso).map((mem) => {
      const e = (day.entries || {})[mem.id] || {};
      const status = REPORT_ATT[e.attendance] ? e.attendance : 'present';
      counts[status]++;
      return {
        memberId: mem.id, name: mem.name || '', role: mem.role || '', status,
        yesterday: String(e.yesterday || '').trim(),
        today: String(e.today || '').trim(),
        blockers: String(e.blockers || '').trim(),
        tickets: (tickets(d.iso, mem.id) || []).map((t) => ({
          key: t.key || '', summary: t.summary || '', status: t.status || '',
        })),
      };
    });
    const sprint = day.jira && day.jira.sprint ? day.jira.sprint.name || '' : '';
    return { iso: d.iso, weekday: d.weekday, isWeekend: d.isWeekend, sprint, counts, entries };
  });

  return {
    month, label: monthLabel(month), dates, members: rows, details,
    recordedDays: recordedDates.length,
    totals: { counts: totals, memberDays, rate: attendanceRate(totals, memberDays) },
  };
}

/* ---------------- Excel ---------------- */

function ticketText(tickets) {
  return tickets.map((t) => t.key + ' ' + t.summary + (t.status ? ' (' + t.status + ')' : '')).join('\n');
}

/** Worksheets for XlsxLite.build(): Summary, Attendance grid, Daily detail. */
function reportSheets(report, generatedAt) {
  const when = generatedAt || new Date().toISOString().slice(0, 16).replace('T', ' ');
  const title = 'Attendance report — ' + report.label;
  const note = report.recordedDays + ' recorded day' + (report.recordedDays === 1 ? '' : 's') +
    ' · generated ' + when + ' · attendance rate = (present + late) / recorded days';

  const summaryHead = ['Member', 'Role', ...REPORT_ATT_KEYS.map((k) => REPORT_ATT[k].label), 'Recorded days', 'Attendance']
    .map((v) => ({ v, s: 'header' }));
  const summary = {
    name: 'Summary',
    cols: [26, 18, 10, 10, 10, 10, 10, 14, 12],
    freeze: { row: 3 },
    rows: [
      [{ v: title, s: 'title' }],
      [{ v: note, s: 'note' }],
      summaryHead,
      ...report.members.map((r) => [
        { v: r.name, s: 'text' }, { v: r.role, s: 'text' },
        ...REPORT_ATT_KEYS.map((k) => ({ v: r.counts[k], s: 'num' })),
        { v: r.recorded, s: 'num' },
        r.rate === null ? { v: '—', s: 'num' } : { v: r.rate, s: 'pct' },
      ]),
      [
        { v: 'Team total', s: 'boldText' }, { v: '', s: 'boldText' },
        ...REPORT_ATT_KEYS.map((k) => ({ v: report.totals.counts[k], s: 'boldNum' })),
        { v: report.totals.memberDays, s: 'boldNum' },
        report.totals.rate === null ? { v: '—', s: 'boldNum' } : { v: report.totals.rate, s: 'boldPct' },
      ],
    ],
  };

  const legend = REPORT_ATT_KEYS.map((k) => REPORT_ATT[k].code + ' = ' + REPORT_ATT[k].label).join(' · ') +
    ' · blank = no record';
  const grid = {
    name: 'Attendance',
    cols: [26, ...report.dates.map(() => 5.5), ...REPORT_ATT_KEYS.map(() => 7)],
    freeze: { row: 4, col: 1 },
    rows: [
      [{ v: 'Daily attendance — ' + report.label, s: 'title' }],
      [{ v: legend, s: 'note' }],
      [{ v: 'Member', s: 'header' }, ...report.dates.map((d) => ({ v: d.day, s: 'header' })),
        ...REPORT_ATT_KEYS.map((k) => ({ v: REPORT_ATT[k].code, s: 'header' }))],
      [{ v: '', s: 'header' }, ...report.dates.map((d) => ({ v: d.weekday, s: 'header' })),
        ...REPORT_ATT_KEYS.map(() => ({ v: 'total', s: 'header' }))],
      ...report.members.map((r) => [
        { v: r.name, s: 'boldText' },
        ...report.dates.map((d) => {
          const st = r.statuses[d.iso];
          if (st) return { v: REPORT_ATT[st].code, s: st };
          return { v: '', s: d.isWeekend ? 'weekend' : 'num' };
        }),
        ...REPORT_ATT_KEYS.map((k) => ({ v: r.counts[k], s: 'num' })),
      ]),
    ],
  };

  const detailHead = ['Date', 'Day', 'Member', 'Role', 'Attendance', 'Yesterday', 'Today', 'Blockers', 'JIRA tickets', 'Sprint']
    .map((v) => ({ v, s: 'header' }));
  const detailRows = [];
  for (const d of report.details) {
    for (const e of d.entries) {
      detailRows.push([
        { v: d.iso, s: 'text' }, { v: d.weekday, s: 'text' },
        { v: e.name, s: 'boldText' }, { v: e.role, s: 'text' },
        { v: REPORT_ATT[e.status].label, s: e.status },
        { v: e.yesterday, s: 'text' }, { v: e.today, s: 'text' }, { v: e.blockers, s: 'text' },
        { v: ticketText(e.tickets), s: 'text' }, { v: d.sprint, s: 'text' },
      ]);
    }
  }
  const detail = {
    name: 'Daily detail',
    cols: [12, 6, 24, 16, 12, 40, 40, 30, 44, 18],
    freeze: { row: 3, col: 3 },
    rows: [
      [{ v: 'Daily detail — ' + report.label, s: 'title' }],
      [{ v: detailRows.length ? 'One row per member per recorded day' : 'No recorded days this month', s: 'note' }],
      detailHead,
      ...detailRows,
    ],
  };

  return [summary, grid, detail];
}

/* ---------------- browser view ---------------- */

function currentReport() {
  return buildMonthlyReport(state, ui.month, memberIssues);
}

function pctText(rate) { return rate === null ? '—' : Math.round(rate * 100) + '%'; }

function viewReport() {
  if (!isValidMonth(ui.month)) ui.month = todayISO().slice(0, 7);
  const r = currentReport();
  const t = r.totals;
  const isNow = r.month === todayISO().slice(0, 7);
  const toolbar = `
  <section class="page-head">
    <div class="page-head-main">
      <div class="page-title-row">
        <h1 class="page-title">${esc(r.label)}</h1>
        ${isNow ? '<span class="chip">This month</span>' : '<button class="btn btn-ghost btn-sm" data-action="month-current">This month</button>'}
        <div class="date-nav">
          <button class="btn btn-ghost btn-icon" data-action="month-prev" title="Previous month" aria-label="Previous month">&lsaquo;</button>
          <input type="month" id="monthInput" value="${esc(r.month)}" aria-label="Report month">
          <button class="btn btn-ghost btn-icon" data-action="month-next" title="Next month" aria-label="Next month">&rsaquo;</button>
        </div>
      </div>
      <p class="page-meta">
        ${r.members.length && r.recordedDays ? `<span><b>${pctText(t.rate)}</b> attendance${tipIcon('Attendance rate = (present + late) ÷ recorded days', 'attendance rate')}</span><span aria-hidden="true">·</span>` : ''}
        <span>${r.recordedDays} recorded day${r.recordedDays === 1 ? '' : 's'}</span><span aria-hidden="true">·</span>
        <span>${r.members.length} member${r.members.length === 1 ? '' : 's'}</span>
      </p>
    </div>
    <div class="toolbar-right">
      <button class="btn btn-primary" data-action="download-xlsx"${r.members.length ? '' : ' disabled'}>Download Excel</button>
    </div>
  </section>`;

  if (!r.members.length) {
    return toolbar + `
    <div class="empty-wrap"><section class="panel empty">
      <div class="empty-ico">&#128202;</div>
      <h3>No team members yet</h3>
      <p>Add members on the Today board — their attendance will be summarised here each month.</p>
    </section></div>`;
  }

  return toolbar + (r.recordedDays ? attendanceGridHtml(r) : `
  <section class="panel empty-inline">
    <p>Nothing recorded in ${esc(r.label)} yet. Days appear here once a daily scrum is started on the Today board.</p>
  </section>`);
}

/** One grid: a coloured cell per member per day, then the month's counts and rate. Dates open the day in History. */
function attendanceGridHtml(r) {
  const offKeys = REPORT_ATT_KEYS.filter((k) => k !== 'present');
  const cols = `minmax(130px, 170px) repeat(${r.dates.length}, minmax(14px, 1fr)) repeat(${offKeys.length}, 52px) 52px`;
  const legend = REPORT_ATT_KEYS.map((k) => `<span><i class="ag-cell g-${k}"></i>${esc(REPORT_ATT[k].label)}</span>`).join('');
  return `
  <section class="panel att-grid-panel">
    <div class="ag-legend">${legend}<span><i class="ag-cell g-none"></i>No record</span></div>
    <div class="table-scroll">
      <div class="ag" style="grid-template-columns:${cols}" role="table" aria-label="Attendance by day">
        <div class="ag-row ag-head" role="row">
          <span role="columnheader"><span class="sr-only">Member</span></span>
          ${r.dates.map((d) => `<span role="columnheader" class="ag-date${d.isWeekend ? ' wknd' : ''}">${d.recorded
            ? `<button class="linklike" data-action="hist-open" data-date="${esc(d.iso)}" title="Open ${esc(d.iso)} in History">${d.day}</button>` : d.day}<small>${esc(d.weekday.slice(0, 2))}</small></span>`).join('')}
          ${offKeys.map((k) => `<span role="columnheader" class="ag-num">${esc(REPORT_ATT[k].label)}</span>`).join('')}
          <span role="columnheader" class="ag-num">Rate</span>
        </div>
        ${r.members.map((m) => `
        <div class="ag-row" role="row">
          <span role="rowheader" class="ag-name" title="${esc(m.name + (m.role ? ' · ' + m.role : ''))}"><span class="dot" style="background:${safeColor(m.color)}"></span>${esc(m.name)}</span>
          ${r.dates.map((d) => {
            const st = m.statuses[d.iso];
            return `<span role="cell" class="ag-cell ${st ? 'g-' + st : d.isWeekend ? 'g-wknd' : 'g-none'}" title="${esc(m.name + ' · ' + d.iso + (st ? ' · ' + REPORT_ATT[st].label : ''))}"></span>`;
          }).join('')}
          ${offKeys.map((k) => `<span role="cell" class="ag-num${m.counts[k] ? ' att-' + k : ' zero'}">${m.counts[k] || '–'}</span>`).join('')}
          <span role="cell" class="ag-num ag-rate">${pctText(m.rate)}</span>
        </div>`).join('')}
      </div>
    </div>
  </section>`;
}

function downloadMonthlyXlsx() {
  try {
    const report = currentReport();
    const bytes = XlsxLite.build(reportSheets(report));
    const blob = new Blob([bytes], { type: XlsxLite.MIME });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'attendance-report-' + report.month + '.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Excel report downloaded', 'success');
  } catch (err) {
    console.error('Excel export failed', err);
    toast('Could not create the Excel file', 'error');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildMonthlyReport, reportSheets, shiftMonth, isValidMonth, monthLabel, REPORT_ATT };
}
