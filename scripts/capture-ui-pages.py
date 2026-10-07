"""Capture README screenshots with synthetic data and no running app server.

Run: python scripts/capture-ui-pages.py
Requires Playwright for Python and a Chromium browser (installed Chrome is used
on Windows). Every request is intercepted; no real account, database, or JIRA
site is accessed.
"""

from pathlib import Path
from urllib.parse import urlparse
import mimetypes

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
OUTPUT = ROOT / "docs" / "screenshots"
OUTPUT.mkdir(parents=True, exist_ok=True)

SEED = r"""() => {
  localStorage.setItem('dailyscrum.setup-hidden.v1', '1');
  const today = todayISO();
  const month = shiftMonth(today.slice(0, 7), -1);
  window.demoMonth = month;
  ui.date = today;
  ui.month = month;
  ui.histMonth = month;
  ui.histSel = month + '-23';
  ui.boardView = 'cards';
  ui.sprintMode = 'board';
  ui.compact = true;

  state.members = [
    ['Andi Wijaya', 'Backend Engineer'],
    ['Sari Putri', 'Frontend Engineer'],
    ['Rizky Pratama', 'Backend Engineer'],
    ['Dewi Lestari', 'QA Engineer'],
    ['Budi Santoso', 'Product Designer'],
    ['Rina Aprilia', 'Frontend Engineer']
  ].map(([name, role], i) => ({
    id: 'm' + i, name, role, email: 'person' + i + '@example.test',
    color: PALETTE[i], lead: ''
  }));

  const notes = [
    ['Completed payment retry handling.', 'Write integration tests for retries.', ''],
    ['Finished the account settings form.', 'Connect the form to the new API.', 'Waiting for API credentials.'],
    ['Reviewed the reconciliation service.', 'Fix edge cases in the import job.', ''],
    ['Verified the sprint release candidate.', 'Test the updated report filters.', ''],
    ['Prepared the report layout.', 'Polish mobile spacing and icons.', ''],
    ['', '', '']
  ];
  const entries = {};
  state.members.forEach((member, i) => {
    entries[member.id] = {
      attendance: i === 5 ? 'leave' : i === 3 ? 'late' : 'present',
      yesterday: notes[i][0], today: notes[i][1], blockers: notes[i][2]
    };
  });
  const issues = Array.from({ length: 18 }, (_, i) => {
    const owner = Math.floor(i / 3);
    const category = ['indeterminate', 'new', 'done'][i % 3];
    return {
      key: 'DEMO-' + (4201 + i),
      summary: [
        'Complete payment retry handling',
        'Improve dashboard loading state',
        'Verify monthly attendance export',
        'Update transaction reconciliation',
        'Review JIRA report filters',
        'Prepare sprint release notes'
      ][owner],
      status: { new: 'To Do', indeterminate: 'In Progress', done: 'Done' }[category],
      statusCategory: category,
      url: 'https://example.test/issue/' + (4201 + i),
      assignee: { email: state.members[owner].email, name: state.members[owner].name }
    };
  });
  const sprint = { name: 'Demo Sprint 42', state: 'active', start: month + '-16', end: today };
  state.days[today] = {
    startedAt: today + 'T01:00:00Z',
    roster: state.members.map(memberSnapshot),
    entries,
    jira: { issues, sprint, syncedAt: today + 'T02:00:00Z' }
  };
  for (const day of [2, 4, 7, 9, 11, 15, 17, 21, 23, 25]) {
    const date = month + '-' + String(day).padStart(2, '0');
    state.days[date] = {
      startedAt: date + 'T01:00:00Z',
      roster: state.members.map(memberSnapshot),
      entries: Object.fromEntries(state.members.map((member, i) => [member.id, {
        attendance: i === (day % 6) ? 'late' : i === 5 && day % 2 ? 'leave' : 'present',
        yesterday: 'Reviewed project work.',
        today: 'Continue sprint tasks.',
        blockers: i === 1 && day === 23 ? 'Waiting for API credentials.' : ''
      }]))
    };
  }

  state.settings.piJql = "project = DEMO AND assignee = '{assignee}' AND status WAS 'Done' ON '{end}' AND resolutionDate >= '{start}' AND resolutionDate < '{afterEnd}'";
  state.settings.piPrefix = 'DEMO';
  auth = { name: 'Demo Admin', role: 'admin', memberId: 'm0' };
  storageMode = 'server';
  creds.site = 'demo.atlassian.net';
  creds.email = 'admin@example.test';
  creds.hasToken = true;
  leads = [];
  lastSavedState = clone(state);
  lastSavedExtras = saveExtrasKey();

  const tasks = issues.map((issue, i) => ({
    ...issue,
    sprintId: i < 9 ? 1 : 2,
    outcome: i % 5 === 0 ? 'carryover' : 'done',
    points: i % 3 === 0 ? 5 : 3,
    assigneeEmail: issue.assignee.email,
    assigneeName: issue.assignee.name,
    doneAt: i % 5 === 0 ? null : month + '-' + String(i < 9 ? 12 : 25).padStart(2, '0'),
    reason: i % 5 === 0 ? 'Not done when the demo sprint closed.' : 'Reached Done during the demo sprint.'
  }));
  kpiUi.reports[month] = {
    month, months: [month], computedAt: today + 'T02:00:00Z', configured: true,
    sprints: [
      { id: 1, name: 'Demo Sprint 40', state: 'closed', start: month + '-01', end: month + '-14', status: 'ok' },
      { id: 2, name: 'Demo Sprint 41', state: 'closed', start: month + '-15', end: month + '-28', status: 'ok' }
    ],
    tasks
  };

  piUi.period = piDefaultPeriod();
  const range = PiPeriods.range(piUi.period);
  piUi.open = 'm0';
  piUi.reports[piUi.period] = {
    period: piUi.period,
    label: PiPeriods.label(piUi.period),
    start: range.start,
    end: range.end,
    generatedAt: today + 'T02:00:00Z',
    cachedAt: today + 'T02:00:00Z',
    prefix: 'DEMO',
    pointsField: 'customfield_10016',
    you: { name: 'Andi Wijaya' },
    people: state.members.map((member, i) => {
      const rows = Array.from({ length: 6 - (i % 3) }, (_, j) => ({
        key: 'DEMO-' + (4301 + i * 10 + j),
        summary: ['Payment retry flow', 'Account settings', 'Attendance export', 'Transaction import', 'Report filters', 'Release review'][j],
        type: 'Task', status: 'Done', points: j % 2 ? 3 : 5,
        sprint: 'Demo Sprint ' + (38 + j % 3),
        sprintStart: range.start,
        resolved: range.end + 'T08:00:00Z',
        timeSpent: 7200
      }));
      return {
        id: member.id, name: member.name, self: i === 0,
        totals: {
          count: rows.length,
          hours: rows.length * 2,
          points: rows.reduce((sum, row) => sum + row.points, 0)
        },
        rows
      };
    })
  };
  render();
}"""


def main():
    errors = []
    unexpected = []
    with sync_playwright() as playwright:
        chrome = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
        launch = {"headless": True}
        if chrome.is_file():
            launch["executable_path"] = str(chrome)
        browser = playwright.chromium.launch(**launch)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1,
            color_scheme="light",
            reduced_motion="reduce",
            timezone_id="Asia/Jakarta",
        )
        context.add_init_script("localStorage.setItem('dailyscrum.theme.v1', 'light')")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))

        def route(request):
            url = urlparse(request.request.url)
            if url.netloc != "preview.invalid":
                request.abort()
                return
            if url.path == "/api/auth/status":
                request.fulfill(status=404, body="{}")
                return
            if url.path.startswith("/api/"):
                unexpected.append(request.request.url)
                request.abort()
                return
            filename = PUBLIC / (url.path.lstrip("/") or "index.html")
            if filename.is_file():
                request.fulfill(
                    body=filename.read_bytes(),
                    content_type=mimetypes.guess_type(str(filename))[0] or "text/plain",
                )
            else:
                request.fulfill(status=404, body="Not found")

        page.route("**/*", route)
        page.goto("http://preview.invalid/")
        page.wait_for_selector("#app .page-head")
        page.evaluate(SEED)

        captures = [
            ("today", "today", None, ".member-card"),
            ("sprint-board", "sprint", None, ".sprint-board"),
            ("sprint-list", "sprint", None, ".sprint-member"),
            ("history", "history", None, ".hcal-grid"),
            ("attendance-report", "report", None, ".att-grid-panel"),
            ("sprint-delivery-report", "kpi", None, ".kpi-cards"),
            ("performance-report", "pi", None, ".pi-rank"),
            ("settings-team", "settings", "team", ".member-table"),
            ("settings-jira", "settings", "jira", "#setSite"),
        ]
        for filename, view, tab, expected in captures:
            page.evaluate(
                """({view, tab, filename}) => {
                  ui.view = view;
                  if (tab) ui.settingsTab = tab;
                  if (view === 'sprint') ui.sprintMode = filename === 'sprint-list' ? 'list' : 'board';
                  render();
                }""",
                {"view": view, "tab": tab, "filename": filename},
            )
            page.locator(expected).first.wait_for(state="visible")
            if filename == "settings-jira":
                page.locator("#setSite").fill("new-demo.atlassian.net")
                page.locator("#jiraSaveBar").wait_for(state="visible")
            page.screenshot(
                path=str(OUTPUT / (filename + ".png")),
                full_page=True,
                animations="disabled",
            )
            assert page.evaluate(
                "document.documentElement.scrollWidth <= innerWidth"
            ), filename + " has horizontal overflow"
            print(OUTPUT / (filename + ".png"))

        assert not errors, "Browser errors: " + "; ".join(errors)
        assert not unexpected, "Unexpected API requests: " + "; ".join(unexpected)
        browser.close()


if __name__ == "__main__":
    main()
