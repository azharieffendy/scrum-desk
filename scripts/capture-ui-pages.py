"""Capture README screenshots with synthetic data and no running app server.

Run: python scripts/capture-ui-pages.py [name ...]
(names limit the run to those captures, e.g. settings-backup)
Requires Playwright for Python and a Chromium browser (installed Chrome is used
on Windows). Every request is intercepted; no real account, database, or JIRA
site is accessed.
"""

from pathlib import Path
from urllib.parse import urlparse
import mimetypes
import sys

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
        blockers: i === 1 && day >= 21 ? 'Waiting for API credentials.'
          : i === 2 && day === 25 ? 'Staging database is read-only.'
          : i === 3 && (day === 9 || day === 11) ? 'Test devices unavailable.'
          : i === 4 && day === 15 ? 'Waiting for brand assets.' : ''
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
  // delivery trend: eight demo sprints, two per month, ending with the two above
  const trendDone = [9, 11, 8, 12, 10, 13, 11, 12];
  const trendCarry = [3, 2, 4, 1, 3, 2, 2, 3];
  kpiUi.trend.data = {
    sprints: trendDone.map((done, i) => {
      const m = shiftMonth(month, Math.floor(i / 2) - 3);
      const carryover = trendCarry[i];
      return {
        id: i - 5, name: 'Demo Sprint ' + (34 + i), state: 'closed', month: m,
        start: m + (i % 2 ? '-15' : '-01'), end: m + (i % 2 ? '-28' : '-14'),
        closedAt: m + (i % 2 ? '-28' : '-14') + 'T10:00:00Z', computedAt: today + 'T02:00:00Z',
        done, carryover, open: 0, excluded: 1, spDone: done * 3 + 2, spCarryover: carryover * 3, spOpen: 0,
        completion: done / (done + carryover)
      };
    })
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

# The full backup panel is server-only: show it as an admin would see it on the
# server itself, with a checked demo backup under review. No request is made.
BACKUP_SEED = r"""() => {
  storageMode = 'server';
  auth.role = 'admin';
  window.fullBackupInsecure = () => false;
  const made = new Date(Date.now() - 3 * 86400000).toISOString();
  fullBackup.status = { lastRestore: null };
  fullBackup.review = {
    id: 'demo', createdAt: made, createdBy: 'admin', appVersion: '1.0.0',
    gitCommit: 'f078b51d0c2e', currentVersion: '1.0.0',
    included: ['database', 'configuration', 'application'], appFiles: 64,
    envKeys: ['PORT', 'TZ', 'JIRA_SITE'],
    accounts: [{ username: 'admin', role: 'admin' }, { username: 'viewer', role: 'viewer' }],
    warnings: ['Configuration values (PORT, TZ, JIRA_SITE) are in the backup but are not changed by this restore; apply them in docker-compose.yml if needed.'],
    replaces: [
      'The whole current database: accounts and passwords, settings, JIRA credentials, notes, team data and report history.',
      'Everyone is signed out and signs in again with the accounts from the backup.'
    ],
    keeps: [
      'A copy of the current database, saved in data/backups/ before it is replaced.',
      'The application files, Docker setup and environment values (restore those separately — see RESTORE.txt in the backup).'
    ],
    tables: [
      { name: 'days', current: 42, backup: 40 },
      { name: 'members', current: 6, backup: 6 },
      { name: 'settings', current: 9, backup: 9 },
      { name: 'users', current: 2, backup: 2 }
    ]
  };
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
            ("blockers-report", "blockers", None, ".blocker-open-list"),
            ("settings-team", "settings", "team", ".member-table"),
            ("settings-jira", "settings", "jira", "#setSite"),
            ("settings-backup", "settings", "data", ".backup-review"),
        ]
        wanted = set(sys.argv[1:])
        unknown = wanted - {c[0] for c in captures}
        assert not unknown, "Unknown captures: " + ", ".join(sorted(unknown))
        for filename, view, tab, expected in captures:
            if wanted and filename not in wanted:
                continue
            if filename == "settings-backup":
                page.evaluate(BACKUP_SEED)
            page.evaluate(
                """({view, tab, filename}) => {
                  ui.view = view;
                  if (tab) ui.settingsTab = tab;
                  if (view === 'blockers') ui.blockerAll = true;
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
