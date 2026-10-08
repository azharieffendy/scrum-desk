/* Daily Scrum — sign-in/setup/users, member helpers, JIRA matching and the API client.
 * Classic script: shares globals with app-core.js, app-auth.js,
 * app-views.js and app.js (see index.html for the load order). */
'use strict';

/* ---------------- auth ---------------- */

function showAuthScreen(mode) {
  navigationReady = false;
  closeConfirm(false);
  closeOwnKeyModal();
  closeModal();
  stopLiveUpdates();
  document.body.classList.add('auth-mode');
  const app = $('#app');
  app.innerHTML = authScreenHtml(mode);
  updateThemeButtons();
  const f = $('#authForm');
  if (f) f.querySelector('input').focus();
}

function authScreenHtml(mode) {
  const setup = mode === 'setup';
  return `
  <div class="auth-wrap">
    <div class="auth-card">
      <button class="theme-toggle auth-theme-toggle" data-action="theme" type="button">Theme</button>
      <div class="auth-logo">${LOGO_SVG}</div>
      <h2>${setup ? 'Create your account' : 'Welcome back'}</h2>
      <p class="auth-sub">${setup
        ? 'First time setup — this account is the <b>admin</b>: it can edit the board, sync JIRA and manage users.'
        : 'Sign in to open the morning board.'}</p>
      <form id="authForm" data-mode="${setup ? 'setup' : 'login'}" novalidate>
        ${setup ? `<label class="field"><span>Setup code</span>
          <input name="setupCode" required autocomplete="off" spellcheck="false" placeholder="printed in the server log on startup"></label>` : ''}
        <label class="field"><span>Username</span>
          <input name="username" autocomplete="username" required maxlength="40" placeholder="e.g. lead"></label>
        <label class="field"><span>Password</span>
          <input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required${setup ? ` minlength="${PasswordPolicy.MIN_LENGTH}"` : ''} placeholder="${setup ? 'at least ' + PasswordPolicy.MIN_LENGTH + ' characters' : 'your password'}"></label>
        ${setup ? `<p class="hint">${PasswordPolicy.HINT[0].toUpperCase() + PasswordPolicy.HINT.slice(1)}.</p>
        <label class="field"><span>Confirm password</span><input name="confirm" type="password" autocomplete="new-password" required minlength="${PasswordPolicy.MIN_LENGTH}"></label>` : ''}
        <div class="auth-error" id="authError" hidden></div>
        <button type="submit" class="btn btn-primary btn-block">${setup ? 'Create account and continue' : 'Sign in'}</button>
      </form>
    </div>
  </div>`;
}

async function onAuthSubmit(f) {
  const mode = f.dataset.mode;
  const err = $('#authError');
  const username = String(f.username.value || '').trim();
  const password = String(f.password.value || '');
  const confirm_ = String((f.confirm && f.confirm.value) || '');
  const setupCode = String((f.setupCode && f.setupCode.value) || '').trim();
  const showErr = (m) => { err.hidden = false; err.textContent = m; };
  if (mode === 'setup' && !setupCode) return showErr('Enter the setup code from the server log.');
  if (username.length < 3) return showErr('Username needs at least 3 characters.');
  const weak = mode === 'setup' && PasswordPolicy.problem(password);
  if (weak) return showErr(weak);
  if (mode === 'setup' && password !== confirm_) return showErr('Passwords do not match.');

  const btn = f.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mode === 'setup' ? { username, password, setupCode } : { username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    auth = { name: (data.user && data.user.name) || username.toLowerCase(), role: (data.user && data.user.role) || 'admin',
      memberId: (data.user && data.user.memberId) || '' };
    toast(mode === 'setup' ? 'Account created — welcome!' : 'Signed in — good morning!', 'success');
    await enterBoard();
  } catch (e) {
    showErr(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function onPasswordSubmit(f) {
  const current = String(f.current.value || '');
  const next = String(f.next.value || '');
  const weak = PasswordPolicy.problem(next);
  if (weak) return toast(weak, 'error');
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    f.current.value = ''; f.next.value = '';
    toast('Password updated', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function onUserCreateSubmit(f) {
  const username = String(f.username.value || '').trim();
  const password = String(f.password.value || '');
  const role = ['admin', 'lead'].includes(f.role.value) ? f.role.value : 'viewer';
  const weak = PasswordPolicy.problem(password);
  if (weak) return toast(weak, 'error');
  try {
    const res = await fetch('/api/auth/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    f.username.value = ''; f.password.value = ''; f.role.value = 'viewer';
    toast('User "' + username.toLowerCase() + '" created (' + role + ')', 'success');
    await refreshUsers();
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function refreshUsers() {
  if (!canAdmin() || storageMode === 'local') { usersList = []; return; }
  try {
    const r = await fetch('/api/auth/users');
    if (!r.ok) return;
    const d = await r.json();
    usersList = d.users || [];
  } catch (_) { /* ignore */ }
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
  auth = { name: '', role: 'admin' };
  usersList = [];
  autoSyncDone = false; // next sign-in refreshes JIRA again
  myJira = null;
  closeOwnKeyModal();
  showAuthScreen('login');
}

async function enterBoard() {
  document.body.classList.remove('auth-mode');
  navigationReady = false;
  ui.view = 'today';
  ui.editingNote = null;
  ui.memberSearch = '';
  ui.jiraDraft = null;
  piEditorUi.draft = null; piEditorUi.options = null; piEditorUi.source = ''; piEditorUi.account = ''; piEditorUi.start = ''; piEditorUi.end = ''; piEditorUi.convertError = ''; piEditorUi.optionsError = ''; piEditorUi.conversion = null; piEditorUi.member = ''; piEditorUi.period = ''; piEditorInvalidate();
  saveMessage = 'All changes saved';
  ui.date = todayISO();
  try { await bootStorage(); }
  catch (e) {
    if (e.status === 401) { showAuthScreen('login'); toast('Session expired — sign in again', 'error'); return; }
    showUnavailableScreen(e.message);
    return;
  }
  restoreNavigationUrl();
  if (ui.view === 'settings' && canAdmin()) await refreshUsers();
  render();
  startLiveUpdates();
  // an admin/lead without their own JIRA key is asked for one; the sync runs once it is saved
  if (needsOwnKey()) openOwnKeyModal(autoSyncJira);
  else autoSyncJira();
}

function showUnavailableScreen(message) {
  navigationReady = false;
  document.body.classList.add('auth-mode');
  $('#app').innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <button class="theme-toggle auth-theme-toggle" data-action="theme" type="button">Theme</button>
    <h2>Board unavailable</h2><p class="auth-sub">${esc(message)}</p>
    <button class="btn btn-primary btn-block" data-action="retry-boot">Retry</button>
  </div></div>`;
  updateThemeButtons();
}

async function boot() {
  let res;
  try {
    res = await fetch('/api/auth/status');
    if (res.status === 404) {
      storageMode = 'local';
      auth = { name: '', role: 'admin' };
      return enterBoard();
    }
    if (!res.ok) throw new Error('Could not reach the server (HTTP ' + res.status + ').');
    const data = await res.json();
    if (typeof data.authenticated !== 'boolean' || typeof data.needsSetup !== 'boolean') {
      throw new Error('The server returned an invalid login status.');
    }
    storageMode = 'server';
    if (data.needsSetup) return showAuthScreen('setup');
    if (!data.authenticated) return showAuthScreen('login');
    auth = {
      name: (data.user && data.user.name) || '',
      role: (data.user && data.user.role) || 'admin',
      memberId: (data.user && data.user.memberId) || '',
    };
  } catch (e) {
    return showUnavailableScreen(e.message || 'Could not reach the server.');
  }
  await enterBoard();
}

/* ---------------- member helpers ---------------- */

function memberById(id) { return state.members.find((m) => m.id === id) || null; }
function memberSnapshot(m) {
  return { id: m.id, name: m.name, role: m.role || '', email: m.email || '', color: m.color, lead: m.lead || '' };
}
/* Today's board shows the current team, so while today's standup runs its
 * saved roster must follow every team change (add, edit, remove). */
function refreshTodayRoster() {
  const today = state.days[todayISO()];
  if (isStarted(today)) today.roster = state.members.map(memberSnapshot);
}
function membersForDay(dateISO) {
  const day = state.days[dateISO];
  return filterByTeam(day && Array.isArray(day.roster) ? day.roster : state.members);
}

function initials(name) {
  const p = String(name || '').trim().split(/\s+/);
  const a = (p[0] || '?')[0] || '?';
  const b = p.length > 1 ? ((p[p.length - 1] || '')[0] || '') : '';
  return (a + b).toUpperCase();
}

/* ---------------- JIRA matching ---------------- */

function matchMember(issue) {
  const a = issue.assignee;
  if (!a) return null;
  if (a.accountId && state.mapping[a.accountId]) return memberById(state.mapping[a.accountId]);
  if (a.email) {
    const m = state.members.find((m) => (m.email || '').toLowerCase() === a.email.toLowerCase());
    if (m) return m;
  }
  if (a.name) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const m = state.members.find((m) => norm(m.name) === norm(a.name));
    if (m) return m;
  }
  return null;
}

function memberIssues(dateISO, memberId) {
  const day = state.days[dateISO];
  if (!day || !day.jira) return [];
  return day.jira.issues.filter((t) => {
    const m = matchMember(t);
    return m && m.id === memberId;
  });
}

function currentJira() {
  const day = state.days[ui.date];
  if (day && day.jira) return Object.assign({ dateISO: ui.date }, day.jira);
  const dates = Object.keys(state.days).filter((d) => state.days[d].jira).sort().reverse();
  if (!dates.length) return null;
  return Object.assign({ dateISO: dates[0] }, state.days[dates[0]].jira);
}

function unmatchedUsers(issues) {
  const map = {};
  for (const t of issues) {
    if (!t.assignee) continue;
    if (matchMember(t)) continue;
    const key = t.assignee.accountId || t.assignee.name || t.assignee.email || 'unknown';
    if (!map[key]) map[key] = { key, name: t.assignee.name || '(unknown)', email: t.assignee.email || '', count: 0 };
    map[key].count++;
  }
  return Object.values(map);
}

function daysLeftLabel(endIso) {
  if (!endIso) return '';
  const end = new Date(endIso); end.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = Math.round((end - today) / 86400000);
  if (d > 1) return d + 'd left';
  if (d === 1) return 'ends tomorrow';
  if (d === 0) return 'ends today';
  return Math.abs(d) + 'd overdue';
}

/* ---------------- API ---------------- */

async function postApi(payload) {
  const res = await fetch('/api/jira', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      creds.accessCode ? { 'x-access-code': creds.accessCode } : {}),
    body: JSON.stringify(Object.assign({ site: creds.site, email: creds.email, token: creds.token }, payload)),
  });
  if (res.status === 401 && storageMode === 'server') { showAuthScreen('login'); }
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok || !data || data.error) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

async function syncJira() {
  const btn = $('#syncBtn');
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    const data = await postApi({ jql: state.settings.jql || undefined, date: todayISO() });
    const day = getDay(todayISO(), true);
    day.jira = { syncedAt: data.syncedAt, sprint: data.sprint, issues: data.issues };
    saveState({ quiet: true });
    render();
    toast('Synced ' + data.issues.length + ' ticket' + (data.issues.length === 1 ? '' : 's') +
      (data.sprint ? ' · ' + data.sprint.name : ''), 'success');
    const un = unmatchedUsers(data.issues);
    if (un.length) toast(un.length + ' JIRA user' + (un.length === 1 ? '' : 's') + ' not on your team — map them in the Sprint view');
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/* Automatic JIRA refresh on every sign-in. Silent when JIRA is not
 * configured yet; the manual Sync button stays available for retries. */
let autoSyncDone = false;
async function autoSyncJira() {
  if (autoSyncDone) return;
  autoSyncDone = true;
  if (!canEdit()) return; // viewers read what admins synced; the server also refreshes the DB on login
  if (storageMode === 'local' && !(creds.site && creds.email && creds.token)) return;
  try {
    const data = await postApi({ jql: state.settings.jql || undefined, date: todayISO() });
    const day = getDay(todayISO(), true);
    day.jira = { syncedAt: data.syncedAt, sprint: data.sprint, issues: data.issues };
    saveState({ quiet: true });
    render();
    toast('JIRA refreshed — ' + data.issues.length + ' ticket' + (data.issues.length === 1 ? '' : 's') +
      (data.sprint ? ' · ' + data.sprint.name : ''), 'success');
  } catch (e) {
    if (!/missing jira credentials/i.test(e.message)) toast('Auto JIRA refresh failed: ' + e.message, 'error');
  }
}
