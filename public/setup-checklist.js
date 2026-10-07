/* ================================================================
   First-time setup checklist: the "Set it up for your team" steps of the
   README, checked against the live board and shown to admins on the Today
   board until they are all done (or hidden in this browser). Also the PI
   tab's warning while the generic query is still in use.
   Globals from app-core.js / own-key.js: state, creds, myJira, auth,
   storageMode, canAdmin, needsOwnKey, esc, render.
   ================================================================ */
'use strict';

const LS_SETUP_HIDDEN = 'dailyscrum.setup-hidden.v1';
const SETUP_DEFAULT_PREFIX = 'TEAM';

const setupUi = { collapsed: false };

function settingsLink(tab, label) {
  return `<button type="button" class="btn btn-ghost btn-sm" data-action="view" data-view="settings" data-tab="${esc(tab)}">${esc(label)}</button>`;
}

function jiraConnected() {
  return Boolean((creds.site && creds.hasToken) || (myJira && myJira.envOverride));
}

function jiraSyncedOnce() {
  return Object.values(state.days || {}).some((d) => d && d.jira);
}

/**
 * The setup steps that apply here, each { id, title, detail, done, tab, link }.
 * Steps that need the server (own key, PI) are left out in browser-only mode.
 */
function setupSteps() {
  const server = storageMode === 'server';
  const members = state.members || [];
  const settings = state.settings || {};
  const steps = [
    { id: 'members', title: 'Add your team members', tab: 'team', link: 'Team',
      detail: 'Everyone who joins the daily scrum, with their role.',
      done: members.length > 0 },
    { id: 'emails', title: 'Give every member their JIRA email',
      tab: 'team', link: 'Team',
      detail: 'Sprint tickets are matched to people by this email.',
      done: members.length > 0 && members.every((m) => m.email) },
    { id: 'jira', title: 'Connect JIRA', tab: 'jira', link: 'JIRA',
      detail: 'Your JIRA site, an email and an API token.',
      done: jiraConnected() },
    server && { id: 'own-key', title: 'Save your own JIRA API key', tab: 'account', link: 'Account',
      detail: 'Admins and Technical Leads call JIRA with their own key.',
      done: !needsOwnKey() },
    { id: 'sync', title: 'Sync the sprint once', tab: 'jira', link: 'JIRA',
      detail: 'Press Sync JIRA on the Today board. If it pulls the wrong tickets, narrow the sprint query (e.g. add project = YOURKEY).',
      done: jiraSyncedOnce() },
    server && { id: 'pi-query', title: 'Replace the report query with your team’s', tab: 'reports', link: 'Performance report',
      detail: 'The built-in query spans all visible projects. Narrow it for your team; use {assignee}, {start} and {end} or {afterEnd}.',
      done: Boolean(settings.piJql) },
    server && { id: 'pi-prefix', title: 'Set the report file name prefix', tab: 'reports', link: 'Performance report',
      detail: 'Your team name at the start of the Performance report workbook name.',
      done: Boolean(settings.piPrefix) && settings.piPrefix.toUpperCase() !== SETUP_DEFAULT_PREFIX },
    { id: 'me', title: 'Link your account to your member card', tab: 'account', link: 'Account',
      detail: 'Pick “This is me” so reports can include you.',
      done: Boolean(auth.memberId) },
  ];
  return steps.filter(Boolean);
}

function isSetupHidden() {
  try { return localStorage.getItem(LS_SETUP_HIDDEN) === '1'; } catch { return false; }
}

/** Hide (true) or show again (false) the checklist in this browser. */
function hideSetupChecklist(hidden) {
  try {
    if (hidden) localStorage.setItem(LS_SETUP_HIDDEN, '1');
    else localStorage.removeItem(LS_SETUP_HIDDEN);
  } catch { /* storage blocked: the checklist simply stays as it is */ }
  render();
}

function toggleSetupChecklist() {
  setupUi.collapsed = !setupUi.collapsed;
  render();
}

/** True when an admin still has steps to do and has not hidden the list. */
function showSetupChecklist() {
  if (!canAdmin() || isSetupHidden()) return false;
  return setupSteps().some((s) => !s.done);
}

function setupChecklistHtml() {
  if (!showSetupChecklist()) return '';
  const steps = setupSteps();
  const done = steps.filter((s) => s.done).length;
  const pct = Math.round((done / steps.length) * 100);
  return `
  <section class="setup${setupUi.collapsed ? ' setup-collapsed' : ''}" aria-labelledby="setupTitle">
    <div class="setup-head">
      <h3 id="setupTitle">Set up your team</h3>
      <span class="setup-count">${done} of ${steps.length} done</span>
      <span class="setup-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}" aria-label="Setup progress"><i style="width:${pct}%"></i></span>
      <button type="button" class="btn btn-ghost btn-sm" data-action="setup-toggle" aria-expanded="${!setupUi.collapsed}">${setupUi.collapsed ? 'Show steps' : 'Collapse'}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="setup-hide" title="Hide in this browser; show it again from Settings → Team">Hide</button>
    </div>
    <ol class="setup-list">
      ${steps.map((s) => `
      <li class="setup-step${s.done ? ' done' : ''}">
        <span class="setup-mark" aria-hidden="true">${s.done ? '&#10003;' : ''}</span>
        <div><div class="setup-title">${esc(s.title)}<span class="sr-only">${s.done ? ' (done)' : ' (to do)'}</span></div>
          <div class="setup-detail">${esc(s.detail)}</div></div>
        ${s.done ? '' : settingsLink(s.tab, s.link)}
      </li>`).join('')}
    </ol>
  </section>`;
}

/** The "show the checklist again" line for Settings → Team, once it was hidden. */
function setupShowAgainHtml() {
  if (!canAdmin() || !isSetupHidden()) return '';
  return '<p class="panel-sub"><button type="button" class="linklike" data-action="setup-show">Show the setup checklist again</button></p>';
}

/** Performance report tab: a warning for admins while the generic default query is in use. */
function piDefaultQueryWarnHtml() {
  if (!canAdmin() || (state.settings && state.settings.piJql)) return '';
  return `<p class="pi-default-warn" role="note"><b>The Performance report uses a query across all visible projects.</b>
    Replace it with your team&rsquo;s in <button type="button" class="linklike" data-action="view" data-view="settings" data-tab="reports">Settings &rarr; Performance report</button>.</p>`;
}
