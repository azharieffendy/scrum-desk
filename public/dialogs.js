/* ================================================================
   Dialogs and save safety: the in-app confirm dialog (replaces the
   browser's confirm/prompt), the Undo toast for reversible actions, and
   the guard that keeps unsaved edits from being lost (close-tab warning,
   offline / not-saved banner). Uses helpers from app-core.js at run time.
   ================================================================ */
'use strict';

const UNDO_MS = 8000;

/* Shared modal lifecycle: nested dialogs keep the underlying dialog inert. */
const dialogStack = [];
const dialogInert = new Map();
let dialogBodyOverflow = '';

function refreshDialogBackground() {
  dialogInert.forEach((value, node) => { node.inert = value; });
  dialogInert.clear();
  const top = dialogStack[dialogStack.length - 1];
  if (!top) return;
  Array.from(document.body.children).forEach((node) => {
    if (node === top.overlay || node.tagName === 'SCRIPT') return;
    dialogInert.set(node, node.inert);
    node.inert = true;
  });
}

function showDialog(overlay) {
  if (!overlay || dialogStack.some((d) => d.overlay === overlay)) return;
  if (!dialogStack.length) {
    dialogBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  dialogStack.push({ overlay, returnFocus: document.activeElement });
  overlay.hidden = false;
  refreshDialogBackground();
}

function hideDialog(overlay) {
  if (!overlay) return;
  overlay.hidden = true;
  const index = dialogStack.findIndex((d) => d.overlay === overlay);
  if (index < 0) return;
  const wasTop = index === dialogStack.length - 1;
  const [closed] = dialogStack.splice(index, 1);
  refreshDialogBackground();
  if (!dialogStack.length) document.body.style.overflow = dialogBodyOverflow;
  if (wasTop && closed.returnFocus && closed.returnFocus.isConnected) closed.returnFocus.focus({ preventScroll: true });
}

function handleDialogKey(e) {
  const top = dialogStack[dialogStack.length - 1];
  if (!top) return false;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (top.overlay.id === 'confirmOverlay') closeConfirm(false);
    else if (top.overlay.id === 'keyOverlay') closeOwnKeyModal();
    else if (top.overlay.id === 'idleOverlay') idleStay();
    else closeModal();
    return true;
  }
  if (e.key !== 'Tab') return false;
  const items = Array.from(top.overlay.querySelectorAll('button, input, select, textarea, a[href], [tabindex]'))
    .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
  const first = items[0], last = items[items.length - 1];
  if (!first) { e.preventDefault(); return true; }
  if (!top.overlay.contains(document.activeElement) || (e.shiftKey && document.activeElement === first)) {
    e.preventDefault(); (e.shiftKey ? last : first).focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
  return true;
}

/* ---------------- confirm dialog ---------------- */

let confirmPending = null; // { resolve, opts }

/**
 * Ask before an action that cannot be undone. Resolves true (or the typed
 * value when opts.input is set) on confirm, false on cancel.
 * opts: { title, message, confirmLabel, danger, typeToConfirm, input: { label, type, minLength, check, placeholder } }
 * input.check(value) returns why the value is refused, or null.
 */
function askConfirm(opts) {
  if (confirmPending) closeConfirm(false);
  const overlay = $('#confirmOverlay');
  if (!overlay) return Promise.resolve(false);
  $('#confirmTitle').textContent = opts.title;
  $('#confirmMessage').textContent = opts.message || '';
  $('#confirmFields').innerHTML = confirmFieldsHtml(opts);
  $('#confirmError').textContent = '';
  const ok = $('#confirmOk');
  ok.textContent = opts.confirmLabel || 'OK';
  ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
  showDialog(overlay);
  // a dangerous action never confirms on a stray Enter: focus starts on Cancel
  const field = $('#confirmFields input');
  (field || (opts.danger ? $('#confirmCancel') : ok)).focus();
  return new Promise((resolve) => { confirmPending = { resolve, opts }; });
}

function confirmFieldsHtml(opts) {
  if (opts.typeToConfirm) {
    return `<label class="field"><span>Type <strong>${esc(opts.typeToConfirm)}</strong> to confirm</span>
      <input name="value" autocomplete="off" spellcheck="false"></label>`;
  }
  if (opts.input) {
    const i = opts.input;
    return `<label class="field"><span>${esc(i.label)}</span>
      <input name="value" type="${i.type === 'password' ? 'password' : 'text'}" autocomplete="${i.type === 'password' ? 'new-password' : 'off'}"
        placeholder="${esc(i.placeholder || '')}"></label>`;
  }
  return '';
}

function closeConfirm(value) {
  const pending = confirmPending;
  confirmPending = null;
  const overlay = $('#confirmOverlay');
  hideDialog(overlay);
  if (!pending) return;
  pending.resolve(value);
}

/** Submit of the confirm form: checks the typed value, then resolves. */
function onConfirmSubmit(form) {
  if (!confirmPending) return;
  const { opts } = confirmPending;
  const input = form.querySelector('input[name="value"]');
  const value = input ? input.value : '';
  const error = confirmFieldError(opts, value);
  if (error) {
    $('#confirmError').textContent = error;
    if (input) input.focus();
    return;
  }
  closeConfirm(opts.input ? value : true);
}

function confirmFieldError(opts, value) {
  if (opts.typeToConfirm && value.trim() !== opts.typeToConfirm) return 'Type ' + opts.typeToConfirm + ' exactly to confirm.';
  if (opts.input && value.length < (opts.input.minLength || 0)) return 'At least ' + opts.input.minLength + ' characters.';
  if (opts.input && opts.input.check) return opts.input.check(value) || '';
  return '';
}

/* ---------------- undo toast ---------------- */

/**
 * A toast with an Undo button, for actions that can be put back. Returns
 * { undo } so callers and tests can trigger it; it works once, until the
 * toast goes away.
 */
function toastUndo(message, undo, ms = UNDO_MS) {
  let open = true;
  const el = document.createElement('div');
  el.className = 'toast toast-undo';
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-action';
  btn.textContent = 'Undo';
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 320); };
  const trigger = () => {
    if (!open) return false;
    open = false;
    close();
    undo();
    return true;
  };
  btn.addEventListener('click', trigger);
  el.append(text, btn);
  $('#toasts').appendChild(el);
  setTimeout(() => { if (open) { open = false; close(); } }, ms);
  return { undo: trigger };
}

/* ---------------- unsaved work ---------------- */

let saveInFlight = false;

/** Edits on this tab the server does not have yet (pending, saving or failed). */
function hasUnsavedWork() {
  if (jiraDraftDirty() || (typeof piDraftDirty === 'function' && piDraftDirty())) return true;
  if (storageMode !== 'server' || !canEdit()) return false;
  if (persistTimer || persistSoon.pending() || persistQueued || saveInFlight) return true;
  return boardDiffersFromSaved();
}

function boardDiffersFromSaved() {
  return ['members', 'mapping', 'settings', 'days'].some((key) =>
    JSON.stringify(state[key] || null) !== JSON.stringify(lastSavedState[key] || null));
}

/** The banner under the top bar: offline, or a save that failed. Hidden when all is saved. */
function updateSaveBanner() {
  const banner = $('#saveBanner');
  if (!banner) return;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const failed = !saveInFlight && storageMode === 'server' && canEdit() && boardDiffersFromSaved();
  if (!offline && !failed) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.className = 'save-banner' + (offline ? ' offline' : '');
  $('#saveBannerText').textContent = offline
    ? 'You are offline. Your changes stay in this tab and are saved when the connection is back. Keep this tab open.'
    : 'Your last changes are not saved yet. They stay in this tab; keep it open and retry.';
}

function retrySave() {
  if (storageMode !== 'server') return;
  persistNow().then(updateSaveBanner);
}

function onBeforeUnload(e) {
  if (!hasUnsavedWork()) return;
  if (persistTimer || persistSoon.pending()) persistNow();
  e.preventDefault();
  e.returnValue = ''; // older browsers need it set to show the warning
}

function initSaveGuard() {
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('offline', updateSaveBanner);
  window.addEventListener('online', () => {
    updateSaveBanner();
    if (hasUnsavedWork()) retrySave();
  });
  // a tab going to the background saves now instead of after the debounce
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && (persistTimer || persistSoon.pending())) persistNow();
  });
}
