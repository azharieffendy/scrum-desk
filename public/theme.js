/* Personal appearance preference; kept outside shared board data. */
'use strict';

/* Browser data saved before the rename to Scrum Desk used "dailyscrum." keys; move it
   once, before any script reads its key (this file loads first). */
const STORAGE_KEYS = ['state.v1', 'creds.v1', 'migration-pending.v1', 'compact.v1', 'boardview.v1', 'sprintMode.v1', 'setup-hidden.v1', 'theme.v1'];
(function moveLegacyStorage() {
  for (const name of STORAGE_KEYS) {
    try {
      const old = localStorage.getItem('dailyscrum.' + name);
      if (old === null) continue;
      if (localStorage.getItem('scrumdesk.' + name) === null) localStorage.setItem('scrumdesk.' + name, old);
      localStorage.removeItem('dailyscrum.' + name);
    } catch (_) { /* storage blocked or full: keep the old key for next time */ }
  }
})();

const THEME_KEY = 'scrumdesk.theme.v1';
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch (_) { return null; }
}

function updateThemeButtons() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.querySelectorAll('[data-action="theme"]').forEach((button) => {
    const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(dark));
    button.textContent = dark ? '☀ Light' : '☾ Dark';
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  updateThemeButtons();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* private storage */ }
  applyTheme(next);
}

applyTheme(savedTheme() || (themeMedia.matches ? 'dark' : 'light'));
themeMedia.addEventListener('change', (event) => {
  if (!savedTheme()) applyTheme(event.matches ? 'dark' : 'light');
});
