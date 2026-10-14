# Changelog

Everything added, changed or fixed in Scrum Desk, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no tagged releases yet,
so entries are grouped by the day they landed on `main`; work that is not merged yet sits
under **Unreleased**.

## Unreleased

### Changed

- **Reports keep their own month** — Attendance, Sprint delivery and Blockers each remember
  the month you picked on that page. Changing the month on one no longer moves the others;
  a page you have not touched shows the running month.
- **Picked months last one sign-in** — signing out (also idle sign-out and an expired
  session) returns every report page to the running month and drops `month` from the address.

## 2026-10-09

### Added

- **Idle sign-out** — sessions record when they were last used and the server rejects any
  that sat idle longer than the admin-set timeout (default 5 minutes, 0 = off, max 480).
  The browser reports real user activity, shows a "Still there?" warning before signing out,
  and activity in another tab keeps the session alive.
- **Settings → Users → Idle sign-out** — admins set the timeout; changing it restarts the
  countdown of live sessions instead of signing everyone out.

### Changed

- The session cookie is now a browser-session cookie (no `Max-Age`).
- Signed-out users get 401 from admin routes and return to the login screen.

### Security

- Wrong current passwords on a password change are rate-limited.

## 2026-10-08

### Added

- **Blocker tracking** — an unresolved blocker from the last standup comes back on today's
  card and sheet row as **Still blocked? / Resolved**. Carried blockers show an age badge in
  standup days (amber from 2, red from 3), and copied standup notes add
  "(blocked N standup days)".
- **Reports → Blockers** — open blockers oldest first plus a blocker log per month and
  member, scoped to a Technical Lead's team, with Excel export.
- **Full encrypted backup and restore** — Settings → Data & backup lets admins download one
  password-protected file (AES-256-GCM, scrypt key) and restore the database from it after a
  checked review that needs `RESTORE` typed to confirm. The current database is saved to
  `data/backups/` before the swap.
- **Offline recovery tool** — `scripts/restore-backup.js` (inspect, restore-db, extract).
- **KPI delivery trend** — a line chart of completion and story points delivered per computed
  sprint on the whole-team Sprint delivery page, windowed up to the selected month or the
  latest sprints (last 6 / 12 / all). Points open their month.
- **Performance report query editor** — paste a working JIRA query and convert its assignee
  and dates into placeholders, build rules (projects, completion status, date field) from
  JIRA, edit a draft with explicit Save / Discard, and test it against JIRA for one member
  and period.
- **Attendance status menu on Today** — a status pill with a keyboard-friendly menu on roll
  call, member cards and sheet rows; Present shows its pill too.
- **Day report Excel export** — download one standup day as a workbook.

### Changed

- **Renamed Daily Scrum to Scrum Desk** with a new icon; the meeting itself is called the
  standup. Existing installs keep working: `data/daily-scrum.db` is renamed to
  `scrum-desk.db` on start, old `.dsbackup` files still restore, and `dailyscrum.*` browser
  keys move to `scrumdesk.*`.
- The Sprint view lists only tickets assigned to team members; Today orders tickets
  consistently.
- `docker-compose.yml` uses `restart: unless-stopped` so the app comes back after a restore.
- Team JSON export is labelled "Export team data".

### Fixed

- `{end}` in the Performance report query now includes the whole final day, so tickets
  resolved on the last day of a period are no longer dropped.
- An open attendance menu is forgotten on Back / Forward and when its pill leaves the page.

## 2026-10-07

### Added

- **First version** — a self-hosted standup board in one Docker container: Today board,
  Sprint view, History, monthly attendance, Sprint delivery (KPI) and Performance reports,
  JIRA Cloud sync, and role-based users (Admin, Technical Lead, Viewer) on a SQLite database.

### Security

- Hashed session tokens, per-user and per-IP sign-in limits, a password policy (10+
  characters with upper, lower, number and special character), JIRA refresh by `POST` only,
  and Technical Leads cannot claim other identities.
