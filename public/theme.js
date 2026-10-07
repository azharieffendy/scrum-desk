/* Personal appearance preference; kept outside shared board data. */
'use strict';

const THEME_KEY = 'dailyscrum.theme.v1';
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
