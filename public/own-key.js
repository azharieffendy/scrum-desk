/*
 * Own JIRA API key: admins and Technical Leads call JIRA with their own
 * email + API token (the site and queries stay team-wide). Until they save
 * one, a popup asks for it at sign-in and before every JIRA action.
 * Globals from app-core.js / app-auth.js: myJira, storageMode, toast, esc, $, render.
 */
'use strict';

/** JIRA actions that need the user's own key first. */
const OWN_KEY_ACTIONS = ['sync', 'kpi-refresh', 'pi-generate', 'kpi-detect-field', 'status-color-reset'];

let ownKeyPending = null; // the click that opened the popup, re-run once a key is saved

/** True when this admin/lead has no key of their own (and the server's env key does not override it). */
function needsOwnKey() {
  return storageMode === 'server' && Boolean(myJira) && !myJira.inUse && !myJira.envOverride;
}

function ownKeyStatusHtml() {
  if (!myJira) return '';
  if (myJira.envOverride) return 'The server&rsquo;s JIRA_* environment variables are in use for everyone.';
  return myJira.inUse
    ? 'JIRA is called with <b>your own key</b> (' + esc(myJira.email) + ').'
    : 'You have no key of your own yet &mdash; set one to use JIRA.';
}

function ownKeyFieldsHtml() {
  const j = myJira || {};
  return `
      <label class="field"><span>Your JIRA email</span>
        <input name="email" type="email" maxlength="256" required placeholder="you@company.com" value="${esc(j.email || '')}" autocomplete="off"></label>
      <label class="field"><span>Your API token</span>
        <input name="token" type="password" maxlength="512" placeholder="${j.hasToken
          ? 'saved — leave blank to keep it'
          : 'create at id.atlassian.com &rarr; Security &rarr; API tokens'}" autocomplete="off"></label>`;
}

/** The "Your JIRA API key" section of Settings → Account. */
function ownKeyPanelHtml() {
  if (!myJira) return '';
  return `
    <form id="ownKeyForm" class="own-key" novalidate>
      <h4>Your JIRA API key</h4>
      <p class="panel-sub">${ownKeyStatusHtml()}</p>
      ${ownKeyFieldsHtml()}
      <div class="row-gap">
        <button type="submit" class="btn btn-primary btn-sm">Save my key</button>
        ${myJira.inUse ? `<button type="button" class="btn btn-ghost btn-sm" data-action="own-key-test">Test</button>
        <button type="button" class="btn btn-danger-ghost btn-sm" data-action="own-key-remove">Remove</button>` : ''}
      </div>
    </form>`;
}

function openOwnKeyModal(pending) {
  ownKeyPending = pending || null;
  const overlay = $('#keyOverlay');
  if (!overlay) return;
  $('#ownKeyModalFields').innerHTML = ownKeyFieldsHtml();
  showDialog(overlay);
  const first = overlay.querySelector('input[name=email]');
  if (first) first.focus();
}

function closeOwnKeyModal() {
  const overlay = $('#keyOverlay');
  hideDialog(overlay);
  ownKeyPending = null;
}

/**
 * Gate for a JIRA action: true when it may run now; otherwise the popup
 * opens and the action runs after the key is saved.
 */
function requireOwnKey(pending) {
  if (!needsOwnKey()) return true;
  openOwnKeyModal(pending);
  toast('Set your own JIRA API key first', 'error');
  return false;
}

async function ownKeyRequest(method, body) {
  const res = await fetch('/api/auth/jira', {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/** Saves from the popup or the Account panel; a blank token keeps the saved one. */
async function onOwnKeySubmit(form) {
  const email = form.email.value.trim();
  const token = form.token.value.trim();
  if (!email) return toast('Enter your JIRA email', 'error');
  if (!token && !(myJira && myJira.hasToken)) return toast('Enter your API token', 'error');
  try {
    myJira = await ownKeyRequest('PUT', token ? { email, token } : { email });
  } catch (e) {
    return toast(e.message, 'error');
  }
  toast('Your JIRA key is saved', 'success');
  const pending = ownKeyPending;
  closeOwnKeyModal();
  render();
  if (pending) pending();
}

async function testOwnKey() {
  try {
    const d = await ownKeyRequest('POST', {});
    toast('Connected as ' + d.user.name, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function removeOwnKey() {
  if (!await askConfirm({
    title: 'Remove your JIRA key?',
    message: 'JIRA actions then use the team key, or ask for your own key again.',
    confirmLabel: 'Remove my key', danger: true,
  })) return;
  try {
    myJira = await ownKeyRequest('PUT', { email: '' });
  } catch (e) {
    return toast(e.message, 'error');
  }
  toast('Your JIRA key was removed');
  render();
}
