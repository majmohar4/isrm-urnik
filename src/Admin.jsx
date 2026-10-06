import { useCallback, useEffect, useMemo, useState } from 'react';
import { APP_VERSION } from './version.js';
import './admin.css';

const TOKEN_KEY = 'isrm-stats-token';
const PLATFORM_LABELS = { web: 'Brskalnik', pwa: 'PWA', 'android-app': 'Android aplikacija' };
const SYSTEM_LABELS = { android: 'Android', ios: 'iPhone / iPad', windows: 'Windows', macos: 'macOS', linux: 'Linux', other: 'Drugo' };
const BROWSER_LABELS = { chrome: 'Chrome', safari: 'Safari', firefox: 'Firefox', edge: 'Edge', samsung: 'Samsung Internet', brave: 'Brave', opera: 'Opera', app: 'Aplikacija', other: 'Drugo' };
const WEEKDAYS = ['Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob', 'Ned'];
const number = new Intl.NumberFormat('sl-SI');

function readToken() { try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function storeToken(token) { try { if (token) window.localStorage.setItem(TOKEN_KEY, token); else window.localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } }

function originLabel(value) {
  const [platform, system] = value.split('|');
  if (platform === 'android-app') return 'Android aplikacija';
  if (platform === 'calendar') return 'Koledar (naročnina .ics)';
  if (platform === 'browser') return `Splet · ${{ android: 'Android', ios: 'iPhone', windows: 'Windows', macos: 'Mac', linux: 'Linux' }[system] || 'drugo'}`;
  const device = { android: 'Android', ios: 'iPhone', windows: 'Windows', macos: 'Mac', linux: 'Linux' }[system] || 'drugo';
  return `${platform === 'pwa' ? 'PWA' : 'Brskalnik'} · ${device}`;
}

function openWord(count) {
  const tail = count % 100;
  return tail === 1 ? 'odprtje' : tail === 2 ? 'odprtji' : tail === 3 || tail === 4 ? 'odprtja' : 'odprtij';
}

function shortDate(date) { return new Intl.DateTimeFormat('sl-SI', { day: 'numeric', month: 'numeric' }).format(new Date(`${date}T12:00:00`)); }
function longDate(date) { return new Intl.DateTimeFormat('sl-SI', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`)); }
function relativeTime(iso) {
  if (!iso) return '—';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'pravkar';
  if (minutes < 60) return `pred ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `pred ${hours} h`;
  return `pred ${Math.round(hours / 24)} dnevi`;
}

function Login({ onToken }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/stats/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.token) throw new Error(payload.error || 'Prijava ni uspela.');
      storeToken(payload.token);
      onToken(payload.token);
    } catch (loginError) { setError(loginError.message); setBusy(false); }
  };
  return <main className="adm adm-login">
    <form className="adm-login__card" onSubmit={submit}>
      <span className="adm-mark">IŠ</span>
      <p className="adm-kicker">IŠRM · administracija</p>
      <h1>Nadzorna plošča</h1>
      <p className="adm-muted">Vnesi geslo za nadzorno ploščo. Naprava si zapomni le preklicljiv ključ, gesla ne.</p>
      <label><span>Geslo</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus required /></label>
      {error && <p className="adm-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || !password}>{busy ? 'Preverjam …' : 'Prijava'}</button>
      <a href="/" className="adm-link">← Nazaj na urnik</a>
    </form>
  </main>;
}

function Kpi({ label, value, hint, delta, accent }) {
  return <div className={`adm-kpi ${accent ? 'adm-kpi--accent' : ''}`}>
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{delta != null && <em className={delta > 0 ? 'up' : delta < 0 ? 'down' : ''}>{delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} {Math.abs(delta)}</em>}{hint}</small>
  </div>;
}

function niceMax(value) {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude * 2) / 2 * magnitude;
}

// Stacked daily bars (segments, top to bottom) with a dashed line, for the last 30 days.
function DailyChart({ series, kicker, title, segments, line, readout }) {
  const [active, setActive] = useState(series.length - 1);
  const max = niceMax(Math.max(1, ...series.map((day) => Math.max(segments.reduce((sum, segment) => sum + day[segment.key], 0), day[line.key]))));
  const points = series.map((day, index) => `${(index + 0.5) / series.length * 100},${100 - day[line.key] / max * 100}`).join(' ');
  const day = series[active] || series.at(-1);
  return <section className="adm-card adm-card--wide">
    <header className="adm-card__head">
      <div><p className="adm-kicker">{kicker}</p><h2>{title}</h2></div>
      <ul className="adm-legend">{[...segments].reverse().map((segment) => <li key={segment.key}><i className={`sw ${segment.className}`} />{segment.label}</li>)}<li><i className="sw sw--line" />{line.label}</li></ul>
    </header>
    <div className="adm-chart__readout" aria-live="polite">
      <b>{longDate(day.date)}</b>
      {readout(day).map(([value, label]) => <span key={label}><strong>{number.format(value)}</strong> {label}</span>)}
    </div>
    <div className="adm-chart">
      <div className="adm-chart__grid">{[1, 0.5, 0].map((step) => <span key={step} style={{ bottom: `${step * 100}%` }}>{number.format(Math.round(max * step))}</span>)}</div>
      <div className="adm-chart__bars" onMouseLeave={() => setActive(series.length - 1)}>
        {series.map((entry, index) => <button key={entry.date} className={index === active ? 'is-active' : ''} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)} aria-label={`${longDate(entry.date)}: ${readout(entry).map(([value, label]) => `${value} ${label}`).join(', ')}`}>
          <span className="bar">{segments.map((segment) => <span key={segment.key} className={segment.className.replace('sw--', 'bar__')} style={{ height: `${entry[segment.key] / max * 100}%` }} />)}</span>
        </button>)}
        <svg className="adm-chart__line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} vectorEffect="non-scaling-stroke" /></svg>
      </div>
      <div className="adm-chart__axis">{series.map((entry, index) => <span key={entry.date}>{index % 5 === 4 || index === 0 ? shortDate(entry.date) : ''}</span>)}</div>
    </div>
  </section>;
}

function Breakdown({ title, kicker, items, labels, total }) {
  const sum = total || items.reduce((value, item) => value + item.count, 0);
  return <section className="adm-card">
    <header className="adm-card__head"><div><p className="adm-kicker">{kicker}</p><h2>{title}</h2></div></header>
    {items.length ? <ul className="adm-bars">{items.map((item, index) => {
      const share = sum ? Math.round(item.count / sum * 100) : 0;
      return <li key={item.label} style={{ '--share': `${share}%`, '--delay': `${index * 60}ms` }}>
        <div><span>{labels ? labels(item.label) : item.label}</span><b>{item.count}<small>{share} %</small></b></div>
        <i />
      </li>;
    })}</ul> : <p className="adm-empty">Še ni podatkov.</p>}
  </section>;
}

function SplitBar({ title, items, labels }) {
  const sum = items.reduce((value, item) => value + item.count, 0);
  return <div className="adm-split">
    <p className="adm-kicker">{title}</p>
    <div className="adm-split__bar">{items.map((item, index) => <span key={item.label} className={`tone-${index % 5}`} style={{ flexGrow: item.count }} title={`${labels(item.label)}: ${item.count}`} />)}{!sum && <span className="tone-empty" style={{ flexGrow: 1 }} />}</div>
    <ul>{items.map((item, index) => <li key={item.label}><i className={`tone-${index % 5}`} />{labels(item.label)}<b>{sum ? Math.round(item.count / sum * 100) : 0} %</b></li>)}</ul>
  </div>;
}

function Heatmap({ heat, subtitle }) {
  const max = Math.max(1, ...heat.flat());
  const peak = heat.flatMap((hours, day) => hours.map((count, hour) => ({ count, day, hour }))).sort((a, b) => b.count - a.count)[0];
  return <section className="adm-card adm-card--wide">
    <header className="adm-card__head">
      <div><p className="adm-kicker">Zadnji 4 tedni · {subtitle}</p><h2>Kdaj odpirajo urnik</h2></div>
      {peak?.count > 0 && <p className="adm-muted">Največ ob <b>{WEEKDAYS[peak.day].toLowerCase()} {peak.hour}:00</b></p>}
    </header>
    <div className="adm-heat" role="table" aria-label="Odprtja po dnevu in uri">
      {heat.map((hours, day) => <div className="adm-heat__row" role="row" key={day}>
        <span role="rowheader">{WEEKDAYS[day]}</span>
        {hours.map((count, hour) => <i key={hour} role="cell" title={`${WEEKDAYS[day]} ${hour}:00 · ${count}`} style={{ '--level': count ? 0.12 + count / max * 0.88 : 0 }} />)}
      </div>)}
      <div className="adm-heat__row adm-heat__hours" aria-hidden="true"><span />{Array.from({ length: 24 }, (_, hour) => <small key={hour}>{hour % 3 === 0 ? hour : ''}</small>)}</div>
    </div>
  </section>;
}

function SystemCard({ server }) {
  const sources = Object.entries(server.sources || {}).flatMap(([programme, statuses]) => Object.entries(statuses || {}).map(([source, status]) => ({ key: `${programme}-${source}`, label: `${programme}. letnik · ${source}`, ok: status?.ok !== false })));
  const failing = sources.filter((source) => !source.ok);
  const preload = server.preload || {};
  return <section className="adm-card">
    <header className="adm-card__head"><div><p className="adm-kicker">Strežnik</p><h2>Stanje sistema</h2></div><span className={`adm-pill ${failing.length ? 'is-bad' : 'is-good'}`}>{failing.length ? `${failing.length} virov ne deluje` : 'Vse deluje'}</span></header>
    <dl className="adm-facts">
      <div><dt>Različica strežnika</dt><dd>{server.version}</dd></div>
      <div><dt>Android izdaja</dt><dd>{server.androidVersion}</dd></div>
      <div><dt>Zagnan</dt><dd>{relativeTime(server.startedAt)}</dd></div>
      <div><dt>Zadnje branje virov</dt><dd>{relativeTime(server.fetchedAt)}</dd></div>
      <div><dt>Prednalaganje</dt><dd>{preload.running ? `${preload.completed}/${preload.total}` : preload.lastCompletedAt ? `končano ${relativeTime(preload.lastCompletedAt)}` : '—'}</dd></div>
      <div><dt>Lastni dogodki</dt><dd>{server.customEvents}</dd></div>
      <div><dt>Aktivna sporočila</dt><dd>{server.announcements}</dd></div>
      <div><dt>Admin naprave</dt><dd>{server.adminDevices}</dd></div>
    </dl>
    {failing.length > 0 && <ul className="adm-failing">{failing.map((source) => <li key={source.key}>{source.label}</li>)}</ul>}
  </section>;
}

function Dashboard({ token, onLogout }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/stats', { method: 'POST', headers: { 'content-type': 'application/json', 'x-isrm-admin-token': token }, body: '{}' });
      if (response.status === 401) { storeToken(''); onLogout(); return; }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Podatkov ni mogoče naložiti.');
      setStats(payload); setError('');
    } catch (loadError) { setError(loadError.message || 'Podatkov ni mogoče naložiti.'); }
    finally { setLoading(false); }
  }, [token, onLogout]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const logout = () => {
    fetch('/api/admin/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-isrm-admin-token': token }, body: '{}' }).catch(() => undefined);
    storeToken(''); onLogout();
  };

  const platformTotal = useMemo(() => stats?.platforms.reduce((sum, item) => sum + item.count, 0) || 0, [stats]);

  return <main className="adm adm-dash">
    <header className="adm-top">
      <a href="/" className="adm-brand"><span className="adm-mark">IŠ</span><span>IŠRM<small>Nadzorna plošča</small></span></a>
      <div className="adm-top__right">
        {stats && <span className="adm-live"><b />{stats.traffic.liveNow} zdaj odprto</span>}
        <button className="adm-ghost" onClick={load} disabled={loading} aria-label="Osveži"><svg viewBox="0 0 24 24" className={loading ? 'spin' : ''}><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg></button>
        <button className="adm-ghost adm-ghost--text" onClick={logout}>Odjava</button>
      </div>
    </header>

    {error && <p className="adm-error" role="alert">{error}</p>}
    {!stats && !error && <div className="adm-skeleton" aria-busy="true">{Array.from({ length: 4 }, (_, index) => <span key={index} />)}</div>}

    {stats && <>
      <section className="adm-hero">
        <div>
          <p className="adm-kicker">{longDate(stats.traffic.today.date)}</p>
          <h1><span>{number.format(stats.traffic.today.visits)}</span> {openWord(stats.traffic.today.visits)} danes</h1>
          <p className="adm-muted"><b>{stats.traffic.liveNow}</b> ima urnik odprt prav zdaj · {number.format(stats.traffic.today.visitors)} različnih obiskovalcev · {number.format(stats.traffic.today.requests)} zahtevkov · povprečno {number.format(stats.traffic.weekVisitsAverage)} odprtij na dan</p>
        </div>
      </section>

      <section className="adm-kpis">
        <Kpi accent label="Odprtja danes" value={number.format(stats.traffic.today.visits)} delta={stats.traffic.today.visits - (stats.traffic.yesterday?.visits || 0)} hint=" vs. včeraj" />
        <Kpi label="Zdaj odprto" value={number.format(stats.traffic.liveNow)} hint="zadnja minuta" />
        <Kpi label="Obiskovalci danes" value={number.format(stats.traffic.today.visitors)} delta={stats.traffic.today.visitors - (stats.traffic.yesterday?.visitors || 0)} hint=" vs. včeraj" />
        <Kpi label="Odprtja na dan" value={number.format(stats.traffic.weekVisitsAverage)} hint={`${number.format(stats.traffic.weekAverage)} obiskovalcev · 7 dni`} />
        <Kpi label="Naprave danes" value={number.format(stats.today.users)} delta={stats.today.users - (stats.yesterday?.users || 0)} hint=" anonimni ključ" />
        <Kpi label="Tedensko aktivne" value={number.format(stats.wau)} hint="naprave · 7 dni" />
        <Kpi label="Mesečno aktivne" value={number.format(stats.mau)} hint="naprave · 30 dni" />
        <Kpi label="Tedenska retencija" value={stats.weeklyRetention == null ? '—' : `${stats.weeklyRetention} %`} hint={`zvestoba ${stats.stickiness} % · ${number.format(stats.totalDevices)} naprav`} />
      </section>

      <DailyChart series={stats.traffic.series} kicker="Vsa odprtja · 30 dni" title="Odprtja in obiskovalci"
        segments={[{ key: 'visits', className: 'sw--returning', label: 'Odprtja' }]} line={{ key: 'visitors', label: 'Obiskovalci' }}
        readout={(day) => [[day.visits, 'odprtij'], [day.visitors, 'obiskovalcev'], [day.requests, 'zahtevkov']]} />

      <div className="adm-grid adm-grid--two">
        <Breakdown kicker="Danes · obiskovalci" title="Od kod prihajajo danes" items={stats.traffic.todayOrigins} labels={originLabel} />
        <Breakdown kicker="Povprečno na dan · 4 tedni" title="Izvor prometa" items={stats.traffic.origins} labels={originLabel} />
      </div>

      <DailyChart series={stats.series} kicker="Naprave z anonimnim ključem · 30 dni" title="Naprave in odprtja"
        segments={[{ key: 'new', className: 'sw--new', label: 'Nove' }, { key: 'returning', className: 'sw--returning', label: 'Vračajoče' }]} line={{ key: 'opens', label: 'Odprtja' }}
        readout={(day) => [[day.users, 'naprav'], [day.new, 'novih'], [day.opens, 'odprtij']]} />

      <section className="adm-card adm-card--wide adm-origins">
        <header className="adm-card__head"><div><p className="adm-kicker">Aktivne naprave · 30 dni</p><h2>Izvor dostopa</h2></div><span className="adm-muted">{platformTotal} naprav</span></header>
        <div className="adm-split-grid">
          <SplitBar title="Način" items={stats.platforms} labels={(value) => PLATFORM_LABELS[value] || value} />
          <SplitBar title="Sistem" items={stats.systems} labels={(value) => SYSTEM_LABELS[value] || value} />
        </div>
      </section>

      <div className="adm-grid">
        <Breakdown kicker="Način × naprava" title="Od kod prihajajo" items={stats.origins} labels={originLabel} />
        <Breakdown kicker="Izbrani letnik" title="Letniki" items={stats.programmes} labels={(value) => `${value}. letnik`} />
        <Breakdown kicker="Brskalnik" title="Brskalniki" items={stats.browsers} labels={(value) => BROWSER_LABELS[value] || value} />
        <Breakdown kicker="Nameščene različice" title="Različice" items={stats.versions} />
      </div>

      <Heatmap heat={stats.traffic.heat.flat().some(Boolean) ? stats.traffic.heat : stats.heat} subtitle={stats.traffic.heat.flat().some(Boolean) ? 'obiski' : 'odprtja'} />

      <div className="adm-grid adm-grid--two">
        <SystemCard server={stats.server} />
        <section className="adm-card adm-note">
          <header className="adm-card__head"><div><p className="adm-kicker">Kako se šteje</p><h2>O podatkih</h2></div></header>
          <p><b>Promet strežnika</b> šteje vsako odprtje spletne strani, PWA ali Android aplikacije (vseh različic) po zahtevkih: obiskovalec je kombinacija IP-naslova in brskalnika, zgoščena z dnevno menjajočim se ključem, zato se ga ne da slediti čez dneve. Šteje se vsako odprtje: nalaganje strani, vsak prihod nazaj v aplikacijo in (za starejše različice) prvo preverjanje sprememb po več kot 75 s tišine — odprta aplikacija namreč vsakih 20 s preveri spremembe, zato je tudi »zdaj odprto« točno. Osveževanje pripomočkov in koledarjev šteje k obiskovalcem, ne k odprtjem. Štejejo se tudi administratorji.</p><p><b>Naprave</b> štejejo anonimni ključ, ki ga ustvari aplikacija (od različice 3.1), in zato ločijo PWA od brskalnika ter nove od vračajočih se naprav. Tudi tu se šteje vsako odprtje.</p>
          <p>Ista oseba na telefonu in računalniku šteje kot dve napravi. Dnevni podatki se hranijo 180 dni.</p>
          <p className="adm-foot">Splet v{APP_VERSION} · posodobljeno {relativeTime(stats.generatedAt)}</p>
        </section>
      </div>
    </>}
  </main>;
}

export default function AdminPanel() {
  const [token, setToken] = useState(readToken);
  useEffect(() => { document.title = 'IŠRM · Nadzorna plošča'; document.documentElement.dataset.theme = 'dark'; }, []);
  const logout = useCallback(() => setToken(''), []);
  return token ? <Dashboard token={token} onLogout={logout} /> : <Login onToken={setToken} />;
}
