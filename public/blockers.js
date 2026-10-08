/* ================================================================
   Blockers — carry-over, aging and the impediment log, all worked
   out from the saved standup days (no extra storage beyond two
   optional note fields):
     blockerSince     date the blocker was first reported, set when
                      "Still blocked" carries it to a new day
     blockerResolved  set when "Resolved" answers the carry-over prompt

   A blocker *episode* is one blocker followed across a member's
   standups: it continues while the next standup has the same
   blockerSince or the same text (case and spaces ignored), skips days
   the member was away, and ends on the first standup without it.
   Ages count standup days (days a daily scrum was started).

   Everything above the browser view is pure (unit-tested in Node);
   the view uses the app's globals (state, ui, esc, toast, ...).
   ================================================================ */
'use strict';

const BLOCKER_STALE_DAYS = 3;
const BLOCKER_AWAY = ['leave', 'sick', 'noshow'];

const blockerText = (e) => String((e && e.blockers) || '').trim();
const normBlocker = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

function noteHasContent(e) {
  return Boolean(e && (e.attendance || ['yesterday', 'today', 'blockers'].some((k) => String(e[k] || '').trim())));
}

/** A day counts once its daily scrum was started; older data without the start button counts if it has notes. */
function isStandupDay(day) {
  if (!day) return false;
  if (day.startedAt !== undefined) return Boolean(day.startedAt);
  return Object.values(day.entries || {}).some(noteHasContent);
}

/** Every standup date, oldest first. */
function standupDates(st) {
  const days = (st && st.days) || {};
  return Object.keys(days).filter((d) => isStandupDay(days[d])).sort();
}

/** Standup days from `from` to `to`, both included (at least 1). */
function standupDaysBetween(dates, from, to) {
  const n = dates.filter((d) => d >= from && d <= to).length;
  return Math.max(1, n);
}

/** Members seen on each standup day (its roster, or the team when it has none) plus anyone with a note. */
function membersOnDay(st, day) {
  const list = Array.isArray(day.roster) ? day.roster : (st.members || []);
  const ids = new Set(list.map((m) => m.id));
  for (const id of Object.keys(day.entries || {})) ids.add(id);
  return ids;
}

/**
 * All blocker episodes, oldest first.
 * @param {{members: object[], days: object}} st  board state
 * @param {{through?: string, today?: string}} [opts]
 *   through: only days up to and including this date
 *   today:  on this date an empty, unanswered blocker is still open — the
 *           standup may not have reached that person yet
 */
function blockerEpisodes(st, opts = {}) {
  const days = (st && st.days) || {};
  const dates = standupDates(st).filter((d) => !opts.through || d <= opts.through);
  const people = new Map();
  for (const m of (st && st.members) || []) people.set(m.id, m);
  for (const d of dates) for (const m of days[d].roster || []) people.set(m.id, m); // latest snapshot wins
  const lastDate = dates[dates.length - 1];
  const episodes = [];
  const open = new Map(); // memberId -> episode

  const close = (ep, resolvedOn) => {
    ep.status = 'resolved';
    ep.resolvedOn = resolvedOn;
    ep.age = standupDaysBetween(dates, ep.since, ep.lastSeen);
    open.delete(ep.memberId);
  };

  for (const d of dates) {
    const day = days[d];
    const here = membersOnDay(st, day);
    for (const ep of [...open.values()]) {
      if (!here.has(ep.memberId)) { ep.left = true; close(ep, d); } // no longer on the team
    }
    for (const id of here) {
      const e = (day.entries || {})[id] || {};
      const text = blockerText(e);
      const cur = open.get(id);
      if (text) {
        const continues = cur && (e.blockerSince ? e.blockerSince === cur.since : normBlocker(text) === cur.key);
        if (continues) {
          cur.text = text;
          cur.key = normBlocker(text);
          cur.lastSeen = d;
          cur.reported++;
          continue;
        }
        if (cur) close(cur, d);
        const since = e.blockerSince && e.blockerSince < d ? e.blockerSince : d;
        const ep = { memberId: id, text, key: normBlocker(text), since, firstSeen: d, lastSeen: d, reported: 1, status: 'open', resolvedOn: null };
        episodes.push(ep);
        open.set(id, ep);
      } else if (cur) {
        if (BLOCKER_AWAY.includes(e.attendance)) continue; // away: the blocker waits for their return
        if (d === opts.today && d === lastDate && !e.blockerResolved) { cur.awaiting = true; continue; }
        close(cur, d);
      }
    }
  }
  for (const ep of open.values()) ep.age = standupDaysBetween(dates, ep.since, lastDate);
  for (const ep of episodes) {
    const m = people.get(ep.memberId) || {};
    ep.name = m.name || '(removed member)';
    ep.role = m.role || '';
    ep.color = m.color;
    ep.lead = m.lead || '';
    delete ep.key;
  }
  return episodes;
}

/** memberId -> the episode that covers `date` for that member (has text that day, or awaits an answer). */
function blockersOnDay(episodes, date) {
  const out = new Map();
  for (const ep of episodes) {
    if (ep.firstSeen <= date && (ep.lastSeen >= date || (ep.awaiting && ep.status === 'open'))) out.set(ep.memberId, ep);
  }
  return out;
}

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [month + '-01', month + '-' + String(last).padStart(2, '0')];
}

/**
 * The Blockers report: what is open now (oldest first) and the log of every
 * episode, narrowed by member and month (month null = all time).
 */
function buildBlockerReport(st, { month = null, member = '', today = '', memberFilter = null } = {}) {
  const all = blockerEpisodes(st, { today });
  const keep = (ep) => (!member || ep.memberId === member) && (!memberFilter || memberFilter(ep));
  const scoped = all.filter(keep);
  const open = scoped.filter((ep) => ep.status === 'open').sort((a, b) => b.age - a.age || a.since.localeCompare(b.since));
  let log = scoped;
  if (month) {
    const [from, to] = monthBounds(month);
    log = scoped.filter((ep) => ep.firstSeen <= to && (ep.status === 'open' || (ep.resolvedOn || ep.lastSeen) >= from));
  }
  log = log.slice().sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.name.localeCompare(b.name));
  const people = new Map();
  for (const ep of all.filter((x) => !memberFilter || memberFilter(x))) people.set(ep.memberId, { id: ep.memberId, name: ep.name });
  return {
    month, member, open, log,
    stale: open.filter((ep) => ep.age >= BLOCKER_STALE_DAYS).length,
    resolved: log.filter((ep) => ep.status === 'resolved').length,
    members: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const daysLabel = (n) => n + ' standup day' + (n === 1 ? '' : 's');

/** Worksheets for XlsxLite.build(): Open blockers and Blocker log. */
function blockerSheets(report, { scope = '', generatedAt } = {}) {
  const when = generatedAt || new Date().toISOString().slice(0, 16).replace('T', ' ');
  const head = (labels) => labels.map((v) => ({ v, s: 'header' }));
  const note = (scope ? scope + ' · ' : '') + 'generated ' + when + ' · ages count standup days';
  const openSheet = {
    name: 'Open blockers',
    cols: [24, 18, 56, 12, 12, 10],
    freeze: { row: 3 },
    rows: [
      [{ v: 'Open blockers', s: 'title' }],
      [{ v: report.open.length ? note : 'No open blockers · ' + note, s: 'note' }],
      head(['Member', 'Role', 'Blocker', 'Since', 'Last seen', 'Days open']),
      ...report.open.map((ep) => [
        { v: ep.name, s: 'boldText' }, { v: ep.role, s: 'text' }, { v: ep.text, s: 'text' },
        { v: ep.since, s: 'text' }, { v: ep.lastSeen, s: 'text' }, { v: ep.age, s: 'num' },
      ]),
    ],
  };
  const logSheet = {
    name: 'Blocker log',
    cols: [24, 18, 56, 12, 12, 10, 10, 14],
    freeze: { row: 3, col: 1 },
    rows: [
      [{ v: 'Blocker log', s: 'title' }],
      [{ v: (report.log.length ? 'One row per blocker, followed across standups · ' : 'No blockers recorded · ') + note, s: 'note' }],
      head(['Member', 'Role', 'Blocker', 'Since', 'Last seen', 'Days open', 'Status', 'Resolved on']),
      ...report.log.map((ep) => [
        { v: ep.name, s: 'boldText' }, { v: ep.role, s: 'text' }, { v: ep.text, s: 'text' },
        { v: ep.since, s: 'text' }, { v: ep.lastSeen, s: 'text' }, { v: ep.age, s: 'num' },
        { v: ep.status === 'open' ? 'Open' : 'Resolved', s: 'text' }, { v: ep.resolvedOn || '', s: 'text' },
      ]),
    ],
  };
  return [openSheet, logSheet];
}

/* ---------------- browser: Today board ---------------- */

/** Blockers on the board's date, worked out once per render (memberId -> episode). */
let boardBlockers = new Map();

function refreshBoardBlockers(date) {
  boardBlockers = blockersOnDay(blockerEpisodes(state, { through: date, today: todayISO() }), date);
  return boardBlockers;
}

/** An earlier blocker nobody has answered yet on today's standup. */
function pendingCarry(memberId, e) {
  const ep = boardBlockers.get(memberId);
  return ep && ep.awaiting && !blockerText(e) ? ep : null;
}

/** "Blocked · 3 standup days" once a blocker has been around for more than one standup. */
function blockerAgeHtml(memberId, e) {
  const ep = boardBlockers.get(memberId);
  if (!ep || !blockerText(e) || ep.age < 2) return '';
  const stale = ep.age >= BLOCKER_STALE_DAYS;
  return `<span class="blocker-age${stale ? ' stale' : ''}" title="Reported since ${esc(fmtShort(ep.since))}">Blocked · ${esc(daysLabel(ep.age))}</span>`;
}

/** The carry-over question on a card or sheet row: the earlier blocker with Still blocked / Resolved. */
function carryPromptHtml(m, e, compact) {
  const ep = pendingCarry(m.id, e);
  if (!ep) return '';
  const meta = `since ${esc(fmtShort(ep.since))} · ${esc(daysLabel(ep.age))}`;
  const attrs = `data-member="${esc(m.id)}" data-date="${esc(ui.date)}"`;
  const buttons = canEdit() ? `<div class="carry-actions">
      <button type="button" class="btn btn-sm carry-still" data-action="blocker-carry" ${attrs}>Still blocked</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="blocker-resolve" ${attrs}>Resolved</button></div>` : '';
  return `<div class="carry-prompt${compact ? ' carry-compact' : ''}" role="group" aria-label="Earlier blocker for ${esc(m.name)}">
    <p><span class="carry-label">${canEdit() ? 'Still blocked?' : 'Not confirmed today'}</span> <span class="carry-text">${esc(ep.text)}</span> <span class="carry-meta">${meta}</span></p>
    ${buttons}
  </div>`;
}

/** Answers the carry-over question: copy the blocker to today with its start date, or mark it resolved (undoable). */
function answerCarry(memberId, date, stillBlocked) {
  const day = getDay(date, false);
  if (!canEdit() || !isStarted(day) || date !== ui.date) return;
  refreshBoardBlockers(date);
  const before = (day.entries || {})[memberId] || {};
  const ep = pendingCarry(memberId, before);
  if (!ep) return;
  day.entries[memberId] = Object.assign({}, before, stillBlocked
    ? { blockers: ep.text, blockerSince: ep.since }
    : { blockerResolved: ep.since });
  if (stillBlocked) delete day.entries[memberId].blockerResolved;
  saveState();
  render();
  if (stillBlocked) { toast('Blocker carried to today', 'success'); return; }
  // Undo takes back only the answer, so a note typed after pressing Resolved survives.
  const hadResolved = Object.prototype.hasOwnProperty.call(before, 'blockerResolved');
  const prevResolved = before.blockerResolved;
  toastUndo('Blocker marked resolved', () => {
    const d = getDay(date, false);
    const cur = isStarted(d) && (d.entries || {})[memberId];
    if (!cur || cur.blockerResolved !== ep.since) return;
    const next = Object.assign({}, cur);
    if (hadResolved) next.blockerResolved = prevResolved; else delete next.blockerResolved;
    d.entries[memberId] = next;
    saveState();
    render();
  });
}

/* ---------------- browser: Reports → Blockers ---------------- */

function blockerTeamFilter() {
  if (!hasTeamPicker() || !ui.team) return null;
  return (ep) => teamKey({ id: ep.memberId, lead: ep.lead }) === ui.team;
}

function currentBlockerReport() {
  return buildBlockerReport(state, {
    month: ui.blockerAll ? null : ui.month, member: ui.blockerMember || '',
    today: todayISO(), memberFilter: blockerTeamFilter(),
  });
}

function blockerAgeBadge(ep) {
  return `<span class="blocker-age${ep.age >= BLOCKER_STALE_DAYS && ep.status === 'open' ? ' stale' : ''}">${esc(daysLabel(ep.age))}</span>`;
}

const blockerDateLink = (iso) => `<button class="linklike" data-action="open-day" data-date="${esc(iso)}" title="Open ${esc(iso)} on the board">${esc(fmtShort(iso))}</button>`;

function blockerStatusHtml(ep) {
  if (ep.status === 'open') return `<span class="blocker-status open">${ep.awaiting ? 'Open · not confirmed today' : 'Open'}</span>`;
  return `<span class="blocker-status">${ep.left ? 'Left the team' : 'Resolved'} ${blockerDateLink(ep.resolvedOn)}</span>`;
}

function viewBlockers() {
  if (!isValidMonth(ui.month)) ui.month = todayISO().slice(0, 7);
  const r = currentBlockerReport();
  if (ui.blockerMember && !r.members.some((m) => m.id === ui.blockerMember)) ui.blockerMember = '';
  const isNow = ui.month === todayISO().slice(0, 7);
  const monthNav = ui.blockerAll ? '' : `
        ${isNow ? '<span class="chip">This month</span>' : '<button class="btn btn-ghost btn-sm" data-action="month-current">This month</button>'}
        <div class="date-nav">
          <button class="btn btn-ghost btn-icon" data-action="month-prev" title="Previous month" aria-label="Previous month">&lsaquo;</button>
          <input type="month" id="monthInput" value="${esc(ui.month)}" aria-label="Log month">
          <button class="btn btn-ghost btn-icon" data-action="month-next" title="Next month" aria-label="Next month">&rsaquo;</button>
        </div>`;
  const memberOpts = [['', 'Everyone']].concat(r.members.map((m) => [m.id, m.name]));
  const toolbar = `
  <section class="page-head">
    <div class="page-head-main">
      <div class="page-title-row">
        <h1 class="page-title">Blockers</h1>
        ${monthNav}
        <button class="btn btn-ghost btn-sm" data-action="blocker-all" aria-pressed="${Boolean(ui.blockerAll)}">All months</button>
      </div>
      <p class="page-meta">
        <span><b>${r.open.length}</b> open</span><span aria-hidden="true">·</span>
        <span${r.stale ? ' class="blocker-stale-count"' : ''}><b>${r.stale}</b> open ${BLOCKER_STALE_DAYS}+ standup days</span><span aria-hidden="true">·</span>
        <span>${r.log.length} in the log${ui.blockerAll ? '' : ' for ' + esc(monthLabel(ui.month))}</span>
      </p>
    </div>
    <div class="toolbar-right">
      ${teamPickerHtml()}
      <label class="team-picker"><span>Member</span>
        <select id="blockerMember" aria-label="Show member">${memberOpts.map(([v, label]) =>
          `<option value="${esc(v)}"${(ui.blockerMember || '') === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
      <button class="btn btn-primary" data-action="download-blockers"${r.open.length || r.log.length ? '' : ' disabled'}>Download Excel</button>
    </div>
  </section>`;

  const openHtml = r.open.length ? `<ul class="blocker-open-list">${r.open.map((ep) => `
      <li class="blocker-open${ep.age >= BLOCKER_STALE_DAYS ? ' stale' : ''}">
        <span class="dot" style="background:${safeColor(ep.color)}"></span>
        <span class="blocker-who"><strong>${esc(ep.name)}</strong>${ep.role ? '<span>' + esc(ep.role) + '</span>' : ''}</span>
        <span class="blocker-what">${esc(ep.text)}${ep.awaiting ? ' <span class="carry-meta">(not confirmed today)</span>' : ''}</span>
        <span class="blocker-when">since ${blockerDateLink(ep.since)}</span>
        ${blockerAgeBadge(ep)}
      </li>`).join('')}</ul>`
    : '<p class="blocker-empty">Nobody is blocked right now.</p>';

  const logHtml = r.log.length ? `
    <div class="table-scroll"><table class="blocker-log">
      <thead><tr><th scope="col">Member</th><th scope="col">Blocker</th><th scope="col">Since</th><th scope="col">Last seen</th><th scope="col" class="num">Days open</th><th scope="col">Status</th></tr></thead>
      <tbody>${r.log.map((ep) => `<tr>
        <th scope="row"><span class="dot" style="background:${safeColor(ep.color)}"></span>${esc(ep.name)}</th>
        <td class="blocker-what">${esc(ep.text)}</td>
        <td>${blockerDateLink(ep.since)}</td>
        <td>${blockerDateLink(ep.lastSeen)}</td>
        <td class="num">${ep.age}</td>
        <td>${blockerStatusHtml(ep)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`
    : `<p class="blocker-empty">No blockers recorded${ui.blockerAll ? '' : ' in ' + esc(monthLabel(ui.month))}.</p>`;

  return toolbar + `
  <section class="panel blocker-panel">
    <h3>Open now</h3>
    <p class="panel-sub">Who is still blocked, oldest first. Ages count standup days; ${BLOCKER_STALE_DAYS} or more is highlighted.</p>
    ${openHtml}
  </section>
  <section class="panel blocker-panel">
    <h3>Blocker log</h3>
    <p class="panel-sub">Every blocker recorded in the daily notes, followed across standups until it was resolved — for retrospectives.</p>
    ${logHtml}
  </section>`;
}

function downloadBlockersXlsx() {
  try {
    const report = currentBlockerReport();
    const parts = [ui.blockerAll ? 'All months' : monthLabel(ui.month)];
    const who = report.members.find((m) => m.id === report.member);
    if (who) parts.push(who.name);
    if (hasTeamPicker() && ui.team) parts.push(ui.team === 'none' ? 'No lead' : leadName(ui.team) + "'s team");
    const bytes = XlsxLite.build(blockerSheets(report, { scope: parts.join(' · ') }));
    const blob = new Blob([bytes], { type: XlsxLite.MIME });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'blockers-' + (ui.blockerAll ? 'all' : ui.month) + '.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Excel report downloaded', 'success');
  } catch (err) {
    console.error('Blockers Excel export failed', err);
    toast('Could not create the Excel file', 'error');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BLOCKER_STALE_DAYS, normBlocker, standupDates, standupDaysBetween,
    blockerEpisodes, blockersOnDay, buildBlockerReport, blockerSheets, daysLabel,
  };
}
