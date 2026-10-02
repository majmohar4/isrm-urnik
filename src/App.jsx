import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_VERSION } from './version.js';

const DAY_NAMES = ['Pon', 'Tor', 'Sre', 'Čet', 'Pet'];
const FULL_DAY_NAMES = ['ponedeljek', 'torek', 'sreda', 'četrtek', 'petek'];

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
    <section><h2>Podatki v tej napravi</h2><p>Izbrani letnik, videz, zadnji pogled in po želji vpisna številka se shranijo samo v lokalno shrambo tvoje naprave. Vpisno številko lahko kadarkoli odstraniš v nastavitvah.</p></section>
    <section><h2>Osebni urnik</h2><p>Ko vključiš osebni urnik, aplikacija pošlje vpisno številko samo uradnemu strežniku urnikov FRI, da izbere tvojo skupino vaj. IŠRM je ne prodaja, ne uporablja za profiliranje in je ne zapisuje v svoj urnik-cache.</p></section>
    <section><h2>Strežnik in koledar</h2><p>Strežnik začasno hrani javne podatke urnika, da je prikaz hiter. Naročniška povezava .ics lahko vsebuje vpisno številko v naslovu, zato jo deli samo z aplikacijami, ki jim zaupaš.</p></section>
    <section><h2>Android aplikacija in pripomočki</h2><p>Android aplikacija ne zahteva dostopa do lokacije, stikov, kamer, datotek ali obvestil. Uporablja le omrežje in običajna Androidova dovoljenja za načrtovano osveževanje pripomočka. Za pripomoček shrani samo njegov način prikaza, izbrani letnik in neobvezno vpisno številko v lokalno shrambo aplikacije. Pripomoček bere urnik prek povezave, ki jo nastaviš.</p></section>
    <section><h2>Operativna obvestila</h2><p>Če upravitelj vključi ntfy, se tja pošiljajo le tehnična obvestila o zagonu, ustavitvi in dosegljivosti virov—ne osebne vpisne številke.</p></section>
    <p className="privacy-updated">Zadnja posodobitev: 2. oktober 2026.</p>
  </main>;
}

function App() {
  if (window.location.pathname === '/privacy') return <PrivacyPolicy />;
  const [weekStart, setWeekStart] = useState(weekFromLocation);
  const [data, setData] = useState(null);
  const [monthEvents, setMonthEvents] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [installPrompt, setInstallPrompt] = useState(null);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [installDismissed, setInstallDismissed] = useState(false);
  const [updateNotice, setUpdateNotice] = useState(() => window.sessionStorage.getItem('isrm-pwa-updated') === '1');
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [navigationDirection, setNavigationDirection] = useState('');
  const [navigationKey, setNavigationKey] = useState(0);
  const refreshRef = useRef(null);
  const refreshingRef = useRef(false);
  const weekRef = useRef(weekStart);

  const weekKey = dateKey(weekStart);
  const weekDays = useMemo(() => Array.from({ length: 5 }, (_, index) => plusDays(weekStart, index)), [weekStart]);
  const todayKey = dateKey(new Date());

  const load = async (refresh = false) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/timetable?week=${weekKey}&programme=${programmeYear}${studentNumber ? `&student=${encodeURIComponent(studentNumber)}` : ''}${refresh ? '&refresh=1' : ''}`);
      const payload = await response.json();
      if (!response.ok && !payload.events?.length) throw new Error(payload.error || 'Povezava z urnikom ni uspela.');
      setData(payload);
      setError(response.ok ? '' : payload.error || 'Prikazani so zadnji shranjeni podatki.');
    } catch (requestError) {
      setError(requestError.message || 'Povezava z urnikom ni uspela.');
    } finally { setLoading(false); }
  };
  refreshRef.current = () => load(true);

  useEffect(() => { setSelectedEvent(null); load(); }, [weekKey, programmeYear, studentNumber]);
  useEffect(() => { window.localStorage.setItem('timetable-last-week', weekKey); }, [weekKey]);
  useEffect(() => {
    if (viewMode !== 'month') return;
    let cancelled = false;
    const monthKey = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}`;
    fetch(`/api/month?month=${monthKey}&programme=${programmeYear}${studentNumber ? `&student=${encodeURIComponent(studentNumber)}` : ''}`)
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => { if (!cancelled) setMonthEvents(response.ok ? payload.events || [] : []); })
      .catch(() => { if (!cancelled) setMonthEvents([]); });
    return () => { cancelled = true; };
  }, [viewMode, weekKey, programmeYear, studentNumber]);
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
    const reset = () => { startY = null; startX = null; distance = 0; active = false; setPullDistance(0); };
    const onStart = (event) => {
      if (refreshingRef.current || window.scrollY > 0 || event.touches.length !== 1 || !event.target.closest('.schedule')) return;
      startY = event.touches[0].clientY;
      startX = event.touches[0].clientX;
      active = true;
    };
    const onMove = (event) => {
      if (!active || startY === null || window.scrollY > 0) return;
      const delta = event.touches[0].clientY - startY;
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
  const install = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; setInstallPrompt(null); };
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
  const addCustomEvent = async () => {
    try { await adminRequest('/api/admin/events', customEvent); setCustomEvent((event) => ({ ...event, title: '', room: '' })); setAdminError('Dogodek je dodan.'); load(true); }
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
        <div className="settings-wrap"><button className="icon-button" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen} aria-label="Nastavitve programa"><Icon name="settings" /></button>{settingsOpen && <div className="settings-menu" role="dialog" aria-label="Nastavitve programa"><span>Program</span><div className="year-switch" role="group" aria-label="Letnik programa">{['1', '2', '3'].map((year) => <button key={year} className={programmeYear === year ? 'is-selected' : ''} onClick={() => setProgrammeYear(year)} aria-pressed={programmeYear === year}>{year}. letnik</button>)}</div><label className="student-number"><b>Vpisna številka</b><input value={studentNumberDraft} onChange={(event) => setStudentNumberDraft(event.target.value.replace(/\D/g, ''))} inputMode="numeric" autoComplete="off" placeholder="Za osebni urnik" /><small>Izbere tvojo FRI skupino pri prekrivanju vaj.</small></label><div className="settings-actions"><button onClick={saveStudentNumber}>Shrani</button>{studentNumber && <button onClick={() => { setStudentNumberDraft(''); setStudentNumber(''); window.localStorage.removeItem('timetable-student-number'); }}>Odstrani</button>}</div><label className="student-number"><b>Admin</b><input type="password" value={adminDraft} onChange={(event) => setAdminDraft(event.target.value)} autoComplete="current-password" placeholder="Geslo za urejanje" /></label>{!adminUnlocked ? <div className="settings-actions"><button onClick={unlockAdmin}>Odpri urejanje</button></div> : <div className="admin-events"><b>Dodaj dogodek</b><input value={customEvent.title} onChange={(event) => setCustomEvent((value) => ({ ...value, title: event.target.value }))} placeholder="Naslov" /><input type="date" value={customEvent.date} onChange={(event) => setCustomEvent((value) => ({ ...value, date: event.target.value }))} /><div><input type="time" value={customEvent.start} onChange={(event) => setCustomEvent((value) => ({ ...value, start: event.target.value }))} /><input type="time" value={customEvent.end} onChange={(event) => setCustomEvent((value) => ({ ...value, end: event.target.value }))} /></div><input value={customEvent.room} onChange={(event) => setCustomEvent((value) => ({ ...value, room: event.target.value }))} placeholder="Lokacija (neobvezno)" /><select value={customEvent.programme} onChange={(event) => setCustomEvent((value) => ({ ...value, programme: event.target.value }))}><option value="all">Vsi letniki</option><option value="1">1. letnik</option><option value="2">2. letnik</option><option value="3">3. letnik</option></select><div className="settings-actions"><button onClick={addCustomEvent}>Dodaj</button></div></div>}{(studentNumberError || adminError) && <p className="settings-error" role="alert">{studentNumberError || adminError}</p>}<small>{studentNumber ? 'Osebni urnik je vključen.' : 'Shranjeno v tej napravi'}</small></div>}</div>
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

    <section key={`${weekKey}-${navigationKey}`} className={`schedule week-content week-content--${navigationDirection}`} aria-label="Tedenski urnik">
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

    {selectedEvent && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setSelectedEvent(null)}><section className={`lesson-dialog lesson-dialog--${selectedEvent.source.toLowerCase()}`} role="dialog" aria-modal="true" aria-label={`Podrobnosti: ${selectedEvent.title}`} onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lesson-faculty"><b>{selectedEvent.source}</b><i>{selectedEvent.source === 'FRI' ? 'Računalništvo in informatika' : 'Matematika in fizika'}</i></span><span className="lesson-type">{selectedEvent.type}</span><h2>{selectedEvent.title}</h2></div><button className="lesson-close" onClick={() => setSelectedEvent(null)} aria-label="Zapri podrobnosti"><Icon name="close" size={18} /></button></header><div className="lesson-details"><div><b>Termin</b><span>{new Intl.DateTimeFormat('sl-SI', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${selectedEvent.date}T12:00:00`))}</span><strong>{selectedEvent.start}–{selectedEvent.end}</strong></div><div><b>Prostor</b><strong>{selectedEvent.room || 'Ni podatka'}</strong></div><div><b>Izvajalec</b><strong>{selectedEvent.teacher || 'Ni podatka'}</strong></div></div></section></div>}

    <footer className="footer"><span>IŠRM · FRI × FMF</span><a href="/privacy">Zasebnost</a><div className="source-statuses">{['FRI', 'FMF'].map((source) => <span key={source} className={data?.sources?.[source]?.ok ? 'ok' : 'warning'}><b />{source}</span>)}</div></footer>
    {installPrompt && !installDismissed && <aside className="install-banner" aria-label="Namestitev aplikacije"><span className="install-banner__mark"><Icon name="grid" size={17} /></span><div><strong>Namesti IŠRM</strong><p>Dodaj urnik na začetni zaslon za hitrejši dostop.</p></div><button className="install-banner__action" onClick={install}><Icon name="download" size={16} />Namesti</button><button className="install-banner__close" onClick={() => setInstallDismissed(true)} aria-label="Zapri obvestilo"><Icon name="close" size={16} /></button></aside>}
  </main>;
}

export default App;
