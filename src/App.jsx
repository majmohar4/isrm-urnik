import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_VERSION } from './version.js';

const DAY_NAMES = ['Pon', 'Tor', 'Sre', 'Čet', 'Pet'];
const FULL_DAY_NAMES = ['ponedeljek', 'torek', 'sreda', 'četrtek', 'petek'];
const LOCAL_WEEK_CACHE_KEY = 'isrm-week-cache-v1';
const LOCAL_MONTH_CACHE_KEY = 'isrm-month-cache-v1';
const LOCAL_CACHE_TTL_MS = 10 * 60_000;
const LOCAL_CACHE_RETENTION_MS = 60 * 24 * 60 * 60_000;

function monday(value = new Date()) {
  const date = new Date(value);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dateKey(date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function readLocalCache(storageKey) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const oldest = Date.now() - LOCAL_CACHE_RETENTION_MS;
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => entry?.storedAt >= oldest && entry.payload));
  } catch { return {}; }
}

function writeLocalCache(storageKey, cache, limit) {
  try {
    const retained = Object.entries(cache)
      .sort(([, left], [, right]) => right.storedAt - left.storedAt)
      .slice(0, limit);
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(retained)));
    return Object.fromEntries(retained);
  } catch { return cache; }
}

function cacheKeyFor(period, programme, studentNumber) {
  return `${programme}:${studentNumber || 'shared'}:${period}`;
}

function plusDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function monthWeekStarts(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const weeks = [];
  for (let cursor = monday(first); cursor <= last; cursor = plusDays(cursor, 7)) weeks.push(cursor);
  return weeks;
}

function formatDate(date) {
  return new Intl.DateTimeFormat('sl-SI', { day: 'numeric', month: 'short' }).format(date).replace('.', '');
}

function formatFetched(value) {
  if (!value) return 'še ni osveženo';
  return new Intl.DateTimeFormat('sl-SI', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function isNewerVersion(remote, installed) {
  const remoteParts = String(remote || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const installedParts = String(installed || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(remoteParts.length, installedParts.length); index += 1) {
    const difference = (remoteParts[index] || 0) - (installedParts[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

const isAndroidDevice = () => /Android/i.test(navigator.userAgent);
const isIosDevice = () => /iPad|iPhone|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandaloneApp = () => window.matchMedia('(display-mode: standalone)').matches || Boolean(navigator.standalone);
// Brave exposes this object on supported platforms. Its iOS user agent is not reliable,
// so the normal Safari/Chrome instructions remain available when it cannot be detected.
const isBraveBrowser = () => /Brave/i.test(navigator.userAgent) || typeof navigator.brave !== 'undefined';

function weekFromLocation() {
  const value = new URLSearchParams(window.location.search).get('week');
  const saved = window.localStorage.getItem('timetable-last-week');
  const candidate = value || saved;
  return candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? monday(`${candidate}T12:00:00`) : monday();
}

function Icon({ name, size = 20 }) {
  const shapes = {
    arrowLeft: <path d="m14 5-7 7 7 7M7 12h12" />,
    arrowRight: <path d="m10 5 7 7-7 7m7-7H5" />,
    refresh: <><path d="M20 11a8 8 0 1 0 2 5" /><path d="M20 4v7h-7" /></>,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 20h16" /></>,
    calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4m8-4v4M4 10h16" /><path d="M8 14h.01M12 14h.01M16 14h.01" /></>,
    timeline: <><path d="M5 4v16M19 4v16M5 8h14M5 14h14" /><path d="M9 6v4m4 2v5" /></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.1 2.1-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56v.1h-3v-.1a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.1-2.1.06-.06A1.7 1.7 0 0 0 7.04 15 1.7 1.7 0 0 0 5.5 13.96h-.1v-3h.1A1.7 1.7 0 0 0 7.04 9.92a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.1-2.1.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.72 4.7v-.1h3v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.1 2.1-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.04h.1v3h-.1A1.7 1.7 0 0 0 19.4 15Z" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" /><path d="M4 19a2.5 2.5 0 0 1 2.5-2.5H20" /></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}

function EventItem({ event, now, onPreview }) {
  const active = now && `${event.date}T${event.start}:00` <= now.toISOString() && `${event.date}T${event.end}:00` > now.toISOString();
  return <article className={`event event--${event.source.toLowerCase()} ${active ? 'event--active' : ''}`}>
    <button className="event__summary" onClick={() => onPreview(event)} aria-label={`Podrobnosti: ${event.title}`}>
      <time className="event__time">{event.start}<span>{event.end}</span></time>
      <div className="event__body">
        <div className="event__line"><h3>{event.title}</h3><span className="event__type">{event.type}</span></div>
        <p><Icon name="pin" size={15} />{event.room}</p>
      </div>
      <span className="event__source">{event.source}</span>
    </button>
  </article>;
}

function timeToMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function layoutTimelineEvents(events) {
  const sorted = [...events].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  const groups = [];
  let group = [];
  let groupEnd = -1;
  for (const event of sorted) {
    const start = timeToMinutes(event.start);
    const end = timeToMinutes(event.end);
    if (group.length && start >= groupEnd) { groups.push(group); group = []; groupEnd = -1; }
    group.push({ event, start, end });
    groupEnd = Math.max(groupEnd, end);
  }
  if (group.length) groups.push(group);
  return groups.flatMap((overlapGroup) => {
    const columns = [];
    const positioned = overlapGroup.map((item) => {
      let column = columns.findIndex((end) => end <= item.start);
      if (column < 0) column = columns.length;
      columns[column] = item.end;
      return { ...item, column };
    });
    return positioned.map((item) => ({
      ...item.event,
      timeline: { top: item.start - 7 * 60, height: item.end - item.start, column: item.column, columns: columns.length },
    }));
  });
}

function Timeline({ events, weekDays, onEventSelect, mode = 'week', mobileDayIndex = 0 }) {
  const hours = Array.from({ length: 14 }, (_, index) => index + 7);
  return <div className={`timeline-scroll timeline-scroll--${mode}`} aria-label={mode === 'day' ? 'Časovni dnevni urnik' : 'Časovni tedenski urnik'}>
    <div className="timeline">
      <div className="timeline__hours">{hours.map((hour) => <span key={hour} style={{ top: `${(hour - 7) * 60}px` }}>{String(hour).padStart(2, '0')}:00</span>)}</div>
      <div className="timeline__days">
        {weekDays.map((day, index) => {
          const dayEvents = layoutTimelineEvents(events.filter((event) => event.date === dateKey(day)));
          return <section className={`timeline-day ${index === mobileDayIndex ? 'is-mobile-active' : ''}`} key={dateKey(day)}>
            <header><b>{DAY_NAMES[index]}</b><span>{formatDate(day)}</span></header>
            <div className="timeline-day__body">
              {dayEvents.map((event) => <article key={event.id} className={`timeline-event timeline-event--${event.source.toLowerCase()}`} style={{ top: `${event.timeline.top}px`, height: `${Math.max(30, event.timeline.height)}px`, left: `${event.timeline.column * 100 / event.timeline.columns}%`, width: `${100 / event.timeline.columns}%` }} title={`${event.title}, ${event.start}–${event.end}, ${event.room}`} role="button" tabIndex="0" onClick={() => onEventSelect(event)} onKeyDown={(keyboardEvent) => { if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') { keyboardEvent.preventDefault(); onEventSelect(event); } }} aria-label={`Podrobnosti: ${event.title}`}>
                <time>{event.start}–{event.end}</time><strong>{event.title}</strong><span>{event.room}</span><em>{event.source}</em>
              </article>)}
            </div>
          </section>;
        })}
      </div>
    </div>
  </div>;
}

function WholeWeek({ events, weekDays, onEventSelect }) {
  return <div className="whole-week" aria-label="Celoten teden na enem zaslonu">
    {weekDays.map((day, index) => {
      const dayEvents = events.filter((event) => event.date === dateKey(day));
      return <section key={dateKey(day)} className="whole-week__day"><header><b>{DAY_NAMES[index]}</b><span>{day.getDate()}</span></header><div>{dayEvents.length ? dayEvents.map((event) => <button key={event.id} className={`whole-week__event whole-week__event--${event.source.toLowerCase()}`} onClick={() => onEventSelect(event)} aria-label={`Podrobnosti: ${event.title}`}><time>{event.start}</time><strong>{event.title}</strong><small>{event.source}</small></button>) : <span className="whole-week__empty">—</span>}</div></section>;
    })}
  </div>;
}

function MonthView({ events, month, onEventSelect, onDaySelect }) {
  const weeks = monthWeekStarts(month);
  const eventsByDay = useMemo(() => events.reduce((days, event) => {
    (days[event.date] ||= []).push(event);
    return days;
  }, {}), [events]);
  return <div className="month-view" aria-label="Mesečni urnik"><header>{FULL_DAY_NAMES.map((day) => <b key={day}>{day.slice(0, 3)}</b>)}</header><div className="month-grid">{weeks.flatMap((week) => Array.from({ length: 5 }, (_, index) => {
    const day = plusDays(week, index); const key = dateKey(day); const isCurrentMonth = day.getMonth() === month.getMonth();
    return <section className={isCurrentMonth ? '' : 'is-outside'} key={key}><button className="month-day-jump" onClick={() => onDaySelect(day)} aria-label={`Odpri ${formatDate(day)}`}><time>{day.getDate()}</time></button>{(eventsByDay[key] || []).map((event) => <button key={event.id} className={`month-event month-event--${event.source.toLowerCase()}`} onClick={() => onEventSelect(event)}><span>{event.start}</span>{event.title}</button>)}</section>;
  }))}</div></div>;
}

function PrivacyPolicy() {
  return <main className="privacy-page">
    <a className="privacy-back" href="/">Nazaj na urnik</a>
    <p className="privacy-kicker">IŠRM · FRI program</p>
    <h1>Politika zasebnosti</h1>
    <p className="privacy-lead">IŠRM je namenjen prikazu urnika. Ne uporablja računov, oglasov, analitike ali sledilnikov.</p>
    <section><h2>Podatki v tej napravi</h2><p>Izbrani letnik, videz, zadnji pogled in po želji vpisna številka se shranijo samo v lokalno shrambo tvoje naprave. Vpisno številko lahko kadarkoli odstraniš v nastavitvah. Če odkleneš urejanje dogodkov, se administratorsko geslo prav tako hrani lokalno v tem brskalniku, dokler ne počistiš podatkov brskalnika.</p></section>
    <section><h2>Osebni urnik</h2><p>Ko vključiš osebni urnik, aplikacija pošlje vpisno številko samo uradnemu strežniku urnikov FRI, da izbere tvojo skupino vaj. IŠRM je ne prodaja, ne uporablja za profiliranje in je ne zapisuje v svoj urnik-cache.</p></section>
    <section><h2>Strežnik in koledar</h2><p>Strežnik začasno hrani javne podatke urnika, da je prikaz hiter. Naročniška povezava .ics lahko vsebuje vpisno številko v naslovu, zato jo deli samo z aplikacijami, ki jim zaupaš.</p></section>
    <section><h2>Android aplikacija in pripomočki</h2><p>Android aplikacija ne zahteva dostopa do lokacije, stikov, kamer, datotek ali obvestil. Uporablja le omrežje in običajna Androidova dovoljenja za načrtovano osveževanje pripomočka. Za pripomoček shrani samo njegov način prikaza, izbrani letnik in neobvezno vpisno številko v lokalno shrambo aplikacije. Urnik se prenaša izključno prek šifrirane povezave HTTPS.</p></section>
    <section><h2>Operativna obvestila</h2><p>Če upravitelj vključi ntfy, se tja pošiljajo le tehnična obvestila o zagonu, ustavitvi in dosegljivosti virov—ne osebne vpisne številke.</p></section>
    <p className="privacy-updated">Zadnja posodobitev: 2. oktober 2026.</p>
  </main>;
}

function AndroidReleasePage() {
  const [release, setRelease] = useState(null);
  const [error, setError] = useState('');
  const installedVersion = new URLSearchParams(window.location.search).get('installed') || '';

  useEffect(() => {
    let cancelled = false;
    fetch('/api/release')
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error || 'Podatkov o izdaji ni mogoče naložiti.');
        if (!cancelled) setRelease(payload);
      })
      .catch((requestError) => { if (!cancelled) setError(requestError.message || 'Podatkov o izdaji ni mogoče naložiti.'); });
    return () => { cancelled = true; };
  }, []);

  const updateAvailable = Boolean(installedVersion && release && isNewerVersion(release.androidVersion, installedVersion));
  const downloadAvailable = Boolean(release?.androidApkUrl);
  return <main className="android-release-page">
    <a className="privacy-back" href="/">Nazaj na urnik</a>
    <p className="privacy-kicker">IŠRM za Android</p>
    <h1>Urnik, tudi brez povezave.</h1>
    <p className="android-release-lead">Native Android aplikacija shrani urnik v napravo, hitro odpre zadnje podatke in vključuje pripomočke za naslednje predavanje ali cel dan.</p>
    {error && <p className="android-release-error" role="alert">{error}</p>}
    {!release && !error && <div className="android-release-loading" aria-live="polite"><span /><span /><span /></div>}
    {release && <section className="android-release-download" aria-label="Prenos Android aplikacije">
      <div><b>{updateAvailable ? 'Posodobitev je pripravljena' : installedVersion ? 'Aplikacija je posodobljena' : 'Zadnja izdaja'}</b><strong>IŠRM {release.androidVersion}</strong><p>{updateAvailable ? `Nameščena je različica ${installedVersion}.` : 'Android 8 ali novejši · brez računov in oglasov.'}</p></div>
      {downloadAvailable ? <a href={release.androidApkUrl} className="android-release-action"><Icon name="download" size={18} />{updateAvailable ? 'Prenesi posodobitev' : 'Prenesi APK'}</a> : <p className="android-release-pending">APK še ni objavljen. Poskusi znova pozneje.</p>}
    </section>}
    <section className="android-release-notes"><h2>Kako poteka posodobitev</h2><p>Ko odpreš Android aplikacijo, sama preveri različico. Če je na voljo novejša, te odpre na tej strani, kjer z enim dotikom preneseš podpisan APK. Android zaradi varnosti nikoli ne dovoli samodejne namestitve brez tvoje potrditve. Za različico iz Trgovine Play uporabi uradno stran trgovine, ko bo objavljena.</p></section>
  </main>;
}

function App() {
  if (window.location.pathname === '/privacy') return <PrivacyPolicy />;
  if (window.location.pathname === '/android') return <AndroidReleasePage />;
  const [weekStart, setWeekStart] = useState(weekFromLocation);
  const [data, setData] = useState(null);
  const [monthEvents, setMonthEvents] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [installPrompt, setInstallPrompt] = useState(null);
  const [androidRelease, setAndroidRelease] = useState(null);
  const [installGuideOpen, setInstallGuideOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [viewMode, setViewMode] = useState(() => window.localStorage.getItem('timetable-view') || 'agenda');
  const [timelineDayIndex, setTimelineDayIndex] = useState(() => Math.max(0, new Date().getDay() - 1));
  const [theme, setTheme] = useState(() => window.localStorage.getItem('timetable-theme') || 'dark');
  const [programmeYear, setProgrammeYear] = useState(() => window.localStorage.getItem('timetable-programme-year') || '1');
  const [studentNumber, setStudentNumber] = useState(() => window.localStorage.getItem('timetable-student-number') || '');
  const [studentNumberDraft, setStudentNumberDraft] = useState(() => window.localStorage.getItem('timetable-student-number') || '');
  const [studentNumberError, setStudentNumberError] = useState('');
  const [adminPassword, setAdminPassword] = useState(() => window.localStorage.getItem('timetable-admin-password') || '');
  const [adminDraft, setAdminDraft] = useState(() => window.localStorage.getItem('timetable-admin-password') || '');
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminError, setAdminError] = useState('');
  const [customEvent, setCustomEvent] = useState({ title: '', date: dateKey(new Date()), start: '12:00', end: '13:00', room: '', programme: 'all' });
  const [eventComposerOpen, setEventComposerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [installDismissed, setInstallDismissed] = useState(false);
  const [updateNotice, setUpdateNotice] = useState(() => window.sessionStorage.getItem('isrm-pwa-updated') === '1');
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [navigationDirection, setNavigationDirection] = useState('');
  const [navigationKey, setNavigationKey] = useState(0);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const refreshRef = useRef(null);
  const refreshingRef = useRef(false);
  const weekRef = useRef(weekStart);
  const timetableCacheRef = useRef(readLocalCache(LOCAL_WEEK_CACHE_KEY));
  const monthCacheRef = useRef(readLocalCache(LOCAL_MONTH_CACHE_KEY));
  const timetableRequestRef = useRef(null);
  const pendingLoadRef = useRef(null);

  const weekKey = dateKey(weekStart);
  const monthKey = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}`;
  const weekDays = useMemo(() => Array.from({ length: 5 }, (_, index) => plusDays(weekStart, index)), [weekStart]);
  const todayKey = dateKey(new Date());

  const load = (refresh = false) => {
    const localKey = cacheKeyFor(weekKey, programmeYear, studentNumber);
    const cached = timetableCacheRef.current[localKey];
    const cacheIsFresh = cached && Date.now() - cached.storedAt < LOCAL_CACHE_TTL_MS;
    if (pendingLoadRef.current) {
      window.clearTimeout(pendingLoadRef.current.timer);
      pendingLoadRef.current.resolve();
      pendingLoadRef.current = null;
    }
    timetableRequestRef.current?.abort();
    if (cached) {
      setData(cached.payload);
      setError('');
      setLoading(false);
      if (!refresh && cacheIsFresh) return Promise.resolve();
    } else setLoading(true);
    const controller = new AbortController();
    timetableRequestRef.current = controller;
    const request = async () => {
      try {
        const response = await fetch(`/api/timetable?week=${weekKey}&programme=${programmeYear}${studentNumber ? `&student=${encodeURIComponent(studentNumber)}` : ''}${refresh ? '&refresh=1' : ''}`, { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok && !payload.events?.length) throw new Error(payload.error || 'Povezava z urnikom ni uspela.');
        if (timetableRequestRef.current !== controller) return;
        setData(payload);
        timetableCacheRef.current[localKey] = { storedAt: Date.now(), payload };
        timetableCacheRef.current = writeLocalCache(LOCAL_WEEK_CACHE_KEY, timetableCacheRef.current, 24);
        setError(response.ok ? '' : payload.error || 'Prikazani so zadnji shranjeni podatki.');
      } catch (requestError) {
        if (requestError.name !== 'AbortError' && timetableRequestRef.current === controller) setError(requestError.message || 'Povezava z urnikom ni uspela.');
      } finally {
        if (timetableRequestRef.current === controller) setLoading(false);
      }
    };
    return new Promise((resolve) => {
      const delay = refresh ? 0 : 140;
      const run = () => { pendingLoadRef.current = null; request().finally(resolve); };
      if (delay) pendingLoadRef.current = { timer: window.setTimeout(run, delay), resolve };
      else run();
    });
  };
  refreshRef.current = () => load(true);

  useEffect(() => { setSelectedEvent(null); load(); }, [weekKey, programmeYear, studentNumber]);
  useEffect(() => { window.localStorage.setItem('timetable-last-week', weekKey); }, [weekKey]);
  useEffect(() => {
    if (viewMode !== 'month') return;
    let cancelled = false;
    const localKey = cacheKeyFor(monthKey, programmeYear, studentNumber);
    const cached = monthCacheRef.current[localKey];
    if (cached) setMonthEvents(cached.payload.events || []);
    if (cached && Date.now() - cached.storedAt < LOCAL_CACHE_TTL_MS) return undefined;
    fetch(`/api/month?month=${monthKey}&programme=${programmeYear}${studentNumber ? `&student=${encodeURIComponent(studentNumber)}` : ''}`)
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (!response.ok || cancelled) return;
        setMonthEvents(payload.events || []);
        monthCacheRef.current[localKey] = { storedAt: Date.now(), payload };
        monthCacheRef.current = writeLocalCache(LOCAL_MONTH_CACHE_KEY, monthCacheRef.current, 8);
      })
      .catch(() => { if (!cancelled && !cached) setMonthEvents([]); });
    return () => { cancelled = true; };
  }, [viewMode, monthKey, programmeYear, studentNumber]);
  useEffect(() => { weekRef.current = weekStart; }, [weekStart]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.get('week')) {
      url.searchParams.set('week', weekKey);
      window.history.replaceState({ week: weekKey }, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') setSelectedEvent(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    const onPopState = () => {
      const nextWeek = weekFromLocation();
      setNavigationDirection(nextWeek < weekRef.current ? 'back' : 'forward');
      setNavigationKey((value) => value + 1);
      setWeekStart(nextWeek);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    let startY = null;
    let startX = null;
    let distance = 0;
    let active = false;
    const reset = () => { startY = null; startX = null; distance = 0; active = false; setPullDistance(0); setSwipeOffset(0); };
    const onStart = (event) => {
      if (refreshingRef.current || window.scrollY > 0 || event.touches.length !== 1 || !event.target.closest('.schedule')) return;
      startY = event.touches[0].clientY;
      startX = event.touches[0].clientX;
      active = true;
    };
    const onMove = (event) => {
      if (!active || startY === null || window.scrollY > 0) return;
      const delta = event.touches[0].clientY - startY;
      const horizontal = startX === null ? 0 : event.touches[0].clientX - startX;
      if (Math.abs(horizontal) > 10 && Math.abs(horizontal) > Math.abs(delta)) {
        setSwipeOffset(Math.max(-46, Math.min(46, horizontal * .2)));
        event.preventDefault();
        return;
      }
      if (delta <= 0) { setPullDistance(0); return; }
      distance = Math.min(108, delta * 0.46);
      setPullDistance(distance);
      event.preventDefault();
    };
    const onEnd = (event) => {
      const horizontal = startX === null ? 0 : event.changedTouches[0].clientX - startX;
      if (Math.abs(horizontal) > 70 && Math.abs(horizontal) > Math.abs(distance)) {
        const nextWeek = plusDays(weekRef.current, horizontal > 0 ? -7 : 7);
        const nextKey = dateKey(nextWeek);
        setNavigationDirection(horizontal > 0 ? 'back' : 'forward');
        setNavigationKey((value) => value + 1);
        setWeekStart(nextWeek);
        const url = new URL(window.location.href);
        url.searchParams.set('week', nextKey);
        window.history.pushState({ week: nextKey }, '', `${url.pathname}${url.search}${url.hash}`);
        reset();
        return;
      }
      const shouldRefresh = active && distance >= 62;
      reset();
      if (!shouldRefresh || refreshingRef.current) return;
      refreshingRef.current = true;
      setPullRefreshing(true);
      setPullDistance(62);
      Promise.resolve(refreshRef.current?.()).finally(() => {
        refreshingRef.current = false;
        setPullRefreshing(false);
        setPullDistance(0);
      });
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', reset);
    };
  }, []);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => { window.localStorage.setItem('timetable-view', viewMode); }, [viewMode]);
  useEffect(() => {
    console.info(`[IŠRM] App version ${APP_VERSION}`);
    if (updateNotice) window.sessionStorage.removeItem('isrm-pwa-updated');
  }, [updateNotice]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('timetable-theme', theme);
  }, [theme]);
  useEffect(() => { window.localStorage.setItem('timetable-programme-year', programmeYear); }, [programmeYear]);
  useEffect(() => {
    const listen = (event) => { event.preventDefault(); setInstallPrompt(event); };
    window.addEventListener('beforeinstallprompt', listen);
    return () => window.removeEventListener('beforeinstallprompt', listen);
  }, []);
  useEffect(() => {
    if (!isAndroidDevice()) return undefined;
    let cancelled = false;
    fetch('/api/release')
      .then((response) => response.ok ? response.json() : null)
      .then((release) => { if (!cancelled) setAndroidRelease(release); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const events = data?.events || [];
  const subscriptionUrl = `${window.location.origin}/api/calendar/subscription?programme=${programmeYear}${studentNumber ? `&student=${encodeURIComponent(studentNumber)}` : ''}`;
  const sourceIssues = data?.sources ? Object.entries(data.sources).filter(([, status]) => !status.ok) : [];
  const navigateWeek = (nextWeek, direction) => {
    const nextKey = dateKey(nextWeek);
    setNavigationDirection(direction);
    setNavigationKey((value) => value + 1);
    setWeekStart(nextWeek);
    const url = new URL(window.location.href);
    url.searchParams.set('week', nextKey);
    window.history.pushState({ week: nextKey }, '', `${url.pathname}${url.search}${url.hash}`);
  };
  const previousWeek = () => navigateWeek(plusDays(weekStart, -7), 'back');
  const nextWeek = () => navigateWeek(plusDays(weekStart, 7), 'forward');
  const install = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; setInstallPrompt(null); setInstallGuideOpen(false); };
  const copySubscription = async () => {
    try { await navigator.clipboard.writeText(subscriptionUrl); setCopyStatus('Povezava kopirana'); }
    catch { setCopyStatus('Kopiranje ni uspelo'); }
  };
  const saveStudentNumber = async () => {
    const next = studentNumberDraft.trim();
    if (next && !/^\d{6,16}$/.test(next)) { setStudentNumberError('Vnesi številko z 6–16 števkami.'); return; }
    if (!next) { setStudentNumberError(''); setStudentNumber(''); window.localStorage.removeItem('timetable-student-number'); return; }
    try {
      setStudentNumberError('Preverjam letnik …');
      const response = await fetch(`/api/student-programme?student=${encodeURIComponent(next)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Letnika ni bilo mogoče prepoznati.');
      setProgrammeYear(payload.programme);
      setStudentNumber(next);
      window.localStorage.setItem('timetable-student-number', next);
      window.localStorage.setItem('timetable-programme-year', payload.programme);
      setStudentNumberError(`Izbran je ${payload.programmeLabel}. letnik.`);
    } catch (requestError) { setStudentNumberError(requestError.message || 'Letnika ni bilo mogoče prepoznati.'); }
  };
  const openMonthDay = (day) => {
    const nextWeek = monday(day);
    setTimelineDayIndex(Math.max(0, Math.min(4, day.getDay() - 1)));
    setViewMode('timeline');
    navigateWeek(nextWeek, nextWeek < weekStart ? 'back' : 'forward');
  };
  const adminRequest = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-isrm-admin-password': adminDraft || adminPassword }, body: JSON.stringify(body || {}) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Administratorska zahteva ni uspela.');
    return payload;
  };
  const unlockAdmin = async () => {
    try { await adminRequest('/api/admin/verify'); setAdminPassword(adminDraft); window.localStorage.setItem('timetable-admin-password', adminDraft); setAdminUnlocked(true); setAdminError(''); }
    catch (requestError) { setAdminError(requestError.message); }
  };
  const openEventComposer = () => {
    setAdminError('');
    setCustomEvent({ title: '', date: weekKey, start: '12:00', end: '13:00', room: '', programme: programmeYear });
    setEventComposerOpen(true);
  };
  const addCustomEvent = async (submitEvent) => {
    submitEvent?.preventDefault();
    if (!customEvent.title.trim()) { setAdminError('Vnesi naslov dogodka.'); return; }
    try {
      const { event } = await adminRequest('/api/admin/events', { ...customEvent, title: customEvent.title.trim(), programme: programmeYear });
      const eventWeek = monday(`${event.date}T12:00:00`);
      if (dateKey(eventWeek) !== weekKey) {
        setEventComposerOpen(false);
        navigateWeek(eventWeek, eventWeek < weekStart ? 'back' : 'forward');
        setAdminError('');
        return;
      }
      setData((current) => {
        if (!current) return current;
        const payload = { ...current, events: [...current.events.filter((item) => item.id !== event.id), event].sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`)) };
        const localKey = cacheKeyFor(weekKey, programmeYear, studentNumber);
        timetableCacheRef.current[localKey] = { storedAt: Date.now(), payload };
        timetableCacheRef.current = writeLocalCache(LOCAL_WEEK_CACHE_KEY, timetableCacheRef.current, 24);
        return payload;
      });
      if (event.date.slice(0, 7) === weekKey.slice(0, 7)) setMonthEvents((current) => [...current.filter((item) => item.id !== event.id), event].sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`)));
      setEventComposerOpen(false);
      setAdminError('');
    }
    catch (requestError) { setAdminError(requestError.message); }
  };

  const pullOffset = Math.min(72, pullDistance) - 82;
  return <main className="app-shell">
    {updateNotice && <aside className="update-sheet" role="status" aria-live="polite"><div><b>The app has been updated to {APP_VERSION}.</b></div><button onClick={() => setUpdateNotice(false)} aria-label="Close update notice"><Icon name="close" size={17} /></button></aside>}
    {(pullDistance > 0 || pullRefreshing) && <div className={`pull-refresh ${pullRefreshing ? 'is-refreshing' : ''} ${pullDistance >= 62 ? 'is-ready' : ''}`} style={{ transform: `translate(-50%, ${pullOffset}px)` }} role="status" aria-live="polite"><span className="pull-refresh__icon"><Icon name="refresh" size={16} /></span><span>{pullRefreshing ? 'Osvežujem urnik' : pullDistance >= 62 ? 'Spusti za osvežitev' : 'Povleci za osvežitev'}</span></div>}
    <header className="topbar">
      <a className="brand" href="#top" aria-label="IŠRM, začetek"><span className="brand__mark"><Icon name="grid" size={19} /></span><span>IŠRM<br /><small>{programmeYear}. letnik · FRI program</small></span></a>
      <div className="topbar__right">
        <button className="theme-toggle" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} aria-pressed={theme === 'dark'} aria-label={theme === 'dark' ? 'Vklopi svetli videz' : 'Vklopi temni videz'}><Icon name="moon" size={16} /><span>{theme === 'dark' ? 'Svetlo' : 'Temno'}</span></button>
        <div className="export-wrap"><button className="export-button" onClick={() => setExportOpen((open) => !open)} aria-expanded={exportOpen}><Icon name="calendar" size={16} /><span>Koledar .ics</span></button>{exportOpen && <div className="export-menu" role="dialog" aria-label="Izvoz koledarja"><a href={`/api/calendar?week=${encodeURIComponent(weekKey)}&programme=${programmeYear}${studentNumber ? `&student=${encodeURIComponent(studentNumber)}` : ''}`} download={`isrm-${programmeYear}-letnik-${weekKey}.ics`} onClick={() => setExportOpen(false)}>Prenesi ta teden</a><button onClick={copySubscription}>{studentNumber ? 'Kopiraj osebno povezavo' : 'Kopiraj naročniško povezavo'}</button><small>{copyStatus || (studentNumber ? 'Vključene so tvoje FRI vaje.' : 'Povezava se samodejno posodablja.')}</small></div>}</div>
        <div className="settings-wrap">
          <button className="icon-button" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen} aria-label="Nastavitve programa"><Icon name="settings" /></button>
          {settingsOpen && <div className="settings-menu" role="dialog" aria-label="Nastavitve programa">
            <span>Program</span>
            <div className="year-switch" role="group" aria-label="Letnik programa">{['1', '2', '3'].map((year) => <button key={year} className={programmeYear === year ? 'is-selected' : ''} onClick={() => setProgrammeYear(year)} aria-pressed={programmeYear === year}>{year}. letnik</button>)}</div>
            <label className="student-number"><b>Vpisna številka</b><input value={studentNumberDraft} onChange={(event) => setStudentNumberDraft(event.target.value.replace(/\D/g, ''))} inputMode="numeric" autoComplete="off" placeholder="Za osebni urnik" /><small>Izbere tvojo FRI skupino pri prekrivanju vaj.</small></label>
            <div className="settings-actions"><button onClick={saveStudentNumber}>Shrani</button>{studentNumber && <button onClick={() => { setStudentNumberDraft(''); setStudentNumber(''); window.localStorage.removeItem('timetable-student-number'); }}>Odstrani</button>}</div>
            <label className="student-number"><b>Admin</b><input type="password" value={adminDraft} onChange={(event) => setAdminDraft(event.target.value)} autoComplete="current-password" placeholder="Geslo za urejanje" /></label>
            {!adminUnlocked ? <div className="settings-actions"><button onClick={unlockAdmin}>Odpri urejanje</button></div> : <p className="admin-unlocked">Urejanje je odklenjeno. Dodaj dogodek z gumbom + spodaj.</p>}
            {(studentNumberError || adminError) && <p className="settings-error" role="alert">{studentNumberError || adminError}</p>}
            <small>{studentNumber ? 'Osebni urnik je vključen.' : 'Shranjeno v tej napravi'}</small>
          </div>}
        </div>
        <button className="icon-button" onClick={() => load(true)} disabled={loading} aria-label="Osveži urnik"><Icon name="refresh" /></button>
      </div>
    </header>

    <div>
    <div className="week-control-row">
    <section className="week-control" aria-label="Izbira tedna">
      <button className="week-arrow" onClick={previousWeek} aria-label="Prejšnji teden"><Icon name="arrowLeft" /></button>
      <button className="week-title" onClick={() => navigateWeek(monday(), 'back')}><span>{formatDate(weekDays[0])} — {formatDate(weekDays[4])}</span><small>Osveženo {formatFetched(data?.fetchedAt)}</small></button>
      <button className="week-arrow" onClick={nextWeek} aria-label="Naslednji teden"><Icon name="arrowRight" /></button>
    </section>
    <button className="today-button" onClick={() => navigateWeek(monday(), 'back')} disabled={weekKey === dateKey(monday())} aria-label="Pojdi na trenutni teden">Danes</button>
    </div>

    {(error || sourceIssues.length > 0) && <div className="notice" role="status">{error || `Pozor: ${sourceIssues.map(([source, status]) => `${source} (${status.message || 'vir ni dosegljiv'})`).join('; ')}. Prikazani so zadnji uspešno shranjeni podatki.`}</div>}

    <section key={`${weekKey}-${navigationKey}`} className={`schedule week-content week-content--${navigationDirection} ${swipeOffset ? 'is-swiping' : ''}`} style={{ '--week-swipe': `${swipeOffset}px` }} aria-label="Tedenski urnik">
      <div className="schedule__heading"><h2>Urnik</h2><div><span>{events.length} {events.length === 1 ? 'obveznost' : 'obveznosti'}</span><div className="view-modes" role="group" aria-label="Prikaz urnika"><button className={viewMode === 'agenda' ? 'is-selected' : ''} onClick={() => setViewMode('agenda')} aria-pressed={viewMode === 'agenda'}>Seznam</button><button className={viewMode === 'timeline' ? 'is-selected' : ''} onClick={() => setViewMode('timeline')} aria-pressed={viewMode === 'timeline'}>Časovni</button><button className={viewMode === 'week' ? 'is-selected' : ''} onClick={() => setViewMode('week')} aria-pressed={viewMode === 'week'}>Teden</button><button className={viewMode === 'month' ? 'is-selected' : ''} onClick={() => setViewMode('month')} aria-pressed={viewMode === 'month'}>Mesec</button></div></div></div>
      {viewMode === 'agenda' && <div className="weekday-tabs">{weekDays.map((day, index) => <a key={dateKey(day)} href={`#day-${index}`} className={dateKey(day) === todayKey ? 'is-today' : ''}><b>{DAY_NAMES[index]}</b><span>{day.getDate()}</span></a>)}</div>}
      {viewMode === 'timeline' && <div className="timeline-day-switch" role="group" aria-label="Dan v časovnem pogledu">{weekDays.map((day, index) => <button key={dateKey(day)} className={timelineDayIndex === index ? 'is-selected' : ''} onClick={() => setTimelineDayIndex(index)} aria-pressed={timelineDayIndex === index}><b>{DAY_NAMES[index]}</b><span>{day.getDate()}</span></button>)}</div>}
      {loading && !data ? <div className="schedule-skeleton">{Array.from({ length: 5 }, (_, index) => <span key={index} />)}</div> : viewMode === 'timeline' ? <Timeline events={events} weekDays={weekDays} onEventSelect={setSelectedEvent} mode="day" mobileDayIndex={timelineDayIndex} /> : viewMode === 'week' ? <Timeline events={events} weekDays={weekDays} onEventSelect={setSelectedEvent} mode="week" /> : viewMode === 'month' ? <MonthView events={monthEvents} month={weekStart} onEventSelect={setSelectedEvent} onDaySelect={openMonthDay} /> : <div className="agenda">
        {weekDays.map((day, index) => {
          const dayEvents = events.filter((event) => event.date === dateKey(day));
          return <section className="agenda-day" id={`day-${index}`} key={dateKey(day)}>
            <header><span>{FULL_DAY_NAMES[index]}</span><time>{formatDate(day)}</time></header>
            {dayEvents.length ? dayEvents.map((event) => <EventItem key={event.id} event={event} now={now} onPreview={setSelectedEvent} />) : <p className="no-events">Brez obveznosti</p>}
          </section>;
        })}
      </div>}
    </section>
    </div>

    {selectedEvent && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setSelectedEvent(null)}><section className={`lesson-dialog lesson-dialog--${selectedEvent.source.toLowerCase()}`} role="dialog" aria-modal="true" aria-label={`Podrobnosti: ${selectedEvent.title}`} onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lesson-faculty"><b>{selectedEvent.source}</b><i>{selectedEvent.source === 'FRI' ? 'Računalništvo in informatika' : selectedEvent.source === 'FMF' ? 'Matematika in fizika' : 'Skupni dogodek'}</i></span><span className="lesson-type">{selectedEvent.type}</span><h2>{selectedEvent.title}</h2></div><button className="lesson-close" onClick={() => setSelectedEvent(null)} aria-label="Zapri podrobnosti"><Icon name="close" size={18} /></button></header><div className="lesson-details"><div><b>Termin</b><span>{new Intl.DateTimeFormat('sl-SI', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${selectedEvent.date}T12:00:00`))}</span><strong>{selectedEvent.start}–{selectedEvent.end}</strong></div><div><b>Prostor</b><strong>{selectedEvent.room || 'Ni podatka'}</strong></div><div><b>Izvajalec</b><strong>{selectedEvent.teacher || 'Ni podatka'}</strong></div></div></section></div>}

    {adminUnlocked && <button className="event-fab" onClick={openEventComposer} aria-label="Dodaj dogodek"><Icon name="plus" size={21} /><span>Dodaj</span></button>}
    {eventComposerOpen && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setEventComposerOpen(false)}><section className="lesson-dialog event-composer" role="dialog" aria-modal="true" aria-labelledby="event-composer-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lesson-faculty"><b>IŠRM</b><i>{programmeYear}. letnik</i></span><h2 id="event-composer-title">Dodaj dogodek</h2></div><button className="lesson-close" onClick={() => setEventComposerOpen(false)} aria-label="Zapri dodajanje dogodka"><Icon name="close" size={18} /></button></header><p>Dogodek bo viden celotnemu {programmeYear}. letniku v prikazanem tednu.</p><form onSubmit={addCustomEvent}><label><b>Naslov</b><input value={customEvent.title} onChange={(event) => setCustomEvent((value) => ({ ...value, title: event.target.value }))} placeholder="Npr. Izpit" autoFocus required /></label><label><b>Datum</b><input type="date" value={customEvent.date} onChange={(event) => setCustomEvent((value) => ({ ...value, date: event.target.value }))} required /></label><div className="event-composer__times"><label><b>Začetek</b><input type="time" value={customEvent.start} onChange={(event) => setCustomEvent((value) => ({ ...value, start: event.target.value }))} required /></label><label><b>Konec</b><input type="time" value={customEvent.end} onChange={(event) => setCustomEvent((value) => ({ ...value, end: event.target.value }))} required /></label></div><label><b>Lokacija <small>neobvezno</small></b><input value={customEvent.room} onChange={(event) => setCustomEvent((value) => ({ ...value, room: event.target.value }))} placeholder="Npr. P.01" /></label>{adminError && <p className="settings-error" role="alert">{adminError}</p>}<div className="event-composer__actions"><button type="button" onClick={() => setEventComposerOpen(false)}>Prekliči</button><button type="submit">Dodaj dogodek</button></div></form></section></div>}

    <footer className="footer"><span>IŠRM · FRI × FMF</span><div className="footer-links">{isAndroidDevice() && androidRelease?.androidApkUrl ? <a className="footer-install" href={androidRelease.androidApkUrl}><Icon name="download" size={14} />Prenesi APK</a> : <button className="footer-install" onClick={installPrompt ? install : () => setInstallGuideOpen(true)}><Icon name="download" size={14} />Namesti PWA</button>}<a href="/privacy">Zasebnost</a></div><div className="source-statuses">{['FRI', 'FMF'].map((source) => <span key={source} className={data?.sources?.[source]?.ok ? 'ok' : 'warning'}><b />{source}</span>)}</div></footer>
    {isAndroidDevice() && androidRelease?.androidApkUrl && !installDismissed && <aside className="install-banner android-install-banner" aria-label="Prenos Android aplikacije"><span className="install-banner__mark"><Icon name="grid" size={17} /></span><div><strong>Namesti IŠRM za Android</strong><p>Native aplikacija {androidRelease.androidVersion} z delovanjem brez povezave in pripomočki.</p></div><a className="install-banner__action" href={androidRelease.androidApkUrl}><Icon name="download" size={16} />Prenesi</a><button className="install-banner__close" onClick={() => setInstallDismissed(true)} aria-label="Zapri obvestilo"><Icon name="close" size={16} /></button></aside>}
    {isIosDevice() && !isStandaloneApp() && !installDismissed && <aside className="install-banner" aria-label="Namestitev IŠRM na iPhone"><span className="install-banner__mark"><Icon name="grid" size={17} /></span><div><strong>Namesti IŠRM</strong><p>{isBraveBrowser() ? 'Brave na iPhonu ni zanesljiv za PWA. Odpri stran v Chromu ali Safariju.' : 'V Safariju ali Chromu izberi Deli in nato Add to Home Screen.'}</p></div><button className="install-banner__action" onClick={() => setInstallGuideOpen(true)}><Icon name="download" size={16} />Navodila</button><button className="install-banner__close" onClick={() => setInstallDismissed(true)} aria-label="Zapri obvestilo"><Icon name="close" size={16} /></button></aside>}
    {!isIosDevice() && !androidRelease?.androidApkUrl && installPrompt && !installDismissed && <aside className="install-banner" aria-label="Namestitev aplikacije"><span className="install-banner__mark"><Icon name="grid" size={17} /></span><div><strong>Namesti IŠRM</strong><p>Dodaj urnik na začetni zaslon za hitrejši dostop.</p></div><button className="install-banner__action" onClick={install}><Icon name="download" size={16} />Namesti</button><button className="install-banner__close" onClick={() => setInstallDismissed(true)} aria-label="Zapri obvestilo"><Icon name="close" size={16} /></button></aside>}
    {installGuideOpen && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setInstallGuideOpen(false)}><section className="lesson-dialog install-guide" role="dialog" aria-modal="true" aria-labelledby="install-guide-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lesson-faculty"><b>IŠRM</b><i>Namestitev</i></span><h2 id="install-guide-title">Namesti aplikacijo</h2></div><button className="lesson-close" onClick={() => setInstallGuideOpen(false)} aria-label="Zapri navodila za namestitev"><Icon name="close" size={18} /></button></header>{isAndroidDevice() && androidRelease?.androidApkUrl ? <><p>Namesti native Android aplikacijo z delovanjem brez povezave in pripomočki.</p><a className="android-release-action" href={androidRelease.androidApkUrl}><Icon name="download" size={18} />Prenesi IŠRM {androidRelease.androidVersion}</a></> : isIosDevice() ? <><p>{isBraveBrowser() ? 'Brave na iPhonu lahko doda le zaznamek. Za pravo PWA namestitev najprej odpri IŠRM v Chromu ali Safariju.' : 'Za PWA namestitev odpri IŠRM v Chromu ali Safariju.'}</p><ol><li>Tapni gumb Deli v spodnji vrstici brskalnika.</li><li>Izberi Add to Home Screen.</li><li>Potrdi Dodaj.</li></ol></> : installPrompt ? <><p>Dodaj IŠRM na začetni zaslon za hitrejši dostop in delovanje brez povezave.</p><button className="android-release-action" onClick={install}><Icon name="download" size={18} />Namesti PWA</button></> : <p>V meniju brskalnika izberi Install app oziroma Namesti aplikacijo.</p>}</section></div>}
  </main>;
}

export default App;
