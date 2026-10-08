/* Daily Scrum — actions, event delegation and init (loaded last).
 * Classic script: shares globals with app-core.js, app-auth.js,
 * app-views.js and app.js (see index.html for the load order). */
'use strict';

/* ---------------- actions ---------------- */

function setAttendance(memberId, att) {
  const day = getDay(ui.date, true);
  day.entries[memberId] = day.entries[memberId] || {};
  day.entries[memberId].attendance = att;
  saveState();
  render();
}

/** Removing keeps the member, their place and JIRA mappings so the Undo toast can put them back. */
function removeMember(id) {
  const index = state.members.findIndex((x) => x.id === id);
  if (index < 0) return;
  const m = state.members[index];
  const mapped = Object.keys(state.mapping).filter((k) => state.mapping[k] === id);
  state.members = state.members.filter((x) => x.id !== id);
  state.mapping = Object.fromEntries(Object.entries(state.mapping).filter(([, v]) => v !== id));
  refreshTodayRoster();
  saveState();
  render();
  return toastUndo(m.name + ' removed from the team — past standups and reports keep them', () => restoreMember(m, index, mapped));
}

function restoreMember(m, index, mapped) {
  if (memberById(m.id)) return;
  const members = state.members.slice();
  members.splice(Math.min(index, members.length), 0, m);
  state.members = members;
  const mapping = Object.assign({}, state.mapping);
  for (const k of mapped) if (!mapping[k]) mapping[k] = m.id;
  state.mapping = mapping;
  refreshTodayRoster();
  saveState();
  render();
  toast(m.name + ' is back on the team', 'success');
}

function deleteDay(d) {
  const saved = state.days[d];
  if (!saved) return;
  delete state.days[d];
  saveState();
  render();
  return toastUndo('Deleted ' + fmtDay(d), () => {
    if (state.days[d]) { toast('That day has new data meanwhile — nothing to undo', 'error'); return; }
    state.days[d] = saved;
    saveState();
    render();
    toast(fmtDay(d) + ' restored', 'success');
  });
}

function openDate(iso) { ui.date = iso; ui.view = 'today'; render(); }

function shiftDay(n) {
  const d = new Date(ui.date + 'T00:00:00');
  d.setDate(d.getDate() + n);
  ui.date = d.toLocaleDateString('sv-SE');
  render();
}

function exportData() {
  const payload = { app: 'daily-scrum', version: 1, exportedAt: new Date().toISOString(), state };
  downloadText('daily-scrum-backup-' + todayISO() + '.json', JSON.stringify(payload, null, 2));
  toast('Backup downloaded', 'success');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let payload;
    try { payload = JSON.parse(reader.result); } catch (_) { toast('That file is not valid JSON', 'error'); return; }
    const incoming = payload && payload.state ? payload.state : payload;
    if (!incoming || !Array.isArray(incoming.members)) { toast('Not a Daily Scrum backup file', 'error'); return; }
    if (!await askConfirm({
      title: 'Import this backup?',
      message: 'Backup from ' + (payload.exportedAt ? new Date(payload.exportedAt).toLocaleString() : 'an unknown date') +
        '. It replaces the current team, notes and history. Export a backup first if you may need them.',
      confirmLabel: 'Replace with backup', danger: true,
    })) return;
    state = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), incoming);
    state.settings = state.settings || { jql: '' };
    normalizeDays();
    saveState({ quiet: true });
    persistNow();
    render();
    toast('Backup imported', 'success');
  };
  reader.readAsText(file);
}

async function eraseAll() {
  if (!await askConfirm({
    title: 'Erase all data?',
    message: 'The team, notes and history are deleted for good. User accounts are kept. This cannot be undone.',
    confirmLabel: 'Erase everything', danger: true, typeToConfirm: 'ERASE',
  })) return;
  localStorage.removeItem(LS_STATE);
  localStorage.removeItem(LS_CREDS);
  state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  creds = { site: '', email: '', token: '', accessCode: '', hasToken: false };
  clearTokenOnNextSave = true;
  ui.view = 'today'; ui.date = todayISO();
  saveState({ quiet: true });
  persistNow();
  render();
  toast('All data erased');
}

function gatherCredsFromDom() {
  const s = $('#setSite'), e = $('#setEmail'), t = $('#setToken');
  if (s) creds.site = s.value.trim();
  if (e) creds.email = e.value.trim();
  if (t) creds.token = t.value.trim();
  takeKpiSetting($('#setKpiField'), 'kpiPointsField', KPI_FIELD_ID, 'Story points field ID looks like customfield_10016');
  saveCreds();
}

function renderJiraSaveBar() {
  const bar = $('#jiraSaveBar');
  if (bar) bar.hidden = !jiraDraftDirty();
  renderSaveStatus();
}

function discardJiraDraft() {
  ui.jiraDraft = null;
  render();
}

async function saveJiraDraft() {
  if (!canAdmin() || !jiraDraftDirty()) return false;
  const draft = ui.jiraDraft;
  creds.site = draft.site.trim();
  creds.email = draft.email.trim();
  creds.token = draft.token.trim();
  state.settings.jql = draft.jql.trim();
  ui.jiraDraft = null;
  saveState({ quiet: true });
  const saved = await persistNow();
  renderSprintChip();
  render();
  if (saved) toast('JIRA connection saved', 'success');
  return saved;
}

// Same rule as the server (lib/kpi-db.js); a bad value would make every save fail.
const KPI_FIELD_ID = /^[\w.-]{1,64}$/;

function takeKpiSetting(input, key, pattern, message) {
  if (!input) return;
  const value = input.value.trim();
  if (value === creds[key]) return;
  if (value && !pattern.test(value)) { toast(message, 'error'); return; }
  creds[key] = value;
  kpiCredsEdited = true;
}

/** Settings "Detect": asks the server which JIRA field holds story points. */
async function detectKpiField() {
  gatherCredsFromDom();
  if (!await persistNow()) return; // detect with the freshest saved credentials
  const btn = $('#kpiDetectBtn');
  if (btn) btn.disabled = true;
  try {
    const data = await kpiFetch('/api/kpi/fields');
    if (!data.suggested) { toast('No story points field found in JIRA', 'error'); return; }
    const field = data.fields.find((x) => x.id === data.suggested);
    creds.kpiPointsField = data.suggested;
    kpiCredsEdited = true;
    render();
    saveCreds();
    toast('Story points field: ' + (field ? field.name + ' (' + field.id + ')' : data.suggested));
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    const again = $('#kpiDetectBtn');
    if (again) again.disabled = false;
  }
}

async function testConnection() {
  if (jiraDraftDirty() && !await saveJiraDraft()) return;
  if (!await persistNow()) return; // use the freshest saved credentials
  const st = $('#connStatus');
  const btn = $('#testBtn');
  if (st) { st.textContent = 'Checking…'; st.className = 'conn-status'; }
  if (btn) btn.disabled = true;
  try {
    const data = await postApi({ action: 'test' });
    if (st) {
      st.textContent = 'Connected as ' + data.user.name +
        (data.authSource === 'env' ? ' (server env)' : data.authSource === 'database' ? ' (database)' : '');
      st.className = 'conn-status ok';
    }
    toast('JIRA connection OK', 'success');
  } catch (e2) {
    if (st) { st.textContent = e2.message; st.className = 'conn-status err'; }
    toast(e2.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------------- status colours ---------------- */

async function putStatusColors(body) {
  const data = await kpiFetch('/api/status-colors', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  statusColors = cleanColorMap(data.statusColors);
}

async function saveStatusColor(name, slot) {
  try {
    await putStatusColors({ colors: { [name]: slot } }); // only this entry; the server merges
    ui.statusPick = '';
    render();
    toast('Status colour saved', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function resetStatusColors() {
  if (!await askConfirm({
    title: 'Reset status colours?',
    message: 'Every status goes back to its automatic colour. Colours picked by hand are lost.',
    confirmLabel: 'Reset colours',
  })) return;
  try {
    await putStatusColors({ reset: true });
    toast('Status colours reset', 'success');
  } catch (e) {
    statusColors = {}; // the server clears the map before it asks JIRA again
    toast(e.message, 'error');
  }
  ui.statusPick = '';
  render();
}

/* ---------------- event delegation ---------------- */

/** Admin-only on top of EDIT_ACTIONS: JIRA connection, backups, global KPI/PI settings, status colours. */
const ADMIN_ACTIONS = ['reset-jql', 'jira-save', 'jira-discard', 'import-btn', 'erase', 'test-conn', 'export',
  'kpi-detect-field', 'status-color-pick', 'status-color-set', 'status-color-reset', 'pi-reset-jql', 'pi-preview', 'pi-save', 'pi-discard', 'pi-analyze', 'pi-convert', 'pi-use-conversion', 'pi-builder', 'pi-direct', 'pi-insert', 'pi-rule-add', 'pi-rule-remove', 'pi-options',
  'kpi-role-add', 'kpi-role-remove'];

const EDIT_ACTIONS = ['add-member', 'edit-member', 'remove-member', 'sync',
  'start-day', 'cancel-day', 'edit-note', 'finish-note', 'delete-day', 'reset-jql', 'jira-save', 'jira-discard', 'import-btn', 'erase', 'test-conn', 'export',
  'kpi-detect-field', 'status-color-pick', 'status-color-set', 'status-color-reset',
  'pi-generate', 'pi-download', 'pi-reset-jql', 'pi-preview', 'pi-save', 'pi-discard', 'pi-analyze', 'pi-convert', 'pi-use-conversion', 'pi-builder', 'pi-direct', 'pi-insert', 'pi-rule-add', 'pi-rule-remove', 'pi-options', 'kpi-role-add', 'kpi-role-remove'];

const clickActions = {
  'pi-save': () => piEditorSave(), 'pi-discard': () => piEditorDiscard(),
  'pi-analyze': () => piEditorAnalyze(), 'pi-convert': () => piEditorConvert(),
  'pi-use-conversion': () => piEditorUseConversion(), 'pi-builder': () => piEditorBuilder(),
  'pi-direct': () => piEditorDirect(), 'pi-insert': el => piEditorInsert(el),
  'pi-rule-add': () => piEditorAddRule(), 'pi-rule-remove': el => piEditorRemoveRule(el),
  'pi-options': () => piEditorOptions(),
  'theme': () => toggleTheme(),
  'kpi-role-add': () => {
    if (document.querySelectorAll('[data-role-rule]').length >= KPI_ROLE_RULES_MAX) {
      toast('Set rules for at most ' + KPI_ROLE_RULES_MAX + ' roles.', 'error');
      return;
    }
    kpiUi.roleDrafts += 1;
    render();
    const inputs = document.querySelectorAll('[data-role-field="role"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  },
  'kpi-role-remove': (el) => {
    el.closest('[data-role-rule]').remove();
    saveKpiRules();
    render();
  },
  'ticket-filter': (el) => {
    if (!['all', 'active', 'done'].includes(el.dataset.filter)) return;
    ui.ticketFilters.set(el.dataset.key, el.dataset.filter);
    render();
  },
  'sprint-collapse-all': (el) => {
    const collapse = el.dataset.mode === 'collapse';
    for (const id of el.dataset.members.split(',')) {
      if (collapse) ui.sprintCollapsed.add(id); else ui.sprintCollapsed.delete(id);
    }
    render();
    const btn = $('[data-action="sprint-collapse-all"]');
    if (btn) btn.focus({ preventScroll: true });
  },
  'board-density': () => {
    ui.compact = !ui.compact;
    ui.editingNote = null;
    ui.ticketExpansion.clear(); // density decides ticket expansion again
    try { localStorage.setItem('dailyscrum.compact.v1', JSON.stringify(ui.compact)); } catch (_) { /* private storage */ }
    render();
    $('[data-action="board-density"]').focus({ preventScroll: true });
  },
  'board-view': (el) => {
    const view = el.dataset.view === 'sheet' ? 'sheet' : 'cards';
    if (ui.boardView === view) return;
    ui.boardView = view;
    ui.editingNote = null;
    try { localStorage.setItem('dailyscrum.boardview.v1', JSON.stringify(view)); } catch (_) { /* private storage */ }
    render();
    const btn = $(`[data-action="board-view"][data-view="${view}"]`);
    if (btn) btn.focus({ preventScroll: true });
  },
  'clear-member-search': () => {
    ui.memberSearch = '';
    const input = $('#memberSearch');
    if (input) { input.value = ''; input.focus(); }
    applyMemberSearch();
  },
  'edit-note': (el) => {
    ui.editingNote = { date: el.dataset.date, member: el.dataset.member, field: el.dataset.field };
    render();
    const field = $$('textarea[data-entry]').find((t) => t.dataset.member === el.dataset.member && t.dataset.field === el.dataset.field);
    if (field) { field.focus({ preventScroll: true }); field.setSelectionRange(field.value.length, field.value.length); }
  },
  'finish-note': (el) => {
    ui.editingNote = null;
    render();
    const button = $$('[data-action="edit-note"]').find((t) => t.dataset.member === el.dataset.member && t.dataset.field === el.dataset.field);
    if (button) button.focus({ preventScroll: true });
  },
  'retry-boot': () => boot(),
  'view': async (el) => {
    if (el.dataset.view === 'pi' && !isPiAvailable()) return;
    ui.view = el.dataset.view;
    if (el.dataset.tab) ui.settingsTab = el.dataset.tab;
    if (ui.view === 'settings' && canAdmin()) await refreshUsers();
    if (ui.view === 'kpi') resetKpi();
    render();
  },
  'prev-day': () => shiftDay(-1),
  'next-day': () => shiftDay(1),
  'goto-today': () => { ui.date = todayISO(); render(); },
  'sync': () => syncJira(),
  'start-day': () => startDay(),
  'cancel-day': () => cancelDay(),
  'copy': () => copyNotes(ui.date),
  'copy-day': (el) => copyNotes(el.dataset.date),
  'report': (el) => downloadReport(el.dataset && el.dataset.date),
  'open-day': (el) => openDate(el.dataset.date),
  'month-prev': () => { ui.month = shiftMonth(ui.month, -1); render(); },
  'month-next': () => { ui.month = shiftMonth(ui.month, 1); render(); },
  'month-current': () => { ui.month = todayISO().slice(0, 7); render(); },
  'download-xlsx': () => downloadMonthlyXlsx(),
  'kpi-refresh': () => refreshKpi(),
  'kpi-download': () => downloadKpiXlsx(),
  'kpi-reload': () => { kpiUi.error = null; render(); },
  'kpi-month': (el) => { ui.month = el.dataset.month; render(); },
  'kpi-trend-count': (el) => { kpiUi.trendCount = Number(el.dataset.count) || 0; render(); },
  'kpi-trend-mode': (el) => { kpiUi.trendMode = el.dataset.mode === 'recent' ? 'recent' : 'month'; render(); },
  'kpi-trend-retry': () => { kpiUi.trend.error = null; render(); }, // the panel reloads it
  'kpi-member': (el) => { kpiUi.memberKey = kpiUi.memberKey === el.dataset.key ? '' : el.dataset.key; render(); },
  'kpi-outcome': (el) => { kpiUi.outcome = el.dataset.outcome || ''; render(); },
  'pi-sort': (el) => applyPiSort(el.dataset.sort),
  'kpi-excluded': () => { kpiUi.showExcluded = !kpiUi.showExcluded; render(); },
  'pi-period': (el) => { piUi.period = el.dataset.period; render(); },
  'pi-generate': () => loadPi(piUi.period, Boolean(piUi.reports[piUi.period])), // again = past the saved copy
  'pi-download': () => downloadPiXlsx(),
  'pi-open': (el) => { piUi.open = piUi.open === el.dataset.id ? '' : el.dataset.id; piUi.find = ''; render(); },
  'pi-reset-jql': () => resetPiTemplate(),
  'pi-preview': () => previewPiJql(),
  'delete-day': (el) => deleteDay(el.dataset.date),
  'confirm-cancel': () => closeConfirm(false),
  'retry-save': () => retrySave(),
  'setup-toggle': () => toggleSetupChecklist(),
  'setup-hide': () => hideSetupChecklist(true),
  'setup-show': () => { hideSetupChecklist(false); ui.view = 'today'; render(); },
  'settings-tab': (el) => { ui.settingsTab = el.dataset.tab; render(); },
  'sprint-mode': (el) => {
    ui.sprintMode = el.dataset.mode === 'list' ? 'list' : 'board';
    try { localStorage.setItem('dailyscrum.sprintMode.v1', JSON.stringify(ui.sprintMode)); } catch (_) { /* private mode */ }
    render();
  },
  'sprint-done': (el) => {
    const id = el.dataset.id;
    if (ui.sprintDoneOpen.has(id)) ui.sprintDoneOpen.delete(id); else ui.sprintDoneOpen.add(id);
    render();
  },
  'hist-month': (el) => { ui.histMonth = shiftMonth(ui.histMonth || todayISO().slice(0, 7), Number(el.dataset.dir) || 0); ui.histSel = ''; render(); },
  'hist-select': (el) => { ui.histSel = el.dataset.date; render(); },
  'hist-open': (el) => { ui.view = 'history'; ui.histMonth = el.dataset.date.slice(0, 7); ui.histSel = el.dataset.date; render(); },
  'att-menu': (el) => {
    if (!canEdit()) return;
    const { id, src } = el.dataset;
    if (attMenuOpen(id, src)) { closeAttMenu(true); return; }
    ui.attMenu = { id, src };
    render();
    const current = $('.att-menu [aria-checked="true"]');
    if (current) current.focus({ preventScroll: true });
  },
  'att-set': (el) => {
    const { id, src, att } = el.dataset;
    if (!canEdit() || !ATT[att]) return;
    ui.attMenu = null;
    setAttendance(id, att);
    // an away member without notes loses their card, so fall back to their roll-call pill
    const trigger = attTrigger(id, src) || attTrigger(id, 'roll');
    if (trigger) trigger.focus({ preventScroll: true });
  },
  'today-filter': (el) => { ui.todayFilter = ui.todayFilter === el.dataset.filter ? '' : el.dataset.filter; render(); },
  'add-member': () => openMemberModal(null),
  'edit-member': (el) => openMemberModal(memberById(el.dataset.id)),
  'remove-member': (el) => removeMember(el.dataset.id),
  'close-modal': () => closeModal(),
  'own-key-later': () => closeOwnKeyModal(),
  'own-key-test': () => testOwnKey(),
  'own-key-remove': () => removeOwnKey(),
  'test-conn': () => testConnection(),
  'jira-save': () => saveJiraDraft(),
  'jira-discard': () => discardJiraDraft(),
  'kpi-detect-field': () => detectKpiField(),
  'status-color-pick': (el) => { ui.statusPick = ui.statusPick === el.dataset.name ? '' : el.dataset.name; render(); },
  'status-color-set': (el) => saveStatusColor(el.dataset.name, Number(el.dataset.slot)),
  'status-color-reset': () => resetStatusColors(),
  'reset-jql': () => {
    jiraDraftValues().jql = '';
    render();
    renderSaveStatus();
  },
  'export': () => exportData(),
  'import-btn': () => { const f = $('#importFile'); if (f) f.click(); },
  'erase': () => eraseAll(),
  'logout': () => logout(),
  'delete-user': async (el) => {
    const u = usersList.find((x) => String(x.id) === String(el.dataset.id));
    if (!u) return;
    if (!await askConfirm({
      title: 'Delete user?',
      message: '"' + u.username + '" can no longer sign in and is signed out everywhere. Their team member card and reports stay.',
      confirmLabel: 'Delete user', danger: true,
    })) return;
    const r = await fetch('/api/auth/users/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: u.id }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast(d.error || 'Failed to delete user', 'error');
    toast('User deleted', 'success');
    await refreshUsers();
    render();
  },
  'reset-user-pass': async (el) => {
    const u = usersList.find((x) => String(x.id) === String(el.dataset.id));
    if (!u) return;
    const np = await askConfirm({
      title: 'Reset password',
      message: 'Set a new password for "' + u.username + '". They are signed out everywhere and sign in with the new one.',
      confirmLabel: 'Set password',
      input: { label: 'New password', type: 'password', check: PasswordPolicy.problem, placeholder: PasswordPolicy.HINT },
    });
    if (np === false) return;
    const r = await fetch('/api/auth/users/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: u.id, newPassword: np }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast(d.error || 'Failed to reset password', 'error');
    toast('Password updated', 'success');
  },
};

function positionDropdown(menu) {
  const panel = menu.querySelector('.dropdown-panel');
  if (!panel) return;
  panel.style.transform = '';
  const rect = panel.getBoundingClientRect();
  const shift = Math.max(8 - rect.left, Math.min(0, window.innerWidth - 8 - rect.right));
  panel.style.transform = `translateX(${shift}px)`;
}

const attTrigger = (id, src) => $(`[data-action="att-menu"][data-id="${CSS.escape(id)}"][data-src="${src}"]`);

/** Closes the attendance menu without a re-render; focus returns to its pill when asked. */
function closeAttMenu(refocus) {
  const open = ui.attMenu;
  if (!open) return;
  ui.attMenu = null;
  $$('.att-menu').forEach((n) => n.remove());
  const trigger = attTrigger(open.id, open.src);
  if (!trigger) return;
  trigger.setAttribute('aria-expanded', 'false');
  if (refocus) trigger.focus({ preventScroll: true });
}

/** Arrows move through the open attendance menu, a status letter picks it, Escape and Tab close it. */
function handleAttMenuKey(e) {
  const menu = $('.att-menu');
  if (!menu || !menu.contains(document.activeElement)) return false;
  const items = $$('[role="menuitemradio"]', menu);
  const at = items.indexOf(document.activeElement);
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (e.key === 'Escape') { e.preventDefault(); closeAttMenu(true); return true; }
  // focus moves back to the pill first, so Tab carries on from there
  if (e.key === 'Tab') { closeAttMenu(true); return true; }
  if (step) { e.preventDefault(); items[(at + step + items.length) % items.length].focus(); return true; }
  if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1].focus(); return true; }
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const pick = items.find((b) => ATT[b.dataset.att].key === e.key.toLowerCase());
  if (!pick) return false;
  e.preventDefault();
  clickActions['att-set'](pick);
  return true;
}

function onDocClick(e) {
  if (ui.attMenu && !e.target.closest('.att-pick')) closeAttMenu(false);
  $$('.nav-dropdown[open]').forEach((menu) => {
    if (!menu.contains(e.target)) menu.open = false;
    else if (e.target.closest('[data-action]')) {
      menu.open = false;
      menu.querySelector('summary').focus({ preventScroll: true });
    }
  });
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (!canEdit() && EDIT_ACTIONS.includes(action)) {
    e.preventDefault();
    toast('Your account is view-only', 'error');
    return;
  }
  if (isLead() && ADMIN_ACTIONS.includes(action)) {
    e.preventDefault();
    toast('Only an admin can do this', 'error');
    return;
  }
  const fn = clickActions[action];
  if (!fn) return;
  e.preventDefault();
  // admins and leads must set their own JIRA key before calling JIRA
  if (OWN_KEY_ACTIONS.includes(action) && !requireOwnKey(() => fn(el))) return;
  fn(el);
}

/** Tab list keyboard support: arrows move between settings tabs, Home/End jump to the ends. */
function moveSettingsTab(e) {
  const ids = settingsTabs().map((t) => t.id);
  const at = ids.indexOf(e.target.dataset.tab);
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  let next;
  if (step) next = ids[(at + step + ids.length) % ids.length];
  else if (e.key === 'Home') next = ids[0];
  else if (e.key === 'End') next = ids[ids.length - 1];
  if (!next) return;
  e.preventDefault();
  ui.settingsTab = next;
  render();
  const tab = document.getElementById('stab-' + next);
  if (tab) tab.focus();
}

function onDocInput(e) {
  const t = e.target;
  if (canAdmin() && piEditorInput(t)) return;
  if (t.id === 'memberSearch') { ui.memberSearch = t.value; applyMemberSearch(); return; }
  if (t.dataset && t.dataset.jira) {
    jiraDraftValues()[t.dataset.jira] = t.value;
    renderJiraSaveBar();
    return;
  }
  if (canEdit() && t.dataset && (t.dataset.setting || t.dataset.set)) saveStatus('Unsaved changes');
  if (t.id === 'piFind') { applyPiFind(t.value); return; }
  if (t.id === 'kpiFind') { applyKpiFind(t.value); return; }
  if (t.matches('textarea[data-entry]') && canEdit()) {
    const day = getDay(t.dataset.date, false);
    if (!isStarted(day)) return;
    day.entries[t.dataset.member] = day.entries[t.dataset.member] || {};
    day.entries[t.dataset.member][t.dataset.field] = t.value;
    saveStatus('Saving…');
    persistSoon();
    refreshBlockerMarks(t, day);
  }
}

/** Typing a blocker flags the card and recounts the summary without a re-render, so focus stays put. */
function refreshBlockerMarks(t, day) {
  const card = t.closest('.member-card, .sheet-row');
  if (card && t.dataset.field === 'blockers') card.classList.toggle('has-blocker', t.value.trim() !== '');
  const bar = document.getElementById('todaySummary');
  if (bar) bar.outerHTML = todaySummaryHtml(boardMembersFor(t.dataset.date, day), day);
}

function onDocChange(e) {
  const t = e.target;
  if (canAdmin() && piEditorChange(t)) return;
  if (t.id === 'dateInput' && t.value) { ui.date = t.value; render(); return; }
  if (t.id === 'monthInput' && isValidMonth(t.value)) { ui.month = t.value; render(); return; }
  if (t.id === 'teamFilter') { ui.team = t.value; render(); return; }
  if (t.id === 'kpiJump' && isValidMonth(t.value)) { ui.month = t.value; render(); return; }
  if (t.id === 'kpiPerson') { kpiUi.memberKey = t.value; render(); return; }
  if (t.id === 'kpiTaskMember') { applyKpiTaskMember(t.value); return; }
  if (t.dataset.jira) { jiraDraftValues()[t.dataset.jira] = t.value; renderJiraSaveBar(); return; }
  if (t.dataset.set) {
    gatherCredsFromDom();
    if (t.dataset.set === 'site') renderSprintChip();
    return;
  }
  if (t.dataset.kpiMember !== undefined) {
    state.settings.kpiMembers = [...document.querySelectorAll('[data-kpi-member]:checked')].map((el) => el.dataset.kpiMember);
    saveState({ quiet: true });
    return;
  }
  if (t.dataset.setting === 'jql') { state.settings.jql = t.value.trim(); saveState({ quiet: true }); return; }
  if (t.dataset.setting === 'piPrefix') { state.settings.piPrefix = t.value.trim(); saveState({ quiet: true }); return; }
  if (t.dataset.setting === 'piPeriodMonths') {
    // the report page then opens on the last finished period of the new length
    state.settings.piPeriodMonths = Number(t.value);
    piEditorUi.period = ''; piEditorInvalidate();
    piUi.period = '';
    saveState({ quiet: true });
    render();
    return;
  }
  if (t.dataset.setting === 'kpiDoneStatuses' || t.dataset.setting === 'kpiDoneCategory' || t.dataset.roleField) { saveKpiRules(); return; }
  if (t.dataset.meMember !== undefined) { linkMeMember(t.value); return; }
  if (t.dataset.account) {
    const v = t.value;
    if (!v) return;
    if (v === '__add') {
      const name = t.closest('.map-row').querySelector('.who strong').textContent.trim();
      const email = (t.closest('.map-row').querySelector('.who span').textContent.split('·')[0] || '').trim();
      const m = { id: uid(), name, role: '', email: email.includes('@') ? email : '', color: PALETTE[state.members.length % PALETTE.length] };
      state.members.push(m);
      state.mapping[t.dataset.account] = m.id;
      refreshTodayRoster();
      toast(name + ' added to the team', 'success');
    } else {
      state.mapping[t.dataset.account] = v;
      toast('User mapped', 'success');
    }
    saveState();
    render();
    return;
  }
  if (t.id === 'importFile' && t.files && t.files[0]) importData(t.files[0]);
}

async function onDocSubmit(e) {
  const f = e.target;
  if (f.id === 'confirmForm') { e.preventDefault(); onConfirmSubmit(f); return; }
  if (f.id === 'memberForm') { e.preventDefault(); onMemberSubmit(e); return; }
  if (f.id === 'authForm') { e.preventDefault(); await onAuthSubmit(f); return; }
  if (f.id === 'pwForm') { e.preventDefault(); await onPasswordSubmit(f); return; }
  if (f.id === 'ownKeyForm' || f.id === 'ownKeyModalForm') { e.preventDefault(); await onOwnKeySubmit(f); return; }
  if (f.id === 'userForm') { e.preventDefault(); await onUserCreateSubmit(f); return; }
}

/* ---------------- init ---------------- */

function init() {
  updateThemeButtons();
  document.addEventListener('click', onDocClick);
  document.addEventListener('input', onDocInput);
  document.addEventListener('change', onDocChange);
  document.addEventListener('submit', onDocSubmit);
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeModal(); });
  $('#confirmOverlay').addEventListener('click', (e) => { if (e.target.id === 'confirmOverlay') closeConfirm(false); });
  window.addEventListener('popstate', onNavigationPop);
  window.addEventListener('resize', () => { $$('.nav-dropdown[open]').forEach(positionDropdown); positionAttMenu(); });
  document.addEventListener('scroll', () => { if (ui.attMenu) positionAttMenu(); }, { capture: true, passive: true });
  document.addEventListener('toggle', (e) => {
    if (e.target.matches && e.target.matches('.nav-dropdown')) {
      if (e.target.open) positionDropdown(e.target);
      return;
    }
    if (e.target.matches && e.target.matches('details[data-sprint-map]')) { ui.sprintMapOpen = e.target.open; return; }
    if (e.target.matches && e.target.matches('details[data-sprint-member]')) {
      const id = e.target.dataset.sprintMember;
      if (e.target.open) ui.sprintCollapsed.delete(id); else ui.sprintCollapsed.add(id);
      const btn = $('[data-action="sprint-collapse-all"]');
      if (btn) {
        const anyOpen = $$('details[data-sprint-member]').some((d) => d.open);
        btn.dataset.mode = anyOpen ? 'collapse' : 'expand';
        btn.textContent = anyOpen ? 'Collapse all' : 'Expand all';
      }
      return;
    }
    if (!e.target.matches || !e.target.matches('details[data-tickets]')) return;
    if (!e.target.isConnected) return;
    const key = e.target.dataset.tickets;
    if (ui.ticketExpansion.has(key) || e.target.open !== (e.target.dataset.initialOpen === 'true')) {
      ui.ticketExpansion.set(key, e.target.open);
    }
  }, true);
  initSaveGuard();
  initTips();
  document.addEventListener('keydown', (e) => {
    if (handleDialogKey(e)) return;
    if (handleAttMenuKey(e)) return;
    if (e.key === 'Escape') {
      const menu = document.activeElement && document.activeElement.closest('.nav-dropdown[open]');
      $$('.nav-dropdown[open]').forEach((d) => { d.open = false; });
      if (menu) { e.preventDefault(); menu.querySelector('summary').focus(); }
    }
    // KPI member rows are focusable table rows: Enter / Space act like a click.
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-action]')) onDocClick(e);
    if (e.target.matches && e.target.matches('.settings-tab')) moveSettingsTab(e);
  });
  // a stream the browser gave up on (sleep, network loss) restarts when the tab is back
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || liveSource || storageMode !== 'server') return;
    if (document.body.classList.contains('auth-mode')) return;
    startLiveUpdates();
    queueLiveSync(0, true);
  });
  $('#app').innerHTML = '<div class="boot">Loading your board&hellip;</div>';
  boot();
}

init();
