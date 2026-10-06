import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { APP_VERSION } from './version.js';
import { pingSession } from './analytics.js';
import AdminPanel from './Admin.jsx';

const DAY_NAMES = ['Pon', 'Tor', 'Sre', 'Čet', 'Pet'];
const FULL_DAY_NAMES = ['ponedeljek', 'torek', 'sreda', 'četrtek', 'petek'];
// Indexed by Date.getDay(), so a weekend column gets its own name.
const SHORT_BY_DAY = ['Ned', 'Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob'];
const FULL_BY_DAY = ['nedelja', 'ponedeljek', 'torek', 'sreda', 'četrtek', 'petek', 'sobota'];
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

// On Saturday and Sunday the useful week is the coming one, like in the Android app.
function currentWeek(value = new Date()) {
  const day = value.getDay();
  return day === 6 || day === 0 ? plusDays(monday(value), 7) : monday(value);
}

// Mon–Fri, plus Saturday/Sunday only when they hold an event (e.g. an admin-added weekend exam).
function daysFor(weekStart, events) {
  return Array.from({ length: 7 }, (_, index) => plusDays(weekStart, index))
    .filter((day, index) => index < 5 || events.some((event) => event.date === dateKey(day)));
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

// First Monday on or after the 1st, so a month page always starts inside its own month.
function firstWeekOfMonth(year, monthIndex) {
  const first = new Date(year, monthIndex, 1);
  return plusDays(first, (8 - (first.getDay() || 7)) % 7);
}

const PAGE_GAP = 24;

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

// A fresh start always opens on today; only an explicit ?week= link (or history navigation) opens another week.
function weekFromLocation() {
  const candidate = new URLSearchParams(window.location.search).get('week');
  return candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? monday(`${candidate}T12:00:00`) : currentWeek();
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

// Measures the selected button so one pill can slide between options instead of each button switching colour.
function usePill(ref, deps) {
  const [style, setStyle] = useState(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const measure = () => {
      const selected = ref.current?.querySelector('.is-selected');
      if (!selected) { setStyle(null); return; }
      setStyle({ width: `${selected.offsetWidth}px`, height: `${selected.offsetHeight}px`, transform: `translate(${selected.offsetLeft}px, ${selected.offsetTop}px)`, transition: placed.current ? undefined : 'none' });
      placed.current = true;
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, deps);
  return style;
}

function PillGroup({ className, selected, children, ...rest }) {
  const ref = useRef(null);
  const style = usePill(ref, [selected]);
  return <div ref={ref} className={`${className} has-pill`} {...rest}><span className="pill" style={style || { opacity: 0 }} aria-hidden="true" />{children}</div>;
}

// Local "YYYY-MM-DDTHH:MM", comparable with a lesson's date + start/end (comparing with toISOString(), which is UTC,
// put the "now" highlight two hours off in Slovenia).
// Same readable lesson types as the Android app.
const TYPE_NAMES = { P: 'Predavanje', AV: 'Avditorne vaje', LV: 'Laboratorijske vaje', V: 'Vaje', S: 'Seminar', SEM: 'Seminar' };
const typeName = (type = '') => TYPE_NAMES[type.toUpperCase()] || type;

function localStamp(date) {
  return `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function EventItem({ event, now, onPreview }) {
  const stamp = now ? localStamp(now) : '';
  const active = !event.cancelled && stamp && `${event.date}T${event.start}` <= stamp && `${event.date}T${event.end}` > stamp;
  const past = stamp && `${event.date}T${event.end}` <= stamp;
  const progress = active ? Math.min(1, Math.max(0, (timeToMinutes(stamp.slice(11)) - timeToMinutes(event.start)) / Math.max(1, timeToMinutes(event.end) - timeToMinutes(event.start)))) : 0;
  return <article className={`event event--${event.source.toLowerCase()} ${active ? 'event--active' : ''} ${past ? 'is-past' : ''} ${event.cancelled ? 'is-cancelled' : ''}`}>
    <button className="event__summary" onClick={() => onPreview(event)} aria-label={`Podrobnosti: ${event.title}`}>
      <span className="event__time"><b>{event.start}</b><span>{event.end}</span></span>
      <span className="event__body">
        <strong className="event__title">{event.title}</strong>
        {event.cancelled ? <span className="cancel-note">{['Odpade', event.cancelNote].filter(Boolean).join(' · ')}</span> : <span className="event__room"><Icon name="pin" size={14} />{event.room || 'Prostor ni znan'}</span>}
        <span className="event__tags"><i className="tag tag--source">{event.source || 'IŠRM'}</i>{event.type && <i className="tag">{event.type}</i>}{active && <i className="tag tag--now">ZDAJ</i>}{event.cancelled && <i className="tag tag--cancel">ODPADE</i>}</span>
      </span>
    </button>
    {active && <span className="event__progress" style={{ '--progress': progress }} aria-hidden="true" />}
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
  return <div className={`timeline-scroll timeline-scroll--${mode}`} aria-label={mode === 'day' ? 'Dnevni urnik' : 'Tedenski urnik'}>
    <div className="timeline">
      <div className="timeline__hours">{hours.map((hour) => <span key={hour} style={{ top: `${(hour - 7) * 60}px` }}>{String(hour).padStart(2, '0')}:00</span>)}</div>
      <div className="timeline__days">
        {weekDays.map((day, index) => {
          const dayEvents = layoutTimelineEvents(events.filter((event) => event.date === dateKey(day)));
          return <section className={`timeline-day ${index === mobileDayIndex ? 'is-mobile-active' : ''}`} key={dateKey(day)}>
            <header><b>{SHORT_BY_DAY[day.getDay()]}</b><span>{formatDate(day)}</span></header>
            <div className="timeline-day__body">
              {dayEvents.map((event) => <article key={event.id} className={`timeline-event timeline-event--${event.source.toLowerCase()} ${event.cancelled ? 'is-cancelled' : ''}`} style={{ top: `${event.timeline.top}px`, height: `${Math.max(30, event.timeline.height)}px`, left: `${event.timeline.column * 100 / event.timeline.columns}%`, width: `${100 / event.timeline.columns}%` }} title={`${event.title}, ${event.start}–${event.end}, ${event.room}`} role="button" tabIndex="0" onClick={() => onEventSelect(event)} onKeyDown={(keyboardEvent) => { if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') { keyboardEvent.preventDefault(); onEventSelect(event); } }} aria-label={`Podrobnosti: ${event.title}`}>
                <time>{event.cancelled ? 'ODPADE · ' : ''}{event.start}–{event.end}</time><strong>{event.title}</strong><span>{event.room}</span><em>{event.source}</em>
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
      return <section key={dateKey(day)} className="whole-week__day"><header><b>{SHORT_BY_DAY[day.getDay()]}</b><span>{day.getDate()}</span></header><div>{dayEvents.length ? dayEvents.map((event) => <button key={event.id} className={`whole-week__event whole-week__event--${event.source.toLowerCase()}`} onClick={() => onEventSelect(event)} aria-label={`Podrobnosti: ${event.title}`}><time>{event.start}</time><strong>{event.title}</strong><small>{event.source}</small></button>) : <span className="whole-week__empty">—</span>}</div></section>;
    })}
  </div>;
}

function MonthView({ events, month, onEventSelect, onDaySelect }) {
  const weeks = monthWeekStarts(month);
  const eventsByDay = useMemo(() => events.reduce((days, event) => {
    (days[event.date] ||= []).push(event);
    return days;
  }, {}), [events]);
  // Weekend columns appear only in a month that has a weekend event.
  const columns = events.some((event) => [0, 6].includes(new Date(`${event.date}T12:00:00`).getDay())) ? 7 : 5;
  return <div className="month-view" style={{ '--month-days': columns }} aria-label="Mesečni urnik"><header>{[...FULL_DAY_NAMES, 'sobota', 'nedelja'].slice(0, columns).map((day) => <b key={day}>{day.slice(0, 3)}</b>)}</header><div className="month-grid">{weeks.flatMap((week) => Array.from({ length: columns }, (_, index) => {
    const day = plusDays(week, index); const key = dateKey(day); const isCurrentMonth = day.getMonth() === month.getMonth();
    return <section className={isCurrentMonth ? '' : 'is-outside'} key={key}><button className="month-day-jump" onClick={() => onDaySelect(day)} aria-label={`Odpri ${formatDate(day)}`}><time>{day.getDate()}</time></button>{(eventsByDay[key] || []).map((event) => <button key={event.id} className={`month-event month-event--${event.source.toLowerCase()} ${event.cancelled ? 'is-cancelled' : ''}`} onClick={() => onEventSelect(event)}><span>{event.start}</span>{event.title}</button>)}</section>;
  }))}</div></div>;
}

function PrivacyPolicy() {
  return <main className="privacy-page">
    <a className="privacy-back" href="/">Nazaj na urnik</a>
    <p className="privacy-kicker">IŠRM · FRI program</p>
    <h1>Politika zasebnosti</h1>
    <p className="privacy-lead">IŠRM je namenjen prikazu urnika. Ne uporablja računov, oglasov ali zunanjih sledilnikov. Za štetje uporabe vodi le lastno, anonimno statistiko, opisano spodaj.</p>
    <section><h2>Podatki v tej napravi</h2><p>Izbrani letnik, videz, zadnji pogled in po želji vpisna številka se shranijo samo v lokalno shrambo tvoje naprave. Vpisno številko lahko kadarkoli odstraniš v nastavitvah. Če odkleneš urejanje dogodkov, se v napravi hrani le preklicljiv administratorski ključ, ne geslo.</p></section>
    <section><h2>Anonimna statistika uporabe</h2><p>Da vemo, koliko ljudi urnik dejansko uporablja, aplikacija ob odprtju (in ob vsaki vrnitvi v aplikacijo) pošlje strežniku IŠRM kratko sporočilo: naključen anonimni ključ, ki ga ustvari sama ob prvem zagonu, način uporabe (brskalnik, nameščena spletna aplikacija ali Android aplikacija), vrsto sistema in brskalnika (npr. Android, iPhone, Windows; Chrome, Safari), izbrani letnik, različico aplikacije, ali je vključen osebni urnik (da/ne) in pri Android aplikaciji število pripomočkov.</p><p>Strežnik ključa ne shrani v izvirni obliki, temveč le njegov zgoščen odtis, in ga ne povezuje z IP-naslovom, vpisno številko ali katerim koli drugim podatkom o tebi. Iz teh podatkov nastanejo le skupni števci (npr. uporabniki na dan, ura odprtja, delež Android/iPhone), ki jih vidi samo upravitelj. Podatki se ne pošiljajo tretjim osebam, dnevni zapisi se izbrišejo po 180 dneh, zapis o napravi pa po letu dni neuporabe. Ključ izbrišeš skupaj s podatki brskalnika ali aplikacije.</p><p>Poleg tega strežnik šteje zahtevke za urnik: za vsak dan izračuna zgoščen odtis IP-naslova in vrste brskalnika s ključem, ki se vsak dan zamenja in se ne shrani. Tako je mogoče prešteti obiskovalce enega dne, ne pa jih slediti čez dneve ali ugotoviti njihovega naslova. IP-naslovi se ne shranjujejo.</p></section>
    <section><h2>Osebni urnik</h2><p>Ko vključiš osebni urnik, aplikacija pošlje vpisno številko samo uradnemu strežniku urnikov FRI, da izbere tvojo skupino vaj. IŠRM je ne prodaja, ne uporablja za profiliranje in je ne zapisuje v svoj urnik-cache.</p></section>
    <section><h2>Strežnik in koledar</h2><p>Strežnik začasno hrani javne podatke urnika, da je prikaz hiter. Naročniška povezava .ics lahko vsebuje vpisno številko v naslovu, zato jo deli samo z aplikacijami, ki jim zaupaš.</p></section>
    <section><h2>Android aplikacija in pripomočki</h2><p>Android aplikacija ne zahteva dostopa do lokacije, stikov, kamer, datotek ali obvestil. Uporablja le omrežje (tudi za anonimno statistiko, opisano zgoraj), običajna Androidova dovoljenja za načrtovano osveževanje pripomočka in, ko ga sam potrdiš, dovoljenje za nameščanje lastnih posodobitev, ki se prenesejo izključno s tega strežnika. Za pripomoček shrani samo njegov način prikaza, izbrani letnik in neobvezno vpisno številko v lokalno shrambo aplikacije. Urnik se prenaša izključno prek šifrirane povezave HTTPS.</p></section>
    <section><h2>Operativna obvestila</h2><p>Če upravitelj vključi ntfy, se tja pošiljajo le tehnična obvestila o zagonu, ustavitvi in dosegljivosti virov—ne osebne vpisne številke.</p></section>
    <p className="privacy-updated">Zadnja posodobitev: 6. oktober 2026.</p>
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
    {release?.androidApkUrl && <p className="android-release-direct">Neposredna povezava za ročni prenos ali deljenje: <a href="/download">{window.location.host}/download</a></p>}
    <section className="android-release-notes"><h2>Kako poteka posodobitev</h2><p>Ko odpreš Android aplikacijo, sama preveri različico. Od različice 2.0 posodobitev prenese in namesti kar v aplikaciji; ročno pa jo lahko vedno preneseš tudi tukaj. Android zaradi varnosti nikoli ne dovoli samodejne namestitve brez tvoje potrditve. Za različico iz Trgovine Play uporabi uradno stran trgovine, ko bo objavljena.</p></section>
  </main>;
}

function App() {
  if (window.location.pathname === '/privacy') return <PrivacyPolicy />;
  if (window.location.pathname === '/android') return <AndroidReleasePage />;
  if (window.location.pathname === '/admin') return <AdminPanel />;
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
  // Mon–Fri only: on weekends Dan opens on Monday of the coming week (getDay() - 1 used to give 5 on Saturday, an empty page).
  const [timelineDayIndex, setTimelineDayIndex] = useState(() => { const day = new Date().getDay(); return day === 0 || day === 6 ? 0 : day - 1; });
  // 'system' follows the device, like the Android app; 'light' and 'dark' are fixed choices.
  const [theme, setTheme] = useState(() => window.localStorage.getItem('timetable-theme') || 'system');
  const [programmeYear, setProgrammeYear] = useState(() => window.localStorage.getItem('timetable-programme-year') || '1');
  const [studentNumber, setStudentNumber] = useState(() => window.localStorage.getItem('timetable-student-number') || '');
  const [studentNumberDraft, setStudentNumberDraft] = useState(() => window.localStorage.getItem('timetable-student-number') || '');
  const [studentNumberError, setStudentNumberError] = useState('');
  // Only a revocable admin key is stored; the password is typed once, exchanged for the key and never kept.
  const [adminToken, setAdminToken] = useState(() => { try { return window.localStorage.getItem('isrm-admin-token') || ''; } catch { return ''; } });
  const [adminDraft, setAdminDraft] = useState('');
  const adminUnlocked = Boolean(adminToken);
  // Saved access only allows editing; this switch turns it on and starts off on every page load, so nothing changes by accident.
  const [editMode, setEditMode] = useState(false);
  const canEdit = adminUnlocked && editMode;
  const [monthReload, setMonthReload] = useState(0);
  const [adminError, setAdminError] = useState('');
  const [customEvent, setCustomEvent] = useState({ title: '', date: dateKey(new Date()), start: '12:00', end: '13:00', room: '', programme: 'all' });
  const [eventComposerOpen, setEventComposerOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [messageComposerOpen, setMessageComposerOpen] = useState(false);
  const [messageDraft, setMessageDraft] = useState({ text: '', days: 3 });
  const [cancelNote, setCancelNote] = useState('');
  const [dismissedMessages, setDismissedMessages] = useState(() => { try { return JSON.parse(window.localStorage.getItem('isrm-dismissed-messages') || '[]'); } catch { return []; } });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [installDismissed, setInstallDismissed] = useState(false);
  const [updateNotice, setUpdateNotice] = useState(() => window.sessionStorage.getItem('isrm-pwa-updated') === '1');
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [navigationDirection, setNavigationDirection] = useState('');
  const [navigationKey, setNavigationKey] = useState(0);
  // Page-turn state while a horizontal swipe is in progress: offset in px, which way, whether a day or a whole week turns.
  const [drag, setDrag] = useState(null);
  const [rollDirection, setRollDirection] = useState('');
  const [dayShift, setDayShift] = useState(null);
  const [viewFade, setViewFade] = useState(false);
  const pagerRef = useRef(null);
  const turningRef = useRef(false);
  const turnPageRef = useRef(null);
  const liveRef = useRef({});
  const refreshRef = useRef(null);
  const refreshingRef = useRef(false);
  const weekRef = useRef(weekStart);
  const timetableCacheRef = useRef(readLocalCache(LOCAL_WEEK_CACHE_KEY));
  const monthCacheRef = useRef(readLocalCache(LOCAL_MONTH_CACHE_KEY));
  const timetableRequestRef = useRef(null);
  const pendingLoadRef = useRef(null);

  const weekKey = dateKey(weekStart);
  const monthKey = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}`;
  const weekDays = useMemo(() => daysFor(weekStart, data?.events || []), [weekStart, data]);
  const todayKey = dateKey(new Date());

  // bypassLocal: skip the 10-minute browser cache but not the server's (used when an admin change was announced).
  const load = (refresh = false, bypassLocal = false) => {
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
      if (!refresh && !bypassLocal && cacheIsFresh) { prefetchNeighbours(); return Promise.resolve(); }
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
        if (response.ok) prefetchNeighbours();
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
  refreshRef.current = (refresh = true, bypassLocal = false) => load(refresh, bypassLocal);

  // The weeks on either side are fetched quietly so a swipe already shows the real neighbouring week, not a placeholder.
  const prefetchNeighbours = () => {
    [-7, 7].forEach((offset) => {
      const key = dateKey(plusDays(weekStart, offset));
      const localKey = cacheKeyFor(key, programmeYear, studentNumber);
      const cached = timetableCacheRef.current[localKey];
      if (cached && Date.now() - cached.storedAt < LOCAL_CACHE_TTL_MS) return;
      fetch(`/api/timetable?week=${key}&programme=${programmeYear}${studentNumber ? `&student=${encodeURIComponent(studentNumber)}` : ''}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (!payload) return;
          timetableCacheRef.current[localKey] = { storedAt: Date.now(), payload };
          timetableCacheRef.current = writeLocalCache(LOCAL_WEEK_CACHE_KEY, timetableCacheRef.current, 24);
        })
        .catch(() => undefined);
    });
  };

  useEffect(() => { setSelectedEvent(null); load(); }, [weekKey, programmeYear, studentNumber]);
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
  }, [viewMode, monthKey, programmeYear, studentNumber, monthReload]);
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
    let canPull = false;
    let horizontal = false;
    let samples = [];
    const reset = () => { startY = null; startX = null; distance = 0; active = false; canPull = false; horizontal = false; samples = []; setPullDistance(0); };
    // In Dan only the day turns, until the swipe would leave the week.
    const dayLevel = (forward) => { const { viewMode: mode, timelineDayIndex: index, dayCount } = liveRef.current; return mode === 'timeline' && (forward ? index < dayCount - 1 : index > 0); };
    const onStart = (event) => {
      if (refreshingRef.current || turningRef.current || event.touches.length !== 1 || !event.target.closest('.schedule') || event.target.closest('.view-modes')) return;
      startY = event.touches[0].clientY;
      startX = event.touches[0].clientX;
      canPull = window.scrollY <= 0;
      active = true;
      samples = [{ x: startX, t: event.timeStamp }];
    };
    const onMove = (event) => {
      if (!active || startY === null) return;
      const deltaY = event.touches[0].clientY - startY;
      const deltaX = event.touches[0].clientX - startX;
      if (!horizontal && Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) horizontal = true;
      if (horizontal) {
        samples.push({ x: event.touches[0].clientX, t: event.timeStamp });
        if (samples.length > 5) samples.shift();
        const forward = deltaX < 0;
        setDrag({ offset: deltaX, forward, level: dayLevel(forward) ? 'day' : 'week', phase: 'drag' });
        event.preventDefault();
        return;
      }
      if (!canPull || Math.abs(deltaX) > Math.abs(deltaY)) return;
      if (deltaY <= 0) { setPullDistance(0); return; }
      distance = Math.min(108, deltaY * 0.46);
      setPullDistance(distance);
      event.preventDefault();
    };
    const onEnd = (event) => {
      if (horizontal && startX !== null) {
        const x = event.changedTouches[0].clientX;
        const deltaX = x - startX;
        const forward = deltaX < 0;
        const first = samples[0];
        const velocity = first ? (x - first.x) / Math.max(1, event.timeStamp - first.t) : 0;
        const width = pagerRef.current?.offsetWidth || window.innerWidth;
        const flung = forward ? velocity < -0.45 : velocity > 0.45;
        const against = forward ? velocity > 0.45 : velocity < -0.45;
        const level = dayLevel(forward) ? 'day' : 'week';
        reset();
        if (!against && (flung || Math.abs(deltaX) > width * 0.3)) {
          turningRef.current = true;
          navigator.vibrate?.(8);
          setDrag({ offset: forward ? -(width + PAGE_GAP) : width + PAGE_GAP, forward, level, phase: 'commit' });
          window.setTimeout(() => { turnPageRef.current?.(forward, level); setDrag(null); turningRef.current = false; }, 330);
        } else {
          setDrag((current) => current && { ...current, offset: 0, phase: 'cancel' });
          window.setTimeout(() => setDrag((current) => (current?.phase === 'cancel' ? null : current)), 420);
        }
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
    const onCancel = () => { if (horizontal) setDrag(null); reset(); };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
    };
  }, []);
  // While the page is visible it asks every 20 s whether anything admin-made changed (a few bytes) and reloads only then.
  useEffect(() => {
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const { revision } = await (await fetch('/api/revision')).json();
        const seen = Number(window.localStorage.getItem('isrm-revision') || 0);
        window.localStorage.setItem('isrm-revision', String(revision));
        if (seen && seen !== revision && !turningRef.current) {
          monthCacheRef.current = {};
          setMonthReload((value) => value + 1);
          refreshRef.current?.(false, true);
        }
      } catch { /* offline: try again on the next tick */ }
    };
    check();
    const timer = window.setInterval(check, 20_000);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, []);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => { window.localStorage.setItem('timetable-view', viewMode); }, [viewMode]);
  useEffect(() => {
    console.info(`[IŠRM] App version ${APP_VERSION}`);
    if (!updateNotice) return undefined;
    window.sessionStorage.removeItem('isrm-pwa-updated');
    // A short confirmation only; it hides itself so the install/download button underneath stays reachable.
    const timer = window.setTimeout(() => setUpdateNotice(false), 5000);
    return () => window.clearTimeout(timer);
  }, [updateNotice]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; };
    apply();
    window.localStorage.setItem('timetable-theme', theme);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { window.localStorage.setItem('timetable-programme-year', programmeYear); }, [programmeYear]);
  const programmeRef = useRef({ programme: programmeYear, personal: Boolean(studentNumber) });
  programmeRef.current = { programme: programmeYear, personal: Boolean(studentNumber) };
  useEffect(() => {
    // Every open counts: once on load, then on each return to the tab/app. Changing the year does not re-count.
    pingSession({ programme: programmeRef.current.programme, personal: programmeRef.current.personal });
    const ping = () => { if (document.visibilityState === 'visible') pingSession(programmeRef.current); };
    document.addEventListener('visibilitychange', ping);
    return () => document.removeEventListener('visibilitychange', ping);
  }, []);
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
  // silent: the new page is already on screen from a finished swipe, so it must not slide in a second time.
  const navigateWeek = (nextWeek, direction, silent = false) => {
    const nextKey = dateKey(nextWeek);
    setRollDirection(direction);
    setNavigationDirection(silent ? '' : direction);
    if (!silent) setNavigationKey((value) => value + 1);
    setWeekStart(nextWeek);
    const url = new URL(window.location.href);
    url.searchParams.set('week', nextKey);
    window.history.pushState({ week: nextKey }, '', `${url.pathname}${url.search}${url.hash}`);
  };
  // In Mesec the arrows and swipes move a whole month, like the app.
  const neighbourWeek = (forward) => (viewMode === 'month' ? firstWeekOfMonth(weekStart.getFullYear(), weekStart.getMonth() + (forward ? 1 : -1)) : plusDays(weekStart, forward ? 7 : -7));
  const previousWeek = () => navigateWeek(neighbourWeek(false), 'back');
  const nextWeek = () => navigateWeek(neighbourWeek(true), 'forward');
  const changeView = (mode) => {
    if (mode === viewMode) return;
    setViewFade(true);
    window.setTimeout(() => setViewFade(false), 420);
    setViewMode(mode);
  };
  const selectTimelineDay = (index) => {
    if (index === timelineDayIndex) return;
    setDayShift({ direction: index > timelineDayIndex ? 'forward' : 'back', key: Date.now() });
    setTimelineDayIndex(index);
  };
  liveRef.current = { viewMode, timelineDayIndex, dayCount: weekDays.length };
  turnPageRef.current = (forward, level) => {
    setDayShift(null);
    if (level === 'day') { setTimelineDayIndex((index) => index + (forward ? 1 : -1)); return; }
    if (viewMode === 'timeline') {
      const previous = neighbourWeek(false);
      setTimelineDayIndex(forward ? 0 : daysFor(previous, timetableCacheRef.current[cacheKeyFor(dateKey(previous), programmeYear, studentNumber)]?.payload.events || []).length - 1);
    }
    navigateWeek(neighbourWeek(forward), forward ? 'forward' : 'back', true);
  };
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
    setTimelineDayIndex(Math.max(0, daysFor(monday(day), monthEvents).findIndex((candidate) => dateKey(candidate) === dateKey(day))));
    changeView('timeline');
    navigateWeek(nextWeek, nextWeek < weekStart ? 'back' : 'forward');
  };
  const saveAdminToken = (token) => {
    setAdminToken(token);
    try { if (token) window.localStorage.setItem('isrm-admin-token', token); else window.localStorage.removeItem('isrm-admin-token'); } catch { /* storage unavailable */ }
  };
  const adminRequest = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-isrm-admin-token': adminToken }, body: JSON.stringify(body || {}) });
    const payload = await response.json();
    // A revoked key (removed elsewhere, or the password changed) locks editing here as well.
    if (response.status === 401) { saveAdminToken(''); throw new Error('Dostop za urejanje ni več veljaven. Znova vnesi geslo.'); }
    if (!response.ok) throw new Error(payload.error || 'Administratorska zahteva ni uspela.');
    return payload;
  };
  const unlockAdmin = async () => {
    try {
      const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: adminDraft, device: 'splet' }) });
      const payload = await response.json();
      if (!response.ok || !payload.token) throw new Error(payload.error || 'Prijava ni uspela.');
      saveAdminToken(payload.token); setAdminDraft(''); setAdminError(''); setEditMode(true);
    } catch (requestError) { setAdminError(requestError.message); }
  };
  const removeAdminAccess = () => {
    const token = adminToken;
    saveAdminToken('');
    fetch('/api/admin/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-isrm-admin-token': token }, body: '{}' }).catch(() => undefined);
  };
  // Browsers that saved the password itself (before keys existed) forget it.
  useEffect(() => { try { window.localStorage.removeItem('timetable-admin-password'); } catch { /* storage unavailable */ } }, []);
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

  // Admin actions that change what everyone sees; each reloads so this view matches the server.
  const runAdmin = async (path, body, after) => {
    try { await adminRequest(path, body); setAdminError(''); after?.(); load(true); }
    catch (requestError) { setAdminError(requestError.message); }
  };
  const deleteEvent = (event) => { if (window.confirm(`Izbrišem »${event.title}« za ves letnik?`)) runAdmin('/api/admin/events/delete', { id: event.id }, () => setSelectedEvent(null)); };
  const setCancelled = (event, cancelled) => runAdmin('/api/admin/cancel', { programme: programmeYear, eventId: event.id, date: event.date, cancelled, note: cancelNote.trim() }, () => { setSelectedEvent(null); setCancelNote(''); });
  const sendMessage = (submitEvent) => {
    submitEvent?.preventDefault();
    if (!messageDraft.text.trim()) { setAdminError('Vpiši sporočilo.'); return; }
    runAdmin('/api/admin/announcements', { programme: programmeYear, text: messageDraft.text.trim(), days: messageDraft.days }, () => { setMessageComposerOpen(false); setMessageDraft({ text: '', days: 3 }); });
  };
  const deleteMessage = (message) => { if (window.confirm('Izbrišem sporočilo za vse?')) runAdmin('/api/admin/announcements/delete', { id: message.id }); };
  const dismissMessage = (message) => {
    const next = [...dismissedMessages, message.id].slice(-50);
    setDismissedMessages(next);
    try { window.localStorage.setItem('isrm-dismissed-messages', JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  const announcements = (data?.announcements || []).filter((message) => !dismissedMessages.includes(message.id));

  // One page of the timetable. The live page and the neighbour shown during a swipe are drawn by the same code.
  const renderPage = ({ week, days, items, monthItems, dayIndex, isLoading, live }) => {
    const dayDrag = live && drag?.level === 'day' ? drag : null;
    const timelineDay = (index, style, extra = '') => <div className={`day-page ${extra}`} style={style}><Timeline events={items} weekDays={days} onEventSelect={setSelectedEvent} mode="day" mobileDayIndex={index} /></div>;
    return <div className={live && viewFade ? 'view-fade' : ''} key={live ? viewMode : undefined} style={{ '--days': days.length }}>
      {viewMode === 'agenda' && <div className="weekday-tabs">{days.map((day, index) => <a key={dateKey(day)} href={`#day-${index}`} className={dateKey(day) === todayKey ? 'is-today' : ''}><b>{SHORT_BY_DAY[day.getDay()]}</b><span>{day.getDate()}</span></a>)}</div>}
      {viewMode === 'timeline' && <PillGroup className="timeline-day-switch" selected={`${dateKey(week)}-${dayIndex}`} role="group" aria-label="Dan v časovnem pogledu">{days.map((day, index) => <button key={dateKey(day)} className={dayIndex === index ? 'is-selected' : ''} onClick={live ? () => selectTimelineDay(index) : undefined} aria-pressed={dayIndex === index}><b>{SHORT_BY_DAY[day.getDay()]}</b><span>{day.getDate()}</span></button>)}</PillGroup>}
      {isLoading ? <div className="schedule-skeleton">{Array.from({ length: 5 }, (_, index) => <span key={index} />)}</div>
        : viewMode === 'timeline' ? <div className="day-pager">
          {timelineDay(dayIndex, dayDrag ? { transform: `translateX(${dayDrag.offset}px)` } : undefined, live && dayShift ? `day-enter day-enter--${dayShift.direction}` : '')}
          {dayDrag && timelineDay(dayIndex + (dayDrag.forward ? 1 : -1), { transform: `translateX(calc(${dayDrag.offset}px ${dayDrag.forward ? '+' : '-'} (100% + ${PAGE_GAP}px)))` }, 'day-page--neighbour')}
        </div>
        : viewMode === 'week' ? <Timeline events={items} weekDays={days} onEventSelect={setSelectedEvent} mode="week" />
        : viewMode === 'month' ? <MonthView events={monthItems} month={week} onEventSelect={setSelectedEvent} onDaySelect={openMonthDay} />
        : <div className="agenda">
          {days.map((day, index) => {
            const dayEvents = items.filter((event) => event.date === dateKey(day));
            return <section className="agenda-day" id={live ? `day-${index}` : undefined} key={dateKey(day)}>
              <header><b>{FULL_BY_DAY[day.getDay()].replace(/^./, (letter) => letter.toUpperCase())}</b><time>{formatDate(day)}</time>{dateKey(day) === todayKey && <i className="tag tag--today">DANES</i>}</header>
              {dayEvents.length ? dayEvents.map((event) => <EventItem key={event.id} event={event} now={now} onPreview={setSelectedEvent} />) : <p className="no-events">Brez obveznosti</p>}
            </section>;
          })}
        </div>}
    </div>;
  };

  const pullOffset = Math.min(72, pullDistance) - 82;
  return <main className="app-shell skin">
    {updateNotice && <aside className="update-sheet" role="status" aria-live="polite"><div><b>IŠRM je posodobljen na {APP_VERSION}.</b></div><button onClick={() => setUpdateNotice(false)} aria-label="Zapri obvestilo o posodobitvi"><Icon name="close" size={17} /></button></aside>}
    {(pullDistance > 0 || pullRefreshing) && <div className={`pull-refresh ${pullRefreshing ? 'is-refreshing' : ''} ${pullDistance >= 62 ? 'is-ready' : ''}`} style={{ transform: `translate(-50%, ${pullOffset}px)` }} role="status" aria-live="polite"><span className="pull-refresh__icon"><Icon name="refresh" size={16} /></span><span>{pullRefreshing ? 'Osvežujem urnik' : pullDistance >= 62 ? 'Spusti za osvežitev' : 'Povleci za osvežitev'}</span></div>}
    <header className="app-header">
      <div><small className={canEdit ? 'is-editing' : ''}>IŠRM · {programmeYear}. letnik{studentNumber ? ' · osebni' : ''}{canEdit ? ' · urejanje' : ''}</small><h1>Urnik</h1></div>
      <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Nastavitve"><Icon name="settings" /></button>
    </header>

    <div>
    <div className="week-control-row">
    <section className="week-control" aria-label="Izbira tedna">
      <button className="week-arrow" onClick={previousWeek} aria-label="Prejšnji teden"><Icon name="arrowLeft" /></button>
      <button className="week-title" onClick={() => navigateWeek(currentWeek(), currentWeek() < weekStart ? 'back' : 'forward')}><span key={viewMode === 'month' ? monthKey : weekKey} className={rollDirection ? `roll roll--${rollDirection}` : ''}>{viewMode === 'month' ? new Intl.DateTimeFormat('sl-SI', { month: 'long', year: 'numeric' }).format(weekStart).replace(/^./, (letter) => letter.toUpperCase()) : <>{formatDate(weekStart)} — {formatDate(plusDays(weekStart, 4))}</>}</span><small>Osveženo {formatFetched(data?.fetchedAt)} · {(viewMode === 'month' ? monthEvents : events).length} {(viewMode === 'month' ? monthEvents : events).length === 1 ? 'obveznost' : 'obveznosti'}</small></button>
      <button className="week-arrow" onClick={nextWeek} aria-label="Naslednji teden"><Icon name="arrowRight" /></button>
    </section>
    <button className="today-button" onClick={() => navigateWeek(currentWeek(), currentWeek() < weekStart ? 'back' : 'forward')} disabled={weekKey === dateKey(currentWeek())} aria-label="Pojdi na trenutni teden">Danes</button>
    </div>

    {announcements.map((message) => <aside key={message.id} className="announcement" role="status"><div><small>Sporočilo · {new Intl.DateTimeFormat('sl-SI', { day: 'numeric', month: 'short' }).format(new Date(message.createdAt))}</small><p>{message.text}</p>{canEdit && <button className="announcement__delete" onClick={() => deleteMessage(message)}>Izbriši za vse</button>}</div><button className="announcement__close" onClick={() => dismissMessage(message)} aria-label="Skrij sporočilo"><Icon name="close" size={16} /></button></aside>)}
    {(error || sourceIssues.length > 0) && <div className="notice" role="status">{error || `Pozor: ${sourceIssues.map(([source, status]) => `${source} (${status.message || 'vir ni dosegljiv'})`).join('; ')}. Prikazani so zadnji uspešno shranjeni podatki.`}</div>}

    <section className="schedule" aria-label="Tedenski urnik">
      <div className="schedule__heading"><PillGroup className="view-modes" selected={viewMode} role="group" aria-label="Prikaz urnika">{[['agenda', 'Seznam'], ['timeline', 'Dan'], ['week', 'Teden'], ['month', 'Mesec']].map(([mode, label]) => <button key={mode} className={viewMode === mode ? 'is-selected' : ''} onClick={() => changeView(mode)} aria-pressed={viewMode === mode}>{label}</button>)}</PillGroup></div>
      <div ref={pagerRef} className={`pager ${drag ? `is-${drag.phase}` : ''}`}>
        <div key={`${weekKey}-${navigationKey}`} className={`pager__page week-content week-content--${navigationDirection}`} style={drag?.level === 'week' ? { transform: `translateX(${drag.offset}px)`, opacity: drag.phase === 'commit' ? 0.4 : 1 - Math.min(1, Math.abs(drag.offset) / 900) } : undefined}>
          {renderPage({ week: weekStart, days: weekDays, items: events, monthItems: monthEvents, dayIndex: timelineDayIndex, isLoading: loading && !data, live: true })}
        </div>
        {drag?.level === 'week' && (() => {
          const next = neighbourWeek(drag.forward);
          const cachedWeek = timetableCacheRef.current[cacheKeyFor(dateKey(next), programmeYear, studentNumber)];
          const cachedMonth = monthCacheRef.current[cacheKeyFor(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`, programmeYear, studentNumber)];
          return <div className="pager__page pager__page--neighbour" aria-hidden="true" style={{ transform: `translateX(calc(${drag.offset}px ${drag.forward ? '+' : '-'} (100% + ${PAGE_GAP}px)))` }}>
            {renderPage({ week: next, days: daysFor(next, cachedWeek?.payload.events || []), items: cachedWeek?.payload.events || [], monthItems: cachedMonth?.payload.events || [], dayIndex: drag.forward ? 0 : daysFor(next, cachedWeek?.payload.events || []).length - 1, isLoading: viewMode === 'month' ? !cachedMonth : !cachedWeek, live: false })}
          </div>;
        })()}
      </div>
    </section>
    </div>

    {selectedEvent && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setSelectedEvent(null)}><section className={`lesson-dialog lesson-dialog--${selectedEvent.source.toLowerCase()}`} role="dialog" aria-modal="true" aria-label={`Podrobnosti: ${selectedEvent.title}`} onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lesson-faculty"><b>{selectedEvent.source}</b><i>{selectedEvent.source === 'FRI' ? 'Računalništvo in informatika' : selectedEvent.source === 'FMF' ? 'Matematika in fizika' : 'Skupni dogodek'}</i></span><span className="lesson-type">{typeName(selectedEvent.type)}</span><h2>{selectedEvent.title}</h2></div><button className="lesson-close" onClick={() => setSelectedEvent(null)} aria-label="Zapri podrobnosti"><Icon name="close" size={18} /></button></header><div className="lesson-details"><div><b>Termin</b><span>{new Intl.DateTimeFormat('sl-SI', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${selectedEvent.date}T12:00:00`))}</span><strong>{selectedEvent.start}–{selectedEvent.end}</strong></div><div><b>Prostor</b><strong>{selectedEvent.room || 'Ni podatka'}</strong></div><div><b>Izvajalec</b><strong>{selectedEvent.teacher || 'Ni podatka'}</strong></div></div>{selectedEvent.cancelled && <p className="lesson-cancelled">{['Ta termin odpade', selectedEvent.cancelNote].filter(Boolean).join(' · ')}</p>}{canEdit && <div className="lesson-admin"><b>Urejanje · admin</b>{!['FRI', 'FMF'].includes(selectedEvent.source) ? <button className="is-danger" onClick={() => deleteEvent(selectedEvent)}>Izbriši dogodek</button> : selectedEvent.cancelled ? <button onClick={() => setCancelled(selectedEvent, false)}>Prekliči odpad · predavanje bo</button> : <><input value={cancelNote} onChange={(event) => setCancelNote(event.target.value)} placeholder="Opomba (neobvezno)" maxLength={160} /><button className="is-danger" onClick={() => setCancelled(selectedEvent, true)}>Označi kot odpadlo</button></>}{adminError && <p className="settings-error" role="alert">{adminError}</p>}</div>}</section></div>}

    {canEdit && <button className="event-fab" onClick={() => setAdminMenuOpen(true)} aria-label="Dodaj"><Icon name="plus" size={21} /><span>Dodaj</span></button>}
    {eventComposerOpen && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setEventComposerOpen(false)}><section className="lesson-dialog event-composer" role="dialog" aria-modal="true" aria-labelledby="event-composer-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lesson-faculty"><b>IŠRM</b><i>{programmeYear}. letnik</i></span><h2 id="event-composer-title">Dodaj dogodek</h2></div><button className="lesson-close" onClick={() => setEventComposerOpen(false)} aria-label="Zapri dodajanje dogodka"><Icon name="close" size={18} /></button></header><p>Dogodek bo viden celotnemu {programmeYear}. letniku v prikazanem tednu.</p><form onSubmit={addCustomEvent}><label><b>Naslov</b><input value={customEvent.title} onChange={(event) => setCustomEvent((value) => ({ ...value, title: event.target.value }))} placeholder="Npr. Izpit" autoFocus required /></label><label><b>Datum</b><input type="date" value={customEvent.date} onChange={(event) => setCustomEvent((value) => ({ ...value, date: event.target.value }))} required /></label><div className="event-composer__times"><label><b>Začetek</b><input type="time" value={customEvent.start} onChange={(event) => setCustomEvent((value) => ({ ...value, start: event.target.value }))} required /></label><label><b>Konec</b><input type="time" value={customEvent.end} onChange={(event) => setCustomEvent((value) => ({ ...value, end: event.target.value }))} required /></label></div><label><b>Lokacija <small>neobvezno</small></b><input value={customEvent.room} onChange={(event) => setCustomEvent((value) => ({ ...value, room: event.target.value }))} placeholder="Npr. P.01" /></label>{adminError && <p className="settings-error" role="alert">{adminError}</p>}<div className="event-composer__actions"><button type="button" onClick={() => setEventComposerOpen(false)}>Prekliči</button><button type="submit">Dodaj dogodek</button></div></form></section></div>}

    {adminMenuOpen && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setAdminMenuOpen(false)}><section className="lesson-dialog admin-menu" role="dialog" aria-modal="true" aria-label="Urejanje" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lesson-faculty"><b>IŠRM</b><i>{programmeYear}. letnik</i></span><h2>Kaj želiš dodati?</h2></div><button className="lesson-close" onClick={() => setAdminMenuOpen(false)} aria-label="Zapri"><Icon name="close" size={18} /></button></header><div className="admin-menu__actions"><button onClick={() => { setAdminMenuOpen(false); openEventComposer(); }}>Nov dogodek</button><button onClick={() => { setAdminMenuOpen(false); setAdminError(''); setMessageComposerOpen(true); }}>Sporočilo za letnik</button></div><p>Predavanje označiš kot odpadlo tako, da ga klikneš na urniku.</p></section></div>}
    {messageComposerOpen && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setMessageComposerOpen(false)}><section className="lesson-dialog event-composer" role="dialog" aria-modal="true" aria-labelledby="message-composer-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lesson-faculty"><b>IŠRM</b><i>{programmeYear}. letnik</i></span><h2 id="message-composer-title">Novo sporočilo</h2></div><button className="lesson-close" onClick={() => setMessageComposerOpen(false)} aria-label="Zapri"><Icon name="close" size={18} /></button></header><p>Prikaže se na vrhu urnika vsem v {programmeYear}. letniku.</p><form onSubmit={sendMessage}><label><b>Sporočilo</b><textarea value={messageDraft.text} onChange={(event) => setMessageDraft((value) => ({ ...value, text: event.target.value }))} rows={4} maxLength={500} placeholder="Npr. Jutri predavanje iz Analize odpade." autoFocus required /></label><div className="message-days" role="group" aria-label="Vidno">{[[1, '1 dan'], [3, '3 dni'], [7, '1 teden'], [14, '2 tedna']].map(([days, label]) => <button type="button" key={days} className={messageDraft.days === days ? 'is-selected' : ''} onClick={() => setMessageDraft((value) => ({ ...value, days }))}>{label}</button>)}</div>{adminError && <p className="settings-error" role="alert">{adminError}</p>}<div className="event-composer__actions"><button type="button" onClick={() => setMessageComposerOpen(false)}>Prekliči</button><button type="submit">Pošlji</button></div></form></section></div>}
    {settingsOpen && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}><section className="lesson-dialog settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="sheet-kicker">Nastavitve</span><h2 id="settings-title">Program</h2></div><button className="lesson-close" onClick={() => setSettingsOpen(false)} aria-label="Zapri nastavitve"><Icon name="close" size={18} /></button></header>
      <span className="sheet-section">Letnik</span>
      <PillGroup className="segmented" selected={programmeYear} role="group" aria-label="Letnik programa">{['1', '2', '3'].map((year) => <button key={year} className={programmeYear === year ? 'is-selected' : ''} onClick={() => setProgrammeYear(year)} aria-pressed={programmeYear === year}>{year}. letnik</button>)}</PillGroup>
      <span className="sheet-section">Vpisna številka · neobvezno</span>
      <input className="sheet-input" value={studentNumberDraft} onChange={(event) => setStudentNumberDraft(event.target.value.replace(/\D/g, ''))} inputMode="numeric" autoComplete="off" placeholder="Za osebni urnik" />
      <small className="sheet-hint">Izbere tvojo FRI skupino pri prekrivanju vaj.</small>
      <div className="sheet-row"><button className="sheet-primary" onClick={saveStudentNumber}>Shrani</button><button className="sheet-secondary" onClick={() => { setStudentNumberDraft(''); setStudentNumber(''); setStudentNumberError('Osebni urnik je izključen.'); window.localStorage.removeItem('timetable-student-number'); }}>Odstrani</button></div>
      {studentNumberError ? <p className="sheet-hint is-strong">{studentNumberError}</p> : <p className="sheet-hint is-strong">{studentNumber ? 'Osebni urnik je vključen.' : 'Shranjeno samo v tej napravi.'}</p>}
      <span className="sheet-section">Videz</span>
      <PillGroup className="segmented" selected={theme} role="group" aria-label="Videz">{[['system', 'Sistem'], ['light', 'Svetlo'], ['dark', 'Temno']].map(([value, label]) => <button key={value} className={theme === value ? 'is-selected' : ''} onClick={() => setTheme(value)} aria-pressed={theme === value}>{label}</button>)}</PillGroup>
      <span className="sheet-section">Koledar .ics</span>
      <small className="sheet-hint">{studentNumber ? 'Naročniška povezava vključuje tvoje FRI vaje in se sama posodablja.' : 'Naročniška povezava se sama posodablja.'}</small>
      <div className="sheet-row"><button className="sheet-secondary" onClick={copySubscription}>Kopiraj povezavo</button><a className="sheet-secondary" href={`/api/calendar?week=${encodeURIComponent(weekKey)}&programme=${programmeYear}${studentNumber ? `&student=${encodeURIComponent(studentNumber)}` : ''}`} download={`isrm-${programmeYear}-letnik-${weekKey}.ics`}>Prenesi ta teden</a></div>
      {copyStatus && <small className="sheet-hint is-strong">{copyStatus}</small>}
      <span className="sheet-section">Urejanje · admin</span>
      {!adminUnlocked ? <><input className="sheet-input" type="password" value={adminDraft} onChange={(event) => setAdminDraft(event.target.value)} autoComplete="current-password" placeholder="Geslo za urejanje" /><button className="sheet-secondary is-wide" onClick={unlockAdmin}>Odpri urejanje</button></>
        : <><label className={`edit-switch ${editMode ? 'is-on' : ''}`}><span><b>Urejanje urnika</b><small>{editMode ? 'Vključeno: + spodaj desno, brisanje in odpadla predavanja.' : 'Izključeno: urnika ni mogoče po nesreči spremeniti.'}</small></span><input type="checkbox" role="switch" checked={editMode} onChange={(event) => setEditMode(event.target.checked)} /><i aria-hidden="true" /></label><small className="sheet-hint">Ob vsakem odprtju strani se urejanje izklopi. Dostop je shranjen na tej napravi, geslo pa ne.</small><button className="sheet-secondary is-wide is-danger" onClick={removeAdminAccess}>Odstrani dostop</button></>}
      {adminError && <p className="settings-error" role="alert">{adminError}</p>}
      <a className="sheet-link" href="/privacy">Politika zasebnosti</a>
      <small className="sheet-hint is-strong">Različica {APP_VERSION} · brez računov, oglasov in sledenja</small>
    </section></div>}
    <footer className="footer"><span className="source-statuses">{['FRI', 'FMF'].map((source) => <span key={source} className={data?.sources?.[source]?.ok === false ? 'warning' : 'ok'}><b />{source}</span>)}</span><span>v{APP_VERSION}</span>{isAndroidDevice() && androidRelease?.androidApkUrl ? <a href={androidRelease.androidApkUrl}>Prenesi aplikacijo</a> : <button onClick={installPrompt ? install : () => setInstallGuideOpen(true)}>Namesti</button>}<a href="/privacy">Zasebnost</a></footer>
    {isAndroidDevice() && androidRelease?.androidApkUrl && !installDismissed && <aside className="install-banner android-install-banner" aria-label="Prenos Android aplikacije"><span className="install-banner__mark"><Icon name="grid" size={17} /></span><div><strong>Namesti IŠRM za Android</strong><p>Native aplikacija {androidRelease.androidVersion} z delovanjem brez povezave in pripomočki.</p></div><a className="install-banner__action" href={androidRelease.androidApkUrl}><Icon name="download" size={16} />Prenesi</a><button className="install-banner__close" onClick={() => setInstallDismissed(true)} aria-label="Zapri obvestilo"><Icon name="close" size={16} /></button></aside>}
    {isIosDevice() && !isStandaloneApp() && !installDismissed && <aside className="install-banner" aria-label="Namestitev IŠRM na iPhone"><span className="install-banner__mark"><Icon name="grid" size={17} /></span><div><strong>Namesti IŠRM</strong><p>{isBraveBrowser() ? 'Brave na iPhonu ni zanesljiv za PWA. Odpri stran v Chromu ali Safariju.' : 'V Safariju ali Chromu izberi Deli in nato Add to Home Screen.'}</p></div><button className="install-banner__action" onClick={() => setInstallGuideOpen(true)}><Icon name="download" size={16} />Navodila</button><button className="install-banner__close" onClick={() => setInstallDismissed(true)} aria-label="Zapri obvestilo"><Icon name="close" size={16} /></button></aside>}
    {!isIosDevice() && !androidRelease?.androidApkUrl && installPrompt && !installDismissed && <aside className="install-banner" aria-label="Namestitev aplikacije"><span className="install-banner__mark"><Icon name="grid" size={17} /></span><div><strong>Namesti IŠRM</strong><p>Dodaj urnik na začetni zaslon za hitrejši dostop.</p></div><button className="install-banner__action" onClick={install}><Icon name="download" size={16} />Namesti</button><button className="install-banner__close" onClick={() => setInstallDismissed(true)} aria-label="Zapri obvestilo"><Icon name="close" size={16} /></button></aside>}
    {installGuideOpen && <div className="lesson-backdrop" role="presentation" onMouseDown={() => setInstallGuideOpen(false)}><section className="lesson-dialog install-guide" role="dialog" aria-modal="true" aria-labelledby="install-guide-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lesson-faculty"><b>IŠRM</b><i>Namestitev</i></span><h2 id="install-guide-title">Namesti aplikacijo</h2></div><button className="lesson-close" onClick={() => setInstallGuideOpen(false)} aria-label="Zapri navodila za namestitev"><Icon name="close" size={18} /></button></header>{isAndroidDevice() && androidRelease?.androidApkUrl ? <><p>Namesti native Android aplikacijo z delovanjem brez povezave in pripomočki.</p><a className="android-release-action" href={androidRelease.androidApkUrl}><Icon name="download" size={18} />Prenesi IŠRM {androidRelease.androidVersion}</a></> : isIosDevice() ? <><p>{isBraveBrowser() ? 'Brave na iPhonu lahko doda le zaznamek. Za pravo PWA namestitev najprej odpri IŠRM v Chromu ali Safariju.' : 'Za PWA namestitev odpri IŠRM v Chromu ali Safariju.'}</p><ol><li>Tapni gumb Deli v spodnji vrstici brskalnika.</li><li>Izberi Add to Home Screen.</li><li>Potrdi Dodaj.</li></ol></> : installPrompt ? <><p>Dodaj IŠRM na začetni zaslon za hitrejši dostop in delovanje brez povezave.</p><button className="android-release-action" onClick={install}><Icon name="download" size={18} />Namesti PWA</button></> : <p>V meniju brskalnika izberi Install app oziroma Namesti aplikacijo.</p>}</section></div>}
  </main>;
}

export default App;
