// site.js — page boilerplate shared by every tool: theme toggle, service worker, small helpers.
// The builder does not edit this file; tool code lives in app.js.

const root = document.documentElement;
const THEME_KEY = 'theme';

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* storage may be unavailable */ }

const toggle = document.getElementById('theme-toggle');
if (toggle) {
  toggle.addEventListener('click', () => {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const current = root.getAttribute('data-theme') || (systemDark ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  });
}

// Service worker: makes the page work offline after the first visit (and installable as a PWA).
const status = document.getElementById('sw-status');
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller && status) status.textContent = 'Update ready: reload to get the latest version.';
        });
      });
      // Only claim offline readiness once a worker is actually active (install succeeded).
      navigator.serviceWorker.ready.then(() => { if (status && !navigator.serviceWorker.controller) status.textContent = 'Ready to work offline.'; });
    } catch (err) {
      console.warn('service worker registration failed', err);
    }
  });
}

// Tiny helpers tools can import: `import { toast, downloadBlob, formatBytes } from './site.js'`
export function toast(message, ms = 2400) {
  document.querySelectorAll('.toast').forEach((t) => t.remove()); // one toast at a time, never overlapping
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function wireDropzone(zone, input, onFiles) {
  if (!zone || !input) return;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { stop(e); zone.classList.add('is-dragover'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { stop(e); zone.classList.remove('is-dragover'); }));
  zone.addEventListener('drop', (e) => { const files = [...(e.dataTransfer?.files || [])]; if (files.length) onFiles(files); });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { const files = [...input.files]; input.value = ''; if (files.length) onFiles(files); });
}
