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
  const device = { android: 'Android', ios: 'iPhone', windows: 'Windows', macos: 'Mac', linux: 'Linux' }[system] || 'drugo';
  return `${platform === 'pwa' ? 'PWA' : 'Brskalnik'} · ${device}`;
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

function DailyChart({ series }) {
  const [active, setActive] = useState(series.length - 1);
  const max = niceMax(Math.max(1, ...series.map((day) => Math.max(day.users, day.opens))));
  const points = series.map((day, index) => `${(index + 0.5) / series.length * 100},${100 - day.opens / max * 100}`).join(' ');
  const day = series[active] || series.at(-1);
  return <section className="adm-card adm-card--wide">
    <header className="adm-card__head">
      <div><p className="adm-kicker">Zadnjih 30 dni</p><h2>Dnevni uporabniki in odprtja</h2></div>
      <ul className="adm-legend"><li><i className="sw sw--returning" />Vračajoči</li><li><i className="sw sw--new" />Novi</li><li><i className="sw sw--line" />Odprtja</li></ul>
    </header>
    <div className="adm-chart__readout" aria-live="polite">
      <b>{longDate(day.date)}</b>
      <span><strong>{day.users}</strong> uporabnikov</span>
      <span><strong>{day.new}</strong> novih</span>
      <span><strong>{day.opens}</strong> odprtij</span>
    </div>
    <div className="adm-chart">
      <div className="adm-chart__grid">{[1, 0.5, 0].map((step) => <span key={step} style={{ bottom: `${step * 100}%` }}>{number.format(Math.round(max * step))}</span>)}</div>
      <div className="adm-chart__bars" onMouseLeave={() => setActive(series.length - 1)}>
        {series.map((entry, index) => <button key={entry.date} className={index === active ? 'is-active' : ''} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)} aria-label={`${longDate(entry.date)}: ${entry.users} uporabnikov, ${entry.opens} odprtij`}>
          <span className="bar">
            <span className="bar__new" style={{ height: `${entry.new / max * 100}%` }} />
            <span className="bar__returning" style={{ height: `${entry.returning / max * 100}%` }} />
          </span>
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

function Heatmap({ heat }) {
  const max = Math.max(1, ...heat.flat());
  const peak = heat.flatMap((hours, day) => hours.map((count, hour) => ({ count, day, hour }))).sort((a, b) => b.count - a.count)[0];
  return <section className="adm-card adm-card--wide">
    <header className="adm-card__head">
      <div><p className="adm-kicker">Zadnji 4 tedni</p><h2>Kdaj odpirajo urnik</h2></div>
      {peak?.count > 0 && <p className="adm-muted">Največ ob <b>{WEEKDAYS[peak.day].toLowerCase()} {peak.hour}:00</b></p>}
    </header>
    <div className="adm-heat" role="table" aria-label="Odprtja po dnevu in uri">
      {heat.map((hours, day) => <div className="adm-heat__row" role="row" key={day}>
        <span role="rowheader">{WEEKDAYS[day]}</span>
        {hours.map((count, hour) => <i key={hour} role="cell" title={`${WEEKDAYS[day]} ${hour}:00 · ${count} odprtij`} style={{ '--level': count ? 0.12 + count / max * 0.88 : 0 }} />)}
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
        {stats && <span className="adm-live"><b />{stats.activeNow} aktivnih · 15 min</span>}
        <button className="adm-ghost" onClick={load} disabled={loading} aria-label="Osveži"><svg viewBox="0 0 24 24" className={loading ? 'spin' : ''}><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg></button>
        <button className="adm-ghost adm-ghost--text" onClick={logout}>Odjava</button>
      </div>
    </header>

    {error && <p className="adm-error" role="alert">{error}</p>}
    {!stats && !error && <div className="adm-skeleton" aria-busy="true">{Array.from({ length: 4 }, (_, index) => <span key={index} />)}</div>}

    {stats && <>
      <section className="adm-hero">
        <div>
          <p className="adm-kicker">{longDate(stats.today.date)}</p>
          <h1><span>{number.format(stats.today.users)}</span> {stats.today.users === 1 ? 'uporabnik' : 'uporabnikov'} danes</h1>
          <p className="adm-muted">{number.format(stats.today.opens)} odprtij · {stats.today.new} novih naprav · skupaj {number.format(stats.totalDevices)} naprav od {new Intl.DateTimeFormat('sl-SI', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(stats.since))}</p>
        </div>
      </section>

      <section className="adm-kpis">
        <Kpi accent label="Danes" value={number.format(stats.today.users)} delta={stats.today.users - (stats.yesterday?.users || 0)} hint=" vs. včeraj" />
        <Kpi label="Tedensko aktivni" value={number.format(stats.wau)} hint="zadnjih 7 dni" />
        <Kpi label="Mesečno aktivni" value={number.format(stats.mau)} hint="zadnjih 30 dni" />
        <Kpi label="Povprečno na dan" value={number.format(stats.dauAverage)} hint="uporabnikov · 30 dni" />
        <Kpi label="Odprtja / uporabnika" value={number.format(stats.opensPerUser)} hint="na aktiven dan" />
        <Kpi label="Zvestoba" value={`${stats.stickiness} %`} hint="dnevni ÷ mesečni" />
        <Kpi label="Tedenska retencija" value={stats.weeklyRetention == null ? '—' : `${stats.weeklyRetention} %`} hint="lanski teden → ta teden" />
        <Kpi label="Osebni urnik" value={number.format(stats.personal)} hint={`${stats.widgets} s pripomočkom`} />
      </section>

      <DailyChart series={stats.series} />

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

      <Heatmap heat={stats.heat} />

      <div className="adm-grid adm-grid--two">
        <SystemCard server={stats.server} />
        <section className="adm-card adm-note">
          <header className="adm-card__head"><div><p className="adm-kicker">Kako se šteje</p><h2>O podatkih</h2></div></header>
          <p>Vsaka namestitev (brskalnik, PWA ali Android aplikacija) ustvari naključen anonimen ključ; strežnik hrani le njegov zgoščen odtis. Odprtje je seja — ponovno se šteje po 30 minutah odsotnosti. Naprave z administratorskim dostopom se ne štejejo.</p>
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
