"""Optional UI regression check: python3 tests/ui-browser.py
Requires Python Playwright and its Chromium browser. Uses only synthetic data;
all requests are intercepted, with no server, database, or external network.
Screenshots are written under /tmp/daily-scrum-ui-check.
"""
from pathlib import Path
from urllib.parse import urlparse
import json
import mimetypes
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1] / 'public'
OUT = Path('/tmp/daily-scrum-ui-check')
OUT.mkdir(exist_ok=True)

SEED = """() => {
  localStorage.setItem(LS_SETUP_HIDDEN, '1');
  state.members = ['Andi Wijaya', 'Sari Putri', 'Muhammad Rizky Pratama', 'Dewi Lestari', 'Budi Santoso', 'Rina Aprilia'].map((name, i) => ({
    id: 'm' + i, name, role: i % 2 ? 'Frontend Engineer' : 'Backend Engineer',
    email: 'person' + i + '@example.test', color: PALETTE[i], lead: 'lead1'
  }));
  const entries = {};
  state.members.forEach((m, i) => entries[m.id] = {
    attendance: i === 5 ? 'leave' : i === 3 ? 'late' : 'present',
    yesterday: i === 5 ? '' : 'Completed API integration and reviewed pull requests.',
    today: i === 5 ? '' : 'Finish transaction retry handling and prepare integration tests.',
    blockers: i === 1 ? 'Waiting for API credentials from the platform team.' : ''
  });
  const issues = Array.from({length: 24}, (_, i) => ({
    key: 'SCRUM-' + (4100 + i), summary: 'Implement transaction reconciliation and validation for the payment gateway',
    status: i % 3 === 0 ? 'To Do' : i % 3 === 1 ? 'In Progress' : 'Done',
    statusCategory: ['new', 'indeterminate', 'done'][i % 3], url: 'https://example.test/issue',
    assignee: {email: 'person' + Math.floor(i / 4) + '@example.test', name: state.members[Math.floor(i / 4)].name}
  }));
  state.days[ui.date] = {startedAt: new Date().toISOString(), roster: state.members, entries,
    jira: {issues, syncedAt: new Date().toISOString(), sprint: {name: 'Demo Sprint 42', end: ui.date}}};
  state.settings.piJql = 'project = DEMO';
  state.settings.piPrefix = 'DEMO';
  leads = [{id: 'lead1', name: 'Team Demo', role: 'lead'}];
  auth = {name: 'Review Admin', role: 'admin'};
  storageMode = 'server';
  creds.site = 'example.test';
  lastSavedState = clone(state); lastSavedExtras = saveExtrasKey();
  window.reviewKpi = {month: ui.month, months: [ui.month], computedAt: new Date().toISOString(), configured: true,
    sprints: [{id: 1, name: 'Demo sprint', state: 'closed', start: ui.month + '-01', end: ui.date, status: 'ok'}],
    tasks: issues.map((t, i) => ({...t, sprintId: 1, outcome: i % 2 ? 'carryover' : 'done',
      points: 3, assigneeEmail: t.assignee.email, assigneeName: t.assignee.name, doneAt: ui.date, reason: 'Synthetic test task'}))};
  kpiUi.reports[ui.month] = window.reviewKpi;
  piUi.period = piDefaultPeriod();
  piUi.reports[piUi.period] = {period: piUi.period, label: 'Demo PI report', start: ui.month + '-01', end: ui.date,
    generatedAt: new Date().toISOString(), pointsField: 'customfield_10016', people: state.members.map(m => ({
      id: m.id, name: m.name, totals: {count: 1, hours: 2, points: 3},
      rows: [{key: 'DEMO-1', summary: 'Synthetic report task', type: 'Task', status: 'Done', points: 3, sprint: 'Demo sprint'}]
    }))};
  render();
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors, writes = [], []
    control = {'fail_save': False, 'server_boot': False}
    server_fixture = {}
    kpi_fixture = {}
    page.on('pageerror', lambda error: errors.append(str(error)))

    def route(request):
        url = urlparse(request.request.url)
        if url.netloc != 'scrum.test':
            request.abort()
            return
        if control['server_boot']:
            if url.path == '/api/auth/status':
                request.fulfill(json={'authenticated': True, 'needsSetup': False, 'user': {'name': 'Test Admin', 'role': 'admin'}})
                return
            if url.path == '/api/state' and request.request.method == 'GET':
                request.fulfill(json=server_fixture)
                return
            if url.path == '/api/jira':
                request.fulfill(status=400, json={'error': 'Missing JIRA credentials'})
                return
            if url.path == '/api/events':
                request.abort()
                return
        if url.path == '/api/state' and request.request.method == 'PUT':
            writes.append(request.request.post_data_json)
            request.fulfill(status=503 if control['fail_save'] else 200,
                            json={'version': len(writes), 'error': 'Synthetic failure'} if control['fail_save'] else {'version': len(writes)})
            return
        if url.path == '/api/kpi':
            request.fulfill(json=kpi_fixture)
            return
        if url.path == '/api/auth/users':
            request.fulfill(json={'users': []})
            return
        filename = ROOT / (url.path.lstrip('/') or 'index.html')
        if filename.is_file():
            request.fulfill(body=filename.read_bytes(), content_type=mimetypes.guess_type(str(filename))[0] or 'text/plain')
        else:
            request.fulfill(status=404, json={})

    def fits(label):
        dims = page.evaluate('({width:innerWidth, scroll:document.documentElement.scrollWidth})')
        if dims['scroll'] > dims['width']:
            page.screenshot(path=str(OUT / 'overflow.png'), full_page=True)
            print(page.evaluate('''() => [...document.querySelectorAll('#app *')].filter(el => {
              const r = el.getBoundingClientRect(); return el.checkVisibility() && (r.right > innerWidth || r.x < 0);
            }).slice(0, 12).map(el => ({tag:el.tagName, cls:el.className, width:el.getBoundingClientRect().width, text:el.textContent.slice(0,80)}))'''))
        assert dims['scroll'] <= dims['width'], (label, dims)

    def menu_fits(selector):
        page.locator(selector + ' > summary').click()
        page.wait_for_function("selector => document.querySelector(selector + ' .dropdown-panel').style.transform !== ''", arg=selector)
        box = page.locator(selector + ' .dropdown-panel').bounding_box()
        assert box and box['x'] >= 0 and box['x'] + box['width'] <= page.viewport_size['width'], (selector, box)
        page.keyboard.press('Escape')

    page.route('**/*', route)
    page.goto('http://scrum.test')
    page.wait_for_selector('.toolbar')
    page.evaluate(SEED)
    kpi_fixture = page.evaluate('window.reviewKpi')

    # Every view fits at phone, tablet, and desktop widths. Wide tables scroll locally.
    for width in [320, 390, 768, 1024, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        for view in ['today', 'sprint', 'history', 'report', 'kpi', 'pi', 'settings']:
            page.evaluate('(view) => { ui.view = view; render(); }', view)
            fits(f'{view} at {width}px')
        page.evaluate("ui.view='today';render()")
        for selector in ['#reportsMenu', '.account-menu', '.day-actions']:
            menu_fits(selector)
        if width in [390, 1440]:
            page.screenshot(path=str(OUT / f'today-{width}.png'), full_page=True)

    # Compact editing saves actual input, preserves text on re-render, and returns focus.
    edit = '[data-action="edit-note"][data-member="m0"][data-field="today"]'
    page.locator(edit).click()
    field = page.locator('textarea[data-member="m0"][data-field="today"]')
    expect(field).to_be_focused()
    field.fill('Updated plan from the keyboard')
    page.evaluate('renderKeepingFocus()')
    expect(field).to_have_value('Updated plan from the keyboard')
    expect(field).to_be_focused()
    page.locator('[data-action="finish-note"]').click()
    expect(page.locator(edit)).to_be_focused()
    expect(page.locator('#saveHint')).to_have_text('All changes saved')
    assert any('Updated plan from the keyboard' in json.dumps(write) for write in writes)
    page.wait_for_timeout(1500)
    expect(page.locator('#saveHint')).to_have_text('All changes saved')

    # Search includes away members, preserves opened tickets, and clears cleanly.
    tickets = page.locator('.member-card[data-member="m0"] details')
    assert not tickets.evaluate('(el) => el.open')  # compact view starts collapsed
    tickets.locator('summary').click()
    page.wait_for_function("ui.ticketExpansion.get(JSON.stringify([ui.date, 'm0'])) === true")
    page.evaluate('render()')
    expect(tickets).to_have_attribute('open', '')
    page.locator('#memberSearch').fill('Rina')
    expect(page.locator('.member-card:visible')).to_have_count(0)
    expect(page.locator('.away-item:visible')).to_have_count(1)
    page.locator('#memberSearch').fill('Nobody matches')
    expect(page.locator('#memberSearchEmpty')).to_be_visible()
    page.locator('[data-action="clear-member-search"]').click()
    expect(page.locator('#memberSearch')).to_be_focused()
    expect(tickets).to_have_attribute('open', '')
    expect(tickets.locator('a.key').first).to_be_visible()
    page.locator('[data-action="board-density"]').click()
    expect(page.locator('textarea[data-entry]')).to_have_count(15)
    expect(tickets).to_have_attribute('open', '')  # full view expands tickets
    page.locator('[data-action="board-density"]').click()
    assert not tickets.evaluate('(el) => el.open')
    assert page.evaluate("localStorage.getItem('dailyscrum.compact.v1')") == 'true'

    # Ticket filters apply to one member, preserve focus/notes, and leave history alone.
    tickets.locator('summary').click()
    card = page.locator('.member-card[data-member="m0"]')
    expect(card.locator('.ticket-breakdown')).to_have_text('2 To do1 In progress1 Done')
    expect(card.locator('.ticket')).to_have_count(4)
    history_size = page.evaluate('history.length')
    active = card.locator('[data-filter="active"]')
    active.click()
    expect(active).to_be_focused()
    expect(active).to_have_attribute('aria-pressed', 'true')
    expect(card.locator('.ticket')).to_have_count(3)
    expect(page.locator('.member-card[data-member="m1"] .ticket')).to_have_count(4)
    card.locator('[data-filter="done"]').click()
    expect(card.locator('.ticket')).to_have_count(1)
    expect(card.locator('.ticket .key')).to_contain_text('SCRUM-4102')
    page.evaluate('renderKeepingFocus()')
    expect(card.locator('[data-filter="done"]')).to_have_attribute('aria-pressed', 'true')
    expect(tickets).to_have_attribute('open', '')
    assert page.evaluate('history.length') == history_size
    expect(card.locator(edit)).to_have_text('Updated plan from the keyboard')
    card.locator('[data-filter="all"]').click()
    expect(page.locator('[data-action="remove-member"]')).to_have_count(0)
    page.locator('#tabs [data-view="settings"]').click()
    page.locator('[data-tab="team"]').click()
    expect(page.locator('[data-action="remove-member"]').first).to_have_text('Remove')

    # Sprint members start expanded and stay collapsed across re-renders.
    page.locator('#tabs [data-view="sprint"]').click()
    person = page.locator('details[data-sprint-member="m0"]')
    expect(person).to_have_attribute('open', '')
    person.locator('summary').click()
    page.wait_for_function("ui.sprintCollapsed.has('m0')")
    page.evaluate('render()')
    assert not person.evaluate('(el) => el.open')
    person.locator('summary').click()
    expect(person.locator('.ticket').first).to_be_visible()
    toggle_all = page.locator('[data-action="sprint-collapse-all"]')
    expect(toggle_all).to_have_text('Collapse all')
    toggle_all.click()
    expect(page.locator('details[data-sprint-member][open]')).to_have_count(0)
    expect(toggle_all).to_have_text('Expand all')
    expect(toggle_all).to_be_focused()
    person.locator('summary').click()
    expect(toggle_all).to_have_text('Collapse all')  # one open person is enough to collapse
    toggle_all.click()
    expect(page.locator('details[data-sprint-member][open]')).to_have_count(0)
    toggle_all.click()
    expect(page.locator('details[data-sprint-member]:not([open])')).to_have_count(0)
    expect(toggle_all).to_have_text('Collapse all')
    page.locator('#tabs [data-view="today"]').click()

    # Member, own-key and stacked confirmation dialogs trap focus in both directions.
    opener = page.locator('[data-action="edit-member"][data-id="m0"]')
    opener.click()
    expect(page.locator('#app')).to_have_attribute('inert', '')
    for key in ['Tab'] * 12 + ['Shift+Tab'] * 12:
        page.keyboard.press(key)
        assert page.evaluate("!!document.activeElement.closest('#overlay')")
    page.evaluate("void askConfirm({title:'Test confirmation', message:'No data changes', danger:true})")
    expect(page.locator('#overlay')).to_have_attribute('inert', '')
    expect(page.locator('#confirmCancel')).to_be_focused()
    page.keyboard.press('Shift+Tab')
    expect(page.locator('#confirmOk')).to_be_focused()
    page.keyboard.press('Escape')
    assert page.evaluate("!!document.activeElement.closest('#overlay')")
    page.keyboard.press('Escape')
    expect(opener).to_be_focused()
    assert not page.locator('#app').evaluate('(el) => el.inert')
    page.evaluate('openOwnKeyModal()')
    for _ in range(8):
        page.keyboard.press('Tab')
        assert page.evaluate("!!document.activeElement.closest('#keyOverlay')")
    page.keyboard.press('Escape')

    # Report links, mobile dropdowns, and account theme switching use the real actions.
    for view in ['report', 'kpi', 'pi']:
        page.locator('#reportsToggle').click()
        page.locator(f'#reportsMenu [data-view="{view}"]').click()
        assert page.evaluate('ui.view') == view
        expect(page.locator('#reportsToggle')).to_have_class('tab active')
        assert not page.locator('#reportsMenu').evaluate('(el) => el.open')

    # Settings feedback survives navigation; failed saves remain visible and can retry.
    page.locator('#tabs [data-view="settings"]').click()
    page.locator('[data-action="settings-tab"][data-tab="jira"]').click()
    page.locator('[data-setting="jql"]').fill('project = DEMO ORDER BY assignee')
    expect(page.locator('#saveHint')).to_have_text('Unsaved changes')
    page.locator('[data-setting="jql"]').press('Tab')
    expect(page.locator('#saveHint')).to_have_text('All changes saved')
    control['fail_save'] = True
    page.locator('[data-setting="jql"]').fill('project = FAILED')
    page.locator('[data-setting="jql"]').press('Tab')
    expect(page.locator('#saveHint')).to_have_text('Not saved')
    expect(page.locator('#saveBanner')).to_be_visible()
    control['fail_save'] = False
    page.locator('[data-action="retry-save"]').click()
    expect(page.locator('#saveHint')).to_have_text('All changes saved')
    page.locator('#tabs [data-view="today"]').click()
    page.locator('.account-menu > summary').click()
    page.locator('.account-menu [data-action="theme"]').click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    expect(page.locator('.toast.error')).to_have_count(0, timeout=10000)
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / 'today-dark.png'), full_page=True)

    # Viewers get readable notes and retain access to attendance/KPI reports.
    page.evaluate("auth.role='viewer';render()")
    expect(page.locator('[data-action="edit-note"], textarea[data-entry]')).to_have_count(0)
    expect(page.locator('#saveHint')).to_have_text('View only')
    page.locator('#reportsToggle').click()
    expect(page.locator('#reportsMenu [data-view="pi"]')).to_be_hidden()
    expect(page.locator('#reportsMenu [data-view="report"]')).to_be_visible()
    expect(page.locator('#reportsMenu [data-view="kpi"]')).to_be_visible()
    # Share links survive browser Back/Forward, refresh, and direct report deep links.
    page.keyboard.press('Escape')
    page.evaluate("auth.role='admin';render()")
    server_fixture = page.evaluate("({state: clone(state), leads: clone(leads), version: 100, creds: {}, myJira: null})")
    control['server_boot'] = True
    page.locator('#teamFilter').select_option('lead1')
    page.locator('#dateInput').fill('2026-09-28')
    expect(page.locator('#dateInput')).to_have_value('2026-09-28')
    selected_url = page.url
    assert 'team=lead1' in selected_url and 'date=2026-09-28' in selected_url
    page.locator('#tabs [data-view="history"]').click()
    page.go_back()
    expect(page.locator('#dateInput')).to_have_value('2026-09-28')
    expect(page.locator('#teamFilter')).to_have_value('lead1')
    page.go_forward()
    page.wait_for_function("ui.view === 'history'")
    page.go_back()
    page.wait_for_function("ui.view === 'today'")
    page.reload()
    expect(page.locator('#dateInput')).to_have_value('2026-09-28')
    expect(page.locator('#teamFilter')).to_have_value('lead1')
    assert page.url == selected_url
    page.goto('http://scrum.test/?view=report&month=2026-08&team=lead1&date=2026-09-28')
    expect(page.locator('#monthInput')).to_have_value('2026-08')
    assert page.evaluate('ui.team') == 'lead1'
    page.reload()
    expect(page.locator('#monthInput')).to_have_value('2026-08')
    page.goto('http://scrum.test/?view=pi&period=2026-P1')
    page.wait_for_function("ui.view === 'pi' && piUi.period === '2026-P1'")
    page.reload()
    page.wait_for_function("ui.view === 'pi' && piUi.period === '2026-P1'")
    page.goto('http://scrum.test/?view=settings&tab=jira')
    expect(page.locator('[data-setting="jql"]')).to_be_visible()
    page.locator('[data-tab="team"]').click()
    page.go_back()
    expect(page.locator('[data-setting="jql"]')).to_be_visible()
    page.reload()
    expect(page.locator('[data-setting="jql"]')).to_be_visible()
    assert not errors, errors
    print('PASS: responsive views, menus, note saving, search, tickets, modal focus, reports, save retry, themes, viewer access, ticket filters, and URL navigation')
    print('Screenshots:', OUT)
    browser.close()
