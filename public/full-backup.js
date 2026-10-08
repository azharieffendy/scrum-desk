/*
 * Full encrypted backup and reviewed database restore — the server-side half of
 * Settings → Data & backup (admins only; lib/backup-service.js does the work).
 * The backup password goes to the server once per request and is never stored.
 * Globals from app-core.js / dialogs.js: storageMode, toast, esc, $, render, askConfirm.
 */
'use strict';

const FULL_BACKUP_PASSWORD_MIN = 10;
const RESTART_POLL_MS = 1500;
const RESTART_WAIT_MS = 120000;

const fullBackup = { busy: '', review: null, status: null, statusLoading: false };

function fullBackupAllowed() {
  return storageMode === 'server' && canEdit() && !isLead();
}

/** True when the page travels unencrypted over the network (plain HTTP to another machine). */
function fullBackupInsecure() {
  const h = location.hostname;
  return location.protocol === 'http:' && !(h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost'));
}

async function fullBackupRequest(action, body) {
  const res = await fetch('/api/backup/' + action, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || ('HTTP ' + res.status));
  }
  return res;
}

async function loadFullBackupStatus() {
  if (fullBackup.statusLoading) return;
  fullBackup.statusLoading = true;
  try { fullBackup.status = await (await fullBackupRequest('status')).json(); }
  catch (_) { fullBackup.status = {}; }
  fullBackup.statusLoading = false;
  render();
}

function lastRestoreHtml() {
  const r = fullBackup.status && fullBackup.status.lastRestore;
  if (!r) return '';
  const when = new Date(r.at).toLocaleString();
  return r.ok
    ? `<p class="backup-note backup-ok">Last restore (${esc(when)}): the database was replaced with the backup of
        ${esc(r.backupCreatedAt ? new Date(r.backupCreatedAt).toLocaleString() : 'an unknown date')}.
        ${r.safetyCopy ? 'The database it replaced is saved as <code>data/' + esc(r.safetyCopy) + '</code>' +
          (r.safetyCopyRaw ? ' (it could not be read cleanly, so it was copied as-is)' : '') + '.' : ''}</p>`
    : `<p class="backup-note backup-bad">Last restore (${esc(when)}) was <b>not applied</b> — the database was left unchanged.
        ${esc(r.error || '')}</p>`;
}

function fullBackupReviewHtml(r) {
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : 'unknown');
  const rows = r.tables.map((t) => `<tr><td>${esc(t.name)}</td>
      <td class="num">${t.current === null ? '—' : t.current}</td><td class="num">${t.backup === null ? '—' : t.backup}</td></tr>`).join('');
  const list = (items) => items.map((x) => '<li>' + esc(x) + '</li>').join('');
  return `
    <div class="backup-review" role="region" aria-label="Backup review">
      <h4>Backup checked — review before restoring</h4>
      <dl class="backup-facts">
        <dt>Made</dt><dd>${esc(fmt(r.createdAt))} by ${esc(r.createdBy || 'unknown')}</dd>
        <dt>Version</dt><dd>${esc(r.appVersion || 'unknown')}${r.gitCommit ? ' (' + esc(r.gitCommit.slice(0, 12)) + ')' : ''}
          &middot; this app ${esc(r.currentVersion || 'unknown')}</dd>
        <dt>Contains</dt><dd>${esc(r.included.join(', ') || 'database')}; ${r.appFiles} app files;
          ${r.envKeys.length ? 'configuration ' + esc(r.envKeys.join(', ')) : 'no configuration values'}</dd>
        <dt>Accounts</dt><dd>${r.accounts.map((a) => esc(a.username) + ' <span class="muted">(' + esc(a.role) + ')</span>').join(', ')}</dd>
        <dt>Checks</dt><dd>Password, encryption, every checksum and the database integrity check passed.</dd>
      </dl>
      ${r.warnings.length ? `<ul class="backup-warnings">${list(r.warnings)}</ul>` : ''}
      <p class="backup-label">Restoring replaces</p><ul>${list(r.replaces)}</ul>
      <p class="backup-label">Kept</p><ul>${list(r.keeps)}</ul>
      <table class="backup-tables"><thead><tr><th>Table</th><th class="num">Now</th><th class="num">In backup</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <div class="row-gap">
        <button type="button" class="btn btn-danger btn-sm" data-action="full-restore"${fullBackup.busy ? ' disabled' : ''}>Restore database&hellip;</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="full-restore-cancel">Cancel</button>
      </div>
    </div>`;
}

/** The full backup and restore sections of the Data & backup panel. */
function fullBackupPanelHtml() {
  if (!fullBackupAllowed()) return '';
  if (!fullBackup.status && !fullBackup.statusLoading) setTimeout(loadFullBackupStatus, 0);
  const busy = fullBackup.busy;
  const insecure = fullBackupInsecure()
    ? '<p class="backup-note backup-bad">This page is opened over plain HTTP, so the password and the backup cross the network unencrypted. Prefer doing this on the server itself (http://localhost) or over HTTPS.</p>'
    : '';
  return `
  <section class="panel">
    <h3>Full encrypted backup</h3>
    <p class="panel-sub">Everything needed to bring the app back: the database (accounts, settings, JIRA credentials,
      notes, team data and report history), the configured environment values, the application and Docker files,
      and restore instructions — encrypted on the server with AES-256-GCM.</p>
    ${insecure}
    <form id="fullBackupForm" class="backup-form" novalidate>
      <label class="field"><span>Backup password</span>
        <input name="password" type="password" minlength="${FULL_BACKUP_PASSWORD_MIN}" autocomplete="new-password" required></label>
      <label class="field"><span>Confirm password</span>
        <input name="confirm" type="password" autocomplete="new-password" required></label>
      <p class="backup-note backup-bad"><b>Keep this password safe.</b> It is not stored anywhere — if it is forgotten,
        nobody can open the backup.</p>
      <button type="submit" class="btn btn-primary btn-sm"${busy ? ' disabled' : ''}>${busy === 'create' ? 'Encrypting&hellip;' : '&#10515; Download encrypted backup'}</button>
    </form>
  </section>
  <section class="panel">
    <h3>Restore full backup</h3>
    <p class="panel-sub">Replaces the database from a <code>.dsbackup</code> file. The file is checked and summarised
      first; nothing changes until you confirm. The current database is saved in <code>data/backups/</code> before it is
      replaced, then the app restarts. Application and Docker files are restored separately (see <code>RESTORE.txt</code> in the backup).</p>
    ${lastRestoreHtml()}
    <form id="restoreCheckForm" class="backup-form" novalidate>
      <label class="field"><span>Backup file</span>
        <input name="file" type="file" accept=".dsbackup,application/octet-stream" required></label>
      <label class="field"><span>Backup password</span>
        <input name="password" type="password" autocomplete="off" required></label>
      <button type="submit" class="btn btn-ghost btn-sm"${busy ? ' disabled' : ''}>${busy === 'inspect' ? 'Checking&hellip;' : 'Check backup'}</button>
    </form>
    ${fullBackup.review ? fullBackupReviewHtml(fullBackup.review) : ''}
  </section>`;
}

function filenameFrom(res, fallback) {
  const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
  return m ? m[1] : fallback;
}

async function onFullBackupSubmit(form) {
  const password = form.password.value;
  const weak = PasswordPolicy.problem(password);
  if (weak) return toast('Backup password: ' + weak, 'error');
  if (password !== form.confirm.value) return toast('The two passwords do not match', 'error');
  fullBackup.busy = 'create';
  render();
  try {
    const res = await fullBackupRequest('create', { password });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filenameFrom(res, 'scrum-desk-full-backup.dsbackup');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Encrypted backup downloaded', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    fullBackup.busy = '';
    render(); // clears the password fields
  }
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

async function onRestoreCheckSubmit(form) {
  const file = form.file.files && form.file.files[0];
  if (!file) return toast('Choose a backup file', 'error');
  if (!form.password.value) return toast('Enter the backup password', 'error');
  const password = form.password.value;
  fullBackup.busy = 'inspect';
  fullBackup.review = null;
  render();
  try {
    const data = await readAsBase64(file);
    fullBackup.review = await (await fullBackupRequest('inspect', { file: data, password })).json();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    fullBackup.busy = '';
    render();
  }
}

async function cancelFullRestore() {
  fullBackup.review = null;
  render();
  try { await fullBackupRequest('cancel', {}); } catch (_) { /* the checked copy also expires on its own */ }
}

async function startFullRestore() {
  const r = fullBackup.review;
  if (!r) return;
  const typed = await askConfirm({
    title: 'Replace the database with this backup?',
    message: 'The database is replaced with the backup of ' + new Date(r.createdAt).toLocaleString() +
      '. The current one is saved in data/backups/ first. The app restarts and everyone signs in again with the accounts from the backup.',
    confirmLabel: 'Restore and restart', danger: true, typeToConfirm: 'RESTORE',
  });
  if (!typed) return;
  fullBackup.busy = 'restore';
  render();
  let out;
  try {
    out = await (await fullBackupRequest('restore', { id: r.id, confirm: 'RESTORE' })).json();
  } catch (e) {
    fullBackup.busy = '';
    fullBackup.review = null;
    render();
    return toast(e.message, 'error');
  }
  toast(out.managed ? 'Restoring — the app is restarting…' : 'Queued — start the app again to apply the restore', 'success');
  waitForRestart();
}

/** Polls until the restarted app answers, then reloads into the sign-in screen. */
async function waitForRestart() {
  const started = Date.now();
  await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
  while (Date.now() - started < RESTART_WAIT_MS) {
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      if (res.ok) { location.reload(); return; }
    } catch (_) { /* still restarting */ }
    await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
  }
  fullBackup.busy = '';
  render();
  toast('The app has not come back yet. Start it again (docker compose up -d), then reload this page.', 'error');
}
