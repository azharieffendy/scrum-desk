/*
 * Idle sign-out: after the admin-set number of minutes without mouse,
 * keyboard or touch activity, the user is signed out. A popup warns a
 * minute before. The server enforces the same timeout, so closing the tab
 * does not keep a session alive; this file only tracks real activity
 * (background refreshes never count) and shows the warning.
 * Other tabs share the session: before warning or signing out, the server
 * is asked how long is left, so activity in another tab keeps this one in.
 * Globals from app-core.js / app-auth.js / dialogs.js: storageMode, logout,
 * toast, esc, $, showDialog, hideDialog.
 */
'use strict';

const IDLE_WARN_MS = 60000;          // the warning shows this long before sign-out (at most half the timeout)
const IDLE_PING_MS = 30000;          // activity is reported at most this often (at most a quarter of the timeout)
const IDLE_ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

let idleMinutes = 0;      // from the server; 0 = no idle sign-out
let idleWatching = false;
let idleTimer = null;
let idleCountdown = null;
let idleLastActivity = 0; // last real activity in this tab
let idlePingAt = 0;       // when activity was last reported to the server
let idleChecking = false;
let idleStartLeftMs = null; // time the server says is left when the watch starts (a reload mid-session)

const idleTimeoutMs = () => idleMinutes * 60000;
const idleWarnMs = () => Math.min(IDLE_WARN_MS, idleTimeoutMs() / 2);
const idlePingMs = () => Math.min(IDLE_PING_MS, idleTimeoutMs() / 4);
const idleWarningOpen = () => { const o = $('#idleOverlay'); return Boolean(o && !o.hidden); };

/**
 * Sets the timeout from a server response; restarts the watch when signed in.
 * `remainingMs` (from /api/auth/status) is the time the session has left, so a
 * reloaded page does not assume a fresh timeout the server never granted.
 */
function setIdleMinutes(minutes, remainingMs) {
  const n = Number(minutes);
  idleMinutes = Number.isInteger(n) && n > 0 ? n : 0;
  idleStartLeftMs = typeof remainingMs === 'number' ? remainingMs : null;
  if (idleWatching) startIdleWatch();
}

function startIdleWatch() {
  stopIdleWatch();
  if (storageMode !== 'server' || !idleMinutes) return;
  idleWatching = true;
  idleLastActivity = idlePingAt = Date.now();
  const left = idleStartLeftMs === null ? idleTimeoutMs() : Math.min(idleStartLeftMs, idleTimeoutMs());
  idleStartLeftMs = null;
  scheduleIdleCheck(left - idleWarnMs());
}

function stopIdleWatch() {
  idleWatching = false;
  clearTimeout(idleTimer);
  idleTimer = null;
  hideIdleWarning();
}

function scheduleIdleCheck(delayMs) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(checkIdle, Math.max(1000, delayMs));
}

function onIdleActivity() {
  if (!idleWatching || idleWarningOpen()) return; // once warned, only "Stay signed in" counts
  const now = Date.now();
  idleLastActivity = now;
  if (now - idlePingAt >= idlePingMs()) reportIdleActivity();
}

/** Tells the server the user is active; resolves to the ms left, or null when signed out. */
async function reportIdleActivity() {
  idlePingAt = Date.now();
  try {
    const res = await fetch('/api/auth/activity', { method: 'POST' });
    if (res.status === 401) return null;
    const data = await res.json();
    return typeof data.idleRemainingMs === 'number' ? data.idleRemainingMs : idleTimeoutMs();
  } catch (_) {
    return undefined; // offline: decide again later
  }
}

/** The server's view of the time left (another tab may have been active); null when signed out. */
async function serverIdleRemaining() {
  if (idleLastActivity > idlePingAt) return reportIdleActivity();
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (!data.authenticated) return null;
    setIdleMinutesQuietly(data.idleMinutes);
    return typeof data.idleRemainingMs === 'number' ? data.idleRemainingMs : idleTimeoutMs();
  } catch (_) {
    return undefined;
  }
}

/* an admin may have changed the timeout since this tab loaded */
function setIdleMinutesQuietly(minutes) {
  const n = Number(minutes);
  if (Number.isInteger(n) && n >= 0) idleMinutes = n;
}

async function checkIdle() {
  if (!idleWatching || idleChecking) return;
  idleChecking = true;
  try {
    const left = await serverIdleRemaining();
    if (!idleWatching) return;
    if (left === null) return idleSignOut();
    if (!idleMinutes) return stopIdleWatch();
    if (left === undefined) return scheduleIdleCheck(IDLE_PING_MS);
    if (left > idleWarnMs()) {
      hideIdleWarning();
      return scheduleIdleCheck(left - idleWarnMs());
    }
    if (left <= 0) return idleSignOut();
    showIdleWarning(left);
    scheduleIdleCheck(left);
  } finally {
    idleChecking = false;
  }
}

function showIdleWarning(leftMs) {
  const overlay = $('#idleOverlay');
  if (!overlay) return;
  const deadline = Date.now() + leftMs;
  const tick = () => {
    const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    $('#idleCountdown').textContent = s + ' second' + (s === 1 ? '' : 's');
  };
  tick();
  clearInterval(idleCountdown);
  idleCountdown = setInterval(tick, 1000);
  if (!idleWarningOpen()) {
    showDialog(overlay);
    const stay = overlay.querySelector('[data-action="idle-stay"]');
    if (stay) stay.focus();
  }
}

function hideIdleWarning() {
  clearInterval(idleCountdown);
  idleCountdown = null;
  if (idleWarningOpen()) hideDialog($('#idleOverlay'));
}

/** "Stay signed in" in the warning. */
async function idleStay() {
  hideIdleWarning();
  idleLastActivity = Date.now();
  const left = await reportIdleActivity();
  if (left === null) return idleSignOut();
  scheduleIdleCheck((typeof left === 'number' ? left : idleTimeoutMs()) - idleWarnMs());
}

async function idleSignOut() {
  const minutes = idleMinutes;
  stopIdleWatch();
  await logout();
  toast('Signed out after ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + ' without activity', 'error');
}

/* ---------------- admin setting (Settings → Users) ---------------- */

function idleSettingHtml() {
  return `
    <form id="idleForm" class="idle-form" novalidate>
      <h4>Idle sign-out</h4>
      <p class="panel-sub">Signs everyone out after this many minutes without activity, with a warning a minute before (half the timeout when it is under 2 minutes). 0 turns it off.</p>
      <label class="field"><span>Minutes without activity</span>
        <input name="minutes" type="number" min="0" max="480" step="1" required value="${esc(String(idleMinutes))}"></label>
      <button type="submit" class="btn btn-ghost btn-sm">Save idle timeout</button>
    </form>`;
}

async function onIdleSettingSubmit(f) {
  const raw = String(f.minutes.value).trim();
  const minutes = raw === '' ? NaN : Number(raw); // an empty field must not mean 0 (off)
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 480) return toast('Enter whole minutes from 0 to 480', 'error');
  try {
    const res = await fetch('/api/auth/idle-timeout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes }),
    });
    if (sessionLost(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    idleMinutes = data.minutes;
    startIdleWatch();
    toast(data.minutes ? 'Idle sign-out after ' + data.minutes + ' min' : 'Idle sign-out turned off', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function initIdleWatch() {
  for (const ev of IDLE_ACTIVITY_EVENTS) document.addEventListener(ev, onIdleActivity, { capture: true, passive: true });
  // timers sleep in background tabs: check as soon as the tab is visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && idleWatching) checkIdle();
  });
}
