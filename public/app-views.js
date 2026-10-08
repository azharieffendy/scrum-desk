/* Scrum Desk — standup notes, view templates, render, modal and toasts.
 * Classic script: shares globals with app-core.js, app-auth.js,
 * app-views.js and app.js (see index.html for the load order). */
'use strict';

/* ---------------- standup notes & report ---------------- */

function attNote(att) {
  switch (att) {
    case 'late': return '(late for opening)';
    case 'leave': return '— ON LEAVE';
    case 'sick': return '— SICK';
    case 'noshow': return '— NO SHOW';
    default: return '';
  }
}

function buildNotes(dateISO) {
  const day = state.days[dateISO];
  const blockerRuns = blockersOnDay(blockerEpisodes(state, { through: dateISO }), dateISO);
  const lines = [];
  lines.push('Daily Standup — ' + fmtDay(dateISO));
  if (hasTeamPicker() && ui.team) lines.push('Team: ' + (ui.team === 'none' ? 'No lead' : leadName(ui.team) + "'s team"));
  const sprint = day && day.jira && day.jira.sprint;
  if (sprint) {
    const dl = daysLeftLabel(sprint.end);
    lines.push('Sprint: ' + sprint.name + (dl ? ' — ' + dl : ''));
  }
  const counts = { late: 0, leave: 0, sick: 0, noshow: 0 };
  for (const m of membersForDay(dateISO)) {
    const e = (day && day.entries && day.entries[m.id]) || {};
    if (counts[e.attendance] != null) counts[e.attendance]++;
  }
  const attParts = [];
  if (counts.late) attParts.push(counts.late + ' late');
  if (counts.leave) attParts.push(counts.leave + ' on leave');
  if (counts.sick) attParts.push(counts.sick + ' sick');
  if (counts.noshow) attParts.push(counts.noshow + ' no show');
  if (attParts.length) lines.push('Attendance: ' + attParts.join(' · '));
  lines.push('');

  for (const m of membersForDay(dateISO)) {
    const e = (day && day.entries && day.entries[m.id]) || {};
    const tickets = memberIssues(dateISO, m.id);
    const note = attNote(e.attendance);
    const hasText = (e.yesterday || '').trim() || (e.today || '').trim() || (e.blockers || '').trim();
    if (!hasText && !tickets.length && !note) continue;
    lines.push('* ' + m.name + (m.role ? ' (' + m.role + ')' : '') + (note ? ' ' + note : ''));
    if (hasText || tickets.length) {
      if ((e.yesterday || '').trim()) lines.push('Yesterday: ' + e.yesterday.trim());
      if ((e.today || '').trim()) lines.push('Today: ' + e.today.trim());
      if ((e.blockers || '').trim()) {
        const run = blockerRuns.get(m.id);
        lines.push('Blockers: ' + e.blockers.trim() + (run && run.age > 1 ? ' (blocked ' + daysLabel(run.age) + ')' : ''));
      }
      if (tickets.length) lines.push('JIRA: ' + tickets.map((t) => t.key + ' ' + t.summary + ' (' + t.status + ')').join('; '));
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
}

async function copyNotes(dateISO) {
  if (!isStarted(state.days[dateISO || ui.date])) { toast('No standup on this day'); return; }
  const text = buildNotes(dateISO || ui.date);
  if (!text) { toast('Nothing to copy yet — add some notes first'); return; }
  const ok = await copyText(text);
  toast(ok ? 'Standup notes copied — paste them anywhere' : 'Could not access the clipboard', ok ? 'success' : 'error');
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** One workbook for a started day: attendance and notes, plus one row per matched JIRA ticket. */
function dayReportSheets(dateISO) {
  const day = state.days[dateISO];
  const people = membersForDay(dateISO).map((m) => ({
    member: m, entry: (day.entries || {})[m.id] || {}, tickets: memberIssues(dateISO, m.id),
  }));
  const heading = (labels) => labels.map((v) => ({ v, s: 'header' }));
  const standupRows = [
    [{ v: 'Daily Standup — ' + fmtDay(dateISO), s: 'title' }],
    [{ v: 'Date', s: 'boldText' }, dateISO],
  ];
  if (hasTeamPicker() && ui.team) standupRows.push([{ v: 'Team', s: 'boldText' }, ui.team === 'none' ? 'No lead' : leadName(ui.team) + "'s team"]);
  if (day.jira && day.jira.sprint) standupRows.push([{ v: 'Sprint', s: 'boldText' }, day.jira.sprint.name || '']);
  standupRows.push([], heading(['Member', 'Role', 'Attendance', 'Yesterday', 'Today', 'Blockers', 'Sprint tickets']));
  for (const { member, entry, tickets } of people) {
    const attendance = ATT[entry.attendance] ? entry.attendance : 'present';
    standupRows.push([
      { v: member.name, s: 'text' }, { v: member.role || '', s: 'text' },
      { v: ATT[attendance].label, s: attendance },
      ...['yesterday', 'today', 'blockers'].map((field) => ({ v: String(entry[field] || ''), s: 'text' })),
      { v: tickets.length, s: 'num' },
    ]);
  }
  const ticketRows = [heading(['Member', 'Key', 'Summary', 'Status', 'Priority'])];
  for (const { member, tickets } of people) {
    for (const ticket of tickets) ticketRows.push([
      { v: member.name, s: 'text' },
      { v: ticket.key || '', s: ticket.url ? 'link' : 'text', link: ticket.url },
      { v: ticket.summary || '', s: 'text' }, { v: ticket.status || '', s: 'text' },
      { v: ticket.priority || '', s: 'text' },
    ]);
  }
  return [
    { name: 'Daily standup', cols: [24, 18, 16, 38, 38, 38, 16], freeze: { row: standupRows.length - people.length }, rows: standupRows },
    { name: 'Sprint tickets', cols: [24, 16, 55, 20, 16], freeze: { row: 1 }, rows: ticketRows },
  ];
}

function downloadReport(dateISO) {
  const d = dateISO || ui.date;
  if (!isStarted(state.days[d])) { toast('No standup on this day'); return; }
  try {
    const bytes = XlsxLite.build(dayReportSheets(d));
    const blob = new Blob([bytes], { type: XlsxLite.MIME });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'standup-report-' + d + '.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Excel report downloaded', 'success');
  } catch (err) {
    console.error('Daily standup Excel export failed', err);
    toast('Could not create the Excel file', 'error');
  }
}

/* ---------------- view templates ---------------- */

/** Past days show their saved roster; today shows the current team. */
function boardMembersFor(date, day) {
  return filterByTeam(date !== todayISO() && day && Array.isArray(day.roster) ? day.roster : state.members);
}

/** Members split per Technical Lead (leads in server order, then "No lead"); empty groups are dropped. */
function groupByTeam(members) {
  const keys = leads.map((l) => l.id).concat('none');
  return keys
    .map((key) => ({ key, name: leadName(key), members: members.filter((m) => teamKey(m) === key) }))
    .filter((g) => g.members.length);
}
/** Group under "All" only when there is more than one team to tell apart. */
function teamGroups(members) {
  if (!hasTeamPicker() || ui.team) return null;
  const groups = groupByTeam(members);
  return groups.length > 1 ? groups : null;
}

function teamPickerHtml() {
  if (!hasTeamPicker()) return '';
  const opts = [['', 'All teams']].concat(leads.map((l) => [l.id, l.name + "'s team"]), [['none', 'No lead']]);
  return `<label class="team-picker"><span>Team</span>
    <select id="teamFilter" aria-label="Show team">${opts.map(([v, label]) =>
      `<option value="${esc(v)}"${ui.team === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;
}
const teamHeading = (g) => `<h4 class="team-group-head"><span>${esc(g.name)}</span><span class="team-group-count">${g.members.length}</span></h4>`;

function viewToday() {
  const day = state.days[ui.date];
  const isToday = ui.date === todayISO();
  const syncedAt = day && day.jira ? new Date(day.jira.syncedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const started = isStarted(day);
  const boardMembers = boardMembersFor(ui.date, day);
  let body;
  if (!boardMembers.length && ui.team && state.members.length) body = '<p class="today-filter-empty">Nobody on this team yet — pick another team or set a Technical Lead on a member in Settings.</p>';
  else if (!boardMembers.length) body = `<section class="member-grid">${emptyTeamHtml()}</section>`;
  else if (!started) body = notStartedHtml();
  else body = startedBoardHtml(boardMembers, day, isToday);
  const dateLabel = new Date(ui.date + 'T00:00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  return `
  ${setupChecklistHtml()}
  <section class="page-head">
    <div class="page-head-main">
      <div class="page-title-row">
        <h1 class="page-title">${esc(dateLabel)}</h1>
        ${isToday
          ? '<span class="chip">Today</span>'
          : '<button class="btn btn-ghost btn-sm" data-action="goto-today">Go to today</button>'}
        <div class="date-nav">
          <button class="btn btn-ghost btn-icon" data-action="prev-day" title="Previous day" aria-label="Previous day">&lsaquo;</button>
          <input type="date" id="dateInput" value="${esc(ui.date)}" aria-label="Board date">
          <button class="btn btn-ghost btn-icon" data-action="next-day" title="Next day" aria-label="Next day">&rsaquo;</button>
        </div>
      </div>
      <p class="page-meta">
        <span>${syncedAt ? 'JIRA updated ' + esc(syncedAt) : 'JIRA has not been synced for this day'}</span>
        ${canEdit() && isToday ? `<button class="linklike" data-action="sync" id="syncBtn" title="Pull the current sprint from JIRA">${day && day.jira ? 'Re-sync' : 'Sync now'}</button>` : ''}
      </p>
    </div>
    <div class="toolbar-right">
      ${teamPickerHtml()}
      ${started ? `
      <details class="nav-dropdown day-actions">
        <summary class="btn btn-ghost">More</summary>
        <div class="dropdown-panel">
          <button class="btn btn-ghost" data-action="report">Download Excel report</button>
          ${canEdit() ? '<button class="btn btn-ghost danger" data-action="cancel-day">Cancel standup</button>' : ''}
        </div>
      </details>
      <button class="btn btn-primary" data-action="copy">Copy standup notes</button>` : ''}
    </div>
  </section>
  ${body}`;
}

function notStartedHtml() {
  const dow = new Date(ui.date + 'T00:00:00').getDay();
  const weekend = dow === 0 || dow === 6;
  const future = ui.date > todayISO();
  let hint;
  if (future) hint = 'This day has not happened yet — a standup can be started on the day itself.';
  else if (canEdit()) hint = 'Start the standup to take attendance and write notes. Days that are never started (holidays, weekends) are left out of reports.';
  else hint = 'An admin has not started the standup for this day.';
  return `
  <div class="empty-wrap">
    <section class="panel empty">
      <div class="empty-ico">&#9208;</div>
      <h3>No standup on this day</h3>
      <p>${weekend ? 'It is the weekend. ' : ''}${hint}</p>
      ${canEdit() && !future ? '<button class="btn btn-primary" data-action="start-day">&#9654; Start standup</button>' : ''}
    </section>
  </div>`;
}

async function startDay() {
  const today = todayISO();
  const date = ui.date;
  if (date > today) { toast('A standup can only be started on the day itself', 'error'); return; }
  if (date < today && !await askConfirm({
    title: 'Start a past day?',
    message: 'Start a standup for ' + fmtDay(date) + '? The current team is used as the roster of that day.',
    confirmLabel: 'Start standup',
  })) return;
  const day = getDay(date, true);
  day.startedAt = new Date().toISOString();
  day.roster = state.members.map(memberSnapshot);
  saveState();
  render();
  toast('Standup started for ' + fmtDay(date), 'success');
}

/** Cancelling keeps a copy of the day so the Undo toast can put it back. */
function cancelDay() {
  const date = ui.date;
  const day = state.days[date];
  if (!isStarted(day)) return;
  const saved = clone({ startedAt: day.startedAt, entries: day.entries || {}, roster: day.roster || null });
  day.startedAt = null;
  day.entries = {};
  day.roster = null;
  persistSoon.cancel();
  saveState();
  render();
  return toastUndo('Standup cancelled for ' + fmtDay(date) + ' — this day counts as no standup', () => restoreCancelledDay(date, saved));
}

function restoreCancelledDay(date, saved) {
  const day = getDay(date, true);
  if (isStarted(day)) { toast('That day was started again meanwhile — nothing to undo', 'error'); return; }
  Object.assign(day, clone(saved));
  saveState();
  render();
  toast('Standup restored', 'success');
}

const AWAY = ['leave', 'sick', 'noshow'];
const entryOf = (day, id) => (day && day.entries && day.entries[id]) || {};
const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const hasBlocker = (e) => hasText(e.blockers);
/** Has a blocker today, or an earlier one still waiting for Still blocked / Resolved. */
const flagsBlocker = (m, e) => hasBlocker(e) || Boolean(pendingCarry(m.id, e));
const hasNotes = (e) => hasText(e.yesterday) || hasText(e.today) || hasText(e.blockers);
/** Away with nothing written: shown only in the roll call, not as a card. */
const isStripped = (e) => AWAY.includes(e.attendance) && !hasNotes(e);
/** Here, but neither yesterday nor today written yet. */
const needsUpdate = (e) => !AWAY.includes(e.attendance) && !hasText(e.yesterday) && !hasText(e.today);

/** Head counts for the summary bar. here = present or late; away = leave, sick or no-show. */
function todaySummary(members, day) {
  const out = { total: members.length, here: 0, late: 0, away: 0, blockers: 0, noUpdate: 0 };
  for (const m of members) {
    const e = entryOf(day, m.id);
    if (AWAY.includes(e.attendance)) out.away++; else out.here++;
    if (e.attendance === 'late') out.late++;
    if (flagsBlocker(m, e)) out.blockers++;
    if (needsUpdate(e)) out.noUpdate++;
  }
  return out;
}

function todaySummaryHtml(members, day) {
  const s = todaySummary(members, day);
  const cur = ui.todayFilter || '';
  const opts = [['', 'Everyone', s.here], ['blockers', 'Blockers', s.blockers], ['noupdate', 'No update', s.noUpdate]];
  return `<div class="seg" id="todaySummary" role="group" aria-label="Show">${opts.map(([val, label, n]) =>
    `<button type="button" class="seg-btn${val === 'blockers' ? ' seg-blockers' : ''}" data-action="today-filter" data-filter="${val}" aria-pressed="${cur === val}">${label} <span>${n}</span></button>`).join('')}</div>`;
}

/* Attendance status: a coloured pill that opens a menu of every status.
 * ui.attMenu = { id, src } names the one open menu; src is 'roll', 'card' or 'sheet'. */

/** The status pill; editors see a caret so it reads as something to click. */
function attPill(att, edit) {
  return `<span class="att-pill att-${att}"><span class="att-dot" aria-hidden="true"></span>${esc(ATT[att].label)}${edit ? '<span class="att-caret" aria-hidden="true">&#9662;</span>' : ''}</span>`;
}

const attMenuOpen = (id, src) => Boolean(ui.attMenu && ui.attMenu.id === id && ui.attMenu.src === src);

function attTriggerAttrs(m, att, src) {
  return `data-action="att-menu" data-id="${esc(m.id)}" data-src="${src}" aria-haspopup="menu" aria-expanded="${attMenuOpen(m.id, src)}" aria-label="Attendance for ${esc(m.name)}: ${esc(ATT[att].label)}. Change status"`;
}

/** The open menu under one pill: every status with its hint and shortcut key, the current one checked. */
function attMenuHtml(m, att, src) {
  if (!attMenuOpen(m.id, src)) return '';
  return `<div class="att-menu" role="menu" aria-label="Attendance for ${esc(m.name)}">${Object.keys(ATT).map((k) =>
    `<button type="button" class="att-option att-${k}" role="menuitemradio" aria-checked="${k === att}" tabindex="-1" data-action="att-set" data-id="${esc(m.id)}" data-src="${src}" data-att="${k}">
      <span class="att-dot" aria-hidden="true"></span><span class="att-option-text">${esc(ATT[k].label)}<small>${esc(ATT[k].title)}</small></span><kbd aria-hidden="true">${ATT[k].key.toUpperCase()}</kbd></button>`).join('')}</div>`;
}

/** Status on a card or sheet row: pill button and menu for editors, a plain pill for viewers. */
function attControl(m, att, src) {
  if (!canEdit()) return `<span class="att-pick" title="${esc(ATT[att].title)}">${attPill(att, false)}</span>`;
  return `<span class="att-pick"><button type="button" class="att-trigger" ${attTriggerAttrs(m, att, src)}>${attPill(att, true)}</button>${attMenuHtml(m, att, src)}</span>`;
}

/** The menu is fixed-position so card and sheet scroll boxes never clip it: below the pill, or above when there is no room. */
function positionAttMenu() {
  const menu = $('.att-menu');
  const trigger = menu && $('[data-action="att-menu"]', menu.parentElement);
  if (!trigger) return;
  const r = trigger.getBoundingClientRect();
  const below = r.bottom + 6 + menu.offsetHeight <= window.innerHeight;
  menu.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - 6 - menu.offsetHeight)) + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - menu.offsetWidth)) + 'px';
}

/** One row of everyone on the roster; clicking a person opens their status menu. */
function rollCallHtml(members, day) {
  const s = todaySummary(members, day);
  const edit = canEdit();
  return `
  <section class="roll-call" aria-label="Roll call">
    <div class="roll-count"><span class="roll-label">Roll call</span><span><b>${s.here}</b>/${s.total} here</span>${edit ? '<span class="roll-hint">Tap a status to change it</span>' : ''}</div>
    <div class="roll-people">${members.map((m) => {
      const saved = entryOf(day, m.id).attendance;
      const att = ATT[saved] ? saved : 'present';
      const inner = `<span class="avatar avatar-roll" style="background:${safeColor(m.color)}">${esc(initials(m.name))}</span><span class="roll-text"><span class="roll-name">${esc(m.name.split(' ')[0])}</span>${attPill(att, edit)}</span>`;
      return edit
        ? `<span class="att-pick"><button type="button" class="roll-person att-${att}" ${attTriggerAttrs(m, att, 'roll')} title="${esc(m.name)}: ${esc(ATT[att].label)}">${inner}</button>${attMenuHtml(m, att, 'roll')}</span>`
        : `<span class="roll-person att-${att}" title="${esc(m.name)}: ${esc(ATT[att].label)}">${inner}</span>`;
    }).join('')}</div>
  </section>`;
}

/** Cards / Sheet switch; the choice is remembered per browser. */
function boardViewHtml() {
  return `<div class="seg board-view" role="group" aria-label="Board layout">${[['cards', 'Cards'], ['sheet', 'Sheet']].map(([v, label]) =>
    `<button type="button" class="seg-btn" data-action="board-view" data-view="${v}" aria-pressed="${ui.boardView === v}">${label}</button>`).join('')}</div>`;
}

/**
 * Cards: roll call, filter row, then the card grid. Sheet: filter row, then one
 * table row per person (away members included, attendance in the member cell).
 * ui.todayFilter 'blockers' / 'noupdate' narrows either layout.
 */
function startedBoardHtml(members, day, isToday) {
  refreshBoardBlockers(ui.date);
  const filter = ui.todayFilter || '';
  const sheet = ui.boardView === 'sheet';
  const shown = members.filter((m) => {
    const e = entryOf(day, m.id);
    if (filter === 'blockers') return flagsBlocker(m, e);
    if (filter === 'noupdate') return needsUpdate(e);
    return sheet || !isStripped(e);
  });
  let board;
  if (!shown.length && filter) board = `<p class="today-filter-empty">${filter === 'blockers' ? 'No blockers right now.' : 'Everyone has given an update.'}</p>`;
  else if (sheet) board = sheetHtml(shown, members, day);
  else {
    const groups = teamGroups(shown);
    const cardsHtml = groups
      ? groups.map((g) => teamHeading(g) + g.members.map((m) => memberCard(m, day)).join('')).join('')
      : shown.map((m) => memberCard(m, day)).join('');
    board = `<section class="member-grid">${cardsHtml}${canEdit() && isToday && !filter ? addMemberCard() : ''}</section>`;
  }
  return `${sheet ? '' : rollCallHtml(members, day)}
    <div class="board-tools">
      <label class="member-search"><span class="sr-only">Find members by name or role</span>
        <input type="search" id="memberSearch" placeholder="Find a member or role" value="${esc(ui.memberSearch)}" autocomplete="off"></label>
      ${todaySummaryHtml(members, day)}
      <span class="search-count" id="memberSearchCount" role="status"></span>
      ${sheet ? '' : `<button class="btn btn-ghost btn-sm" data-action="board-density" aria-pressed="${ui.compact}">Compact view</button>`}
      ${boardViewHtml()}
    </div>
    ${board}
    <p class="today-filter-empty" id="memberSearchEmpty" hidden>No members match your search. <button class="linklike" data-action="clear-member-search">Clear search</button></p>`;
}


/** One note cell of the sheet: plain text for viewers, a click-to-edit preview for editors, the autosaved textarea while editing. */
function sheetNote(m, e, field, label) {
  const value = e[field] || '';
  const editing = ui.editingNote && ui.editingNote.date === ui.date && ui.editingNote.member === m.id && ui.editingNote.field === field;
  const attrs = `data-date="${esc(ui.date)}" data-member="${esc(m.id)}" data-field="${field}"`;
  if (canEdit() && editing) {
    return `<textarea data-entry ${attrs} rows="3" aria-label="${label} for ${esc(m.name)}">${esc(value)}</textarea>
      <button type="button" class="btn btn-ghost btn-sm" data-action="finish-note" ${attrs}>Done editing</button>`;
  }
  const filled = value.trim() !== '';
  const text = filled ? esc(value) : (field === 'blockers' || AWAY.includes(e.attendance) ? '—' : 'No update yet');
  const cls = `sheet-note${filled ? '' : ' note-empty'}`;
  if (!canEdit()) return `<p class="${cls}">${text}</p>`;
  return `<button type="button" class="${cls}" data-action="edit-note" ${attrs} aria-label="Edit ${label.toLowerCase()} for ${esc(m.name)}: ${filled ? esc(value) : 'empty'}">${text}</button>`;
}

function sheetRow(m, day) {
  const e = entryOf(day, m.id);
  const att = ATT[e.attendance] ? e.attendance : 'present';
  const tickets = memberIssues(ui.date, m.id);
  const counts = ticketSummary(tickets);
  const attHtml = attControl(m, att, 'sheet');
  return `<tr class="sheet-row att-${att}${AWAY.includes(att) ? ' is-away' : ''}${hasBlocker(e) ? ' has-blocker' : ''}" data-member="${esc(m.id)}" data-search="${esc((m.name + ' ' + (m.role || '')).toLowerCase())}">
    <th scope="row"><div class="sheet-member">
      <span class="avatar avatar-roll" style="background:${safeColor(m.color)}">${esc(initials(m.name))}</span>
      <span class="sheet-who"><strong>${esc(m.name)}</strong><span>${m.role ? esc(m.role) + ' · ' : ''}${attHtml}</span></span>
    </div></th>
    <td>${sheetNote(m, e, 'yesterday', 'Yesterday')}</td>
    <td>${sheetNote(m, e, 'today', 'Today')}</td>
    <td class="sheet-blockers">${blockerAgeHtml(m.id, e)}${carryPromptHtml(m, e, true)}${sheetNote(m, e, 'blockers', 'Blockers')}</td>
    <td>${tickets.length ? `${ticketBarHtml(counts, tickets.length)}
      <span class="sheet-ticket-meta">${counts.progress} in progress · ${counts.done}/${tickets.length} done</span>` : '<span class="sheet-ticket-meta">—</span>'}</td>
  </tr>`;
}

/** Sheet layout for screen-sharing: columns line up, one row per person, team headings as spanning rows. */
function sheetHtml(shown, members, day) {
  const s = todaySummary(members, day);
  const groups = teamGroups(shown);
  const rows = groups
    ? groups.map((g) => `<tr class="sheet-group"><th colspan="5" scope="colgroup">${esc(g.name)} <span class="team-group-count">${g.members.length}</span></th></tr>` +
        g.members.map((m) => sheetRow(m, day)).join('')).join('')
    : shown.map((m) => sheetRow(m, day)).join('');
  return `<div class="sheet-wrap"><table class="sheet">
    <thead><tr><th scope="col">Member <span class="sheet-here"><b>${s.here}</b>/${s.total} here</span></th><th scope="col">Yesterday</th><th scope="col">Today</th><th scope="col">Blockers</th><th scope="col">Sprint tickets</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function entryField(m, e, field, label, placeholder, extra = '') {
  const value = e[field] || '';
  const editing = ui.editingNote && ui.editingNote.date === ui.date && ui.editingNote.member === m.id && ui.editingNote.field === field;
  const attrs = `data-date="${esc(ui.date)}" data-member="${esc(m.id)}" data-field="${field}"`;
  const text = value.trim() ? esc(value) : (field === 'blockers' ? 'No blockers' : 'No update yet');
  if (!canEdit()) return `<div class="field field-${field}"><span>${label}${extra}</span><p class="note-text${value.trim() ? '' : ' note-empty'}">${text}</p></div>`;
  if (ui.compact && !editing) return `<div class="field field-${field}"><span>${label}${extra}</span>
    <button type="button" class="note-preview${value.trim() ? '' : ' note-empty'}" data-action="edit-note" ${attrs} aria-label="Edit ${field} for ${esc(m.name)}: ${text}">${text}</button></div>`;
  return `<div class="field field-${field}"><label class="field"><span>${label}${extra}</span>
    <textarea data-entry ${attrs} rows="3" placeholder="${placeholder}" aria-label="${field} for ${esc(m.name)}">${esc(value)}</textarea></label>
    ${ui.compact ? `<button type="button" class="btn btn-ghost btn-sm" data-action="finish-note" ${attrs}>Done editing</button>` : ''}</div>`;
}

function applyMemberSearch() {
  const q = ui.memberSearch.trim().toLowerCase();
  const cards = $$('.member-card, .away-item, .sheet-row');
  let shown = 0;
  cards.forEach((card) => { card.hidden = !card.dataset.search.includes(q); if (!card.hidden) shown++; });
  $$('.member-grid .team-group-head, .sheet .sheet-group').forEach((head) => {
    let next = head.nextElementSibling, visible = false;
    while (next && !next.classList.contains('team-group-head') && !next.classList.contains('sheet-group')) {
      if ((next.classList.contains('member-card') || next.classList.contains('sheet-row')) && !next.hidden) visible = true;
      next = next.nextElementSibling;
    }
    head.hidden = !visible;
  });
  const away = $('.away-strip');
  if (away) away.hidden = !cards.some((card) => card.classList.contains('away-item') && !card.hidden);
  const add = $('.add-member');
  if (add) add.hidden = Boolean(q);
  const empty = $('#memberSearchEmpty');
  if (empty) empty.hidden = !q || shown > 0;
  const count = $('#memberSearchCount');
  if (count) count.textContent = q ? `${shown} of ${cards.length} members` : '';
}

/** Stacked done / in progress / to do bar for n tickets. */
function ticketBarHtml(counts, n) {
  const pct = (x) => (n ? (x / n) * 100 : 0).toFixed(1) + '%';
  return `<span class="ticket-bar" title="${counts.done} done · ${counts.progress} in progress · ${counts.todo} to do"><span class="tb-done" style="width:${pct(counts.done)}"></span><span class="tb-prog" style="width:${pct(counts.progress)}"></span><span class="tb-todo" style="width:${pct(counts.todo)}"></span></span>`;
}

function ticketSummary(tickets) {
  return {
    todo: tickets.filter((t) => t.statusCategory === 'new').length,
    progress: tickets.filter((t) => t.statusCategory === 'indeterminate').length,
    done: tickets.filter((t) => t.statusCategory === 'done').length,
  };
}

function filterMemberTickets(tickets, filter) {
  if (filter === 'active') return tickets.filter((t) => t.statusCategory !== 'done');
  if (filter === 'done') return tickets.filter((t) => t.statusCategory === 'done');
  return tickets;
}

/** Today ticket priority: To Do, Untested, other active statuses, then Done. */
function todayTicketRank(ticket) {
  if (ticket.statusCategory === 'done') return 3;
  if (ticket.statusCategory === 'new' || String(ticket.status || '').trim().toLowerCase() === 'to do') return 0;
  if (String(ticket.status || '').trim().toLowerCase() === 'untested') return 1;
  return 2;
}

function memberTicketsHtml(m, tickets, key) {
  const selected = ui.ticketFilters.get(key) || 'all';
  const counts = ticketSummary(tickets);
  const shown = filterMemberTickets(tickets, selected).slice().sort((a, b) => todayTicketRank(a) - todayTicketRank(b));
  const filters = [['all', 'All', tickets.length], ['active', 'Active', tickets.length - counts.done], ['done', 'Done', counts.done]];
  return `<div class="ticket-filters" role="group" aria-label="Sprint ticket filter for ${esc(m.name)}">
    ${filters.map(([value, label, count]) => `<button class="ticket-filter" type="button" data-action="ticket-filter" data-key="${esc(key)}" data-filter="${value}" aria-pressed="${selected === value}"${value === 'active' ? ' title="To do and in-progress tickets"' : ''}>${label} <span>${count}</span></button>`).join('')}
    </div>
    ${shown.length ? '<ul class="tickets">' + shown.map(ticketRow).join('') + '</ul>'
      : `<p class="jira-empty">No ${selected === 'done' ? 'done' : 'active'} tickets.</p>`}`;
}

function memberCard(m, day) {
  const e = entryOf(day, m.id);
  const att = ATT[e.attendance] ? e.attendance : 'present';
  const blocked = hasBlocker(e);
  const tickets = memberIssues(ui.date, m.id);
  const counts = ticketSummary(tickets);
  const ticketKey = JSON.stringify([ui.date, m.id]);
  const ticketsOpen = ui.ticketExpansion.has(ticketKey) ? ui.ticketExpansion.get(ticketKey) : !ui.compact && tickets.length > 0;
  const blockers = blocked || canEdit() ? entryField(m, e, 'blockers', blocked ? 'Blocker' : 'Blockers', 'Anything stuck or needed&hellip;', blockerAgeHtml(m.id, e)) : '';
  const n = tickets.length;
  return `
  <article class="member-card${att !== 'present' ? ' att-' + att : ''}${blocked ? ' has-blocker' : ''}" data-member="${esc(m.id)}" data-search="${esc((m.name + ' ' + (m.role || '')).toLowerCase())}">
    <header class="member-head">
      <span class="avatar" style="background:${safeColor(m.color)}">${esc(initials(m.name))}</span>
      <div class="member-name"><strong>${blocked ? '<span class="blocker-flag" title="Has a blocker">⚠</span>' : ''}${esc(m.name)}</strong>${m.role ? '<span>' + esc(m.role) + '</span>' : ''}</div>
      ${attControl(m, att, 'card')}
      ${canEdit() && memberById(m.id) ? `<div class="member-actions">
        <button class="btn-icon-ghost" data-action="edit-member" data-id="${esc(m.id)}" title="Edit ${esc(m.name)}">&#9998;</button>
      </div>` : ''}
    </header>
    ${blocked ? blockers : carryPromptHtml(m, e, false)}
    ${entryField(m, e, 'yesterday', 'Yesterday', 'What was finished&hellip;')}
    ${entryField(m, e, 'today', 'Today', 'What is the focus today&hellip;')}
    ${blocked ? '' : blockers}
    <details class="jira-block" data-tickets="${esc(ticketKey)}" data-initial-open="${ticketsOpen}"${ticketsOpen ? ' open' : ''}>
      <summary class="jira-head"><span class="jira-title">${n} sprint ticket${n === 1 ? '' : 's'}</span>
        ${n ? `${ticketBarHtml(counts, n)}
        <span class="ticket-done">${counts.done} done<span class="sr-only">, ${counts.progress} in progress, ${counts.todo} to do</span></span>` : ''}
      </summary>
      ${tickets.length
        ? memberTicketsHtml(m, tickets, ticketKey)
        : '<p class="jira-empty">No sprint tickets matched.' + (canEdit() ? ' Sync JIRA or map users in the Sprint view.' : '') + '</p>'}
    </details>
  </article>`;
}

/** Badge colour: the saved palette slot, else a stable per-name slot in the category's hues. */
function statusBadgeClass(name, category) {
  const slot = slotFor(name, category, statusColors);
  return slot == null ? 's-' + category : 'st-' + slot;
}

function ticketRow(t) {
  return `<li class="ticket st-${esc(t.statusCategory)}">
    <a class="key" href="${esc(t.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(t.key)} in JIRA (new tab)">${esc(t.key)} <span aria-hidden="true">↗</span></a>
    <span class="sum" title="${esc(t.summary)}">${esc(t.summary)}</span>
    <span class="status ${esc(statusBadgeClass(t.status, t.statusCategory))}" data-cat="${esc(t.statusCategory)}" title="Status">${esc(t.status)}</span>
  </li>`;
}

function addMemberCard() {
  return `<button class="add-member" data-action="add-member"><span class="plus">+</span> Add team member</button>`;
}

function emptyTeamHtml() {
  return `
  <div class="empty-wrap" style="grid-column:1/-1">
    <section class="panel empty">
      <div class="empty-ico">&#128100;</div>
      <h3>Your board is empty</h3>
      <p>${canEdit()
        ? 'Add your team members, then mark attendance and write what everyone is doing each morning.'
        : 'An admin has not added team members yet.'}</p>
      ${canEdit() ? '<button class="btn btn-primary" data-action="add-member">+ Add your first member</button>' : ''}
      ${canAdmin() ? '<p class="hint">Optionally connect JIRA in <button class="linklike" data-action="view" data-view="settings" data-tab="jira">Settings</button> to pull the current sprint automatically.</p>' : ''}
    </section>
  </div>`;
}

/* ---------------- sprint view ---------------- */

function viewSprint() {
  const j = currentJira();
  if (!j) {
    return `
    <div class="empty-wrap">
      <section class="panel empty">
        <div class="empty-ico">&#127939;</div>
        <h3>No sprint data yet</h3>
        <p>Sync JIRA to pull the active sprint and every ticket assigned to your team.</p>
        ${canEdit()
          ? '<button class="btn btn-primary" data-action="sync">&#8635; Sync JIRA now</button>' +
            (canAdmin() ? '<p class="hint">Connection is set up in <button class="linklike" data-action="view" data-view="settings" data-tab="jira">Settings</button> (site, email, API token).</p>' : '')
          : '<p class="hint">Ask an admin to sync JIRA.</p>'}
      </section>
    </div>`;
  }
  const s = j.sprint;
  const team = filterByTeam(state.members);
  const teamIds = new Set(team.map((m) => m.id));
  const byMember = {};
  const issues = (j.issues || []).filter((t) => {
    if (!t.assignee) return false;
    const m = matchMember(t);
    if (!m || !teamIds.has(m.id)) return false;
    (byMember[m.id] = byMember[m.id] || []).push(t);
    return true;
  });
  const cnt = (cat) => issues.filter((t) => t.statusCategory === cat).length;
  const synced = new Date(j.syncedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  let elapsed = null;
  if (s && s.start && s.end) {
    const st = new Date(s.start).getTime(), en = new Date(s.end).getTime();
    elapsed = Math.max(0, Math.min(100, Math.round(((Date.now() - st) / (en - st || 1)) * 100)));
  }
  const share = (n) => ((n / (issues.length || 1)) * 100).toFixed(1) + '%';

  const unmatched = unmatchedUsers(j.issues || []);
  const listed = team.filter((m) => byMember[m.id]);

  const board = ui.sprintMode !== 'list';
  const hiddenCount = unmatched.reduce((n, u) => n + (u.count || 0), 0);
  return `
  <section class="page-head">
    <div class="page-head-main">
      <div class="page-title-row">
        <h1 class="page-title">${s ? esc(s.name) : 'Active sprint'}</h1>
        ${s && s.state ? '<span class="chip">' + esc(s.state) + '</span>' : ''}
      </div>
      <p class="page-meta">
        ${s && s.start ? '<span>' + fmtShort(s.start) + ' &rarr; ' + fmtShort(s.end) + '</span><span aria-hidden="true">·</span>' : ''}
        ${s && s.end ? '<span>' + esc(daysLeftLabel(s.end)) + '</span><span aria-hidden="true">·</span>' : ''}
        <span>Synced ${esc(synced)}</span>
        ${canEdit() ? '<button class="linklike" data-action="sync" id="syncBtn">Re-sync</button>' : ''}
      </p>
    </div>
    <div class="toolbar-right">
      ${teamPickerHtml()}
      ${board ? '' : collapseAllButton(listed)}
      <div class="seg" role="group" aria-label="Layout">
        <button type="button" class="seg-btn" data-action="sprint-mode" data-mode="board" aria-pressed="${board}">Board</button>
        <button type="button" class="seg-btn" data-action="sprint-mode" data-mode="list" aria-pressed="${!board}">List</button>
      </div>
    </div>
  </section>

  ${unmatched.length && canEdit() ? `
  <details class="notice notice-warn" data-sprint-map${ui.sprintMapOpen ? ' open' : ''}>
    <summary><b>${unmatched.length} JIRA user${unmatched.length === 1 ? ' isn’t' : 's aren’t'} on your team.</b>
      <span>Their ${hiddenCount} ticket${hiddenCount === 1 ? ' is' : 's are'} left out of the board.</span><span class="notice-action">Map users</span></summary>
    <div class="notice-body">
    ${unmatched.map((u) => `
      <div class="map-row">
        <div class="who"><strong>${esc(u.name)}</strong>${u.email ? '<span>' + esc(u.email) + ' · ' + u.count + ' ticket' + (u.count === 1 ? '' : 's') + '</span>' : '<span>' + u.count + ' ticket' + (u.count === 1 ? '' : 's') + '</span>'}</div>
        <select data-account="${esc(u.key)}" aria-label="Map ${esc(u.name)}">
          <option value="">Map to member&hellip;</option>
          ${state.members.map((m) => '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>').join('')}
          <option value="__add">+ Add as team member</option>
        </select>
      </div>`).join('')}
    </div>
  </details>` : ''}

  <section class="panel sprint-progress" aria-label="Sprint progress">
    <div class="sp-stats">
      <span><b>${issues.length}</b> ticket${issues.length === 1 ? '' : 's'}</span>
      <span class="sp-key"><i class="k-done"></i>${cnt('done')} done</span>
      <span class="sp-key"><i class="k-prog"></i>${cnt('indeterminate')} in progress</span>
      <span class="sp-key"><i class="k-todo"></i>${cnt('new')} to do</span>
    </div>
    <div class="sp-bar" aria-hidden="true"><span class="k-done" style="width:${share(cnt('done'))}"></span><span class="k-prog" style="width:${share(cnt('indeterminate'))}"></span><span class="k-todo" style="width:${share(cnt('new'))}"></span></div>
    ${elapsed == null ? '' : `<div class="sp-time" style="--t:${elapsed}%"><span class="sp-time-label">${elapsed}% of sprint time used</span></div>`}
  </section>

  ${board ? sprintBoardHtml(listed, byMember) : sprintMembersHtml(listed, byMember)}
  ${state.members.length && !listed.length ? '<section class="panel empty"><h3>No team tickets in this sprint</h3><p class="panel-sub">Only tickets assigned to a team member appear here.</p></section>' : ''}

  ${!state.members.length ? `
  <section class="panel empty">
    <h3>Add your team to see per-member tickets</h3>
    <p class="panel-sub">Add members and map their JIRA accounts to show their sprint tickets here.</p>
    ${canEdit() ? '<button class="btn btn-primary" data-action="add-member">+ Add team member</button>' : ''}
  </section>` : ''}`;
}

/** Board layout: one row per member, columns for to do / in progress / done (done collapsed to a count). */
function sprintBoardHtml(members, byMember) {
  if (!members.length) return '';
  const groups = teamGroups(members);
  const rows = groups
    ? groups.map((g) => `<div class="sb-group">${esc(g.name)} <span class="team-group-count">${g.members.length}</span></div>` + g.members.map((m) => sprintBoardRow(m, byMember[m.id])).join('')).join('')
    : members.map((m) => sprintBoardRow(m, byMember[m.id])).join('');
  return `
  <section class="panel sprint-board">
    <div class="sb-row sb-head"><span>Member</span><span>To do</span><span class="sb-h-prog">In progress</span><span class="sb-h-done">Done</span></div>
    ${rows}
  </section>`;
}

function sprintBoardRow(m, tickets) {
  tickets = tickets || [];
  const by = (cat) => tickets.filter((t) => t.statusCategory === cat);
  const prog = by('indeterminate'), todo = by('new'), done = by('done');
  const open = ui.sprintDoneOpen.has(m.id);
  const card = (t, inProgress) => `<a class="sb-card${inProgress ? ' sb-prog' : ''}" href="${esc(t.url)}" target="_blank" rel="noopener" title="Open ${esc(t.key)} in JIRA (new tab)">
      <span class="sb-card-top"><span class="key">${esc(t.key)}</span>${inProgress ? `<span class="status ${esc(statusBadgeClass(t.status, t.statusCategory))}">${esc(t.status)}</span>` : ''}</span>
      <span class="sb-sum">${esc(t.summary)}</span></a>`;
  const col = (list, inProgress) => list.length ? list.map((t) => card(t, inProgress)).join('') : '<span class="sb-empty">—</span>';
  const avatar = m.color
    ? `<span class="avatar avatar-sm" style="background:${safeColor(m.color)}">${esc(initials(m.name))}</span>`
    : '<span class="avatar avatar-sm sb-none">?</span>';
  return `
  <div class="sb-row">
    <div class="sb-who">${avatar}<div><strong>${esc(m.name)}</strong><span>${m.role ? esc(m.role) + ' · ' : ''}${tickets.length} ticket${tickets.length === 1 ? '' : 's'}</span></div></div>
    <div class="sb-col">${col(todo, false)}</div>
    <div class="sb-col">${col(prog, true)}</div>
    <div class="sb-col sb-col-done">${done.length ? `<button type="button" class="sb-done-toggle" data-action="sprint-done" data-id="${esc(m.id)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${done.length} done</button>${open
      ? '<ul class="sb-done">' + done.map((t) => `<li><a class="key" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.key)}</a> <span>${esc(t.summary)}</span></li>`).join('') + '</ul>' : ''}` : '<span class="sb-empty">—</span>'}</div>
  </div>`;
}

/** One toggle for every listed person: collapses while any is open, otherwise expands. */
function collapseAllButton(members) {
  if (!members.length) return '';
  const mode = members.some((m) => !ui.sprintCollapsed.has(m.id)) ? 'collapse' : 'expand';
  return `<button class="btn btn-ghost btn-sm" data-action="sprint-collapse-all" data-mode="${mode}" data-members="${esc(members.map((m) => m.id).join(','))}">${mode === 'collapse' ? 'Collapse all' : 'Expand all'}</button>`;
}

function sprintMembersHtml(members, byMember) {
  const groups = teamGroups(members);
  if (!groups) return members.map((m) => sprintMemberSection(m, byMember[m.id])).join('');
  return groups.map((g) => `<h4 class="team-group-head team-group-head-page"><span>${esc(g.name)}</span><span class="team-group-count">${g.members.length}</span></h4>` +
    g.members.map((m) => sprintMemberSection(m, byMember[m.id])).join('')).join('');
}

function sprintMemberSection(m, tickets) {
  const groups = [
    ['new', 'To do'],
    ['indeterminate', 'In progress'],
    ['done', 'Done'],
  ];
  const mini = groups.map(([cat, label]) => {
    const n = tickets.filter((t) => t.statusCategory === cat).length;
    return n ? '<span class="m" title="' + label + '">' + n + ' ' + label.toLowerCase() + '</span>' : '';
  }).join('');
  return `
  <details class="panel sprint-member" data-sprint-member="${esc(m.id)}"${ui.sprintCollapsed.has(m.id) ? '' : ' open'}>
    <summary class="sprint-member-head">
      <span class="avatar" style="background:${safeColor(m.color)}">${esc(initials(m.name))}</span>
      <strong>${esc(m.name)}</strong>${m.role ? ' <span style="color:var(--muted);font-size:13px">' + esc(m.role) + '</span>' : ''}
      <span class="mini">${mini}</span>
    </summary>
    ${groups.map(([cat, label]) => {
      const list = tickets.filter((t) => t.statusCategory === cat);
      if (!list.length) return '';
      return '<div class="group-label"><em class="g-' + (cat === 'new' ? 'new' : cat === 'done' ? 'done' : '') + '">' + label + ' · ' + list.length + '</em></div>' +
        '<ul class="tickets">' + list.map(ticketRow).join('') + '</ul>';
    }).join('')}
  </details>`;
}

/* ---------------- history view ---------------- */

function viewHistory() {
  const dates = Object.keys(state.days).filter((d) => isStarted(state.days[d])).sort().reverse();
  if (!dates.length) {
    return `
    <div class="empty-wrap">
      <section class="panel empty">
        <div class="empty-ico">&#128220;</div>
        <h3>No history yet</h3>
        <p>Every day a standup was started will appear here.</p>
        <button class="btn btn-primary" data-action="view" data-view="today">Go to today's board</button>
      </section>
    </div>`;
  }
  const month = isValidMonth(ui.histMonth) ? ui.histMonth : dates[0].slice(0, 7);
  ui.histMonth = month;
  const started = new Set(dates);
  const inMonth = dates.filter((d) => d.startsWith(month));
  const sel = ui.histSel && started.has(ui.histSel) ? ui.histSel : (inMonth[0] || '');
  const [y, mo] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const cells = Math.ceil((lead + new Date(Date.UTC(y, mo, 0)).getUTCDate()) / 7) * 7;
  const today = todayISO();
  const label = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  let grid = '';
  for (let i = 0; i < cells; i++) {
    const d = new Date(Date.UTC(y, mo - 1, 1 + i - lead));
    const iso = d.toISOString().slice(0, 10);
    const rec = started.has(iso);
    const cls = ['hcal-day', d.getUTCMonth() !== mo - 1 ? 'out' : '', d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 'wknd' : '',
      iso === today ? 'today' : '', iso === sel ? 'sel' : '', rec ? 'rec' : ''].filter(Boolean).join(' ');
    if (!rec) { grid += `<div class="${cls}"><span class="hcal-num">${d.getUTCDate()}</span></div>`; continue; }
    const s = historyDaySummary(iso, state.days[iso]);
    const blk = s.blockers.length;
    grid += `<button type="button" class="${cls}" data-action="hist-select" data-date="${iso}" aria-pressed="${iso === sel}" aria-label="${esc(fmtDay(iso))}: ${s.here} of ${s.total} here${blk ? ', ' + blk + ' blocker' + (blk === 1 ? '' : 's') : ''}">
      <span class="hcal-top"><span class="hcal-num">${d.getUTCDate()}</span>${blk ? `<span class="hcal-blk">${blk} blocker${blk === 1 ? '' : 's'}</span>` : ''}</span>
      <span class="hcal-dots" aria-hidden="true">${s.people.map((p) => `<i class="hd-${p.att}"></i>`).join('')}</span>
      <span class="hcal-here">${s.here}/${s.total} here</span>
    </button>`;
  }
  return `
  <section class="page-head">
    <div class="page-head-main">
      <div class="page-title-row">
        <h1 class="page-title">${esc(label)}</h1>
        <div class="date-nav">
          <button class="btn btn-ghost btn-icon" data-action="hist-month" data-dir="-1" title="Previous month" aria-label="Previous month">&lsaquo;</button>
          <button class="btn btn-ghost btn-icon" data-action="hist-month" data-dir="1" title="Next month" aria-label="Next month">&rsaquo;</button>
        </div>
      </div>
      <p class="page-meta"><span>${inMonth.length} standup${inMonth.length === 1 ? '' : 's'} this month · ${dates.length} saved in total</span></p>
    </div>
    <div class="hist-legend" aria-hidden="true">${Object.keys(ATT).map((k) => `<span><i class="hd-${k}"></i>${esc(ATT[k].label)}</span>`).join('')}</div>
  </section>
  <div class="hist-layout">
    <section class="panel hcal" aria-label="${esc(label)}">
      <div class="hcal-head" aria-hidden="true">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => '<span>' + w + '</span>').join('')}</div>
      <div class="hcal-grid">${grid}</div>
    </section>
    ${sel ? historyDetailHtml(sel) : '<aside class="panel hist-detail"><p class="muted">No standups this month. Use the arrows to go to another month.</p></aside>'}
  </div>`;
}

/** Roster, attendance and blockers of one saved day. */
function historyDaySummary(iso, day) {
  const people = boardMembersFor(iso, day).map((m) => {
    const e = entryOf(day, m.id);
    return { m, e, att: ATT[e.attendance] ? e.attendance : 'present' };
  });
  return { people, total: people.length, here: people.filter((p) => !AWAY.includes(p.att)).length, blockers: people.filter((p) => hasBlocker(p.e)) };
}

function historyDetailHtml(iso) {
  const day = state.days[iso];
  const s = historyDaySummary(iso, day);
  const d = new Date(iso + 'T00:00:00');
  const blk = s.blockers.length;
  return `
  <aside class="panel hist-detail" aria-label="${esc(fmtDay(iso))}">
    <div class="hd-head">
      <span class="hd-weekday">${esc(d.toLocaleDateString('en-GB', { weekday: 'long' }))}${iso === todayISO() ? ' · Today' : ''}</span>
      <strong class="hd-title">${esc(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }))}</strong>
      <span class="muted">${s.here}/${s.total} here · ${blk ? blk + ' blocker' + (blk === 1 ? '' : 's') : 'no blockers'}${day.jira ? ' · JIRA synced' : ''}</span>
    </div>
    <ul class="hd-people">${s.people.map((p) => `
      <li><span class="avatar avatar-sm${AWAY.includes(p.att) ? ' dim' : ''}" style="background:${safeColor(p.m.color)}">${esc(initials(p.m.name))}</span>
        <span class="hd-name">${esc(p.m.name)}</span><span class="att-badge att-${p.att}">${esc(ATT[p.att].label)}</span></li>`).join('')}
    </ul>
    ${blk ? `<div class="hd-blockers"><span class="hd-label">Blockers</span>${s.blockers.map((p) => `<p><b>${esc(p.m.name.split(' ')[0])}</b> · ${esc(p.e.blockers)}</p>`).join('')}</div>` : ''}
    <div class="hd-actions">
      <button class="btn btn-primary" data-action="open-day" data-date="${esc(iso)}">Open board</button>
      <button class="btn btn-ghost" data-action="copy-day" data-date="${esc(iso)}">Copy notes</button>
      <details class="nav-dropdown hd-more">
        <summary class="btn btn-ghost" aria-label="More actions" title="More actions">&hellip;</summary>
        <div class="dropdown-panel">
          <button class="btn btn-ghost" data-action="report" data-date="${esc(iso)}">Download Excel report</button>
          ${canEdit() ? `<button class="btn btn-ghost danger" data-action="delete-day" data-date="${esc(iso)}">Delete this day&hellip;</button>` : ''}
        </div>
      </details>
    </div>
  </aside>`;
}

/* ---------------- settings view ---------------- */

/** Settings tabs in order; edit tabs need an admin or a Technical Lead, admin tabs an admin, server tabs the server. */
const SETTINGS_TABS = [
  { id: 'account', label: 'Your account', group: 'You', panel: () => accountPanel() },
  { id: 'status-colors', label: 'Status colours', group: 'You', server: true, panel: () => statusColorsPanel() },
  { id: 'team', label: 'Team members', group: 'Team', edit: true, panel: () => teamPanel() },
  { id: 'jira', label: 'JIRA connection', group: 'Admin', admin: true, panel: () => jiraPanel() },
  { id: 'kpi', label: 'KPI rules', group: 'Admin', admin: true, server: true, panel: () => kpiPanel() },
  { id: 'reports', label: 'Performance report', group: 'Admin', admin: true, server: true, panel: () => reportsPanel() },
  { id: 'users', label: 'Users', group: 'Admin', admin: true, panel: () => usersPanel() },
  { id: 'data', label: 'Data & backup', group: 'Admin', admin: true, panel: () => dataPanel() },
];

function settingsTabs() {
  return SETTINGS_TABS.filter((t) => (!t.edit || canEdit()) && (!t.admin || canAdmin()) && (!t.server || storageMode === 'server'));
}

function viewSettings() {
  const tabs = settingsTabs();
  const active = tabs.find((t) => t.id === ui.settingsTab) || tabs.find((t) => t.id === 'team') || tabs[0];
  const groups = [...new Set(tabs.map((t) => t.group))];
  ui.settingsTab = active.id;
  const tabBtn = (t) => `<button type="button" class="settings-tab${t === active ? ' active' : ''}" role="tab" id="stab-${t.id}" data-action="settings-tab" data-tab="${t.id}" aria-selected="${t === active}" aria-controls="settings-panel" tabindex="${t === active ? 0 : -1}">${esc(t.label)}</button>`;
  return `
  <section class="page-head"><div class="page-head-main"><h1 class="page-title">Settings</h1></div></section>
  <div class="settings-layout">
    <nav class="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
      ${groups.map((g) => `<span class="settings-group" role="presentation">${esc(g)}</span>` + tabs.filter((t) => t.group === g).map(tabBtn).join('')).join('')}
    </nav>
    <div class="settings-body" id="settings-panel" role="tabpanel" aria-labelledby="stab-${active.id}">
      ${active.panel()}
      ${canAdmin() ? jiraSaveBarHtml() : ''}
    </div>
  </div>`;
}

function jiraSaveBarHtml() {
  return `<div class="settings-save-bar" id="jiraSaveBar" role="region" aria-label="JIRA settings changes"${jiraDraftDirty() ? '' : ' hidden'}>
    <strong>Unsaved changes</strong>
    <button type="button" class="btn btn-ghost" data-action="jira-discard">Discard</button>
    <button type="button" class="btn btn-primary" data-action="jira-save">Save changes</button>
  </div>`;
}

function accountPanel() {
  const local = storageMode === 'local';
  return `
  <section class="panel">
    <h3>Account</h3>
    <p class="panel-sub">${local
      ? 'Static hosting mode — no accounts, data stays in this browser.'
      : 'Signed in as <b>' + esc(auth.name || '?') + '</b> · ' + roleInfo(auth.role).account +
        '. Everyone who signs in shares the same board.'}</p>
    ${piMeField()}
    ${!local ? ownKeyPanelHtml() : ''}
    ${!local ? `
    <form id="pwForm" novalidate>
      <label class="field"><span>Current password</span>
        <input name="current" type="password" autocomplete="current-password" placeholder="your current password"></label>
      <label class="field"><span>New password</span>
        <input name="next" type="password" autocomplete="new-password" minlength="${PasswordPolicy.MIN_LENGTH}" placeholder="${PasswordPolicy.HINT}"></label>
      <div class="row-gap">
        <button type="submit" class="btn btn-ghost btn-sm">Change password</button>
        <button type="button" class="btn btn-danger-ghost btn-sm" data-action="logout">Sign out</button>
      </div>
    </form>` : ''}
  </section>`;
}

const ROLE_INFO = {
  admin: { letter: 'A', color: '#1066A0', label: 'Admin — full access', account: 'admin (full access)' },
  lead: { letter: 'T', color: '#1F7A5A', label: 'Technical Lead — own team only', account: 'Technical Lead (your own team only)' },
  viewer: { letter: 'V', color: '#594D7F', label: 'Viewer — view + download only', account: 'viewer (view + download only)' },
};
const roleInfo = (role) => ROLE_INFO[role] || ROLE_INFO.viewer;

function usersPanel() {
  return `
  <section class="panel">
    <h3>Users</h3>
    <p class="panel-sub">Admins can edit everything. Technical Leads write the standup, manage members and sync JIRA for their own team only. Viewers can only view the board and download reports.</p>
    <ul class="member-list">
      ${usersList.map((u) => `
      <li>
        <span class="avatar" style="background:${roleInfo(u.role).color}">${roleInfo(u.role).letter}</span>
        <div class="mi"><strong>${esc(u.username)}</strong>
          <span>${roleInfo(u.role).label}</span></div>
        ${u.username === auth.name
          ? '<span class="chip">you</span>'
          : `<button class="btn-icon-ghost" data-action="reset-user-pass" data-id="${esc(u.id)}" title="Reset password">&#9998;</button>
             <button class="btn-icon-ghost danger" data-action="delete-user" data-id="${esc(u.id)}" title="Delete user">&#10005;</button>`}
      </li>`).join('')}
    </ul>
    <form id="userForm" novalidate>
      <label class="field"><span>New username</span>
        <input name="username" required minlength="3" maxlength="40" placeholder="e.g. manager" autocomplete="off"></label>
      <label class="field"><span>Password</span>
        <input name="password" type="password" required minlength="${PasswordPolicy.MIN_LENGTH}" placeholder="${PasswordPolicy.HINT}" autocomplete="new-password"></label>
      <label class="field"><span>Role</span>
        <select name="role">
          <option value="viewer">${ROLE_INFO.viewer.label}</option>
          <option value="lead">${ROLE_INFO.lead.label}</option>
          <option value="admin">${ROLE_INFO.admin.label}</option>
        </select></label>
      <button type="submit" class="btn btn-ghost">+ Create user</button>
    </form>
  </section>`;
}

function jiraPanel() {
  const draft = jiraDraftValues();
  return `
  <section class="panel">
    <h3>JIRA connection</h3>
    <p class="panel-sub">Used by Sync on the Today and Sprint pages. Save changes before testing the connection.</p>
    <label class="field"><span>Site</span>
      <input id="setSite" data-jira="site" placeholder="yourteam.atlassian.net" value="${esc(draft.site)}" autocomplete="off"></label>
    <label class="field"><span>Atlassian email</span>
      <input id="setEmail" data-jira="email" type="email" placeholder="you@company.com" value="${esc(draft.email)}" autocomplete="off"></label>
    <label class="field"><span>API token</span>
      <input id="setToken" data-jira="token" type="password" placeholder="${creds.hasToken
        ? 'saved — leave blank to keep, or paste a new token'
        : 'create at id.atlassian.com &rarr; Security &rarr; API tokens'}" value="${esc(draft.token)}" autocomplete="off"></label>
    <label class="field"><span>Board query (JQL)</span>
      <input data-jira="jql" placeholder="sprint in openSprints() ORDER BY assignee" value="${esc(draft.jql)}" autocomplete="off"></label>
    <p class="panel-sub">Leave empty to use the active sprint of every board you can see.</p>
    <div class="row-gap">
      <button class="btn btn-primary" data-action="test-conn" id="testBtn">Test connection</button>
      <span class="conn-status" id="connStatus"></span>
      <button class="linklike" data-action="reset-jql" style="font-size:12.5px">reset query</button>
    </div>
  </section>`;
}

function kpiPanel() {
  return `
  <section class="panel">
    <h3>Sprint delivery (KPI)</h3>
    <p class="panel-sub">The Sprint delivery (KPI) report searches JIRA for the work of the members below, on every board and project, by their JIRA email. Leave the story points field blank to detect it automatically; changing it clears the cached KPI data.</p>
    <label class="field"><span>Story points field ID</span>
      <input id="setKpiField" data-set="kpiField" placeholder="e.g. customfield_10016" value="${esc(creds.kpiPointsField || '')}" autocomplete="off"></label>
    <div class="row-gap">
      <button class="btn btn-ghost" data-action="kpi-detect-field" id="kpiDetectBtn">Detect story points field</button>
    </div>
    ${kpiMembersField()}
    ${kpiRulesField()}
  </section>`;
}

/** What counts as delivered (lib/kpi-core.js rules); saving recomputes the cached sprints, no JIRA calls. */
function kpiRulesField() {
  const s = state.settings;
  const statuses = s.kpiDoneStatuses === undefined ? '' : s.kpiDoneStatuses;
  return `
    <fieldset class="kpi-members">
      <legend>Counting rules</legend>
      <p class="panel-sub">What counts as delivered. Changing it re-counts every cached sprint automatically, from the stored history, without calling JIRA.</p>
      <label class="field"><span>Statuses that count as delivered${kpiRoleRules(s).length ? ' (everyone else)' : ''}</span>
        <input data-setting="kpiDoneStatuses" placeholder="e.g. Ready for QA" value="${esc(statuses)}" autocomplete="off"></label>
      <p class="panel-sub">Comma-separated, any case (so a status whose name contains a comma can't be listed). May be empty only while the Done category counts.
        The history keeps each status name as it was when the task moved, so after a status is renamed in JIRA, list both names (e.g. <code>Ready for QA, Ready for Test</code>).</p>
      <label class="kpi-pick"><input type="checkbox" data-setting="kpiDoneCategory"${s.kpiDoneCategory !== false ? ' checked' : ''}>
        Also count JIRA's Done category</label>
      ${kpiRoleRulesField()}
    </fieldset>`;
}

/**
 * Per-role counting rules: a status move counts by the rules of the role of whoever held the
 * task just before it (role = the member's role under Settings → Team, any case).
 */
function kpiRoleRulesField() {
  const rows = kpiRoleRules(state.settings).concat(Array.from({ length: kpiUi.roleDrafts }, () => ({ role: '', doneStatuses: '', doneCategory: true })));
  const roles = [...new Set(state.members.map((m) => (m.role || '').trim()).filter(Boolean))].sort();
  const who = (role) => {
    const names = state.members.filter((m) => role && (m.role || '').trim().toLowerCase() === role.toLowerCase()).map((m) => m.name);
    return names.length ? names.join(', ') : 'nobody on the team has this role yet';
  };
  const row = (r, i) => `
      <div class="kpi-role-row" data-role-rule>
        <label class="field"><span>Role</span>
          <input data-role-field="role" list="kpiRoleList" placeholder="e.g. QA" value="${esc(r.role)}" autocomplete="off"></label>
        <label class="field"><span>Statuses that count as delivered</span>
          <input data-role-field="statuses" placeholder="e.g. Ready for QA" value="${esc(r.doneStatuses)}" autocomplete="off"></label>
        <label class="kpi-pick"><input type="checkbox" data-role-field="category"${r.doneCategory !== false ? ' checked' : ''}> Done category</label>
        <button type="button" class="btn btn-ghost btn-sm" data-action="kpi-role-remove" data-index="${i}" aria-label="Remove the rule for ${esc(r.role || 'this role')}">Remove</button>
        <p class="panel-sub kpi-role-who">${r.role ? esc(who(r.role)) : 'Type a role to save this rule.'}</p>
      </div>`;
  return `
      <h4 class="kpi-role-head">Per-role rules</h4>
      <p class="panel-sub">Optional. A task counts for the person who was assigned when it moved, judged by their role's rule
        (e.g. Software Engineer: <code>Ready for QA</code> + Done category; QA: Done category only). Roles come from Settings → Team, any case;
        anyone whose role has no rule here uses the rule above. A task still counts once, for whoever delivered it first.</p>
      <datalist id="kpiRoleList">${roles.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      ${rows.map(row).join('')}
      <button type="button" class="btn btn-ghost btn-sm" data-action="kpi-role-add">+ Add a role rule</button>`;
}

/** Who the KPI report covers (the server searches JIRA for them); nobody ticked = the whole team. */
function kpiMembersField() {
  if (!state.members.length) return '';
  const picked = new Set(state.settings.kpiMembers || []);
  const boxes = state.members.map((m) => `
      <label class="kpi-pick"><input type="checkbox" data-kpi-member="${esc(m.id)}"${picked.has(m.id) ? ' checked' : ''}>
        <span class="kpi-pick-dot" style="background:${esc(m.color || '')}"></span>${esc(m.name)}</label>`).join('');
  return `
    <fieldset class="kpi-members">
      <legend>Team members in the report</legend>
      <p class="panel-sub">Tick who the KPI report counts. Nobody ticked = the whole team. Members without a JIRA email are not found in JIRA.</p>
      <div class="kpi-pick-list">${boxes}</div>
    </fieldset>`;
}

const STAGE_LABELS = { new: 'To do', indeterminate: 'In progress', done: 'Done' };

function statusColorsPanel() {
  const rows = statusColorRows(statusColors);
  const admin = canAdmin();
  return `
  <section class="panel">
    <h3>Status colours</h3>
    <p class="panel-sub">Each JIRA status keeps its own badge colour. The dot shows the stage: hollow = to do, half = in progress, solid = done.${
      admin ? ' Click a badge to pick another colour.' : ''}</p>
    ${rows.length
      ? '<ul class="sc-list">' + rows.map((r) => statusColorRow(r, admin)).join('') + '</ul>'
      : '<p class="jira-empty">No statuses yet — colours are assigned on the next JIRA sync.</p>'}
    ${admin ? `<div class="row-gap">
      <button class="btn btn-ghost btn-sm" data-action="status-color-reset">Reset to automatic</button>
    </div>` : ''}
  </section>`;
}

function statusColorRow(r, admin) {
  const open = admin && ui.statusPick === r.name;
  const badge = admin
    ? `<button type="button" class="status st-${r.slot}" data-cat="${r.category}" data-action="status-color-pick" data-name="${esc(r.name)}" aria-expanded="${open}" title="Change colour">${esc(r.name)}</button>`
    : `<span class="status st-${r.slot}" data-cat="${r.category}">${esc(r.name)}</span>`;
  const note = r.sharedWith.length ? `<span class="sc-note">Same colour as ${esc(r.sharedWith.join(', '))}</span>` : '';
  return `<li class="sc-row">${badge}${note}${open ? statusColorPicker(r) : ''}</li>`;
}

function statusColorPicker(r) {
  const groups = Object.keys(STATUS_SLOT_RANGES).map((cat) => {
    const [lo, hi] = STATUS_SLOT_RANGES[cat];
    const swatches = [];
    for (let i = lo; i <= hi; i++) {
      swatches.push(`<button type="button" class="status st-${i} sc-swatch" data-cat="${cat}" data-action="status-color-set" data-name="${esc(r.name)}" data-slot="${i}" aria-pressed="${i === r.slot}" title="Colour ${i + 1}">Aa</button>`);
    }
    return `<div class="sc-group"><span class="sc-group-label">${STAGE_LABELS[cat]}</span>${swatches.join('')}</div>`;
  });
  return `<div class="sc-picker" role="group" aria-label="Colour for ${esc(r.name)}">${groups.join('')}</div>`;
}

function teamPanel() {
  const lead = hasTeamPicker();
  const row = lead ? 'mt-row with-lead' : 'mt-row';
  return `
  <section class="panel">
    <div class="panel-head">
      <div><h3>Team members</h3>
        <p class="panel-sub">${state.members.length} member${state.members.length === 1 ? '' : 's'} · order here is the board order · JIRA email matches sprint tickets to a person${
          isLead() ? ' · only your own team is listed' : ''}</p></div>
      <button class="btn btn-primary" data-action="add-member">Add member</button>
    </div>
    ${setupShowAgainHtml()}
    ${state.members.length ? `
    <div class="member-table" role="table" aria-label="Team members">
      <div class="${row} mt-head" role="row"><span role="columnheader">Name</span><span role="columnheader">Role</span><span role="columnheader">JIRA email</span>${lead ? '<span role="columnheader">Technical Lead</span>' : ''}<span role="columnheader"><span class="sr-only">Actions</span></span></div>
      ${state.members.map((m) => `
      <div class="${row}" role="row">
        <span role="cell" class="mt-name"><span class="avatar avatar-sm" style="background:${safeColor(m.color)}">${esc(initials(m.name))}</span><strong>${esc(m.name)}</strong></span>
        <span role="cell" class="muted">${esc(m.role || '—')}</span>
        <span role="cell" class="mt-email${m.email ? '' : ' missing'}">${m.email ? esc(m.email) : 'Not set · tickets won’t match'}</span>
        ${lead ? `<span role="cell" class="muted">${esc(teamKey(m) === 'none' ? '—' : leadName(teamKey(m)))}</span>` : ''}
        <span role="cell" class="mt-actions">
          <button class="btn-icon-ghost" data-action="edit-member" data-id="${esc(m.id)}" title="Edit ${esc(m.name)}">&#9998;</button>
          <button class="btn-icon-ghost danger" data-action="remove-member" data-id="${esc(m.id)}" title="Remove from team" aria-label="Remove ${esc(m.name)} from team">&times;</button>
        </span>
      </div>`).join('')}
    </div>` : ''}
  </section>`;
}

function dataPanel() {
  return `
  <section class="panel">
    <h3>Data &amp; backup</h3>
    <p class="panel-sub">${storageMode === 'local'
      ? "Everything lives in this browser's localStorage — nothing leaves your machine except JIRA API calls."
      : 'Everything is stored in the server\'s SQLite database (<code>data/scrum-desk.db</code>), so it survives browser changes and is shared with every signed-in user.'}
      <b>Export team data</b> saves members, notes and history as JSON, to move them elsewhere or keep a copy.
      It leaves out accounts, settings and JIRA credentials${fullBackupAllowed() ? '; to bring back the whole app, use the full encrypted backup below' : ''}.</p>
    <div class="row-gap">
      <button class="btn btn-ghost" data-action="export">&#10515; Export team data</button>
      <button class="btn btn-ghost" data-action="import-btn">&#10514; Import team data</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>
    <div style="margin-top:12px">
      <button class="btn btn-danger-ghost btn-sm" data-action="erase">Erase all data</button>
    </div>
  </section>${fullBackupPanelHtml()}`;
}

/* ---------------- render ---------------- */

function render() {
  const app = $('#app');
  const active = document.activeElement;
  const restore = active && active !== document.body ? focusSelector(active) : '';
  if (document.body.classList.contains('auth-mode')) return; // auth screens manage #app themselves
  app.dataset.view = ui.view;
  if (ui.view === 'sprint') app.innerHTML = viewSprint();
  else if (ui.view === 'history') app.innerHTML = viewHistory();
  else if (ui.view === 'report') app.innerHTML = reportsTabsHtml() + viewReport();
  else if (ui.view === 'kpi') app.innerHTML = reportsTabsHtml() + viewKpi();
  else if (ui.view === 'pi') app.innerHTML = reportsTabsHtml() + viewPi();
  else if (ui.view === 'blockers') app.innerHTML = reportsTabsHtml() + viewBlockers();
  else if (ui.view === 'settings') app.innerHTML = viewSettings();
  else app.innerHTML = viewToday();
  // forget a menu whose pill is no longer on the page (another view, a live update removed the card)
  if (ui.attMenu && !app.innerHTML.includes('class="att-menu"')) ui.attMenu = null;
  $$('#tabs [data-view]').forEach((t) => {
    const selected = t.dataset.view === ui.view || (t.hasAttribute('data-reports') && ['report', 'kpi', 'pi', 'blockers'].includes(ui.view));
    t.classList.toggle('active', selected);
    if (selected) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  const account = $('.account-menu > summary');
  if (account) account.classList.toggle('active', ui.view === 'settings');
  renderLogoutButton();
  renderSprintChip();
  renderSaveStatus();
  if (ui.view === 'today') { applyMemberSearch(); positionAttMenu(); }
  syncNavigationUrl();
  if (restore && active.isConnected === false) {
    const replacement = $(restore);
    if (replacement) replacement.focus({ preventScroll: true });
  }
}

/** One Reports page: Attendance / Sprint delivery / Performance / Blockers as tabs. */
function reportsTabsHtml() {
  const tabs = [['report', 'Attendance'], ['kpi', 'Sprint delivery'], ['pi', 'Performance'], ['blockers', 'Blockers']].filter(([id]) => id !== 'pi' || isPiAvailable());
  return `<nav class="report-tabs" aria-label="Reports">${tabs.map(([id, label]) =>
    `<button class="report-tab${ui.view === id ? ' active' : ''}" data-action="view" data-view="${id}"${ui.view === id ? ' aria-current="page"' : ''}>${label}</button>`).join('')}</nav>`;
}

/** Top-bar "Sign out": server mode only (browser-storage mode has no accounts). */
function renderLogoutButton() {
  const btn = $('#logoutBtn');
  if (!btn) return;
  btn.hidden = storageMode !== 'server' || !auth.name;
  btn.title = auth.name ? 'Signed in as ' + auth.name : '';
  btn.textContent = 'Sign out';
  const name = $('#accountName');
  if (name) name.textContent = auth.name || 'Browser workspace';
}

function renderSprintChip() {
  const chip = $('#sprintChip');
  const j = currentJira();
  if (j && j.sprint) {
    chip.hidden = false;
    chip.innerHTML = '<span class="pulse"></span>' + esc(j.sprint.name) + ' · ' + esc(daysLeftLabel(j.sprint.end));
  } else {
    chip.hidden = true;
  }
}

const persistSoon = debounce(() => {
  saveState({ quiet: true });
}, 350);

/* ---------------- modal (member add/edit) ---------------- */

let editingMemberId = null;

function openMemberModal(member) {
  editingMemberId = member ? member.id : null;
  $('#modalTitle').textContent = member ? 'Edit member' : 'Add team member';
  const f = $('#memberForm');
  f.name.value = member ? member.name : '';
  f.role.value = member ? (member.role || '') : '';
  f.email.value = member ? (member.email || '') : '';
  // admins pick the lead; a Technical Lead's new members are always theirs (the server enforces it)
  const pickLead = canAdmin() && storageMode === 'server' && leads.length > 0;
  $('#memberLeadField').hidden = !pickLead;
  if (pickLead) {
    const cur = member ? teamKey(member) : (ui.team || 'none');
    f.lead.innerHTML = '<option value="">No lead</option>' +
      leads.map((l) => `<option value="${esc(l.id)}"${cur === l.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
  }
  showDialog($('#overlay'));
  f.name.focus();
}
function closeModal() { hideDialog($('#overlay')); editingMemberId = null; }

function onMemberSubmit(e) {
  const f = e.target;
  const name = String(f.name.value || '').trim();
  if (!name) { f.name.focus(); return; }
  const role = String(f.role.value || '').trim();
  const email = String(f.email.value || '').trim();
  const fields = { name, role, email };
  if (!$('#memberLeadField').hidden) fields.lead = String(f.lead.value || '');
  if (editingMemberId) {
    const m = memberById(editingMemberId);
    if (m) Object.assign(m, fields);
  } else {
    state.members.push(Object.assign({ id: uid(), color: PALETTE[state.members.length % PALETTE.length] }, fields));
  }
  refreshTodayRoster();
  saveState();
  closeModal();
  render();
  toast('Member saved', 'success');
}

/* ---------------- toasts ---------------- */

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 4000);
}
