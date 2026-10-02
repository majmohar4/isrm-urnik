import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || './data';
const CACHE_FILE = join(DATA_DIR, 'timetable-cache.json');
const CUSTOM_EVENTS_FILE = join(DATA_DIR, 'custom-events.json');
const REFRESH_MS = Math.max(5, Number(process.env.REFRESH_MINUTES || 15)) * 60_000;
const MIN_SOURCE_INTERVAL_MS = Math.max(2, Number(process.env.MIN_REQUEST_INTERVAL_SECONDS || 3)) * 1000;
const PROGRAMME_SOURCES_FILE = process.env.PROGRAMME_SOURCES_FILE || './programme-sources.json';
const DEFAULT_PROGRAMMES = {
  '1': {
    label: '1. letnik',
    friUrl: process.env.FRI_YEAR_1_URL || 'https://urnik.fri.uni-lj.si/timetable/fri-2026_2027-zimski/allocations?group=64611',
    fmfUrl: process.env.FMF_YEAR_1_URL || 'https://urnik.fmf.uni-lj.si/layer_one/42/',
  },
  '2': {
    label: '2. letnik',
    friUrl: process.env.FRI_YEAR_2_URL || 'https://urnik.fri.uni-lj.si/timetable/fri-2026_2027-zimski/allocations?group=64538',
    fmfUrl: process.env.FMF_YEAR_2_URL || 'https://urnik.fmf.uni-lj.si/layer_one/49/',
  },
  '3': {
    label: '3. letnik',
    friUrl: process.env.FRI_YEAR_3_URL || 'https://urnik.fri.uni-lj.si/timetable/fri-2026_2027-zimski/allocations?group=64558',
    fmfUrl: process.env.FMF_YEAR_3_URL || 'https://urnik.fmf.uni-lj.si/layer_one/55/',
  },
};

function loadProgrammes() {
  try {
    const configured = JSON.parse(readFileSync(PROGRAMME_SOURCES_FILE, 'utf8'));
    const entries = Object.entries(configured);
    if (!entries.length || entries.some(([, programme]) => !programme?.label || !programme?.friUrl || !programme?.fmfUrl)) throw new Error('each year needs label, friUrl, and fmfUrl');
    for (const [, programme] of entries) {
      const fri = new URL(programme.friUrl);
      const fmf = new URL(programme.fmfUrl);
      if (fri.protocol !== 'https:' || fmf.protocol !== 'https:' || fri.hostname !== 'urnik.fri.uni-lj.si' || fmf.hostname !== 'urnik.fmf.uni-lj.si' || !fri.pathname.includes('/allocations') || !fmf.pathname.startsWith('/layer_one/')) throw new Error('source URLs must be HTTPS FRI allocation and FMF layer pages');
    }
    return Object.fromEntries(entries);
  } catch (error) {
    console.warn(`Could not load ${PROGRAMME_SOURCES_FILE}; using bundled programme links: ${error.message}`);
    return DEFAULT_PROGRAMMES;
  }
}

const PROGRAMMES = loadProgrammes();
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.majmohar.eu').replace(/\/+$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'isrm-alerts';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';
const APP_VERSION = process.env.APP_VERSION || 'unversioned';
const ANDROID_APP_VERSION = process.env.ANDROID_APP_VERSION || '1.0';
const ANDROID_APK_URL = process.env.ANDROID_APK_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DIST = join(process.cwd(), 'dist');
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const MAX_UPSTREAM_BODY_BYTES = 4 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_CLIENT_STATES = 5_000;
const MAX_CACHED_WEEKS_PER_PROGRAMME = 16;
const RATE_WINDOW_MS = 60_000;
const PRELOAD_WEEKS = Math.min(8, Math.max(1, Number(process.env.PRELOAD_WEEKS || 5)));
const PRELOAD_REFRESH_MS = Math.max(60, Number(process.env.PRELOAD_REFRESH_MINUTES || 360)) * 60_000;
const USER_RECHECK_MS = 60_000;
const clientStates = new Map();

mkdirSync(DATA_DIR, { recursive: true });

let cache = loadCache();
let customEvents = loadCustomEvents();
const refreshInFlight = new Map();
const sourceState = new Map();
const recheckQueuedAt = new Map();
const personalFriTemplates = new Map();
const preloadState = { running: false, completed: 0, total: PRELOAD_WEEKS * Object.keys(PROGRAMMES).length, lastStartedAt: null, lastCompletedAt: null, lastError: null };
const MAX_BACKOFF_MS = 30 * 60_000;
const PERSONAL_TEMPLATE_TTL_MS = 6 * 60 * 60_000;
const MAX_PERSONAL_TEMPLATES = 100;

function setSecurityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  response.setHeader('content-security-policy', "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; upgrade-insecure-requests; block-all-mixed-content");
}

function clientKey(request) {
  if (TRUST_PROXY) {
    const forwarded = request.headers['cf-connecting-ip'] || request.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return request.socket.remoteAddress || 'unknown';
}

function enforceRateLimit(request, response, path) {
  const now = Date.now();
  const maxRequests = path.startsWith('/api/calendar') ? 15 : path.startsWith('/api/') ? 30 : 180;
  const key = clientKey(request);
  let state = clientStates.get(key);
  if (!state) {
    if (clientStates.size >= MAX_CLIENT_STATES) {
      let oldestKey;
      let oldestSeen = Infinity;
      for (const [candidate, value] of clientStates) if (value.lastSeen < oldestSeen) { oldestKey = candidate; oldestSeen = value.lastSeen; }
      if (oldestKey) clientStates.delete(oldestKey);
    }
    state = { count: 0, resetAt: now + RATE_WINDOW_MS, inFlight: 0, lastSeen: now };
    clientStates.set(key, state);
  }
  if (now >= state.resetAt) { state.count = 0; state.resetAt = now + RATE_WINDOW_MS; }
  state.lastSeen = now;
  if (state.count >= maxRequests || state.inFlight >= 6) {
    const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
    response.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfter), 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: 'Preveč zahtevkov. Poskusite znova čez nekaj trenutkov.' }));
    return false;
  }
  state.count += 1;
  state.inFlight += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.inFlight = Math.max(0, state.inFlight - 1);
  };
  response.once('finish', release);
  response.once('close', release);
  return true;
}

function loadCache() {
  try {
    const loaded = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (loaded.programmes) return loaded;
    // Preserve the original first-year cache on upgrade, but isolate it from
    // all current and future programme-year feeds.
    return { fetchedAt: loaded.fetchedAt || null, programmes: { '1': { weeks: loaded.weeks || {}, sources: loaded.sources || {}, friTemplate: loaded.friTemplate } } };
  }
  catch { return { fetchedAt: null, weeks: {}, sources: {} }; }
}

function loadCustomEvents() {
  try {
    const loaded = JSON.parse(readFileSync(CUSTOM_EVENTS_FILE, 'utf8'));
    return Array.isArray(loaded) ? loaded : [];
  } catch { return []; }
}

function persistCustomEvents() {
  writeFileSync(CUSTOM_EVENTS_FILE, JSON.stringify(customEvents), 'utf8');
}

function customEventsFor(programme, weekKey, events) {
  if (weekKey === 'subscription') return [...events, ...customEvents.filter((event) => event.programme === 'all' || event.programme === programme)];
  const lastDay = isoDate(addDays(monday(`${weekKey}T12:00:00`), 4));
  return [...events, ...customEvents.filter((event) => (event.programme === 'all' || event.programme === programme) && event.date >= weekKey && event.date <= lastDay)]
    .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
}

function adminAuthorized(request) {
  const supplied = String(request.headers['x-isrm-admin-password'] || '');
  if (!ADMIN_PASSWORD || supplied.length !== ADMIN_PASSWORD.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(ADMIN_PASSWORD));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error('Payload too large');
  }
  return JSON.parse(body || '{}');
}

function customEventFrom(input) {
  const clean = (value, max = 120) => String(value || '').trim().slice(0, max);
  const title = clean(input.title);
  const date = clean(input.date, 10);
  const start = clean(input.start, 5);
  const end = clean(input.end, 5);
  const programme = ['all', '1', '2', '3'].includes(input.programme) ? input.programme : 'all';
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || end <= start) throw new Error('Neveljavni podatki dogodka.');
  return { id: `custom-${randomUUID()}`, source: 'IŠRM', title, type: clean(input.type, 32) || 'Osebno', date, start, end, room: clean(input.room, 80), teacher: clean(input.teacher, 80), programme };
}

function persistCache() {
  for (const stored of Object.values(cache.programmes || {})) {
    const staleWeeks = Object.entries(stored.weeks || {}).sort(([, a], [, b]) => new Date(b.fetchedAt) - new Date(a.fetchedAt)).slice(MAX_CACHED_WEEKS_PER_PROGRAMME);
    for (const [weekKey] of staleWeeks) delete stored.weeks[weekKey];
  }
  writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

function programmeId(value) {
  return Object.hasOwn(PROGRAMMES, value) ? value : '1';
}

function programmeCache(programme) {
  const id = programmeId(programme);
  if (!cache.programmes) cache.programmes = {};
  cache.programmes[id] ||= { weeks: {}, sources: {}, friTemplate: null };
  return cache.programmes[id];
}

function studentNumber(value) {
  return /^\d{6,16}$/.test(value || '') ? value : null;
}

function personalFriUrl(programme, student) {
  const source = new URL(PROGRAMMES[programme].friUrl);
  source.search = '';
  source.searchParams.set('student', student);
  return source.toString();
}

async function detectStudentProgramme(student) {
  // The FRI personal allocation page exposes group names such as 2_BUN-RM.
  // Its leading year is the same programme-year selector used by this app.
  const html = await fetchText('FRI-student-programme', personalFriUrl('1', student));
  const matches = [...html.matchAll(/(?:^|[^A-Z0-9])([1-3])_BUN(?:[^A-Z0-9]|$)/gi)];
  const programme = matches.map((match) => match[1]).find((year) => Object.hasOwn(PROGRAMMES, year));
  if (!programme) throw new Error('Letnika vpisne številke ni bilo mogoče prepoznati.');
  return programme;
}

async function sendNtfyNotification({ title, tags, body, timeoutMs = 10_000 }) {
  if (!NTFY_TOPIC || !NTFY_SERVER) return;
  try {
    await fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        title,
        tags,
        ...(NTFY_TOKEN ? { authorization: `Bearer ${NTFY_TOKEN}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.warn('Could not send ntfy alert:', error.message);
  }
}

async function notifySourceChanges(previous, current) {
  const transitions = Object.keys(current).filter((source) => previous?.[source]?.ok !== undefined && previous[source].ok !== current[source].ok);
  if (!transitions.length) return;
  const summary = transitions.map((source) => current[source].ok
    ? `${source} timetable source recovered.`
    : `${source} timetable source failed: ${current[source].message || 'unknown error'}`).join(' ');
  await sendNtfyNotification({
    title: 'ISRM urnik',
    tags: current[transitions[0]].ok ? 'white_check_mark' : 'warning',
    body: `IŠRM: ${summary}`,
  });
}

function monday(dateLike = new Date()) {
  const date = new Date(dateLike);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function isoDate(date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function createFriTemplate(events, weekStart) {
  const mondayKey = isoDate(weekStart);
  return events.map(({ date, ...event }) => ({
    ...event,
    // Calendar-day arithmetic avoids a timezone/noon offset shifting recurrences.
    dayOffset: Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${mondayKey}T00:00:00Z`)) / 86_400_000),
  }));
}

function materializeFriTemplate(template, weekStart) {
  return template.map(({ dayOffset, ...event }) => ({ ...event, date: isoDate(addDays(weekStart, dayOffset)) }));
}

function synchronizeFriTemplate(programme) {
  const stored = programmeCache(programme);
  if (!stored.friTemplate?.events?.length) return;
  let changed = false;
  for (const [cachedWeekKey, cachedWeek] of Object.entries(stored.weeks)) {
    const cachedStart = monday(`${cachedWeekKey}T12:00:00`);
    const expectedFri = materializeFriTemplate(stored.friTemplate.events, cachedStart);
    const actualFri = cachedWeek.events.filter((event) => event.source === 'FRI');
    if (JSON.stringify(actualFri) !== JSON.stringify(expectedFri)) {
      cachedWeek.events = [
        ...cachedWeek.events.filter((event) => event.source !== 'FRI'),
        ...expectedFri,
      ].sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
      changed = true;
    }
  }
  if (changed) persistCache();
}

function ensureFriTemplate(programme) {
  const stored = programmeCache(programme);
  if (stored.friTemplate?.version === 5 && stored.friTemplate.events?.length) {
    synchronizeFriTemplate(programme);
    return true;
  }
  if (stored.friTemplate) {
    // Version 4 excluded the laboratory rows even though they are present in
    // the selected FRI cohort page. Discard that incomplete recurrence and
    // fetch a complete template on the next request.
    delete stored.friTemplate;
    persistCache();
    return false;
  }
  const legacy = Object.entries(stored.weeks).find(([, week]) => week.events?.some((event) => event.source === 'FRI'));
  if (!legacy) return false;
  const [weekKey, week] = legacy;
  const start = monday(`${weekKey}T12:00:00`);
  stored.friTemplate = { version: 5, fetchedAt: week.fetchedAt, events: createFriTemplate(week.events.filter((event) => event.source === 'FRI'), start) };
  // Migrate any cache written by the first recurrence implementation.
  synchronizeFriTemplate(programme);
  persistCache();
  return true;
}

function decodeHtml(value = '') {
  return value
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function timeFromPercent(percent) {
  const minutes = Math.round((Number(percent) / 100) * 13 * 60 + 7 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseFri(html, weekStart, sourceUrl) {
  if (!/allocations|timetable/i.test(html)) throw new Error('FRI format changed: timetable marker was not found');
  const sourceParams = new URL(sourceUrl).searchParams;
  if (!sourceParams.get('group') && !sourceParams.get('student')) throw new Error('FRI configuration is missing the selected group or student');
  const dayIndex = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4 };
  const events = [];
  const entries = html.split(/<div class="grid-entry"\s/i).slice(1);

  for (const entry of entries) {
    // The selected FRI cohort page intentionally includes its laboratory rows
    // alongside shared lectures. Keep exactly the allocations rendered there.
    const day = entry.match(/data-day="([A-Z]{3})"/i)?.[1]?.toUpperCase();
    const start = entry.match(/data-start="(\d{2}:\d{2})"/i)?.[1];
    const duration = Number(entry.match(/data-duration="(\d+)"/i)?.[1]);
    const hover = entry.match(/class="entry-hover">([\s\S]*?)<\/div>/i)?.[1];
    if (!day || !start || !duration || !hover || dayIndex[day] === undefined) continue;
    const lines = decodeHtml(hover.replace(/<!--[\s\S]*?-->/g, ''));
    const room = lines[1] || 'Lokacija ni navedena';
    const title = (lines[2] || 'FRI obveznost').replace(/\(\d+\)_[A-Z]+$/, '').trim();
    const teacher = lines[3] || '';
    const eventType = entry.match(/class="entry-type">\|\s*([^<\s]+)/i)?.[1] || 'FRI';
    const startMinutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
    const endMinutes = startMinutes + duration * 60;
    const end = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
    events.push({
      id: `fri-${day}-${start}-${title}`,
      source: 'FRI',
      title,
      type: eventType,
      date: isoDate(addDays(weekStart, dayIndex[day])),
      start,
      end,
      room,
      teacher,
    });
  }
  return events;
}

function parseFmf(html, weekStart) {
  if (!/id="timetable"/i.test(html)) throw new Error('FMF format changed: timetable container was not found');
  const events = [];
  // Each visual box carries a left/top/height style. Splitting on its stable class
  // avoids relying on brittle nested-div matching in the source HTML.
  const blocks = html.split(/<div class="entry-absolute-box\b/i).slice(1);
  for (const entry of blocks) {
    const style = entry.match(/style="([^"]*)"/i)?.[1] || '';
    const block = entry;
    const left = style.match(/left:\s*([\d.]+)%/i)?.[1];
    const top = style.match(/top:\s*([\d.]+)%/i)?.[1];
    const height = style.match(/height:\s*([\d.]+)%/i)?.[1];
    const title = block.match(/class="subject"[^>]*>[\s\S]*?([^<]+)<\/a>/i)?.[1]?.replace(/\s+/g, ' ').trim();
    if (!left || !top || !height || !title) continue;
    const type = block.match(/class="entry-type">\s*([^<]+)/i)?.[1]?.trim() || 'FMF';
    const room = block.match(/class="classroom[^>]*>[\s\S]*?<a[^>]*title="([^"]+)/i)?.[1] || 'Lokacija ni navedena';
    const teacher = block.match(/class="teacher">[\s\S]*?<a[^>]*title="([^"]+)/i)?.[1] || '';
    const startMinutes = Math.round((Number(top) / 100) * 13 * 60 + 7 * 60);
    const endMinutes = startMinutes + Math.round((Number(height) / 100) * 13 * 60);
    const asTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const dayOffset = Math.round(Number(left) / 20);
    events.push({
      id: `fmf-${dayOffset}-${startMinutes}-${title}-${room}`,
      source: 'FMF', title, type,
      date: isoDate(addDays(weekStart, dayOffset)),
      start: asTime(startMinutes), end: asTime(endMinutes), room, teacher,
    });
  }
  return events;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(MAX_BACKOFF_MS, Number(retryAfter) * 1000);
  return Math.min(MAX_BACKOFF_MS, (2 ** attempt) * 1500 + Math.round(Math.random() * 600));
}

async function fetchText(source, url) {
  const state = sourceState.get(source) || { nextAllowedAt: 0, cooldownUntil: 0 };
  const now = Date.now();
  if (now < state.cooldownUntil) {
    const seconds = Math.ceil((state.cooldownUntil - now) / 1000);
    throw new Error(`${source} is in a respectful cooldown (${seconds}s remaining)`);
  }
  // Queue nearby week requests rather than rejecting them. This makes next/previous
  // week navigation reliable without sending a burst to either university server.
  const scheduledAt = Math.max(now, state.nextAllowedAt || 0);
  state.nextAllowedAt = scheduledAt + MIN_SOURCE_INTERVAL_MS;
  sourceState.set(source, state);
  if (scheduledAt > now) await wait(scheduledAt - now);
  if (Date.now() < state.cooldownUntil) throw new Error(`${source} is in a respectful cooldown after a rate limit`);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'SkupniUrnik/1.0 (personal timetable dashboard; low-frequency cache)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BODY_BYTES) throw new Error(`${source} response exceeded the size limit`);
        state.cooldownUntil = 0;
        const body = await response.text();
        if (body.length > MAX_UPSTREAM_BODY_BYTES) throw new Error(`${source} response exceeded the size limit`);
        return body;
      }
      const delay = retryDelay(response, attempt);
      if (response.status === 429 || response.status >= 500) {
        state.cooldownUntil = Date.now() + delay;
        lastError = new Error(`HTTP ${response.status}; retrying after ${Math.ceil(delay / 1000)}s`);
        if (attempt < 2) { await wait(delay); continue; }
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(retryDelay(null, attempt));
    }
  }
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + MAX_BACKOFF_MS);
  throw lastError || new Error('Request failed');
}

async function refreshWeek(programme, weekKey, { force = false } = {}) {
  const programmeKey = programmeId(programme);
  const profile = PROGRAMMES[programmeKey];
  const stored = programmeCache(programmeKey);
  const refreshKey = `${programmeKey}:${weekKey}`;
  ensureFriTemplate(programmeKey);
  const cachedWeek = stored.weeks[weekKey];
  if (!force && stored.friTemplate?.version === 5 && cachedWeek?.fetchedAt && Date.now() - new Date(cachedWeek.fetchedAt).getTime() < REFRESH_MS) return cachedWeek;
  if (refreshInFlight.has(refreshKey)) return refreshInFlight.get(refreshKey);

  const refresh = (async () => {
    const weekStart = monday(`${weekKey}T12:00:00`);
    const fmfDate = isoDate(weekStart);
    const friResult = stored.friTemplate?.events?.length
      ? { status: 'fulfilled', value: materializeFriTemplate(stored.friTemplate.events, weekStart), cached: true }
      : await Promise.allSettled([
        fetchText(`FRI-${programmeKey}`, profile.friUrl).then((html) => parseFri(html, weekStart, profile.friUrl)),
    ]).then(([result]) => result);
    if (friResult.status === 'fulfilled' && !friResult.cached) {
      stored.friTemplate = { version: 5, fetchedAt: new Date().toISOString(), events: createFriTemplate(friResult.value, weekStart) };
      synchronizeFriTemplate(programmeKey);
    }
    const fmfResult = await Promise.allSettled([
      fetchText(`FMF-${programmeKey}`, `${profile.fmfUrl}${profile.fmfUrl.includes('?') ? '&' : '?'}day=${fmfDate}`).then((html) => parseFmf(html, weekStart)),
    ]).then(([result]) => result);
    const sourceResults = [friResult, fmfResult];
    const previous = cachedWeek?.events || [];
    const events = sourceResults.flatMap((result, index) => result.status === 'fulfilled'
      ? result.value
      : previous.filter((event) => event.source === (index === 0 ? 'FRI' : 'FMF')));
    stored.weeks[weekKey] = { fetchedAt: new Date().toISOString(), events: events.sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)) };
    cache.fetchedAt = stored.weeks[weekKey].fetchedAt;
    const previousSources = stored.sources;
    stored.sources = {
      FRI: sourceResults[0].status === 'fulfilled' ? { ok: true, checkedAt: stored.friTemplate?.fetchedAt || cache.fetchedAt, eventCount: sourceResults[0].value.length, cached: Boolean(sourceResults[0].cached) } : { ok: false, message: sourceResults[0].reason.message, checkedAt: cache.fetchedAt },
      FMF: sourceResults[1].status === 'fulfilled' ? { ok: true, checkedAt: cache.fetchedAt, eventCount: sourceResults[1].value.length } : { ok: false, message: sourceResults[1].reason.message, checkedAt: cache.fetchedAt },
    };
    persistCache();
    notifySourceChanges(previousSources, stored.sources);
    return stored.weeks[weekKey];
  })().finally(() => { refreshInFlight.delete(refreshKey); });
  refreshInFlight.set(refreshKey, refresh);
  return refresh;
}

async function personalizedFriEvents(programme, weekKey, student) {
  const key = `${programme}:${student}`;
  const existing = personalFriTemplates.get(key);
  const weekStart = monday(`${weekKey}T12:00:00`);
  if (existing && Date.now() - new Date(existing.fetchedAt).getTime() < PERSONAL_TEMPLATE_TTL_MS) return materializeFriTemplate(existing.events, weekStart);
  const html = await fetchText(`FRI-personal-${programme}`, personalFriUrl(programme, student));
  const events = parseFri(html, weekStart, personalFriUrl(programme, student));
  if (personalFriTemplates.size >= MAX_PERSONAL_TEMPLATES) personalFriTemplates.delete(personalFriTemplates.keys().next().value);
  personalFriTemplates.set(key, { fetchedAt: new Date().toISOString(), events: createFriTemplate(events, weekStart) });
  return events;
}

async function personalizedWeek(programme, weekKey, student, options) {
  const base = await refreshWeek(programme, weekKey, options);
  const personalFri = await personalizedFriEvents(programme, weekKey, student);
  return {
    ...base,
    events: [...base.events.filter((event) => event.source !== 'FRI'), ...personalFri]
      .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)),
  };
}

function queueRecheck(programme, weekKey) {
  const key = `${programme}:${weekKey}`;
  const now = Date.now();
  if (now - (recheckQueuedAt.get(key) || 0) < USER_RECHECK_MS) return;
  recheckQueuedAt.set(key, now);
  refreshWeek(programme, weekKey, { force: true }).catch((error) => console.warn(`Background recheck failed for ${key}:`, error.message));
}

function preloadWeekKeys() {
  const start = monday();
  return Array.from({ length: PRELOAD_WEEKS }, (_, index) => isoDate(addDays(start, index * 7)));
}

function monthWeekKeys(monthValue) {
  const [year, month] = monthValue.split('-').map(Number);
  const first = new Date(year, month - 1, 1, 12);
  const last = new Date(year, month, 0, 12);
  const keys = [];
  for (let cursor = monday(first); cursor <= last; cursor = addDays(cursor, 7)) keys.push(isoDate(cursor));
  return keys;
}

async function preloadUpcomingWeeks() {
  if (preloadState.running) return;
  preloadState.running = true;
  preloadState.completed = 0;
  preloadState.lastStartedAt = new Date().toISOString();
  preloadState.lastError = null;
  try {
    for (const programme of Object.keys(PROGRAMMES)) for (const weekKey of preloadWeekKeys()) {
      const cachedWeek = programmeCache(programme).weeks[weekKey];
      const stale = !cachedWeek?.fetchedAt || Date.now() - new Date(cachedWeek.fetchedAt).getTime() >= PRELOAD_REFRESH_MS;
      if (stale) await refreshWeek(programme, weekKey);
      preloadState.completed += 1;
    }
    preloadState.lastCompletedAt = new Date().toISOString();
  } catch (error) {
    preloadState.lastError = error.message;
    console.warn('Upcoming timetable preload failed:', error.message);
  } finally {
    preloadState.running = false;
  }
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
function sendJson(response, payload, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function icalEscape(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icalDateTime(date, time) {
  return `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
}

function calendarText(programme, weekKey, events) {
  const createdAt = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const calendarEvents = events.map((event) => [
    'BEGIN:VEVENT',
    `UID:${icalEscape(`${event.id}-${event.date}`)}@skupni-urnik`,
    `DTSTAMP:${createdAt}`,
    `DTSTART;TZID=Europe/Ljubljana:${icalDateTime(event.date, event.start)}`,
    `DTEND;TZID=Europe/Ljubljana:${icalDateTime(event.date, event.end)}`,
    `SUMMARY:${icalEscape(event.title)} (${icalEscape(event.type)})`,
    `LOCATION:${icalEscape(event.room)}`,
    `DESCRIPTION:${icalEscape([event.source, event.teacher].filter(Boolean).join(' · '))}`,
    'END:VEVENT',
  ].join('\r\n')).join('\r\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Skupni urnik//FRI FMF//SL', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:IŠRM ${PROGRAMMES[programme].label} ${weekKey}`, calendarEvents, 'END:VCALENDAR', ''].join('\r\n');
}

function sendCalendar(response, programme, weekKey, events) {
  const filename = weekKey === 'subscription' ? `isrm-${programme}-letnik.ics` : `isrm-${programme}-letnik-${weekKey}.ics`;
  response.writeHead(200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  response.end(calendarText(programme, weekKey, customEventsFor(programme, weekKey, events)));
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  if (!['GET', 'POST'].includes(request.method || '')) {
    response.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' });
    return response.end(JSON.stringify({ error: 'Metoda ni podprta.' }));
  }
  if (!request.url || request.url.length > MAX_URL_LENGTH) {
    response.writeHead(414, { 'content-type': 'application/json; charset=utf-8' });
    return response.end(JSON.stringify({ error: 'Zahteva je predolga.' }));
  }
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedWeek = url.searchParams.get('week');
  if (requestedWeek && !/^\d{4}-\d{2}-\d{2}$/.test(requestedWeek)) return sendJson(response, { error: 'Neveljaven teden.' }, 400);
  if (!enforceRateLimit(request, response, url.pathname)) return;
  if (url.pathname.startsWith('/api/admin/')) {
    if (request.method !== 'POST') return sendJson(response, { error: 'Metoda ni podprta.' }, 405);
    if (!adminAuthorized(request)) return sendJson(response, { error: 'Napačno administratorsko geslo.' }, 401);
    try {
      if (url.pathname === '/api/admin/verify') return sendJson(response, { ok: true });
      const input = await readJson(request);
      if (url.pathname === '/api/admin/events') {
        const event = customEventFrom(input);
        customEvents.push(event);
        persistCustomEvents();
        return sendJson(response, { event }, 201);
      }
      if (url.pathname === '/api/admin/events/delete') {
        const before = customEvents.length;
        customEvents = customEvents.filter((event) => event.id !== input.id);
        if (customEvents.length === before) return sendJson(response, { error: 'Dogodek ni najden.' }, 404);
        persistCustomEvents();
        return sendJson(response, { ok: true });
      }
      return sendJson(response, { error: 'Pot ni najdena.' }, 404);
    } catch (error) { return sendJson(response, { error: error.message || 'Neveljavna zahteva.' }, 400); }
  }
  if (request.method !== 'GET') return sendJson(response, { error: 'Metoda ni podprta.' }, 405);
  if (url.pathname === '/api/release') return sendJson(response, { androidVersion: ANDROID_APP_VERSION, androidApkUrl: ANDROID_APK_URL });
  if (url.pathname === '/api/student-programme') {
    const student = studentNumber(url.searchParams.get('student'));
    if (!student) return sendJson(response, { error: 'Neveljavna vpisna številka.' }, 400);
    try {
      const programme = await detectStudentProgramme(student);
      return sendJson(response, { programme, programmeLabel: PROGRAMMES[programme].label });
    } catch {
      return sendJson(response, { error: 'Letnika za to vpisno številko ni bilo mogoče prepoznati.' }, 422);
    }
  }
  if (url.pathname === '/api/month') {
    const month = url.searchParams.get('month');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return sendJson(response, { error: 'Neveljaven mesec.' }, 400);
    const programme = programmeId(url.searchParams.get('programme'));
    const studentParam = url.searchParams.get('student');
    const student = studentNumber(studentParam);
    if (studentParam && !student) return sendJson(response, { error: 'Neveljavna vpisna številka.' }, 400);
    const stored = programmeCache(programme);
    const weekKeys = monthWeekKeys(month);
    try {
      // Cached weeks are returned immediately. Missing future weeks are filled
      // in behind the response instead of delaying the mobile month view.
      if (!Object.values(stored.weeks).some((week) => week?.events?.length)) await refreshWeek(programme, weekKeys[0]);
      const weeks = await Promise.all(weekKeys.map(async (weekKey) => {
        const cachedWeek = stored.weeks[weekKey];
        if (!cachedWeek) { queueRecheck(programme, weekKey); return []; }
        queueRecheck(programme, weekKey);
        const baseEvents = student ? (await personalizedWeek(programme, weekKey, student)).events : cachedWeek.events;
        return customEventsFor(programme, weekKey, baseEvents);
      }));
      return sendJson(response, { programme, programmeLabel: PROGRAMMES[programme].label, month, events: weeks.flat(), cached: true });
    } catch {
      return sendJson(response, { error: 'Mesečnega urnika trenutno ni mogoče pripraviti.', events: [] }, 503);
    }
  }
  if (url.pathname === '/api/timetable') {
    const programme = programmeId(url.searchParams.get('programme'));
    const studentParam = url.searchParams.get('student');
    const student = studentNumber(studentParam);
    if (studentParam && !student) return sendJson(response, { error: 'Neveljavna vpisna številka.' }, 400);
    const stored = programmeCache(programme);
    const requested = url.searchParams.get('week');
    const weekKey = isoDate(monday(requested ? `${requested}T12:00:00` : new Date()));
    const manualRefresh = url.searchParams.get('refresh') === '1';
    const cachedWeek = stored.weeks[weekKey];
    if (cachedWeek && !manualRefresh && !student) {
      queueRecheck(programme, weekKey);
      return sendJson(response, { programme, programmeLabel: PROGRAMMES[programme].label, weekStart: weekKey, ...cachedWeek, events: customEventsFor(programme, weekKey, cachedWeek.events), sources: stored.sources, refreshMinutes: REFRESH_MS / 60_000, revalidating: true });
    }
    try {
      const week = student ? await personalizedWeek(programme, weekKey, student, { force: manualRefresh }) : await refreshWeek(programme, weekKey, { force: manualRefresh });
      return sendJson(response, { programme, programmeLabel: PROGRAMMES[programme].label, weekStart: weekKey, ...week, events: customEventsFor(programme, weekKey, week.events), sources: stored.sources, refreshMinutes: REFRESH_MS / 60_000, personalized: Boolean(student) });
    } catch (error) {
      return sendJson(response, { error: 'Urnika trenutno ni mogoče osvežiti.', detail: error.message, programme, weekStart: weekKey, events: stored.weeks[weekKey]?.events || [], sources: stored.sources }, 503);
    }
  }
  if (url.pathname === '/api/calendar') {
    const programme = programmeId(url.searchParams.get('programme'));
    const studentParam = url.searchParams.get('student');
    const student = studentNumber(studentParam);
    if (studentParam && !student) return sendJson(response, { error: 'Neveljavna vpisna številka.' }, 400);
    const stored = programmeCache(programme);
    const requested = url.searchParams.get('week');
    const weekKey = isoDate(monday(requested ? `${requested}T12:00:00` : new Date()));
    const cachedWeek = stored.weeks[weekKey];
    if (cachedWeek && !student) {
      queueRecheck(programme, weekKey);
      return sendCalendar(response, programme, weekKey, cachedWeek.events);
    }
    try {
      const week = student ? await personalizedWeek(programme, weekKey, student) : await refreshWeek(programme, weekKey);
      return sendCalendar(response, programme, weekKey, week.events);
    } catch {
      const events = stored.weeks[weekKey]?.events || [];
      if (events.length) return sendCalendar(response, programme, weekKey, events);
      return sendJson(response, { error: 'Koledarja trenutno ni mogoče pripraviti.', weekStart: weekKey }, 503);
    }
  }
  if (url.pathname === '/api/calendar/subscription') {
    const programme = programmeId(url.searchParams.get('programme'));
    const studentParam = url.searchParams.get('student');
    const student = studentNumber(studentParam);
    if (studentParam && !student) return sendJson(response, { error: 'Neveljavna vpisna številka.' }, 400);
    const stored = programmeCache(programme);
    const weekKey = isoDate(monday());
    const events = Object.values(stored.weeks).flatMap((week) => week.events || []).sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
    queueRecheck(programme, weekKey);
    if (events.length && !student) return sendCalendar(response, programme, 'subscription', events);
    try {
      if (!events.length) await refreshWeek(programme, weekKey);
      const personalizedEvents = student
        ? (await Promise.all(Object.keys(stored.weeks).map(async (key) => (await personalizedWeek(programme, key, student)).events))).flat()
        : Object.values(stored.weeks).flatMap((week) => week.events || []);
      return sendCalendar(response, programme, 'subscription', personalizedEvents);
    } catch {
      return sendJson(response, { error: 'Koledarja trenutno ni mogoče pripraviti.' }, 503);
    }
  }
  if (url.pathname === '/live') return sendJson(response, { ok: true });
  if (url.pathname === '/health') {
    const sources = Object.fromEntries(Object.entries(cache.programmes || {}).map(([programme, stored]) => [programme, stored.sources]));
    const failingSources = Object.entries(sources).flatMap(([programme, statuses]) => Object.entries(statuses).filter(([, status]) => !status.ok).map(([source]) => `${programme}:${source}`));
    return sendJson(response, { ok: failingSources.length === 0, fetchedAt: cache.fetchedAt, failingSources, sources, preload: preloadState }, failingSources.length ? 503 : 200);
  }

  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = normalize(join(DIST, requestedPath));
  const file = (candidate === DIST || candidate.startsWith(`${DIST}/`)) && existsSync(candidate) ? candidate : join(DIST, 'index.html');
  const mustRevalidate = file.endsWith('index.html') || file.endsWith('sw.js') || file.endsWith('manifest.webmanifest');
  response.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': mustRevalidate ? 'no-cache' : 'public, max-age=31536000, immutable' });
  createReadStream(file).pipe(response);
});

let isShuttingDown = false;

async function shutDown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  await sendNtfyNotification({
    title: 'ISRM urnik se ustavlja',
    tags: 'warning',
    body: `IŠRM timetable service is shutting down (${APP_VERSION}).`,
    timeoutMs: 4_000,
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => { void shutDown('SIGTERM'); });
process.on('SIGINT', () => { void shutDown('SIGINT'); });

server.listen(PORT, () => {
  console.log(`Skupni urnik is listening on :${PORT}`);
  void sendNtfyNotification({
    title: 'ISRM urnik je pripravljen',
    tags: 'white_check_mark',
    body: `IŠRM timetable service is online (${APP_VERSION}).`,
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;

preloadUpcomingWeeks();
setInterval(() => preloadUpcomingWeeks(), REFRESH_MS).unref();
