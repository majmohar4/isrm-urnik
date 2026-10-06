import { APP_VERSION } from './version.js';

// Anonymous session count (see /privacy): a random install id, the kind of app and device, the chosen year.
// Sent on every open and every return to the app; the server merges duplicates a few seconds apart.
const ID_KEY = 'isrm-install-id';

function installId() {
  let id = window.localStorage.getItem(ID_KEY);
  if (!/^[a-f0-9]{32}$/.test(id || '')) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    window.localStorage.setItem(ID_KEY, id);
  }
  return id;
}

function deviceSystem() {
  const agent = navigator.userAgent;
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  if (/iPhone|iPad|iPod/i.test(agent) || (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(agent)) return 'android';
  if (/Windows/i.test(agent)) return 'windows';
  if (/Macintosh/i.test(agent)) return 'macos';
  if (/Linux|CrOS/i.test(agent)) return 'linux';
  return 'other';
}

export function pingSession({ programme, personal }) {
  try {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || Boolean(navigator.standalone);
    const body = JSON.stringify({
      id: installId(),
      platform: standalone ? 'pwa' : 'web',
      os: deviceSystem(),
      browser: navigator.brave ? 'brave' : undefined,
      programme,
      personal: Boolean(personal),
      version: APP_VERSION,
    });
    fetch('/api/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
  } catch { /* storage unavailable: not counted */ }
}
