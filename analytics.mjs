import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

// Anonymous usage counts for the admin panel. Each app install keeps a random id it generated itself; the server only
// stores a salted hash of it, so the stored data cannot be linked back to a person, an IP or a student number.
// Nothing here is ever sent anywhere else.

const PLATFORMS = ['web', 'pwa', 'android-app'];
const SYSTEMS = ['android', 'ios', 'windows', 'macos', 'linux', 'other'];
const BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'samsung', 'brave', 'opera', 'app', 'other'];
const DAY_RETENTION = 180;
const DEVICE_RETENTION_DAYS = 365;
const MAX_DEVICES = 20_000;
const FLUSH_MS = 60_000;

function localDate(date = new Date()) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function daysAgo(amount, from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() - amount);
  return localDate(date);
}

function systemFromAgent(agent) {
  if (/iPhone|iPad|iPod/i.test(agent)) return 'ios';
  if (/Android|Dalvik/i.test(agent)) return 'android';
  if (/Windows/i.test(agent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(agent)) return 'macos';
  if (/Linux|CrOS/i.test(agent)) return 'linux';
  return 'other';
}

function browserFromAgent(agent) {
  if (/Dalvik|okhttp/i.test(agent)) return 'app';
  if (/SamsungBrowser/i.test(agent)) return 'samsung';
  if (/Edg(e|A|iOS)?\//i.test(agent)) return 'edge';
  if (/OPR\/|OPiOS/i.test(agent)) return 'opera';
  if (/Firefox|FxiOS/i.test(agent)) return 'firefox';
  if (/Chrome|CriOS/i.test(agent)) return 'chrome';
  if (/Safari/i.test(agent)) return 'safari';
  return 'other';
}

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

export function createAnalytics({ file, programmes }) {
  let state = load();
  let dirty = false;

  function load() {
    try {
      const loaded = JSON.parse(readFileSync(file, 'utf8'));
      if (loaded && typeof loaded.salt === 'string' && loaded.devices && loaded.days) return loaded;
    } catch { /* first start or unreadable: begin empty */ }
    return { salt: randomBytes(32).toString('hex'), since: new Date().toISOString(), devices: {}, days: {} };
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(state), 'utf8');
      renameSync(`${file}.tmp`, file);
    } catch (error) { dirty = true; console.warn('Analytics could not be saved:', error.message); }
  }

  function prune() {
    const oldestDay = daysAgo(DAY_RETENTION);
    for (const day of Object.keys(state.days)) if (day < oldestDay) delete state.days[day];
    const oldestDevice = daysAgo(DEVICE_RETENTION_DAYS);
    for (const [hash, device] of Object.entries(state.devices)) if (device.last < oldestDevice) delete state.devices[hash];
  }

  // One call per app session (the clients ping on open and after 30 minutes in the background).
  function record(input, userAgent = '') {
    const id = String(input?.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return false;
    const agent = String(userAgent).slice(0, 400);
    const hash = createHash('sha256').update(`${state.salt}:${id}`).digest('hex').slice(0, 20);
    const now = new Date();
    const today = localDate(now);
    const platform = pick(input.platform, PLATFORMS, 'web');
    const os = pick(input.os, SYSTEMS, systemFromAgent(agent));
    const browser = platform === 'android-app' ? 'app' : pick(input.browser, BROWSERS, browserFromAgent(agent));
    const programme = programmes.includes(String(input.programme)) ? String(input.programme) : '';
    const version = /^\d{1,3}(\.\d{1,3}){0,3}$/.test(String(input.version || '')) ? String(input.version) : '';

    let device = state.devices[hash];
    if (!device) {
      if (Object.keys(state.devices).length >= MAX_DEVICES) return false;
      device = state.devices[hash] = { first: today, opens: 0 };
    }
    Object.assign(device, {
      last: today, lastAt: now.toISOString(), platform, os, browser, programme, version,
      personal: Boolean(input.personal), widgets: Math.min(20, Math.max(0, Number(input.widgets) || 0)),
    });
    device.opens += 1;

    const day = state.days[today] ||= { opens: 0, hours: Array(24).fill(0), visitors: {} };
    day.opens += 1;
    day.hours[now.getHours()] += 1;
    const visitor = day.visitors[hash] ||= { o: 0, p: platform, s: os };
    visitor.o += 1; visitor.p = platform; visitor.s = os;

    if (!state.prunedOn || state.prunedOn !== today) { state.prunedOn = today; prune(); }
    dirty = true;
    return true;
  }

  function stats() {
    const now = new Date();
    const today = localDate(now);
    const devices = Object.entries(state.devices);
    const series = Array.from({ length: 30 }, (_, index) => {
      const date = daysAgo(29 - index, now);
      const day = state.days[date];
      const hashes = day ? Object.keys(day.visitors) : [];
      const created = hashes.filter((hash) => state.devices[hash]?.first === date).length;
      return { date, users: hashes.length, opens: day?.opens || 0, new: created, returning: hashes.length - created };
    });
    const uniqueSince = (days) => {
      const seen = new Set();
      for (let index = 0; index < days; index += 1) Object.keys(state.days[daysAgo(index, now)]?.visitors || {}).forEach((hash) => seen.add(hash));
      return seen;
    };
    const week = uniqueSince(7);
    const month = uniqueSince(30);
    const previousWeek = new Set();
    for (let index = 7; index < 14; index += 1) Object.keys(state.days[daysAgo(index, now)]?.visitors || {}).forEach((hash) => previousWeek.add(hash));
    const retained = [...previousWeek].filter((hash) => week.has(hash)).length;

    // Breakdowns use each device's latest state, counted over the last 30 days.
    const active = devices.filter(([hash]) => month.has(hash)).map(([, device]) => device);
    const tally = (key) => Object.entries(active.reduce((counts, device) => {
      const value = typeof key === 'function' ? key(device) : device[key];
      if (value) counts[value] = (counts[value] || 0) + 1;
      return counts;
    }, {})).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));

    // Opens per weekday (Mon = 0) and hour over the last four weeks.
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (let index = 0; index < 28; index += 1) {
      const date = daysAgo(index, now);
      const day = state.days[date];
      if (!day) continue;
      const weekday = (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
      day.hours.forEach((count, hour) => { heat[weekday][hour] += count; });
    }

    const recentCutoff = now.getTime() - 15 * 60_000;
    const last30Opens = series.reduce((sum, day) => sum + day.opens, 0);
    const last30UserDays = series.reduce((sum, day) => sum + day.users, 0);
    const todayEntry = series.at(-1);
    const yesterdayEntry = series.at(-2);
    return {
      generatedAt: now.toISOString(),
      since: state.since,
      today: { ...todayEntry, date: today },
      yesterday: yesterdayEntry,
      activeNow: devices.filter(([, device]) => new Date(device.lastAt).getTime() >= recentCutoff).length,
      wau: week.size,
      mau: month.size,
      dauAverage: Math.round((last30UserDays / 30) * 10) / 10,
      stickiness: month.size ? Math.round((last30UserDays / 30 / month.size) * 100) : 0,
      opensPerUser: last30UserDays ? Math.round((last30Opens / last30UserDays) * 10) / 10 : 0,
      weeklyRetention: previousWeek.size ? Math.round((retained / previousWeek.size) * 100) : null,
      totalDevices: devices.length,
      series,
      heat,
      origins: tally((device) => `${device.platform}|${device.os}`),
      platforms: tally('platform'),
      systems: tally('os'),
      browsers: tally('browser'),
      programmes: tally('programme'),
      versions: tally((device) => (device.version ? `${device.platform === 'android-app' ? 'Android' : 'Splet'} ${device.version}` : '')),
      personal: active.filter((device) => device.personal).length,
      widgets: active.filter((device) => device.widgets > 0).length,
    };
  }

  const timer = setInterval(flush, FLUSH_MS);
  timer.unref();
  return { record, stats, flush };
}
