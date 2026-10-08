/* Performance settings: drafts, conversion, rule builder and explicit JIRA testing. */
'use strict';

const PI_MAX_RULES = 20;

const piEditorUi = {
  draft: null, base: '', mode: null, rules: [], builderError: '',
  options: null, optionsError: '', loading: false,
  source: '', account: '', start: '', end: '', conversion: null, convertError: '',
  period: '', member: '', result: null, error: '', testing: false, request: 0,
};

/** The template being edited; follows the saved one until the admin changes it. */
function piEditorDraft() {
  const saved = state.settings.piJql || PI_DEFAULT_TEMPLATE;
  const u = piEditorUi;
  if (u.draft === null || (u.base !== saved && u.draft === u.base)) {
    u.draft = saved;
    u.base = saved;
    u.rules = PiQuery.parse(saved) || [];
    u.mode = u.rules.length ? 'builder' : 'jql';
  }
  return u.draft;
}

function piDraftDirty() {
  return piEditorUi.draft !== null && piEditorUi.draft.trim() !== (state.settings.piJql || PI_DEFAULT_TEMPLATE).trim();
}

function piEditorPeriod() { return piEditorUi.period || piCurrentPeriod(); }

/** Any edit makes an earlier test result stale (and ignores one still running). */
function piEditorInvalidate() {
  const u = piEditorUi;
  u.builderError = '';
  u.result = null;
  u.error = '';
  u.request++;
  u.testing = false;
}

function piEditorSet(text) {
  piEditorUi.draft = text;
  piEditorInvalidate();
  piEditorFeedback();
  renderSaveStatus();
}

function piValidationHtml(v) {
  return v.errors.map(e => '<p class="pi-error">' + esc(e) + '</p>').join('') +
    v.warnings.map(w => '<p class="panel-sub">' + esc(w) + '</p>').join('');
}

function piDraftStatusText() {
  const saving = typeof saveMessage !== 'undefined' ? saveMessage : '';
  if (piDraftDirty()) return 'Unsaved changes';
  if (saving === 'Not saved') return 'Not saved · retry using the save banner';
  if (saving === 'Saving…') return 'Saving…';
  if (storageMode === 'server' && lastSavedState.settings && lastSavedState.settings.piJql !== state.settings.piJql) return 'Saving…';
  return state.settings.piJql ? 'Saved · custom team query' : 'Built-in query';
}

/** Updates validation, status and buttons in place (keeps focus while typing). */
function piEditorFeedback() {
  const v = PiQuery.validate(piEditorDraft());
  const errors = document.getElementById('piValidation');
  if (errors) errors.innerHTML = piValidationHtml(v);
  const status = document.getElementById('piDraftStatus');
  if (status) status.textContent = piDraftStatusText();
  const save = document.getElementById('piSave');
  if (save) save.disabled = Boolean(v.errors.length) || !piDraftDirty();
  const test = document.getElementById('piTest');
  if (test) test.disabled = Boolean(v.errors.length) || piEditorUi.testing;
  const result = document.getElementById('piTestResult');
  if (result && !piEditorUi.result && !piEditorUi.testing && !piEditorUi.error) result.innerHTML = '';
}

/** Report members (or everyone when none are picked), plus the admin's own member. */
function piMemberList() {
  const picked = new Set(state.settings.kpiMembers || []);
  const chosen = state.members.filter(m => picked.has(m.id));
  const ids = new Set((chosen.length ? chosen : state.members).map(m => m.id));
  if (auth.memberId) ids.add(auth.memberId);
  return state.members.filter(m => ids.has(m.id));
}

function piTestAccount() {
  const member = state.members.find(m => m.id === piEditorUi.member);
  if (!member) return 'Choose a test member';
  const mapped = Object.keys(state.mapping || {}).filter(k => state.mapping[k] === member.id).sort()[0];
  return mapped || member.email || 'No JIRA account mapped';
}

function piTestResultHtml() {
  const u = piEditorUi;
  if (u.error) return `<p class="pi-error" role="alert">${esc(u.error)}</p>`;
  if (!u.result) return '';
  const r = u.result;
  const count = r.more ? r.count.toLocaleString() + '+' : String(r.count);
  return `<p role="status"><strong>${esc(r.person)} · ${esc(r.label)}: ${esc(count)} tickets</strong></p>
    ${r.more ? '<p class="panel-sub">The test stops counting here; the report itself reads every ticket.</p>' : ''}
    <p class="panel-sub">Tested ${esc(new Date(r.testedAt).toLocaleString())} using the current draft.</p>
    <a class="linklike" href="${esc(r.url)}" target="_blank" rel="noopener">Open in JIRA ↗</a>
    <details><summary>Actual query sent to JIRA</summary><pre class="pi-jql">${esc(r.jql)}</pre></details>`;
}

function piPeriodLengthHtml() {
  const options = PI_PERIODS.LENGTHS.map(n =>
    `<option value="${n}"${n === piPeriodMonths() ? ' selected' : ''}>${esc(PI_PERIODS.lengthLabel(n))}</option>`).join('');
  return `<label class="field"><span>Period length</span><select id="piPeriodMonths" data-setting="piPeriodMonths">${options}</select></label>
    <p class="panel-sub">Periods start in January. For four months: January–April, May–August, September–December.</p>`;
}

function piMembersHtml() {
  const people = piMemberList();
  return `<p class="panel-sub">Report includes ${people.length} members${people.length ? ' — ' + esc(people.map(m => m.name).join(', ')) : ''}.
    <button class="linklike" data-action="view" data-view="settings" data-tab="kpi">Manage report members</button>.
    Your linked member is also included.</p>`;
}

function piAccountOptions(source) {
  try {
    return PiQuery.candidates(source).accounts.map(a => `<option value="${esc(a)}"></option>`).join('');
  } catch {
    return '';
  }
}

function piConversionHtml(c) {
  if (!c) return '';
  const warnings = (c.warnings || []).map(w => `<p class="pi-error">${esc(w)}</p>`).join('');
  return `<div class="pi-editor-grid">
      <div><h4>Original</h4><pre class="pi-jql">${esc(c.original)}</pre></div>
      <div><h4>Converted template</h4><pre class="pi-jql">${esc(c.template)}</pre></div>
    </div>
    ${warnings}
    <p class="panel-sub">${esc(c.note)} Other dates and accounts stay literal.</p>
    <button class="btn btn-primary btn-sm" data-action="pi-use-conversion">Use this template</button>`;
}

function piConverterHtml() {
  const u = piEditorUi;
  return `<details class="pi-converter"${u.source ? ' open' : ''}><summary>Paste a JIRA query</summary>
    <p class="panel-sub">Paste a working query. Choose its original assignee and dates, review the conversion, then use the template.</p>
    <label class="field"><span>Original JIRA query</span><textarea id="piSource" rows="5" spellcheck="false">${esc(u.source)}</textarea></label>
    <button class="btn btn-ghost btn-sm" data-action="pi-analyze">Find account and dates</button>
    <div class="pi-editor-grid">
      <label class="field"><span>Original assignee</span><input id="piConvertAccount" list="piAccounts" value="${esc(u.account)}"><datalist id="piAccounts">${piAccountOptions(u.source)}</datalist></label>
      <label class="field"><span>First date in pasted query</span><input id="piConvertStart" type="date" value="${esc(u.start)}"></label>
      <label class="field"><span>Last boundary date in pasted query</span><input id="piConvertEnd" type="date" value="${esc(u.end)}"></label>
    </div>
    <button class="btn btn-ghost btn-sm" data-action="pi-convert">Review conversion</button>
    ${u.convertError ? `<p class="pi-error" role="alert">${esc(u.convertError)}</p>` : ''}
    ${piConversionHtml(u.conversion)}</details>`;
}

function piPlaceholderTableHtml(range) {
  const rows = [
    ['{assignee}', 'JIRA account of each member', piTestAccount()],
    ['{start}', 'First day', range.start],
    ['{end}', 'Final day (fully included)', range.end],
    ['{afterEnd}', 'Day after the period', range.afterEnd],
  ];
  return `<div class="pi-table-wrap"><table class="rtable"><thead><tr><th>Placeholder</th><th>Meaning</th><th>Value for test</th></tr></thead><tbody>
    ${rows.map(([ph, meaning, value]) => `<tr><td><button class="linklike" data-action="pi-insert" data-placeholder="${ph}">${ph}</button></td><td>${meaning}</td><td>${esc(value)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function piTemplateHtml(tpl, validation, range) {
  const u = piEditorUi;
  const builder = u.mode === 'builder';
  const dirty = piDraftDirty();
  return `<div class="row-gap">
      <button class="btn btn-ghost btn-sm" data-action="pi-builder">Build with rules</button>
      <button class="btn btn-ghost btn-sm" data-action="pi-direct">Edit JQL directly</button>
      <button class="linklike" data-action="pi-reset-jql">Use built-in query</button>
    </div>
    ${u.builderError ? `<p class="pi-error" role="alert">${esc(u.builderError)}</p>` : ''}
    ${builder ? piBuilderHtml() : ''}
    <label class="field"><span>Query template (JQL)${builder ? ' · generated from rules' : ''}</span><textarea id="piJql" rows="7" spellcheck="false" class="pi-template"${builder ? ' readonly' : ''}>${esc(tpl)}</textarea></label>
    <p class="panel-sub">This template runs once for each report member. Click a placeholder to insert it in direct JQL mode. Date limits include the entire final day; the test shows the expanded query.</p>
    ${piPlaceholderTableHtml(range)}
    <div id="piValidation" aria-live="polite">${piValidationHtml(validation)}</div>
    <div class="settings-save-bar">
      <span id="piDraftStatus" role="status">${dirty ? 'Unsaved changes' : state.settings.piJql ? 'Saved · custom team query' : 'Built-in query'}</span>
      <button class="btn btn-primary btn-sm" id="piSave" data-action="pi-save"${validation.errors.length || !dirty ? ' disabled' : ''}>Save changes</button>
      <button class="btn btn-ghost btn-sm" data-action="pi-discard">Discard</button>
    </div>`;
}

function piPrefixHtml(period) {
  const prefix = state.settings.piPrefix || '';
  return `<label class="field"><span>File name prefix</span><input data-setting="piPrefix" placeholder="TEAM" maxlength="40" value="${esc(prefix)}" autocomplete="off"></label>
    <p class="panel-sub">Download name: <b>${esc((prefix || PI_DEFAULT_PREFIX) + ' - JIRA - ' + piPeriodWords(period) + '.xlsx')}</b></p>`;
}

function piTestPanelHtml(period, validation) {
  const u = piEditorUi;
  const periods = [];
  for (let i = -6; i <= 6; i++) {
    const p = PI_PERIODS.shift(period, i);
    periods.push(`<option value="${p}"${p === period ? ' selected' : ''}>${esc(piLabel(p))}</option>`);
  }
  const members = state.members.map(m => `<option value="${esc(m.id)}"${m.id === u.member ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  return `<section class="panel"><h3>Test the current draft</h3>
    <p class="panel-sub">Test without saving. JIRA checks the query and returns the matching ticket count using your connected account's permissions.</p>
    <div class="pi-editor-grid">
      <label class="field"><span>Team member</span><select id="piPreviewMember"><option value="">Choose a member…</option>${members}</select></label>
      <label class="field"><span>Test period</span><select id="piPreviewPeriod">${periods.join('')}</select></label>
    </div>
    <button class="btn btn-primary btn-sm" id="piTest" data-action="pi-preview"${u.testing || validation.errors.length ? ' disabled' : ''}>${u.testing ? 'Testing…' : 'Test query'}</button>
    <div id="piTestResult" aria-live="polite">${piTestResultHtml()}</div></section>`;
}

function piEditorPanel() {
  const tpl = piEditorDraft();
  const period = piEditorPeriod();
  const range = PI_PERIODS.range(period);
  const validation = PiQuery.validate(tpl);
  return `<section class="panel pi-editor"><h3>Performance report</h3>
    ${piPeriodLengthHtml()}
    ${piMembersHtml()}
    ${piConverterHtml()}
    ${piTemplateHtml(tpl, validation, range)}
    ${piPrefixHtml(period)}
  </section>${piTestPanelHtml(period, validation)}`;
}

/** Options from JIRA plus whatever a rule already uses, so loading never drops a saved value. */
function piRuleChoices(r, opts) {
  const projects = opts.projects.concat(r.projects
    .filter(p => !opts.projects.some(o => o.value === p || o.name === p))
    .map(p => ({ value: p, name: p })));
  const fields = opts.fields.concat(opts.fields.some(f => f.value === r.field) ? [] : [{ value: r.field, name: r.field }]);
  const statuses = [...new Set(opts.statuses.concat(r.category ? [] : [r.status]))];
  return { projects, fields, statuses };
}

function piRuleHtml(r, i, opts) {
  const c = piRuleChoices(r, opts);
  const projects = c.projects.map(p => {
    const selected = r.projects.includes(p.value) || r.projects.includes(p.name);
    return `<option value="${esc(p.value)}"${selected ? ' selected' : ''}>${esc(p.name)}${p.name !== p.value ? ' (' + esc(p.value) + ')' : ''}</option>`;
  }).join('');
  const statuses = c.statuses.map(s => `<option value="${esc(s)}"${!r.category && r.status === s ? ' selected' : ''}>${esc(s)}</option>`).join('');
  const fields = c.fields.map(f => `<option value="${esc(f.value)}"${f.value === r.field ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
  return `<fieldset class="pi-rule"><legend>Rule ${i + 1}${i ? ' · OR' : ''}</legend><div class="pi-editor-grid">
      <label class="field"><span>Projects (Ctrl / Cmd to pick several; none means all)</span><select multiple size="4" data-pi-rule="${i}" data-pi-part="projects">${projects}</select></label>
      <label class="field"><span>Completion status</span><select data-pi-rule="${i}" data-pi-part="status"><option value="@category"${r.category ? ' selected' : ''}>Any Done-category status</option>${statuses}</select></label>
      <label class="field"><span>Counted by</span><select data-pi-rule="${i}" data-pi-part="field">${fields}</select></label>
    </div>
    <button class="linklike" data-action="pi-rule-remove" data-index="${i}"${piEditorUi.rules.length === 1 ? ' disabled' : ''}>Remove rule</button></fieldset>`;
}

function piBuilderHtml() {
  const u = piEditorUi;
  const opts = u.options || { projects: [], statuses: [], fields: [{ value: 'resolutionDate', name: 'Resolved date' }] };
  return `<div class="pi-builder">
    <p class="panel-sub">Every rule requires the member and status, and counts dates inside the selected period. Rules are joined with OR.</p>
    <button class="btn btn-ghost btn-sm" data-action="pi-options"${u.loading ? ' disabled' : ''}>${u.loading ? 'Loading…' : 'Load projects, statuses and date fields from JIRA'}</button>
    ${u.optionsError ? `<p class="pi-error">${esc(u.optionsError)}</p>` : ''}
    ${u.rules.map((r, i) => piRuleHtml(r, i, opts)).join('')}
    <button class="btn btn-ghost btn-sm" data-action="pi-rule-add">+ Add rule</button></div>`;
}

const PI_CONVERTER_INPUTS = { piSource: 'source', piConvertAccount: 'account', piConvertStart: 'start', piConvertEnd: 'end' };

/** input events; true when handled. */
function piEditorInput(t) {
  const u = piEditorUi;
  if (t.id === 'piJql') {
    u.mode = 'jql';
    piEditorSet(t.value);
    return true;
  }
  const key = PI_CONVERTER_INPUTS[t.id];
  if (!key) return false;
  u[key] = t.value;
  u.conversion = null;
  const btn = document.querySelector('[data-action="pi-use-conversion"]');
  if (btn) btn.disabled = true;
  return true;
}

/** A rule select changed: regenerate the template in place, keeping the selects (and focus). */
function piRuleChange(t) {
  const r = piEditorUi.rules[Number(t.dataset.piRule)];
  if (!r) return;
  const part = t.dataset.piPart;
  if (part === 'projects') r.projects = Array.from(t.selectedOptions).map(o => o.value);
  else if (part === 'status') {
    r.category = t.value === '@category';
    r.status = r.category ? 'Done' : t.value;
  } else if (part === 'field') r.field = t.value;
  piEditorSet(PiQuery.build(piEditorUi.rules));
  const textarea = document.getElementById('piJql');
  if (textarea) textarea.value = piEditorUi.draft;
}

/** change events; true when handled. */
function piEditorChange(t) {
  if (piEditorInput(t)) return true;
  if (t.id === 'piPreviewMember' || t.id === 'piPreviewPeriod') {
    piEditorUi[t.id === 'piPreviewMember' ? 'member' : 'period'] = t.value;
    piEditorInvalidate();
    render();
    return true;
  }
  if (t.dataset.piRule === undefined) return false;
  piRuleChange(t);
  return true;
}

async function piEditorSave() {
  if (!canAdmin()) return;
  if (PiQuery.validate(piEditorDraft()).errors.length) { piEditorFeedback(); return; }
  state.settings.piJql = piTemplateToSave(piEditorUi.draft);
  piEditorUi.base = state.settings.piJql || PI_DEFAULT_TEMPLATE;
  piUi.reports = {};
  saveState({ quiet: true });
  render();
  await persistNow();
  piEditorFeedback();
}

function piEditorDiscard() {
  piEditorUi.draft = null;
  piEditorInvalidate();
  piEditorDraft();
  render();
  renderSaveStatus();
}

function piEditorAnalyze() {
  const u = piEditorUi;
  try {
    const c = PiQuery.candidates(u.source);
    u.account = c.accounts.length === 1 ? c.accounts[0] : '';
    u.start = c.dates[0] || '';
    u.end = c.dates.at(-1) || '';
    u.convertError = c.accounts.length > 1 ? 'Several assignees found. Choose the one to replace.' : '';
  } catch (e) {
    u.convertError = e.message;
  }
  u.conversion = null;
  render();
}

function piEditorConvert() {
  const u = piEditorUi;
  try {
    u.conversion = { ...PiQuery.convert(u.source, u.account, u.start, u.end), original: u.source };
    u.convertError = '';
  } catch (e) {
    u.convertError = e.message;
    u.conversion = null;
  }
  render();
}

function piEditorUseConversion() {
  if (!piEditorUi.conversion) return;
  piEditorUi.mode = 'jql';
  piEditorSet(piEditorUi.conversion.template);
  piEditorUi.rules = PiQuery.parse(piEditorUi.draft) || [];
  render();
}

function piEditorBuilder() {
  const rules = PiQuery.parse(piEditorDraft());
  if (!rules) {
    piEditorUi.builderError = 'This query has conditions the builder cannot represent. Your JQL is preserved; continue with Edit JQL directly.';
    render();
    return;
  }
  piEditorUi.builderError = '';
  piEditorUi.rules = rules;
  piEditorUi.mode = 'builder';
  render();
}

function piEditorDirect() {
  piEditorUi.builderError = '';
  piEditorUi.mode = 'jql';
  render();
}

/** Inserts a placeholder at the cursor (switching to direct JQL) and puts the cursor after it. */
function piEditorInsert(el) {
  const ph = el.dataset.placeholder;
  const draft = piEditorDraft();
  const textarea = document.getElementById('piJql');
  const a = textarea ? textarea.selectionStart : draft.length;
  const b = textarea ? textarea.selectionEnd : a;
  piEditorUi.mode = 'jql';
  piEditorSet(draft.slice(0, a) + ph + draft.slice(b));
  render();
  const next = document.getElementById('piJql');
  if (next) {
    next.focus();
    next.setSelectionRange(a + ph.length, a + ph.length);
  }
}

function piEditorAddRule() {
  if (piEditorUi.rules.length >= PI_MAX_RULES) { toast('Use at most 20 rules', 'error'); return; }
  piEditorUi.rules.push({ projects: [], category: false, status: 'Done', field: 'resolutionDate' });
  piEditorSet(PiQuery.build(piEditorUi.rules));
  render();
}

function piEditorRemoveRule(el) {
  if (piEditorUi.rules.length <= 1) return;
  piEditorUi.rules.splice(Number(el.dataset.index), 1);
  piEditorSet(PiQuery.build(piEditorUi.rules));
  render();
}

async function piEditorOptions() {
  piEditorUi.loading = true;
  piEditorUi.optionsError = '';
  render();
  try {
    piEditorUi.options = await kpiFetch('/api/pi/options');
  } catch (e) {
    piEditorUi.optionsError = e.message;
  }
  piEditorUi.loading = false;
  render();
}

/** Tests the current draft; a result is kept only if nothing changed while JIRA answered. */
async function piEditorTest() {
  const u = piEditorUi;
  piEditorDraft();
  if (!u.member) { u.error = 'Choose a team member first.'; render(); return; }
  if (PiQuery.validate(u.draft).errors.length) { piEditorFeedback(); return; }
  const request = ++u.request;
  const template = u.draft;
  const person = u.member;
  const period = piEditorPeriod();
  u.result = null;
  u.error = '';
  u.testing = true;
  render();
  try {
    const result = await kpiFetch('/api/pi/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template, person, period }),
    });
    if (request === u.request && template === u.draft && person === u.member && period === piEditorPeriod()) u.result = result;
  } catch (e) {
    if (request === u.request) u.error = e.message;
  } finally {
    if (request === u.request) {
      u.testing = false;
      render();
    }
  }
}
