import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { createAnalytics } from './analytics.mjs';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || './data';
const CACHE_FILE = join(DATA_DIR, 'timetable-cache.json');
const CUSTOM_EVENTS_FILE = join(DATA_DIR, 'custom-events.json');
const CANCELLATIONS_FILE = join(DATA_DIR, 'cancellations.json');
const ANNOUNCEMENTS_FILE = join(DATA_DIR, 'announcements.json');
const ADMIN_TOKENS_FILE = join(DATA_DIR, 'admin-tokens.json');
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
const ANDROID_RELEASE_URL = process.env.ANDROID_RELEASE_URL || '/android';
// Short "what's new" for the in-app update sheet; separate items with "|".
const ANDROID_RELEASE_NOTES = (process.env.ANDROID_RELEASE_NOTES || '').split('|').map((note) => note.trim()).filter(Boolean).slice(0, 6);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Separate, view-only password for the /admin statistics panel; it cannot edit events, cancellations or messages.
const STATS_PASSWORD = process.env.STATS_PASSWORD || '';
const DIST = join(process.cwd(), 'dist');
// Self-hosted Android builds, mounted read-only from ./releases (see compose.yaml).
const RELEASES_DIR = process.env.RELEASES_DIR || '/releases';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const MAX_UPSTREAM_BODY_BYTES = 4 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_CLIENT_STATES = 5_000;
const MAX_CACHED_WEEKS_PER_PROGRAMME = 20;
const RATE_WINDOW_MS = 60_000;
// A whole semester plus exams ahead is kept warm, so browsing forward rarely waits on the faculty sites.
// The whole school year ahead is kept warm (weeks past NEAR_WEEKS are refreshed daily), so browsing forward or
// opening a far month practically never waits on the faculty sites.
const PRELOAD_WEEKS = Math.min(52, Math.max(1, Number(process.env.PRELOAD_WEEKS || 45)));
const NEAR_WEEKS = 8;
const FAR_REFRESH_MS = 24 * 60 * 60_000;
const PRELOAD_PAST_WEEKS = 2;
const PRELOAD_REFRESH_MS = Math.max(60, Number(process.env.PRELOAD_REFRESH_MINUTES || 360)) * 60_000;
// Viewing a week re-checks it upstream at most this often; with ~40 users, per-view rechecks would mostly repeat work.
const USER_RECHECK_MS = REFRESH_MS;
const clientStates = new Map();
const STARTED_AT = new Date().toISOString();

mkdirSync(DATA_DIR, { recursive: true });

let cache = loadCache();
let customEvents = loadCustomEvents();
// Admin-marked cancelled lectures: one entry per lecture occurrence (programme + event id + date).
let cancellations = loadJsonList(CANCELLATIONS_FILE);
// Admin messages shown as a banner to everyone in a programme until they expire.
let announcements = loadJsonList(ANNOUNCEMENTS_FILE);
// Long-lived admin keys handed out in exchange for the password, so devices never store the password itself.
// Only a SHA-256 of each key is kept, together with a fingerprint of the password it was issued under: changing
// ADMIN_PASSWORD therefore revokes every key at once.
let adminTokens = loadJsonList(ADMIN_TOKENS_FILE);
const analytics = createAnalytics({ file: join(DATA_DIR, 'analytics.json'), programmes: Object.keys(PROGRAMMES) });
// Bumped on every admin change (events, cancellations, messages). Open apps poll /api/revision — a few bytes — and
// reload only when it moved, so everyone sees edits within seconds without re-fetching timetables all the time.
// Starting from the clock means a restart also counts as a change, which is harmless.
let contentRevision = Date.now();
const refreshInFlight = new Map();
const sourceState = new Map();
const recheckQueuedAt = new Map();
const personalFriTemplates = new Map();
const preloadState = { running: false, completed: 0, total: (PRELOAD_WEEKS + PRELOAD_PAST_WEEKS) * Object.keys(PROGRAMMES).length, lastStartedAt: null, lastCompletedAt: null, lastError: null };
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
  // Each kind of request has its own counter. They used to share one, so browsing a few weeks (90 allowed) used up the
  // admin limit (5) and adding an event failed with "too many requests".
  const bucket = path.startsWith('/api/admin/') ? 'admin'
    : path.startsWith('/api/calendar') ? 'calendar'
      : path === '/api/timetable' || path === '/api/month' || path === '/api/revision' ? 'timetable'
        : path.startsWith('/api/') ? 'api' : 'static';
  const maxRequests = { admin: 30, calendar: 15, timetable: 120, api: 30, static: 180 }[bucket];
  const key = `${clientKey(request)}|${bucket}`;
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

// Weeks parsed before the FMF reservation fix stored titles like `a href="/reservations_list/…" title="X">Rezervacija: X`.
// Past weeks are rarely re-fetched, so they are repaired once on load instead of waiting for a refresh that never comes.
function repairFmfTitles(cache) {
  for (const programme of Object.values(cache.programmes || {})) {
    for (const week of Object.values(programme.weeks || {})) {
      for (const event of week.events || []) {
        const repaired = /^a href=/.test(event.title || '') ? event.title.slice(event.title.indexOf('>') + 1).trim() : null;
        if (repaired) { event.id = event.id.replace(event.title, repaired); event.title = repaired; }
      }
    }
  }
  return cache;
}

function loadCache() {
  try {
    const loaded = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (loaded.programmes) return repairFmfTitles(loaded);
    // Preserve the original first-year cache on upgrade, but isolate it from
    // all current and future programme-year feeds.
    return { fetchedAt: loaded.fetchedAt || null, programmes: { '1': { weeks: loaded.weeks || {}, sources: loaded.sources || {}, friTemplate: loaded.friTemplate } } };
  }
  catch { return { fetchedAt: null, weeks: {}, sources: {} }; }
}

function loadCustomEvents() {
  try {
    const loaded = JSON.parse(readFileSync(CUSTOM_EVENTS_FILE, 'utf8'));
    return Array.isArray(loaded) ? loaded.map((event) => event?.source === 'IŠRM' && event.type === 'Osebno' ? { ...event, type: 'Skupno' } : event) : [];
  } catch { return []; }
}

function persistCustomEvents() {
  writeFileSync(CUSTOM_EVENTS_FILE, JSON.stringify(customEvents), 'utf8');
}

function loadJsonList(file) {
  try {
    const loaded = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(loaded) ? loaded : [];
  } catch { return []; }
}

const cancellationKey = (programme, eventId, date) => `${programme}|${eventId}|${date}`;

function applyCancellations(programme, events) {
  if (!cancellations.length) return events;
  const byKey = new Map(cancellations.map((entry) => [entry.key, entry]));
  return events.map((event) => {
    const entry = byKey.get(cancellationKey(programme, event.id, event.date));
    return entry ? { ...event, cancelled: true, cancelNote: entry.note || '' } : event;
  });
}

function activeAnnouncements(programme) {
  const now = Date.now();
  return announcements
    .filter((entry) => (entry.programme === 'all' || entry.programme === programme) && new Date(entry.expiresAt).getTime() > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function customEventsFor(programme, weekKey, events) {
  return applyCancellations(programme, withCustomEvents(programme, weekKey, events));
}

function withCustomEvents(programme, weekKey, events) {
  if (weekKey === 'subscription') return [...events, ...customEvents.filter((event) => event.programme === 'all' || event.programme === programme)];
  // Through Sunday: custom events may fall on any day, and weekend ones were silently dropped.
  const lastDay = isoDate(addDays(monday(`${weekKey}T12:00:00`), 6));
  return [...events, ...customEvents.filter((event) => (event.programme === 'all' || event.programme === programme) && event.date >= weekKey && event.date <= lastDay)]
    .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const passwordFingerprint = () => sha256(`isrm-admin:${ADMIN_PASSWORD}`).slice(0, 16);

const statsFingerprint = () => sha256(`isrm-stats:${STATS_PASSWORD}`).slice(0, 16);

function secretMatches(supplied, secret) {
  if (!secret || supplied.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(secret));
}
const passwordMatches = (supplied) => secretMatches(supplied, ADMIN_PASSWORD);

// Keys still valid under the current passwords; anything issued under an old password is dropped.
const liveTokens = () => adminTokens.filter((entry) => (ADMIN_PASSWORD && entry.password === passwordFingerprint()) || (STATS_PASSWORD && entry.password === statsFingerprint()));

function tokenRecord(request) {
  const token = String(request.headers['x-isrm-admin-token'] || '');
  if (!ADMIN_PASSWORD || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = sha256(token);
  return adminTokens.find((entry) => entry.hash === hash && entry.password === passwordFingerprint()) || null;
}

// Statistics-only keys are signed with the stats fingerprint, so they never pass tokenRecord/adminAuthorized above.
function statsTokenRecord(request) {
  const token = String(request.headers['x-isrm-admin-token'] || '');
  if (!STATS_PASSWORD || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = sha256(token);
  return adminTokens.find((entry) => entry.hash === hash && entry.password === statsFingerprint()) || null;
}

// A saved admin key, or the password itself (older app versions still send it).
function adminAuthorized(request) {
  return Boolean(tokenRecord(request)) || passwordMatches(String(request.headers['x-isrm-admin-password'] || ''));
}

function persistAdminTokens() { writeFileSync(ADMIN_TOKENS_FILE, JSON.stringify(adminTokens), 'utf8'); }

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
  return { id: `custom-${randomUUID()}`, source: 'IŠRM', title, type: clean(input.type, 32) || 'Skupno', date, start, end, room: clean(input.room, 80), teacher: clean(input.teacher, 80), programme };
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
    // `[^<>]` rather than `[^<]`: reservations wrap the name in an inner <a href title>, and a capture that
    // may contain `>` swallowed that tag's attributes into the title.
    const title = block.match(/class="subject"[^>]*>[\s\S]*?([^<>]+)<\/a>/i)?.[1]?.replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
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

// Background work (rechecks of weeks someone just viewed, preloading) shares the polite per-source request spacing
// with people who are actually waiting for an uncached week. It used to fire immediately, so every viewed week queued a
// recheck and a person opening a new week waited behind all of them, 3 s each. Now background jobs run one at a time
// and only after a few quiet seconds, so they occupy at most one slot ahead of a waiting person.
const INTERACTIVE_QUIET_MS = 4_000;
const MAX_BACKGROUND_JOBS = 80;
const backgroundQueue = [];
let backgroundRunning = false;
let lastInteractiveAt = 0;

function markInteractive() { lastInteractiveAt = Date.now(); }

async function yieldToPeople() {
  while (Date.now() - lastInteractiveAt < INTERACTIVE_QUIET_MS) await wait(1_000);
}

function queueRecheck(programme, weekKey) {
  const key = `${programme}:${weekKey}`;
  const now = Date.now();
  const fetchedAt = programmeCache(programme).weeks[weekKey]?.fetchedAt;
  if (fetchedAt && now - new Date(fetchedAt).getTime() < REFRESH_MS) return;
  if (now - (recheckQueuedAt.get(key) || 0) < USER_RECHECK_MS) return;
  if (backgroundQueue.length >= MAX_BACKGROUND_JOBS || backgroundQueue.some((job) => job.key === key)) return;
  recheckQueuedAt.set(key, now);
  backgroundQueue.push({ key, programme, weekKey });
  void runBackgroundQueue();
}

async function runBackgroundQueue() {
  if (backgroundRunning) return;
  backgroundRunning = true;
  try {
    while (backgroundQueue.length) {
      await yieldToPeople();
      const job = backgroundQueue.shift();
      await refreshWeek(job.programme, job.weekKey, { force: true }).catch((error) => console.warn(`Background recheck failed for ${job.key}:`, error.message));
    }
  } finally {
    backgroundRunning = false;
  }
}

function preloadWeekKeys() {
  const start = addDays(monday(), -7 * PRELOAD_PAST_WEEKS);
  return Array.from({ length: PRELOAD_WEEKS + PRELOAD_PAST_WEEKS }, (_, index) => isoDate(addDays(start, index * 7)));
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
    for (const programme of Object.keys(PROGRAMMES)) for (const [index, weekKey] of preloadWeekKeys().entries()) {
      const cachedWeek = programmeCache(programme).weeks[weekKey];
      const maxAge = index <= PRELOAD_PAST_WEEKS + NEAR_WEEKS ? PRELOAD_REFRESH_MS : FAR_REFRESH_MS;
      const stale = !cachedWeek?.fetchedAt || Date.now() - new Date(cachedWeek.fetchedAt).getTime() >= maxAge;
      if (stale) { await yieldToPeople(); await refreshWeek(programme, weekKey); }
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

function publicReleaseUrl(value, { allowPath = false } = {}) {
  if (!value) return '';
  if (allowPath && value.startsWith('/')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
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
    `SUMMARY:${event.cancelled ? 'ODPADE: ' : ''}${icalEscape(event.title)} (${icalEscape(event.type)})`,
    ...(event.cancelled ? ['STATUS:CANCELLED'] : []),
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
  const url = new URL(request.url, 'http://localhost');
  const requestedWeek = url.searchParams.get('week');
  if (requestedWeek && !/^\d{4}-\d{2}-\d{2}$/.test(requestedWeek)) return sendJson(response, { error: 'Neveljaven teden.' }, 400);
  if (!enforceRateLimit(request, response, url.pathname)) return;
  // Raw visitor counting for the admin panel: app/API calls and page loads, never static files or admin requests.
  if (request.method === 'GET' || url.pathname === '/api/ping') {
    const tracked = url.pathname === '/' || url.pathname === '/index.html' || (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/admin/')) || !extname(url.pathname);
    if (tracked && !['/live', '/health', '/admin'].includes(url.pathname)) analytics.track({ ip: clientKey(request), agent: request.headers['user-agent'], path: url.pathname });
  }
  if (url.pathname.startsWith('/api/admin/')) {
    if (request.method !== 'POST') return sendJson(response, { error: 'Metoda ni podprta.' }, 405);
    if (url.pathname === '/api/admin/login') {
      // Exchanges the password for a long-lived key once; the device keeps only the key.
      const input = await readJson(request).catch(() => ({}));
      if (!passwordMatches(String(input.password || ''))) return sendJson(response, { error: 'Napačno administratorsko geslo.' }, 401);
      const token = randomBytes(32).toString('hex');
      adminTokens = [...liveTokens().slice(-49), { hash: sha256(token), password: passwordFingerprint(), label: String(input.device || '').slice(0, 60), createdAt: new Date().toISOString() }];
      persistAdminTokens();
      return sendJson(response, { token });
    }
    // The statistics panel signs in with STATS_PASSWORD (view only) or the full admin password.
    if (url.pathname === '/api/admin/stats/login') {
      const input = await readJson(request).catch(() => ({}));
      const password = String(input.password || '');
      const scope = secretMatches(password, STATS_PASSWORD) ? 'stats' : passwordMatches(password) ? 'admin' : '';
      if (!scope) return sendJson(response, { error: 'Napačno geslo.' }, 401);
      const token = randomBytes(32).toString('hex');
      adminTokens = [...liveTokens().slice(-49), { hash: sha256(token), password: scope === 'stats' ? statsFingerprint() : passwordFingerprint(), scope, label: 'nadzorna plošča', createdAt: new Date().toISOString() }];
      persistAdminTokens();
      return sendJson(response, { token, scope });
    }
    if (url.pathname === '/api/admin/stats') {
      if (!tokenRecord(request) && !statsTokenRecord(request)) return sendJson(response, { error: 'Napačno geslo.' }, 401);
      const sources = Object.fromEntries(Object.entries(cache.programmes || {}).map(([programme, stored]) => [programme, stored.sources]));
      return sendJson(response, {
        ...analytics.stats(),
        server: { version: APP_VERSION, androidVersion: ANDROID_APP_VERSION, startedAt: STARTED_AT, fetchedAt: cache.fetchedAt, sources, preload: preloadState, customEvents: customEvents.length, announcements: announcements.filter((entry) => new Date(entry.expiresAt).getTime() > Date.now()).length, adminDevices: adminTokens.filter((entry) => entry.password === passwordFingerprint()).length },
      });
    }
    if (url.pathname === '/api/admin/logout') {
      const record = tokenRecord(request) || statsTokenRecord(request);
      if (record) { adminTokens = adminTokens.filter((entry) => entry !== record); persistAdminTokens(); }
      return sendJson(response, { ok: true });
    }
    if (!adminAuthorized(request)) return sendJson(response, { error: 'Napačno administratorsko geslo.' }, 401);
    try {
      if (url.pathname === '/api/admin/verify') return sendJson(response, { ok: true });
      const input = await readJson(request);
      if (url.pathname === '/api/admin/events') {
        const event = customEventFrom(input);
        customEvents.push(event);
        contentRevision += 1;
        persistCustomEvents();
        return sendJson(response, { event }, 201);
      }
      if (url.pathname === '/api/admin/cancel') {
        const programme = programmeId(String(input.programme || ''));
        const eventId = String(input.eventId || '').slice(0, 300);
        const date = String(input.date || '');
        if (!eventId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(response, { error: 'Neveljavna obveznost.' }, 400);
        const key = cancellationKey(programme, eventId, date);
        cancellations = cancellations.filter((entry) => entry.key !== key);
        if (input.cancelled !== false) cancellations.push({ key, programme, eventId, date, note: String(input.note || '').trim().slice(0, 160), at: new Date().toISOString() });
        // Old dates are dropped so the file never grows without bound.
        const cutoff = isoDate(addDays(new Date(), -60));
        cancellations = cancellations.filter((entry) => entry.date >= cutoff);
        contentRevision += 1;
        writeFileSync(CANCELLATIONS_FILE, JSON.stringify(cancellations), 'utf8');
        return sendJson(response, { ok: true, cancelled: input.cancelled !== false });
      }
      if (url.pathname === '/api/admin/announcements') {
        const text = String(input.text || '').trim().slice(0, 500);
        if (!text) return sendJson(response, { error: 'Vnesi sporočilo.' }, 400);
        const days = Math.min(30, Math.max(1, Number(input.days) || 3));
        const programme = ['all', '1', '2', '3'].includes(input.programme) ? input.programme : 'all';
        const createdAt = new Date().toISOString();
        const announcement = { id: `msg-${randomUUID()}`, text, programme, createdAt, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() };
        announcements = [...announcements.filter((entry) => new Date(entry.expiresAt).getTime() > Date.now()), announcement];
        contentRevision += 1;
        writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(announcements), 'utf8');
        return sendJson(response, { announcement }, 201);
      }
      if (url.pathname === '/api/admin/announcements/delete') {
        const before = announcements.length;
        announcements = announcements.filter((entry) => entry.id !== input.id);
        if (announcements.length === before) return sendJson(response, { error: 'Sporočilo ni najdeno.' }, 404);
        contentRevision += 1;
        writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(announcements), 'utf8');
        return sendJson(response, { ok: true });
      }
      if (url.pathname === '/api/admin/events/delete') {
        const before = customEvents.length;
        customEvents = customEvents.filter((event) => event.id !== input.id);
        if (customEvents.length === before) return sendJson(response, { error: 'Dogodek ni najden.' }, 404);
        contentRevision += 1;
        persistCustomEvents();
        return sendJson(response, { ok: true });
      }
      return sendJson(response, { error: 'Pot ni najdena.' }, 404);
    } catch (error) { return sendJson(response, { error: error.message || 'Neveljavna zahteva.' }, 400); }
  }
  // Anonymous session ping from the web app, PWA and Android app (see analytics.mjs and /privacy).
  if (url.pathname === '/api/ping') {
    if (request.method !== 'POST') return sendJson(response, { error: 'Metoda ni podprta.' }, 405);
    const input = await readJson(request).catch(() => null);
    analytics.record(input, request.headers['user-agent']);
    response.writeHead(204, { 'cache-control': 'no-store' });
    return response.end();
  }
  if (request.method !== 'GET') return sendJson(response, { error: 'Metoda ni podprta.' }, 405);
  if (url.pathname === '/api/revision') return sendJson(response, { revision: contentRevision });
  // The app's failsafe reads FRI/FMF itself when this server is down; it keeps the latest source links from here.
  if (url.pathname === '/api/sources') return sendJson(response, { programmes: Object.fromEntries(Object.entries(PROGRAMMES).map(([id, profile]) => [id, { friUrl: profile.friUrl, fmfUrl: profile.fmfUrl }])) });
  if (url.pathname === '/api/release') return sendJson(response, {
    androidVersion: ANDROID_APP_VERSION,
    androidApkUrl: publicReleaseUrl(ANDROID_APK_URL),
    androidReleaseUrl: publicReleaseUrl(ANDROID_RELEASE_URL, { allowPath: true }) || '/android',
    androidNotes: ANDROID_RELEASE_NOTES,
  });
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
        let cachedWeek = stored.weeks[weekKey];
        // A missing week is fetched now rather than shown as an empty month; with the year-long preload this is rare.
        if (!cachedWeek) { markInteractive(); cachedWeek = await refreshWeek(programme, weekKey).catch(() => null); if (!cachedWeek) return []; }
        queueRecheck(programme, weekKey);
        const baseEvents = student ? (await personalizedWeek(programme, weekKey, student)).events : cachedWeek.events;
        return customEventsFor(programme, weekKey, baseEvents);
      }));
      return sendJson(response, { programme, programmeLabel: PROGRAMMES[programme].label, month, events: weeks.flat(), announcements: activeAnnouncements(programme), cached: true });
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
      return sendJson(response, { programme, programmeLabel: PROGRAMMES[programme].label, weekStart: weekKey, ...cachedWeek, events: customEventsFor(programme, weekKey, cachedWeek.events), sources: stored.sources, announcements: activeAnnouncements(programme), refreshMinutes: REFRESH_MS / 60_000, revalidating: true });
    }
    try {
      markInteractive();
      const week = student ? await personalizedWeek(programme, weekKey, student, { force: manualRefresh }) : await refreshWeek(programme, weekKey, { force: manualRefresh });
      return sendJson(response, { programme, programmeLabel: PROGRAMMES[programme].label, weekStart: weekKey, ...week, events: customEventsFor(programme, weekKey, week.events), sources: stored.sources, announcements: activeAnnouncements(programme), refreshMinutes: REFRESH_MS / 60_000, personalized: Boolean(student) });
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

  // A stable, shareable link that always points at the newest APK (manual updates, or sending it to someone).
  if (url.pathname === '/download' || url.pathname === '/download/') {
    const target = publicReleaseUrl(ANDROID_APK_URL);
    if (!target) return sendJson(response, { error: 'Android aplikacija še ni objavljena.' }, 404);
    response.writeHead(302, { location: target, 'cache-control': 'no-store' });
    return response.end();
  }
  const download = url.pathname.match(/^\/downloads\/(ISRM-\d+(?:\.\d+)*\.apk)$/);
  if (download) {
    // The name is matched against a strict pattern, so it cannot climb out of RELEASES_DIR. no-cache: a rebuilt APK can
    // reuse its version's file name, and a cached copy (Cloudflare kept one for a day) would hand out the old build.
    const file = join(RELEASES_DIR, download[1]);
    if (!existsSync(file)) return sendJson(response, { error: 'Ta izdaja ne obstaja.' }, 404);
    response.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': statSync(file).size, 'content-disposition': `attachment; filename="${download[1]}"`, 'cache-control': 'no-cache' });
    return createReadStream(file).pipe(response);
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
  analytics.flush();
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

// Faculties publish changes overnight. At 05:00 and 06:00 (server TZ) this week and next are fetched fresh from both
// sources, and the FRI recurrence — otherwise reused indefinitely once built — is rebuilt from today's FRI page. The
// old template is only replaced when the new page parsed into events, so a failed fetch never empties FRI.
const MORNING_HOURS = [5, 6];
let lastMorningRun = '';

async function refreshFriTemplate(programme) {
  const profile = PROGRAMMES[programme];
  const stored = programmeCache(programme);
  const weekStart = monday();
  try {
    const events = parseFri(await fetchText(`FRI-${programme}`, profile.friUrl), weekStart, profile.friUrl);
    if (events.length) {
      stored.friTemplate = { version: 5, fetchedAt: new Date().toISOString(), events: createFriTemplate(events, weekStart) };
      synchronizeFriTemplate(programme);
      persistCache();
    }
  } catch (error) { console.warn(`FRI template refresh failed for ${programme}:`, error.message); }
}

async function morningRefresh() {
  for (const programme of Object.keys(PROGRAMMES)) {
    await refreshFriTemplate(programme);
    for (const offset of [0, 7]) await refreshWeek(programme, isoDate(addDays(monday(), offset)), { force: true }).catch((error) => console.warn(`Morning refresh failed for ${programme}:`, error.message));
  }
  personalFriTemplates.clear();
  console.log(`Morning refresh finished at ${new Date().toISOString()}`);
}

// FRI is one page per programme, so it is also re-read whenever its copy is older than FRI_TEMPLATE_MAX_AGE_MS —
// checked shortly after start-up (a restart over 05:00 must not leave it stale) and every 15 minutes after that.
const FRI_TEMPLATE_MAX_AGE_MS = 3 * 60 * 60_000;
async function refreshStaleFriTemplates() {
  for (const programme of Object.keys(PROGRAMMES)) {
    if (Date.now() - new Date(programmeCache(programme).friTemplate?.fetchedAt || 0).getTime() > FRI_TEMPLATE_MAX_AGE_MS) {
      await yieldToPeople();
      await refreshFriTemplate(programme);
    }
  }
}
setTimeout(() => { void refreshStaleFriTemplates(); }, 20_000).unref();
setInterval(() => { void refreshStaleFriTemplates(); }, 15 * 60_000).unref();

setInterval(() => {
  const now = new Date();
  const key = `${isoDate(now)}-${now.getHours()}`;
  if (MORNING_HOURS.includes(now.getHours()) && key !== lastMorningRun) { lastMorningRun = key; void morningRefresh(); }
}, 60_000).unref();
