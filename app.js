/* Hockey Stats — a phone app for tracking a defenseman's games, season over season.
   Plain HTML/JavaScript. Data is saved on the phone first, then synced to a Google Sheet. */
'use strict';

const APP_VERSION = '1.0.3';
const LS_KEY = 'hockeyStats.v1';
const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';

/* ============================== Helpers ============================== */
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => new Date().toLocaleDateString('en-CA');
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

function fmtT(ms) {
  ms = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(ms / 3600), m = Math.floor((ms % 3600) / 60), s = ms % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function parseT(str) { // "18:42" -> ms
  const p = String(str || '').trim().split(':').map(Number);
  if (p.some(isNaN) || !p.length) return null;
  let s = 0; for (const n of p) s = s * 60 + n;
  return s * 1000;
}
function fmtDate(iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-CA', opts);
}
function seasonLabelFor(d = new Date()) {
  const y = d.getFullYear(), start = d.getMonth() >= 7 ? y : y - 1; // seasons start in August
  return `${start}–${String((start + 1) % 100).padStart(2, '0')}`;
}
const periodName = p => (p >= 4 ? 'OT' : 'P' + p);
const periodLong = p => (p >= 4 ? 'Overtime' : 'Period ' + p);
const signed = n => (n > 0 ? '+' + n : String(n));
const avg = (a, b, d = 1) => (b ? (a / b).toFixed(d) : '–');
const b64urlEncode = str => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = str => {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return decodeURIComponent(escape(atob(str)));
};

/* ============================== Data ============================== */
function blankDb() {
  return {
    v: 1,
    settings: { deviceId: uid(), deviceName: '', url: '', key: '', activePlayerId: null, lastSync: null, lastSyncError: null, dirty: {} },
    players: [], seasons: [], games: []
  };
}
function loadDb() {
  try { const d = JSON.parse(localStorage.getItem(LS_KEY)); if (d && d.v === 1) return d; } catch (e) { /* ignore */ }
  return blankDb();
}
let db = loadDb();
function saveDb() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); }
  catch (e) { alert('This phone could not save the last change: ' + e.message); }
}
// Every change: stamp it, mark it for syncing, save instantly.
function touch(kind, rec) {
  rec.updatedAt = Date.now();
  db.settings.dirty[kind + ':' + rec.id] = 1;
  saveDb();
  scheduleSync();
}

const ui = { view: 'home', params: {}, seasonId: null, chartMetric: 'pts', syncState: '' };

const players = () => db.players.filter(p => !p.deleted);
function activePlayer() {
  return players().find(p => p.id === db.settings.activePlayerId) || players()[0] || null;
}
const seasonsFor = pid => db.seasons.filter(s => s.playerId === pid && !s.deleted).sort((a, b) => b.label.localeCompare(a.label));
function curSeason(p) {
  if (!p) return null;
  const list = seasonsFor(p.id);
  return list.find(s => s.id === ui.seasonId) || list[0] || null;
}
const gameById = id => db.games.find(g => g.id === id);
function gamesFor(pid, sid) {
  return db.games.filter(g => !g.deleted && !g.draft && g.playerId === pid && (!sid || g.seasonId === sid))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.t0 || 0) - (a.t0 || 0));
}
const myLiveGame = () => db.games.find(g => !g.deleted && g.status === 'live' && g.deviceId === db.settings.deviceId);
const playerName = id => (db.players.find(p => p.id === id) || {}).name || '';
const seasonOf = id => db.seasons.find(s => s.id === id) || {};

// If Grandpa and Kyla both track the same game (same player, day and opponent), only one counts.
function duplicateIds() {
  const groups = {};
  for (const g of db.games) {
    if (g.deleted || g.draft) continue;
    const k = g.playerId + '|' + g.date + '|' + (g.opponent || '').trim().toLowerCase();
    (groups[k] = groups[k] || []).push(g);
  }
  const out = new Set();
  for (const k in groups) {
    const list = groups[k];
    if (list.length < 2 || new Set(list.map(g => g.recordedBy)).size < 2) continue;
    list.sort((a, b) => (b.ev.length - a.ev.length) || (b.updatedAt - a.updatedAt));
    list.slice(1).forEach(g => { if (g.recordedBy !== list[0].recordedBy) out.add(g.id); });
  }
  return out;
}

/* ============================== Game maths ==============================
   Events are stored compactly: [msSinceGameStart, type, group, value]
   ps/pe = period start/end, on/off = shift, wh/pl = whistle/play,
   gf, ga, goal, ast, hit, shot, rush, blk, pen (value = minutes). */
function compute(g, at) {
  const r = {
    toi: 0, bench: 0, play: 0, toiP: {}, playP: {}, shifts: [],
    goal: 0, ast: 0, gf: 0, ga: 0, gfOn: 0, gaOn: 0, hit: 0, pim: 0, pens: 0, shot: 0, rush: 0, blk: 0,
    period: 0, maxPeriod: 0, live: false, paused: false, onIce: false, cur: null, benchCur: 0
  };
  let last = null;
  const adv = t => {
    if (last !== null && r.live && !r.paused) {
      const dt = Math.max(0, t - last);
      r.play += dt; r.playP[r.period] = (r.playP[r.period] || 0) + dt;
      if (r.onIce) { r.toi += dt; r.toiP[r.period] = (r.toiP[r.period] || 0) + dt; if (r.cur) r.cur.toi += dt; }
      else { r.bench += dt; r.benchCur += dt; }
    }
    last = t;
  };
  for (const e of g.ev || []) {
    const [t, type, , v] = e;
    adv(t);
    switch (type) {
      case 'ps': r.period = v; r.maxPeriod = Math.max(r.maxPeriod, v); r.live = true; r.paused = false; r.benchCur = 0; break;
      case 'pe': r.live = false; r.paused = false; break;
      case 'on': r.onIce = true; r.cur = { p: r.period, toi: 0 }; r.shifts.push(r.cur); break;
      case 'off': r.onIce = false; r.cur = null; r.benchCur = 0; break;
      case 'wh': r.paused = true; break;
      case 'pl': r.paused = false; break;
      case 'gf': r.gf++; if (r.onIce) r.gfOn++; break;
      case 'ga': r.ga++; if (r.onIce) r.gaOn++; break;
      case 'pen': r.pens++; r.pim += Number(v) || 0; break;
      default: if (type in r) r[type]++;
    }
  }
  if (g.status === 'live' && at) adv(at - g.t0);
  return r;
}
const ADJ_KEYS = ['goal', 'ast', 'gfOn', 'gaOn', 'hit', 'pim', 'shot', 'rush', 'blk'];
// Final numbers for a game = what was tapped + any after-game corrections.
function stats(g, at) {
  const c = compute(g, at);
  const a = g.adj || {};
  for (const k of ADJ_KEYS) c[k] = Math.max(0, c[k] + (a[k] || 0));
  if (g.toiOverride != null) c.toi = g.toiOverride;
  c.nShifts = g.shiftsOverride != null ? g.shiftsOverride : c.shifts.length;
  c.avgShift = c.nShifts ? c.toi / c.nShifts : 0;
  c.longest = c.shifts.reduce((m, s) => Math.max(m, s.toi), 0);
  c.pts = c.goal + c.ast;
  c.pm = c.gfOn - c.gaOn;
  c.soGoals = (g.so && g.so.att || []).filter(Boolean).length;
  c.soAtt = (g.so && g.so.att || []).length;
  return c;
}
function result(g) {
  if (g.status !== 'final' || !g.score) return '';
  const { us, them } = g.score;
  const so = g.so && g.so.res;
  if (us > them) return 'W';
  if (us < them) return g.hadOT || so ? 'OTL' : 'L';
  if (so === 'W') return 'W';
  if (so === 'L') return 'OTL';
  return 'T';
}
function resultLabel(g) {
  const r = result(g); if (!r) return '';
  if (g.so && g.so.res && g.score && g.score.us === g.score.them) return r === 'W' ? 'W (SO)' : 'L (SO)';
  if (g.hadOT && r === 'W') return 'W (OT)';
  if (r === 'OTL') return 'L (OT)';
  return r;
}
function scoreText(g) {
  if (!g.score) return '';
  return `${g.score.us}–${g.score.them}`;
}

function seasonTotals(list, dups) {
  const t = { gp: 0, toi: 0, shifts: 0, longest: 0, goal: 0, ast: 0, pts: 0, pm: 0, gfOn: 0, gaOn: 0, hit: 0, pim: 0, shot: 0, rush: 0, blk: 0, W: 0, L: 0, OTL: 0, T: 0, soAtt: 0, soGoals: 0 };
  for (const g of list) {
    if (g.status !== 'final' || g.deleted || (dups && dups.has(g.id))) continue;
    const s = stats(g);
    t.gp++; t.toi += s.toi; t.shifts += s.nShifts; t.longest = Math.max(t.longest, s.longest);
    for (const k of ['goal', 'ast', 'pts', 'pm', 'gfOn', 'gaOn', 'hit', 'pim', 'shot', 'rush', 'blk', 'soAtt', 'soGoals']) t[k] += s[k];
    const r = result(g); if (r) t[r]++;
  }
  return t;
}

/* ============================== Rendering ============================== */
const app = $('#app');
function go(view, params = {}) {
  ui.view = view; ui.params = params;
  render();
  window.scrollTo(0, 0);
}
function render() {
  const p = activePlayer();
  if (ui.view === 'connect') return app.innerHTML = viewConnect();
  if (!p && ui.view !== 'settings') return app.innerHTML = viewWelcome();
  const views = { home: viewHome, newgame: viewNewGame, game: viewGame, shootout: viewShootout, finish: viewFinish, summary: viewSummary, edit: viewEdit, games: viewGames, stats: viewStats, settings: viewSettings };
  app.innerHTML = (views[ui.view] || viewHome)();
  if (ui.view === 'game') { keepAwake(true); tick(); } else keepAwake(false);
  if (ui.view === 'settings') afterSettings();
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  games: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
  stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
};
function nav(active) {
  const item = (v, label) => `<button data-act="nav" data-v="${v}" class="${active === v ? 'on' : ''}">${ICONS[v]}${label}</button>`;
  return `<nav class="nav">${item('home', 'Home')}${item('games', 'Games')}${item('stats', 'Stats')}${item('settings', 'Settings')}</nav>`;
}
function topbar(title, backTo) {
  return `<header class="topbar">${backTo ? `<button class="back" data-act="nav" data-v="${backTo}">‹ Back</button>` : ''}<h2>${esc(title)}</h2></header>`;
}
function avatar(p, size) {
  const style = p && p.photo ? `style="background-image:url('${p.photo}')${size ? `;width:${size}px;height:${size}px` : ''}"` : (size ? `style="width:${size}px;height:${size}px"` : '');
  return `<div class="avatar" ${style}>${p && !p.photo ? esc((p.name || '?')[0]) : ''}</div>`;
}
function syncLine() {
  const s = db.settings;
  if (!s.url) return `<div class="sync-line"><span class="dot"></span>Saved on this phone only — connect a Google Sheet in Settings</div>`;
  const pending = Object.keys(s.dirty).length;
  let dot = 'ok', text;
  if (ui.syncState === 'syncing') { dot = 'busy'; text = 'Syncing…'; }
  else if (s.lastSyncError) { dot = 'err'; text = s.lastSyncError; }
  else if (!navigator.onLine) { dot = 'busy'; text = `Offline — ${pending ? pending + ' change(s) will sync later' : 'all saved'}`; }
  else if (pending) { dot = 'busy'; text = `${pending} change(s) waiting to sync`; }
  else text = s.lastSync ? `Synced ${new Date(s.lastSync).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}` : 'Connected';
  return `<div class="sync-line" data-act="syncnow"><span class="dot ${dot}"></span>${esc(text)}</div>`;
}

/* ---------- Welcome (first run) ---------- */
function viewWelcome() {
  return `<div class="page" style="padding-bottom:24px">
    <div class="hero"><h1>Hockey Stats</h1><div class="sub">Let's set up this phone.</div></div>
    <div class="wrap">
      ${db.settings.url ? `<div class="banner info"><b>✓ Connected to the Google Sheet.</b> The sheet has no players yet, so add the first one below and tap Start.</div>` : `<div class="card">
        <h3>Got a setup link?</h3>
        <p class="small muted" style="margin-top:0">If someone shared access with you (QR code or text message), paste the link here.</p>
        <div class="field"><textarea id="w-link" placeholder="https://…#connect=…"></textarea></div>
        <button class="btn line" data-act="pastelink" data-src="w-link">Connect with link</button>
      </div>`}
      <div class="card">
        <h3>${db.settings.url ? 'Add the first player' : 'Or start fresh'}</h3>
        <div class="field"><label>Your name (shows as "Recorded by")</label><input id="w-me" value="${esc(db.settings.deviceName || 'Grandpa')}" autocomplete="off"></div>
        <div class="field"><label>Player</label><input id="w-name" value="Colin" autocomplete="off"></div>
        <div class="two">
          <div class="field"><label>Season</label><input id="w-season" value="${seasonLabelFor()}"></div>
          <div class="field"><label>Jersey #</label><input id="w-jersey" inputmode="numeric"></div>
        </div>
        <div class="field"><label>Team</label><input id="w-team" value="St. James Canucks"></div>
        <div class="field"><label>Level</label><input id="w-level" value="U13 A2"></div>
        <button class="btn" data-act="welcome">Start</button>
      </div>
    </div></div>`;
}

/* ---------- Home ---------- */
function viewHome() {
  const p = activePlayer(), s = curSeason(p), live = myLiveGame();
  const list = s ? gamesFor(p.id, s.id) : [];
  const t = seasonTotals(list, duplicateIds());
  const others = db.games.filter(g => !g.deleted && g.status === 'live' && g.deviceId !== db.settings.deviceId && Date.now() - g.updatedAt < 4 * 3600e3);
  const chips = players().length > 1
    ? `<div class="chips">${players().map(x => `<button class="chip ${x.id === p.id ? 'on' : ''}" data-act="player" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>` : '';
  const sub = s ? [s.team, s.level, s.jersey ? '#' + s.jersey : '', s.label].filter(Boolean).map(x => `<span style="white-space:nowrap">${esc(x)}</span>`).join(' · ') : 'No season yet — add one in Settings';
  return `<div class="page">
    <div class="hero">
      <div class="hero-row">${avatar(p)}<div><h1>${esc(p.name)}</h1><div class="sub">${sub}</div></div></div>
      ${chips}
    </div>
    <div class="wrap">
      ${others.map(g => `<div class="banner warn">${esc(g.recordedBy)} is tracking a live game for ${esc(playerName(g.playerId))} vs ${esc(g.opponent || 'opponent')}.</div>`).join('')}
      ${live
        ? `<button class="btn big go" data-act="resume">Resume game vs ${esc(live.opponent || 'opponent')}</button>`
        : `<button class="btn big" data-act="newgame" ${s ? '' : 'disabled'}>Start new game</button>`}
      <div class="card">
        <h3>${esc(s ? s.label : '')} season</h3>
        <div class="tiles">
          <div class="tile"><b>${t.gp}</b><span>GP</span></div>
          <div class="tile"><b>${t.goal}-${t.ast}-${t.pts}</b><span>G-A-P</span></div>
          <div class="tile"><b>${signed(t.pm)}</b><span>+/-</span></div>
          <div class="tile"><b>${t.gp ? fmtT(t.toi / t.gp) : '–'}</b><span>TOI/GP</span></div>
          <div class="tile"><b>${t.hit}</b><span>Hits</span></div>
          <div class="tile"><b>${t.blk}</b><span>Blocks</span></div>
        </div>
        <p class="small muted" style="margin:10px 0 0">Record ${t.W}-${t.L}-${t.OTL}${t.T ? '-' + t.T : ''} (W-L-OTL${t.T ? '-T' : ''})</p>
      </div>
      ${list[0] ? `<div class="card"><h3>Last game</h3>${gameRow(list[0])}</div>` : ''}
      ${syncLine()}
    </div>
    ${nav('home')}</div>`;
}
function gameRow(g, dups) {
  const s = stats(g);
  const badge = g.status === 'live' ? '<span class="badge live">LIVE</span>'
    : dups && dups.has(g.id) ? '<span class="badge dup">Duplicate</span>'
    : `<span class="badge ${result(g)}">${esc(resultLabel(g))} ${esc(scoreText(g))}</span>`;
  return `<button class="row" data-act="${g.status === 'live' && g.deviceId === db.settings.deviceId ? 'resume' : 'summary'}" data-id="${g.id}">
    <div class="grow"><div class="title">${g.homeAway === 'Away' ? '@' : 'vs'} ${esc(g.opponent || 'Opponent')}</div>
    <div class="meta">${fmtDate(g.date)} · ${s.goal}G ${s.ast}A · +/- ${signed(s.pm)} · TOI ${fmtT(s.toi)}</div></div>${badge}</button>`;
}

/* ---------- New game ---------- */
function viewNewGame() {
  const p = activePlayer(), s = curSeason(p);
  const seg = (name, opts, val) => `<div class="seg" data-seg="${name}">${opts.map(o => `<button type="button" class="${o === val ? 'on' : ''}" data-act="seg" data-v="${o}">${o}</button>`).join('')}</div>`;
  return `<div class="page" style="padding-bottom:24px">${topbar('New game', 'home')}
    <div class="wrap"><div class="card">
      <p class="small muted" style="margin-top:0">${esc(p.name)} · ${esc(s.label)} · ${esc(s.team || '')} ${esc(s.level || '')}</p>
      <div class="field"><label>Date</label><input id="n-date" type="date" value="${todayISO()}"></div>
      <div class="field"><label>Opponent</label><input id="n-opp" placeholder="e.g. Assiniboine Park" autocomplete="off"></div>
      <div class="field"><label>Home or away</label>${seg('n-ha', ['Home', 'Away'], 'Home')}</div>
      <div class="field"><label>Arena</label><input id="n-arena" autocomplete="off"></div>
      <div class="field"><label>Game type</label>${seg('n-type', ['Regular', 'Playoff', 'Tourney', 'Exhib.'], 'Regular')}</div>
      <div class="two">
        <div class="field"><label>Period length (min)</label><input id="n-plen" type="number" inputmode="numeric" value="20"></div>
        <div class="field"><label>OT length (min)</label><input id="n-otlen" type="number" inputmode="numeric" value="5"></div>
      </div>
      <button class="btn big go" data-act="startgame">Go to game</button>
    </div></div></div>`;
}
const segVal = name => { const b = document.querySelector(`[data-seg="${name}"] .on`); return b ? b.dataset.v : ''; };
const TYPE_NAMES = { 'Tourney': 'Tournament', 'Exhib.': 'Exhibition' };

/* ---------- Live game ---------- */
const LAST_LABEL = { on: 'On ice', off: 'Off ice', wh: 'Whistle', pl: 'Play on', ps: 'Period start', pe: 'Period end', gf: 'GF', ga: 'GA', goal: 'Goal', ast: 'Assist', hit: 'Hit', shot: 'Shot att.', rush: 'Rush', blk: 'Block', pen: 'Penalty' };
function viewGame() {
  const g = myLiveGame();
  if (!g) { ui.view = 'home'; return viewHome(); }
  const p = db.players.find(x => x.id === g.playerId) || {};
  const c = stats(g, Date.now());
  const next = c.maxPeriod + 1;
  const lastEv = g.ev[g.ev.length - 1];
  const lastLabel = lastEv ? LAST_LABEL[lastEv[1]] + (lastEv[1] === 'pen' ? ` ${lastEv[3]}m` : '') : '';

  let big;
  if (c.live) {
    big = `<button class="shift ${c.onIce ? 'on' : ''} ${c.paused ? 'paused' : ''}" data-act="shift">
      <div class="state">${c.onIce ? 'ON ICE' : 'ON BENCH'}</div>
      <div class="timer" id="t-shift">${fmtT(c.onIce ? c.cur.toi : c.benchCur)}</div>
      <div class="hint">${c.paused ? 'Whistle — clock stopped' : c.onIce ? 'Tap when he reaches the bench' : 'Tap when he steps on the ice'}</div></button>`;
  } else if (c.maxPeriod < 3) {
    big = `<button class="shift start" data-act="pstart" data-p="${next}"><div class="state">START ${periodLong(next).toUpperCase()}</div>
      <div class="hint">${c.maxPeriod ? `End of ${periodLong(c.maxPeriod).toLowerCase()} · tap at the drop of the puck` : 'Tap at the opening face-off'}</div></button>`;
  } else {
    big = `<div class="shift start endreg">
      <div class="state" style="font-size:22px">${c.maxPeriod >= 4 ? 'END OF OVERTIME' : 'END OF REGULATION'}</div>
      ${c.maxPeriod < 4 ? `<button class="btn alt" style="max-width:280px" data-act="pstart" data-p="4">Start overtime</button>` : ''}
      <button class="btn alt" style="max-width:280px" data-act="shootout">Shootout</button>
      <button class="btn" style="max-width:280px;background:#fff;color:var(--blue)" data-act="finish">Finish game</button></div>`;
  }
  const stat = (k, label, cls = '', extra = '') => `<button class="stat ${cls}" data-act="tap" data-k="${k}"><span class="lbl">${label}</span><span class="cnt">${extra}</span></button>`;
  return `<div class="game">
    <div class="g-top">
      <div><div class="opp">${esc(p.name)} ${g.homeAway === 'Away' ? '@' : 'vs'} ${esc(g.opponent || 'Opponent')}</div>
        <div class="per num">${c.live ? `${periodName(c.period)} · <span id="t-play">${fmtT(c.playP[c.period] || 0)}</span> played` : c.maxPeriod ? 'Intermission' : 'Before the game'}</div></div>
      <div class="g-score">${c.gf}–${c.ga}</div>
      <button class="g-menu" data-act="gmenu" aria-label="Game menu">⋯</button>
    </div>
    <button class="whistle ${c.paused ? 'stopped' : ''}" data-act="whistle" ${c.live ? '' : 'disabled'}>${c.paused ? '⏸ WHISTLE — tap when play resumes' : '▶ Play on — tap at the whistle'}</button>
    ${big}
    <div class="g-line">TOI <b id="t-toi">${fmtT(c.toi)}</b> · Shifts <b>${c.shifts.length}</b> · Bench <b id="t-bench">${fmtT(c.bench)}</b></div>
    <div class="pad">
      ${stat('hit', 'Hit', '', c.hit)}${stat('shot', 'Shot Att.', '', c.shot)}${stat('blk', 'Blocked', '', c.blk)}
      ${stat('rush', 'Rush', '', c.rush)}${stat('goal', 'Goal', '', c.goal)}${stat('ast', 'Assist', '', c.ast)}
      ${stat('gf', 'GF', 'gf', `${c.gf} <small>${c.gfOn} on ice</small>`)}${stat('ga', 'GA', 'ga', `${c.ga} <small>${c.gaOn} on ice</small>`)}${stat('pen', 'Penalty', 'pen', `${c.pim} <small>min</small>`)}
    </div>
    <div class="g-bottom">
      <button data-act="undo" ${lastEv ? '' : 'disabled'}>↶ Undo${lastLabel ? ' · ' + esc(lastLabel) : ''}</button>
      <button class="end" data-act="pend" ${c.live ? '' : 'disabled'}>End ${c.live ? periodName(c.period) : 'period'}</button>
    </div>
  </div>`;
}
// Updates just the running clocks, 4x a second.
function tick() {
  if (ui.view !== 'game') return;
  const g = myLiveGame(); if (!g) return;
  const c = stats(g, Date.now());
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  if (c.live) set('t-shift', fmtT(c.onIce ? (c.cur ? c.cur.toi : 0) : c.benchCur));
  set('t-play', fmtT(c.playP[c.period] || 0));
  set('t-toi', fmtT(c.toi));
  set('t-bench', fmtT(c.bench));
}
setInterval(tick, 250);

function addEvents(g, list) {
  const grp = (g.grp = (g.grp || 0) + 1);
  const t = Date.now() - g.t0;
  for (const [type, v] of list) g.ev.push(v === undefined ? [t, type, grp] : [t, type, grp, v]);
  touch('games', g);
}

/* ---------- Shootout ---------- */
function viewShootout() {
  const g = myLiveGame() || gameById(ui.params.id);
  if (!g) return viewHome();
  g.so = g.so || { att: [], res: null };
  const name = playerName(g.playerId);
  return `<div class="page" style="padding-bottom:24px">${topbar('Shootout', 'game')}
    <div class="wrap">
      <div class="card"><h3>${esc(name)}'s attempts</h3>
        <div class="so-list">${g.so.att.map(a => `<div class="so-dot ${a ? 'g' : 'm'}">${a ? '✓' : '✕'}</div>`).join('') || '<span class="muted small">No attempts yet — tap below when he shoots.</span>'}</div>
        <div class="btn-row" style="margin-top:12px"><button class="btn go" data-act="soatt" data-v="1">Scored</button><button class="btn" style="background:var(--bench)" data-act="soatt" data-v="0">Missed</button></div>
        <button class="btn alt" style="margin-top:10px" data-act="soundo" ${g.so.att.length ? '' : 'disabled'}>Undo last attempt</button>
        <p class="small muted">Shootout goals are tracked separately and don't count as regular goals.</p>
      </div>
      <div class="card"><h3>Team result</h3>
        <div class="seg"><button class="${g.so.res === 'W' ? 'on' : ''}" data-act="sores" data-v="W">Won shootout</button><button class="${g.so.res === 'L' ? 'on' : ''}" data-act="sores" data-v="L">Lost shootout</button></div>
      </div>
      <button class="btn big" data-act="finish">Finish game</button>
    </div></div>`;
}

/* ---------- Finish ---------- */
function viewFinish() {
  const g = myLiveGame(); if (!g) return viewHome();
  const c = stats(g, Date.now());
  return `<div class="page" style="padding-bottom:24px">${topbar('Finish game', 'game')}
    <div class="wrap"><div class="card">
      <h3>Final score</h3>
      <p class="small muted" style="margin-top:0">Filled in from the GF/GA taps. Shootout goals aren't included.</p>
      <div class="two">
        <div class="field"><label>${esc(seasonOf(g.seasonId).team || 'Us')}</label><input id="f-us" type="number" inputmode="numeric" value="${c.gf}"></div>
        <div class="field"><label>${esc(g.opponent || 'Them')}</label><input id="f-them" type="number" inputmode="numeric" value="${c.ga}"></div>
      </div>
      ${g.so && g.so.res ? `<p class="small">Shootout: ${g.so.res === 'W' ? 'won' : 'lost'}</p>` : ''}
      <div class="field"><label>Notes (optional)</label><textarea id="f-notes" placeholder="Anything worth remembering">${esc(g.notes || '')}</textarea></div>
      <button class="btn big go" data-act="savefinal">Save game</button>
    </div></div></div>`;
}

/* ---------- Game summary ---------- */
function viewSummary() {
  const g = gameById(ui.params.id); if (!g) return viewGames();
  const s = stats(g), se = seasonOf(g.seasonId), dups = duplicateIds();
  const periods = Object.keys(s.toiP).map(Number).sort();
  const rows = [
    ['Goals', s.goal], ['Assists', s.ast], ['Points', s.pts], ['Plus / minus', signed(s.pm)],
    ['GF while on ice', s.gfOn], ['GA while on ice', s.gaOn], ['Hits', s.hit], ['Shot attempts', s.shot],
    ['Rushes', s.rush], ['Blocked shots', s.blk], ['Penalty minutes', s.pim]
  ];
  if (s.soAtt) rows.push(['Shootout', `${s.soGoals} for ${s.soAtt}`]);
  return `<div class="page">${topbar(fmtDate(g.date), 'games')}
    <div class="wrap">
      ${dups.has(g.id) ? `<div class="banner warn">This looks like a duplicate of a game tracked by someone else, so it isn't counted in season stats. Delete it if it's not needed.</div>` : ''}
      <div class="card" style="text-align:center">
        <div class="muted small">${esc(playerName(g.playerId))} · ${esc(se.team || '')} ${g.homeAway === 'Away' ? '@' : 'vs'} ${esc(g.opponent || 'Opponent')}</div>
        <div style="font-size:40px;font-weight:800" class="num">${esc(scoreText(g)) || '—'}</div>
        <div><span class="badge ${result(g)}">${esc(resultLabel(g) || (g.status === 'live' ? 'LIVE' : ''))}</span></div>
        <div class="small muted" style="margin-top:6px">${esc(TYPE_NAMES[g.type] || g.type || '')}${g.arena ? ' · ' + esc(g.arena) : ''} · Recorded by ${esc(g.recordedBy || '')}</div>
      </div>
      <div class="card"><h3>Ice time</h3><div class="tiles">
        <div class="tile"><b>${fmtT(s.toi)}</b><span>TOI</span></div>
        <div class="tile"><b>${s.nShifts}</b><span>Shifts</span></div>
        <div class="tile"><b>${fmtT(s.avgShift)}</b><span>Avg shift</span></div></div>
        ${s.longest ? `<p class="small muted" style="margin:10px 0 0">Longest shift ${fmtT(s.longest)} · Bench time ${fmtT(s.bench)}</p>` : ''}
        ${periods.length ? `<table class="stats" style="margin-top:6px">${periods.map(pp => `<tr><td>${periodLong(pp)}</td><td>${fmtT(s.toiP[pp])}</td></tr>`).join('')}</table>` : ''}
      </div>
      <div class="card"><h3>Stats</h3><table class="stats">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table></div>
      ${g.notes ? `<div class="card"><h3>Notes</h3><div>${esc(g.notes)}</div></div>` : ''}
      <button class="btn" data-act="share" data-id="${g.id}">Share summary</button>
      <div class="btn-row"><button class="btn alt" data-act="edit" data-id="${g.id}">Edit</button><button class="btn danger" data-act="delgame" data-id="${g.id}">Delete</button></div>
    </div>${nav('games')}</div>`;
}
const RESULT_WORDS = { W: 'WIN', L: 'LOSS', OTL: 'OT LOSS', T: 'TIE' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
function shareText(g) {
  const s = stats(g), se = seasonOf(g.seasonId), name = playerName(g.playerId);
  const team = se.team || 'Us', opp = g.opponent || 'Opponent';
  const r = result(g);
  const so = g.so && g.so.res && g.score && g.score.us === g.score.them ? ' (shootout)' : g.hadOT && r ? ' (OT)' : '';
  const lines = [`🏒 ${name}'s game recap`];
  if (g.score) lines.push(`${team} ${g.score.us}, ${opp} ${g.score.them}${r ? ` — ${RESULT_WORDS[r]}${so}` : ''}`);
  else lines.push(`${team} ${g.homeAway === 'Away' ? 'at' : 'vs'} ${opp}`);
  lines.push(`${fmtDate(g.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${g.homeAway === 'Away' ? 'Away' : 'Home'}`, '');
  lines.push(s.pts ? `⭐ ${plural(s.goal, 'goal')}, ${plural(s.ast, 'assist')} (${plural(s.pts, 'point')})` : '⭐ No points this game');
  lines.push(`➕ Plus/minus: ${signed(s.pm)}`);
  lines.push(`⏱️ Ice time: ${fmtT(s.toi)} over ${plural(s.nShifts, 'shift')}${s.nShifts ? ` (avg ${fmtT(s.avgShift)})` : ''}`);
  lines.push(`💥 ${plural(s.hit, 'hit')} · 🛡️ ${plural(s.blk, 'blocked shot')}`);
  lines.push(`🎯 ${plural(s.shot, 'shot attempt')} · 🚀 ${plural(s.rush, 'rush', 'rushes')}`);
  if (s.pim) lines.push(`⛔ ${plural(s.pim, 'penalty minute')}`);
  if (s.soAtt) lines.push(`🥅 Shootout: ${s.soGoals} for ${s.soAtt}`);
  if (g.notes) lines.push('', `📝 ${g.notes}`);
  return lines.join('\n');
}

// A score-graphic picture of the game, sized for a phone screen.
function drawShareCard(g) {
  const s = stats(g), se = seasonOf(g.seasonId), name = playerName(g.playerId);
  const W = 1080, H = 1350, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  const F = (w, px) => `${w} ${px}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;
  const BLUE = '#0b3f91', BLUE2 = '#1a5cc8', SOFT = '#e6eefb', INK = '#0f1b33', MUTED = '#5b6780';
  const fit = (text, weight, px, maxW) => { let size = px; do { x.font = F(weight, size); size -= 2; } while (x.measureText(text).width > maxW && size > 20); return x.font; };
  const rr = (X, Y, w, h, r, fill) => { x.beginPath(); x.roundRect(X, Y, w, h, r); x.fillStyle = fill; x.fill(); };

  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  // Header band
  x.fillStyle = BLUE; x.fillRect(0, 0, W, 340);
  x.fillStyle = BLUE2; x.fillRect(0, 324, W, 16);
  x.textAlign = 'left'; x.fillStyle = '#c9d6ee';
  x.font = F(700, 34); x.fillText('GAME RECAP', 70, 100);
  x.fillStyle = '#ffffff'; x.font = fit(name.toUpperCase(), 900, 96, W - 140); x.fillText(name.toUpperCase(), 70, 196);
  x.fillStyle = '#c9d6ee'; x.font = F(600, 34);
  const sub = [se.team, se.level, se.jersey ? '#' + se.jersey : ''].filter(Boolean).join(' · ');
  x.fillText(sub, 70, 250);
  x.fillText(`${fmtDate(g.date, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })} · ${g.homeAway === 'Away' ? 'Away' : 'Home'}`, 70, 300);
  // Score
  const r = result(g);
  if (g.score) {
    x.textAlign = 'center';
    x.fillStyle = INK; x.font = F(900, 110);
    x.fillText(`${g.score.us} – ${g.score.them}`, W / 2, 470);
  }
  // Result line
  x.textAlign = 'center';
  x.fillStyle = INK; x.font = fit(`${se.team || 'Us'} vs ${g.opponent || 'Opponent'}`, 700, 40, W - 140);
  x.fillText(`${se.team || 'Us'} ${g.homeAway === 'Away' ? 'at' : 'vs'} ${g.opponent || 'Opponent'}`, W / 2, g.score ? 530 : 470);
  if (r) {
    const word = RESULT_WORDS[r] + (g.so && g.so.res && g.score && g.score.us === g.score.them ? ' · SHOOTOUT' : g.hadOT ? ' · OT' : '');
    x.font = F(800, 34); const pw = x.measureText(word).width + 64;
    rr(W / 2 - pw / 2, 556, pw, 62, 31, r === 'W' ? '#dcf3e3' : r === 'T' ? SOFT : '#fde8e6');
    x.fillStyle = r === 'W' ? '#15803d' : r === 'T' ? BLUE : '#c2271d'; x.fillText(word, W / 2, 599);
  }
  // Stat tiles
  const tiles = [
    [s.goal, 'GOALS'], [s.ast, 'ASSISTS'], [signed(s.pm), 'PLUS / MINUS'],
    [fmtT(s.toi), 'ICE TIME'], [s.hit, 'HITS'], [s.blk, 'BLOCKED SHOTS'],
    [s.shot, 'SHOT ATTEMPTS'], [s.rush, 'RUSHES'], [s.nShifts, 'SHIFTS']
  ];
  const gx = 60, gy = 650, gap = 22, tw = (W - gx * 2 - gap * 2) / 3, th = 172;
  tiles.forEach(([val, label], i) => {
    const cx = gx + (i % 3) * (tw + gap), cy = gy + Math.floor(i / 3) * (th + gap);
    rr(cx, cy, tw, th, 28, SOFT);
    x.fillStyle = BLUE; x.font = F(900, 74); x.fillText(String(val), cx + tw / 2, cy + 96);
    x.fillStyle = MUTED; x.font = F(700, 26); x.fillText(label, cx + tw / 2, cy + 142);
  });
  // Footer
  const extra = [s.pim ? `${s.pim} penalty min` : '', s.nShifts ? `avg shift ${fmtT(s.avgShift)}` : '', s.soAtt ? `shootout ${s.soGoals} for ${s.soAtt}` : ''].filter(Boolean).join('  ·  ');
  x.fillStyle = MUTED; x.font = F(600, 30);
  if (extra) x.fillText(extra, W / 2, 1305);
  return new Promise(res => cv.toBlob(res, 'image/png'));
}

/* ---------- Edit game (after-game fixes, or a game entered by hand) ---------- */
function viewEdit() {
  const g = gameById(ui.params.id); if (!g) return viewGames();
  const s = stats(g);
  const seg = (name, opts, val) => `<div class="seg" data-seg="${name}">${opts.map(o => `<button type="button" class="${o === val ? 'on' : ''}" data-act="seg" data-v="${o}">${o}</button>`).join('')}</div>`;
  const typeShort = Object.keys(TYPE_NAMES).find(k => TYPE_NAMES[k] === g.type) || g.type || 'Regular';
  const steps = [['goal', 'Goals'], ['ast', 'Assists'], ['gfOn', 'GF while on ice'], ['gaOn', 'GA while on ice'], ['hit', 'Hits'], ['shot', 'Shot attempts'], ['rush', 'Rushes'], ['blk', 'Blocked shots'], ['pim', 'Penalty minutes']];
  return `<div class="page" style="padding-bottom:24px">${topbar(ui.params.isNew ? 'Add past game' : 'Edit game', null)}
    <div class="wrap">
      <div class="card"><h3>Game</h3>
        <div class="field"><label>Date</label><input id="e-date" type="date" value="${esc(g.date)}"></div>
        <div class="field"><label>Opponent</label><input id="e-opp" value="${esc(g.opponent)}" autocomplete="off"></div>
        <div class="field"><label>Home or away</label>${seg('e-ha', ['Home', 'Away'], g.homeAway || 'Home')}</div>
        <div class="field"><label>Arena</label><input id="e-arena" value="${esc(g.arena)}" autocomplete="off"></div>
        <div class="field"><label>Game type</label>${seg('e-type', ['Regular', 'Playoff', 'Tourney', 'Exhib.'], typeShort)}</div>
        <div class="two">
          <div class="field"><label>Our score</label><input id="e-us" type="number" inputmode="numeric" value="${g.score ? g.score.us : ''}"></div>
          <div class="field"><label>Their score</label><input id="e-them" type="number" inputmode="numeric" value="${g.score ? g.score.them : ''}"></div>
        </div>
        <div class="field"><label>Overtime / shootout</label>${seg('e-ot', ['None', 'OT', 'SO win', 'SO loss'], g.so && g.so.res === 'W' ? 'SO win' : g.so && g.so.res === 'L' ? 'SO loss' : g.hadOT ? 'OT' : 'None')}</div>
        <div class="field"><label>Notes</label><textarea id="e-notes">${esc(g.notes)}</textarea></div>
      </div>
      <div class="card"><h3>Stats</h3>
        ${steps.map(([k, label]) => `<div class="step"><span>${label}</span><div class="ctl"><button data-act="stepper" data-k="${k}" data-d="-1">−</button><b id="st-${k}">${s[k]}</b><button data-act="stepper" data-k="${k}" data-d="1">+</button></div></div>`).join('')}
        <div class="two" style="margin-top:12px">
          <div class="field"><label>Time on ice (m:ss)</label><input id="e-toi" value="${fmtT(s.toi)}" inputmode="numeric"></div>
          <div class="field"><label>Shifts</label><input id="e-shifts" type="number" inputmode="numeric" value="${s.nShifts}"></div>
        </div>
      </div>
      <button class="btn big" data-act="saveedit" data-id="${g.id}">Save</button>
      <button class="btn alt" data-act="canceledit" data-id="${g.id}">Cancel</button>
    </div></div>`;
}

/* ---------- Games list ---------- */
function seasonPicker(p, s) {
  const list = seasonsFor(p.id);
  if (list.length < 2) return '';
  return `<div class="field" style="margin:0"><select data-change="season">${list.map(x => `<option value="${x.id}" ${x.id === s.id ? 'selected' : ''}>${esc(x.label)} · ${esc(x.level || '')}</option>`).join('')}</select></div>`;
}
function viewGames() {
  const p = activePlayer(), s = curSeason(p);
  const list = s ? gamesFor(p.id, s.id) : [], dups = duplicateIds();
  return `<div class="page">${topbar(`${p.name} · games`)}
    <div class="wrap">
      ${s ? seasonPicker(p, s) : ''}
      <div class="list">${list.map(g => gameRow(g, dups)).join('') || '<div class="card muted">No games yet this season.</div>'}</div>
      <button class="btn alt" data-act="pastgame" ${s ? '' : 'disabled'}>+ Add a past game by hand</button>
    </div>${nav('games')}</div>`;
}

/* ---------- Stats ---------- */
const METRICS = {
  pts: { label: 'Points per game', game: s => s.pts, season: t => t.gp ? t.pts / t.gp : 0, fmt: v => v.toFixed(2), gfmt: v => String(v) },
  toi: { label: 'Time on ice', game: s => s.toi / 60000, season: t => t.gp ? t.toi / t.gp / 60000 : 0, fmt: v => fmtT(v * 60000), gfmt: v => fmtT(v * 60000) },
  pm: { label: 'Plus / minus', game: s => s.pm, season: t => t.pm, fmt: v => signed(Math.round(v)), gfmt: v => signed(v) },
  hit: { label: 'Hits per game', game: s => s.hit, season: t => t.gp ? t.hit / t.gp : 0, fmt: v => v.toFixed(1), gfmt: v => String(v) },
  blk: { label: 'Blocks per game', game: s => s.blk, season: t => t.gp ? t.blk / t.gp : 0, fmt: v => v.toFixed(1), gfmt: v => String(v) },
  shot: { label: 'Shot attempts per game', game: s => s.shot, season: t => t.gp ? t.shot / t.gp : 0, fmt: v => v.toFixed(1), gfmt: v => String(v) },
  rush: { label: 'Rushes per game', game: s => s.rush, season: t => t.gp ? t.rush / t.gp : 0, fmt: v => v.toFixed(1), gfmt: v => String(v) }
};
function barChart(points, fmt) {
  // points: [{label, value}]
  if (!points.length) return '<p class="muted small">No finished games yet.</p>';
  const W = 340, H = 170, top = 18, bottom = 24, left = 4, right = 4;
  const vals = points.map(p => p.value);
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const span = max - min || 1;
  const bw = (W - left - right) / points.length;
  const y = v => top + (max - v) / span * (H - top - bottom);
  const zero = y(0);
  const showVals = points.length <= 14;
  const labelEvery = Math.ceil(points.length / 8);
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
  out += `<line x1="${left}" x2="${W - right}" y1="${zero}" y2="${zero}" stroke="#d6deec"/>`;
  points.forEach((p, i) => {
    const x = left + i * bw + bw * 0.15, w = bw * 0.7;
    const y1 = Math.min(y(p.value), zero), h = Math.max(1.5, Math.abs(y(p.value) - zero));
    out += `<rect x="${x}" y="${y1}" width="${w}" height="${h}" rx="3" fill="${p.value < 0 ? '#c2271d' : '#1a5cc8'}"/>`;
    if (showVals) out += `<text class="val" x="${x + w / 2}" y="${p.value < 0 ? y1 + h + 11 : y1 - 4}" text-anchor="middle">${esc(fmt(p.value))}</text>`;
    if (i % labelEvery === 0) out += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>`;
  });
  return out + '</svg>';
}
function viewStats() {
  const p = activePlayer(), s = curSeason(p), dups = duplicateIds();
  const list = s ? gamesFor(p.id, s.id) : [];
  const t = seasonTotals(list, dups);
  const pg = (n, d = 1) => avg(n, t.gp, d);
  const rows = [
    ['Games played', t.gp, ''], ['Record (W-L-OTL)', `${t.W}-${t.L}-${t.OTL}${t.T ? '-' + t.T : ''}`, ''],
    ['Goals', t.goal, pg(t.goal, 2)], ['Assists', t.ast, pg(t.ast, 2)], ['Points', t.pts, pg(t.pts, 2)],
    ['Plus / minus', signed(t.pm), ''], ['GF on ice', t.gfOn, pg(t.gfOn)], ['GA on ice', t.gaOn, pg(t.gaOn)],
    ['Hits', t.hit, pg(t.hit)], ['Shot attempts', t.shot, pg(t.shot)], ['Rushes', t.rush, pg(t.rush)],
    ['Blocked shots', t.blk, pg(t.blk)], ['Penalty minutes', t.pim, pg(t.pim)],
    ['Time on ice', fmtT(t.toi), t.gp ? fmtT(t.toi / t.gp) : '–'], ['Shifts', t.shifts, pg(t.shifts)],
    ['Avg shift', t.shifts ? fmtT(t.toi / t.shifts) : '–', ''], ['Longest shift', t.longest ? fmtT(t.longest) : '–', '']
  ];
  if (t.soAtt) rows.push(['Shootout', `${t.soGoals} for ${t.soAtt}`, '']);

  const m = METRICS[ui.chartMetric] || METRICS.pts;
  const finished = list.filter(g => g.status === 'final' && !dups.has(g.id)).slice().reverse();
  const gamePts = finished.map(g => ({ label: fmtDate(g.date, { month: 'short', day: 'numeric' }), value: m.game(stats(g)) }));
  const allSeasons = seasonsFor(p.id).slice().reverse();
  const seasonPts = allSeasons.map(se => ({ label: se.label, value: m.season(seasonTotals(gamesFor(p.id, se.id), dups)) }));
  const career = allSeasons.map(se => ({ se, t: seasonTotals(gamesFor(p.id, se.id), dups) }));
  const ct = career.reduce((a, { t: x }) => { for (const k in x) a[k] = (a[k] || 0) + x[k]; return a; }, {});

  return `<div class="page">${topbar(`${p.name} · stats`)}
    <div class="wrap">
      ${s ? seasonPicker(p, s) : ''}
      <div class="card"><h3>${esc(s ? s.label : '')} totals</h3>
        <table class="stats"><tr><td class="small muted">Stat</td><td class="small muted" style="font-weight:600">Total · Per game</td></tr>
        ${rows.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}${c ? ` <span class="muted" style="font-weight:500">· ${c}</span>` : ''}</td></tr>`).join('')}</table>
      </div>
      <div class="card"><h3>Charts</h3>
        <div class="field"><select data-change="metric">${Object.entries(METRICS).map(([k, v]) => `<option value="${k}" ${k === ui.chartMetric ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
        <div class="small muted" style="font-weight:700;margin-bottom:4px">Game by game · ${esc(s ? s.label : '')}</div>
        ${barChart(gamePts, m.gfmt)}
        <div class="small muted" style="font-weight:700;margin:12px 0 4px">Season by season</div>
        ${barChart(seasonPts, m.fmt)}
      </div>
      <div class="card"><h3>Career</h3><div class="scroll-x"><table class="grid">
        <tr><th>Season</th><th>GP</th><th>G</th><th>A</th><th>P</th><th>+/-</th><th>Hits</th><th>Blk</th><th>SA</th><th>PIM</th><th>TOI/GP</th></tr>
        ${career.map(({ se, t: x }) => `<tr><td>${esc(se.label)} <span class="muted small">${esc(se.level || '')}</span></td><td>${x.gp}</td><td>${x.goal}</td><td>${x.ast}</td><td>${x.pts}</td><td>${signed(x.pm)}</td><td>${x.hit}</td><td>${x.blk}</td><td>${x.shot}</td><td>${x.pim}</td><td>${x.gp ? fmtT(x.toi / x.gp) : '–'}</td></tr>`).join('')}
        ${career.length > 1 ? `<tr><td><b>Career</b></td><td><b>${ct.gp}</b></td><td><b>${ct.goal}</b></td><td><b>${ct.ast}</b></td><td><b>${ct.pts}</b></td><td><b>${signed(ct.pm)}</b></td><td><b>${ct.hit}</b></td><td><b>${ct.blk}</b></td><td><b>${ct.shot}</b></td><td><b>${ct.pim}</b></td><td><b>${ct.gp ? fmtT(ct.toi / ct.gp) : '–'}</b></td></tr>` : ''}
      </table></div></div>
      <p class="small muted">Plus/minus counts every goal for and against while he's on the ice, including power-play goals.</p>
    </div>${nav('stats')}</div>`;
}

/* ---------- Settings ---------- */
function viewSettings() {
  const st = db.settings, p = activePlayer();
  const connected = !!st.url;
  return `<div class="page">${topbar('Settings')}
    <div class="wrap">
      <div class="card"><h3>Players</h3>
        <div class="list">${players().map(x => `<div class="row" style="background:var(--bg)">
          <label class="photo-row" style="cursor:pointer">${avatar(x, 48)}<input type="file" accept="image/*" class="hidden" data-change="photo" data-id="${x.id}"></label>
          <div class="grow"><div class="title">${esc(x.name)}</div><div class="meta">${seasonsFor(x.id).map(s => esc(s.label + ' ' + (s.level || ''))).join(' · ') || 'No seasons'}</div></div>
          <button class="badge" style="border:0" data-act="editplayer" data-id="${x.id}">Edit</button></div>`).join('')}</div>
        <p class="small muted">Tap a photo circle to add a picture.</p>
        <button class="btn alt" data-act="addplayer">+ Add player (e.g. Cody)</button>
      </div>

      ${p ? `<div class="card"><h3>${esc(p.name)}'s seasons</h3>
        <div class="list">${seasonsFor(p.id).map(s => `<button class="row" style="background:var(--bg)" data-act="editseason" data-id="${s.id}"><div class="grow"><div class="title">${esc(s.label)}</div><div class="meta">${esc([s.team, s.level, s.jersey ? '#' + s.jersey : ''].filter(Boolean).join(' · '))}</div></div><span class="badge">Edit</span></button>`).join('')}</div>
        <button class="btn alt" style="margin-top:10px" data-act="addseason">+ Add season</button></div>` : ''}

      <div class="card"><h3>This phone</h3>
        <div class="field"><label>Your name (shows as "Recorded by")</label><input id="s-me" value="${esc(st.deviceName)}" data-change="me"></div>
      </div>

      <div class="card"><h3>Google Sheet sync</h3>
        ${syncLine()}
        ${connected ? `
          <div class="btn-row" style="margin-top:12px"><button class="btn alt" data-act="syncnow">Sync now</button><button class="btn alt" data-act="shareaccess">Share access</button></div>
          ${st.badKey ? `<div class="field" style="margin-top:12px"><label>Paste the new setup link</label><textarea id="s-link"></textarea></div>
          <button class="btn" data-act="pastelink" data-src="s-link">Reconnect with link</button>` : `<button class="btn danger" style="margin-top:10px" data-act="rotate">Reset access (disconnect other phones)</button>`}
          <details style="margin-top:12px"><summary class="small muted">Connection details</summary>
            <div class="field" style="margin-top:10px"><label>Web App URL</label><input id="s-url" value="${esc(st.url)}"></div>
            <div class="field"><label>Access key</label><input id="s-key" value="${esc(st.key)}"></div>
            <button class="btn line" data-act="saveconn">Save &amp; test</button>
            <button class="btn danger" style="margin-top:8px" data-act="disconnect">Disconnect this phone</button>
          </details>` : `
          <p class="small muted">Paste the Web App URL and access key from the Apps Script setup, or paste a setup link.</p>
          <div class="field"><label>Web App URL</label><input id="s-url" placeholder="https://script.google.com/macros/s/…/exec"></div>
          <div class="field"><label>Access key</label><input id="s-key"></div>
          <button class="btn" data-act="saveconn">Connect</button>
          <div class="field" style="margin-top:14px"><label>…or paste a setup link</label><textarea id="s-link"></textarea></div>
          <button class="btn line" data-act="pastelink" data-src="s-link">Connect with link</button>`}
      </div>

      <div class="card"><h3>Backup</h3>
        <p class="small muted" style="margin-top:0">Extra safety copy of everything on this phone.</p>
        <div class="btn-row"><button class="btn alt" data-act="export">Save backup file</button>
        <label class="btn alt" style="cursor:pointer">Restore backup<input type="file" accept="application/json,.json" class="hidden" data-change="import"></label></div>
      </div>
      <p class="small muted" style="text-align:center">Hockey Stats ${APP_VERSION}</p>
    </div>${nav('settings')}</div>`;
}
function afterSettings() { /* hook for future */ }

/* ---------- Connect screen (opened from a QR code / setup link) ---------- */
let pendingConnect = null;
function viewConnect() {
  const c = pendingConnect || {};
  return `<div class="page" style="padding-bottom:24px">
    <div class="hero"><h1>Hockey Stats</h1><div class="sub">Connect this phone to the team stats sheet</div></div>
    <div class="wrap"><div class="card">
      <div class="field"><label>Your name (shows as "Recorded by")</label><input id="c-name" value="${esc(c.n || '')}" autocomplete="off"></div>
      <button class="btn big" data-act="doconnect">Connect</button>
      <button class="btn alt" style="margin-top:10px" data-act="cancelconnect">Cancel</button>
    </div>
    ${!isStandalone() ? `<div class="banner info">After connecting: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>, so Hockey Stats opens like an app.</div>` : ''}
    </div></div>`;
}
function parseConnectLink(text) {
  // Email scanners (like Outlook Safe Links) wrap the link and percent-encode it, so decode before looking.
  let str = String(text || '').trim();
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(str); if (d === str) break; str = d; } catch (e) { break; } }
  const m = str.match(/#connect=([A-Za-z0-9_\-]+)/);
  if (!m) return null;
  try {
    const o = JSON.parse(b64urlDecode(m[1]));
    if (!o.s || !o.k) return null;
    o.url = /^https?:/.test(o.s) ? o.s : `https://script.google.com/macros/s/${o.s}/exec`;
    return o;
  } catch (e) { return null; }
}
function makeConnectLink(name) {
  const m = db.settings.url.match(/\/s\/([^/]+)\/exec/);
  const payload = { s: m ? m[1] : db.settings.url, k: db.settings.key, n: name };
  return location.origin + location.pathname + '#connect=' + b64urlEncode(JSON.stringify(payload));
}
function checkHashConnect() {
  const c = parseConnectLink(location.hash);
  if (!c) return false;
  // Already connected to this sheet? Ignore the old link (it may hold a key that was since reset).
  if (db.settings.url === c.url && (db.settings.key === c.k || !db.settings.badKey)) {
    if (isStandalone()) history.replaceState(null, '', location.pathname);
    return false;
  }
  pendingConnect = c;
  ui.view = 'connect';
  return true;
}

/* ============================== Modal ============================== */
const modal = $('#modal');
function openSheet(html) { modal.innerHTML = `<div class="sheet">${html}</div>`; modal.hidden = false; }
function closeSheet() { modal.hidden = true; modal.innerHTML = ''; }
modal.addEventListener('click', e => { if (e.target === modal) closeSheet(); });

function formSheet(title, fields, onSave, extraBtn = '') {
  openSheet(`<h3>${esc(title)}</h3>${fields.map(f => `<div class="field"><label>${esc(f.label)}</label><input id="fs-${f.k}" value="${esc(f.v || '')}" ${f.num ? 'inputmode="numeric"' : ''} autocomplete="off"></div>`).join('')}
    <button class="btn" data-act="fssave">Save</button>${extraBtn}<button class="btn alt" data-act="close">Cancel</button>`);
  formSheet.cb = () => { const out = {}; fields.forEach(f => out[f.k] = $('#fs-' + f.k).value.trim()); onSave(out); };
}

/* ============================== Actions ============================== */
const A = {
  nav: d => go(d.v === 'game' && !myLiveGame() ? 'home' : d.v),
  close: () => closeSheet(),
  fssave: () => { formSheet.cb && formSheet.cb(); },
  seg: (d, el) => { el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); },
  syncnow: () => syncNow(true),
  player: d => { db.settings.activePlayerId = d.id; ui.seasonId = null; saveDb(); render(); },

  welcome() {
    const name = $('#w-name').value.trim() || 'Player';
    db.settings.deviceName = $('#w-me').value.trim() || 'Me';
    const p = { id: uid(), name };
    db.players.push(p); touch('players', p);
    const s = { id: uid(), playerId: p.id, label: $('#w-season').value.trim() || seasonLabelFor(), team: $('#w-team').value.trim(), level: $('#w-level').value.trim(), jersey: $('#w-jersey').value.trim() };
    db.seasons.push(s); touch('seasons', s);
    db.settings.activePlayerId = p.id; saveDb();
    go('home');
  },

  newgame() {
    syncNow(); // quietly pull the latest so we can spot a game someone else is already tracking
    go('newgame');
  },
  resume: () => go('game'),
  startgame() {
    const p = activePlayer(), s = curSeason(p);
    const date = $('#n-date').value || todayISO();
    const opp = $('#n-opp').value.trim();
    const clash = db.games.find(g => !g.deleted && g.playerId === p.id && g.date === date && g.recordedBy !== db.settings.deviceName &&
      (g.opponent || '').trim().toLowerCase() === opp.toLowerCase());
    if (clash && !confirm(`${clash.recordedBy} already has a game for ${p.name} on this date vs ${clash.opponent || 'this opponent'}. Track it here too? (Only one will count.)`)) return;
    const type = segVal('n-type');
    const g = {
      id: uid(), playerId: p.id, seasonId: s.id, date, opponent: opp, homeAway: segVal('n-ha'), arena: $('#n-arena').value.trim(),
      type: TYPE_NAMES[type] || type, periodLen: Number($('#n-plen').value) || 20, otLen: Number($('#n-otlen').value) || 5,
      status: 'live', recordedBy: db.settings.deviceName || 'Me', deviceId: db.settings.deviceId, t0: Date.now(), ev: [], adj: {}, so: { att: [], res: null }, notes: ''
    };
    db.games.push(g); touch('games', g);
    go('game');
  },

  shift() {
    const g = myLiveGame(); const c = compute(g, Date.now());
    if (!c.live) return;
    addEvents(g, [[c.onIce ? 'off' : 'on']]); render();
  },
  whistle() {
    const g = myLiveGame(); const c = compute(g, Date.now());
    if (!c.live) return;
    addEvents(g, [[c.paused ? 'pl' : 'wh']]); render();
  },
  tap(d) {
    const g = myLiveGame(); const k = d.k;
    if (k === 'pen') return openSheet(`<h3>Penalty — how many minutes?</h3>
      <div class="pen-grid">${[2, 4, 5, 10].map(n => `<button data-act="pen" data-v="${n}">${n}<small>min</small></button>`).join('')}</div>
      <p class="small muted" style="margin:0">If he's on the ice, his shift ends automatically.</p>
      <button class="btn alt" data-act="close">Cancel</button>`);
    // A goal or assist by him is also a goal for his team while he's on the ice.
    if (k === 'goal' || k === 'ast') addEvents(g, [['gf'], [k]]);
    else addEvents(g, [[k]]);
    render();
  },
  pen(d) {
    const g = myLiveGame(); const c = compute(g, Date.now());
    const list = c.onIce ? [['off'], ['pen', Number(d.v)]] : [['pen', Number(d.v)]];
    addEvents(g, list); closeSheet(); render();
  },
  pstart(d) {
    const g = myLiveGame(); addEvents(g, [['ps', Number(d.p)]]); render();
  },
  pend() {
    const g = myLiveGame(); const c = compute(g, Date.now());
    if (!c.live) return;
    if (!confirm(`End ${periodLong(c.period).toLowerCase()}?`)) return;
    addEvents(g, c.onIce ? [['off'], ['pe', c.period]] : [['pe', c.period]]);
    syncNow();
    render();
  },
  undo() {
    const g = myLiveGame(); if (!g || !g.ev.length) return;
    const grp = g.ev[g.ev.length - 1][2];
    while (g.ev.length && g.ev[g.ev.length - 1][2] === grp) g.ev.pop();
    touch('games', g); render();
  },
  gmenu() {
    const g = myLiveGame(); const c = compute(g, Date.now());
    openSheet(`<h3>Game</h3>
      ${c.live ? '' : `<button class="btn alt" data-act="shootout">Shootout</button>`}
      <button class="btn alt" data-act="gameinfo">Edit opponent / arena</button>
      <button class="btn alt" data-act="finish">Finish game now</button>
      <button class="btn alt" data-act="leave">Back to home (game keeps running)</button>
      <button class="btn danger" data-act="discard">Discard this game</button>
      <button class="btn alt" data-act="close">Close</button>`);
  },
  gameinfo() {
    const g = myLiveGame();
    formSheet('Game info', [{ k: 'opponent', label: 'Opponent', v: g.opponent }, { k: 'arena', label: 'Arena', v: g.arena }], v => {
      g.opponent = v.opponent; g.arena = v.arena; touch('games', g); closeSheet(); render();
    });
  },
  leave: () => { closeSheet(); go('home'); },
  discard() {
    const g = myLiveGame();
    if (!confirm('Discard this game and everything tapped in it?')) return;
    g.deleted = true; touch('games', g); closeSheet(); go('home');
  },
  shootout: () => { closeSheet(); go('shootout'); },
  soatt(d) { const g = myLiveGame(); g.so = g.so || { att: [], res: null }; g.so.att.push(d.v === '1' ? 1 : 0); touch('games', g); render(); },
  soundo() { const g = myLiveGame(); g.so.att.pop(); touch('games', g); render(); },
  sores(d) { const g = myLiveGame(); g.so.res = g.so.res === d.v ? null : d.v; touch('games', g); render(); },
  finish() {
    const g = myLiveGame(); const c = compute(g, Date.now());
    closeSheet();
    if (c.live) {
      if (!confirm(`End ${periodLong(c.period).toLowerCase()} and finish the game?`)) return;
      addEvents(g, c.onIce ? [['off'], ['pe', c.period]] : [['pe', c.period]]);
    }
    go('finish');
  },
  savefinal() {
    const g = myLiveGame(); const c = compute(g, Date.now());
    g.score = { us: Number($('#f-us').value) || 0, them: Number($('#f-them').value) || 0 };
    g.notes = $('#f-notes').value.trim();
    g.hadOT = c.maxPeriod >= 4;
    g.status = 'final';
    touch('games', g);
    keepAwake(false);
    syncNow();
    go('summary', { id: g.id });
  },

  summary: d => go('summary', { id: d.id }),
  async share(d) {
    const g = gameById(d.id), text = shareText(g);
    let file = null;
    try {
      const blob = await drawShareCard(g);
      const nm = `${playerName(g.playerId)}-${g.date}-vs-${(g.opponent || 'game').replace(/[^a-z0-9]+/gi, '-')}.png`;
      file = new File([blob], nm, { type: 'image/png' });
    } catch (e) { /* drawing not supported: text only */ }
    if (navigator.share) {
      try {
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], text });
        else await navigator.share({ text });
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    // No share sheet (e.g. a computer): show the card and the text to copy.
    const url = file ? URL.createObjectURL(file) : '';
    openSheet(`<h3>Game recap</h3>
      ${url ? `<img src="${url}" alt="Game recap picture" style="width:100%;border-radius:14px;border:1px solid var(--line)">` : ''}
      <pre id="sh-text" style="white-space:pre-wrap;font:15px/1.45 inherit;background:var(--bg);padding:12px;border-radius:12px;margin:0">${esc(text)}</pre>
      <button class="btn" data-act="copyrecap">Copy text</button>
      <button class="btn alt" data-act="close">Close</button>`);
    A.copyrecap.text = text;
  },
  copyrecap() {
    const t = A.copyrecap.text;
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => alert('Copied — paste it into a text.')).catch(() => alert('Press and hold the text to copy it.'));
  },
  edit: d => go('edit', { id: d.id }),
  pastgame() {
    const p = activePlayer(), s = curSeason(p);
    const g = { id: uid(), playerId: p.id, seasonId: s.id, date: todayISO(), opponent: '', homeAway: 'Home', arena: '', type: 'Regular', status: 'final',
      recordedBy: db.settings.deviceName || 'Me', deviceId: db.settings.deviceId, t0: Date.now(), ev: [], adj: {}, so: { att: [], res: null }, notes: '', score: { us: 0, them: 0 }, draft: true };
    db.games.push(g); saveDb();
    go('edit', { id: g.id, isNew: true });
  },
  stepper(d) {
    const el = $('#st-' + d.k);
    el.textContent = Math.max(0, Number(el.textContent) + Number(d.d) * (d.k === 'pim' ? 2 : 1));
  },
  canceledit(d) {
    const g = gameById(d.id);
    if (g && g.draft) { db.games = db.games.filter(x => x !== g); saveDb(); return go('games'); }
    go('summary', { id: d.id });
  },
  saveedit(d) {
    const g = gameById(d.id); const raw = compute(g);
    g.date = $('#e-date').value || g.date;
    g.opponent = $('#e-opp').value.trim();
    g.arena = $('#e-arena').value.trim();
    g.homeAway = segVal('e-ha');
    const t = segVal('e-type'); g.type = TYPE_NAMES[t] || t;
    const us = $('#e-us').value, them = $('#e-them').value;
    g.score = us === '' && them === '' ? null : { us: Number(us) || 0, them: Number(them) || 0 };
    const ot = segVal('e-ot');
    g.hadOT = ot !== 'None';
    g.so = g.so || { att: [], res: null };
    g.so.res = ot === 'SO win' ? 'W' : ot === 'SO loss' ? 'L' : null;
    g.notes = $('#e-notes').value.trim();
    g.adj = {};
    for (const k of ADJ_KEYS) {
      const want = Number($('#st-' + k).textContent) || 0;
      if (want !== raw[k]) g.adj[k] = want - raw[k];
    }
    const toi = parseT($('#e-toi').value);
    g.toiOverride = toi != null && fmtT(toi) !== fmtT(raw.toi) ? toi : null;
    const sh = $('#e-shifts').value;
    g.shiftsOverride = sh !== '' && Number(sh) !== raw.shifts.length ? Number(sh) : null;
    // Keep the game in the season that matches its date if one exists.
    const target = seasonsFor(g.playerId).find(se => se.label === seasonLabelFor(new Date(g.date + 'T12:00')));
    if (target) g.seasonId = target.id;
    delete g.draft;
    g.status = g.status === 'live' ? 'live' : 'final';
    touch('games', g);
    go('summary', { id: g.id });
  },
  delgame(d) {
    const g = gameById(d.id);
    if (!confirm(`Delete the game vs ${g.opponent || 'opponent'} on ${fmtDate(g.date)}?`)) return;
    g.deleted = true; touch('games', g); go('games');
  },

  addplayer() {
    formSheet('Add player', [{ k: 'name', label: 'Name', v: '' }, { k: 'label', label: 'Season', v: seasonLabelFor() }, { k: 'team', label: 'Team', v: 'St. James Canucks' }, { k: 'level', label: 'Level', v: '' }, { k: 'jersey', label: 'Jersey #', v: '', num: true }], v => {
      if (!v.name) return;
      const p = { id: uid(), name: v.name }; db.players.push(p); touch('players', p);
      const s = { id: uid(), playerId: p.id, label: v.label || seasonLabelFor(), team: v.team, level: v.level, jersey: v.jersey };
      db.seasons.push(s); touch('seasons', s);
      db.settings.activePlayerId = p.id; ui.seasonId = null; saveDb(); closeSheet(); render();
    });
  },
  editplayer(d) {
    const p = db.players.find(x => x.id === d.id);
    formSheet('Edit player', [{ k: 'name', label: 'Name', v: p.name }], v => {
      if (v.name) p.name = v.name; touch('players', p); closeSheet(); render();
    }, `<button class="btn danger" data-act="delplayer" data-id="${p.id}">Remove player</button>`);
  },
  delplayer(d) {
    const p = db.players.find(x => x.id === d.id);
    if (!confirm(`Remove ${p.name}? Their games stay in the Google Sheet but are hidden here.`)) return;
    p.deleted = true; touch('players', p);
    if (db.settings.activePlayerId === p.id) db.settings.activePlayerId = (players()[0] || {}).id || null;
    saveDb(); closeSheet(); render();
  },
  addseason() {
    const p = activePlayer(), last = seasonsFor(p.id)[0] || {};
    const nextLabel = last.label ? (() => { const y = parseInt(last.label, 10) + 1; return `${y}–${String((y + 1) % 100).padStart(2, '0')}`; })() : seasonLabelFor();
    formSheet(`New season for ${p.name}`, [{ k: 'label', label: 'Season', v: nextLabel }, { k: 'team', label: 'Team', v: last.team || '' }, { k: 'level', label: 'Level', v: '' }, { k: 'jersey', label: 'Jersey #', v: last.jersey || '', num: true }], v => {
      const s = { id: uid(), playerId: p.id, label: v.label || nextLabel, team: v.team, level: v.level, jersey: v.jersey };
      db.seasons.push(s); touch('seasons', s); ui.seasonId = s.id; closeSheet(); render();
    });
  },
  editseason(d) {
    const s = db.seasons.find(x => x.id === d.id);
    formSheet('Edit season', [{ k: 'label', label: 'Season', v: s.label }, { k: 'team', label: 'Team', v: s.team }, { k: 'level', label: 'Level', v: s.level }, { k: 'jersey', label: 'Jersey #', v: s.jersey, num: true }], v => {
      Object.assign(s, v); touch('seasons', s); closeSheet(); render();
    });
  },

  async saveconn() {
    const url = $('#s-url').value.trim(), key = $('#s-key').value.trim();
    if (!/^https:\/\/script\.google\.com\//.test(url)) return alert('The Web App URL should start with https://script.google.com/');
    if (!key) return alert('Enter the access key.');
    const old = { url: db.settings.url, key: db.settings.key };
    db.settings.url = url; db.settings.key = key;
    try { await api({ action: 'ping' }); db.settings.lastSyncError = null; saveDb(); await syncNow(true); alert('Connected to the Google Sheet.'); }
    catch (e) { Object.assign(db.settings, old); saveDb(); alert('Could not connect: ' + e.message); }
    render();
  },
  pastelink(d) {
    const c = parseConnectLink($('#' + d.src).value);
    if (!c) return alert("That doesn't look like a setup link. It should contain #connect=");
    pendingConnect = c; go('connect');
  },
  async doconnect() {
    const c = pendingConnect; if (!c) return go('home');
    const name = $('#c-name').value.trim() || c.n || 'Me';
    const old = { url: db.settings.url, key: db.settings.key, deviceName: db.settings.deviceName };
    Object.assign(db.settings, { url: c.url, key: c.k, deviceName: name, lastSyncError: null });
    try {
      await api({ action: 'ping' });
      saveDb();
      await syncNow(true);
      pendingConnect = null;
      if (isStandalone()) history.replaceState(null, '', location.pathname);
      if (!db.settings.activePlayerId && players()[0]) db.settings.activePlayerId = players()[0].id;
      saveDb();
      go('home');
    } catch (e) {
      Object.assign(db.settings, old); saveDb();
      alert('Could not connect: ' + e.message);
    }
  },
  cancelconnect() { pendingConnect = null; history.replaceState(null, '', location.pathname); go('home'); },
  disconnect() {
    if (!confirm('Disconnect this phone from the Google Sheet? Games stay on this phone.')) return;
    Object.assign(db.settings, { url: '', key: '', lastSync: null, lastSyncError: null });
    saveDb(); render();
  },
  shareaccess() {
    openSheet(`<h3>Share access</h3>
      <p class="small muted" style="margin:0">Creates a QR code that connects another phone to this sheet.</p>
      <div class="field"><label>Who is it for?</label><input id="sa-name" value="Kyla" autocomplete="off"></div>
      <button class="btn" data-act="makeqr">Make QR code</button>
      <div id="sa-out"></div>
      <button class="btn alt" data-act="close">Close</button>`);
  },
  async makeqr() {
    const name = $('#sa-name').value.trim() || 'Guest';
    const link = makeConnectLink(name);
    const out = $('#sa-out');
    out.innerHTML = `<div class="qr-box"><div id="qr"></div></div>
      <p class="small" style="margin:8px 0">${esc(name)}: open the iPhone <b>Camera</b>, point it at this code and tap the link. Then in Safari tap <b>Share → Add to Home Screen</b>.</p>
      <button class="btn line" data-act="sendlink">Text the link instead</button>`;
    A.sendlink.link = link;
    try {
      await loadScript(QR_LIB);
      new window.QRCode($('#qr'), { text: link, width: 460, height: 460, correctLevel: window.QRCode.CorrectLevel.L });
    } catch (e) {
      $('#qr').innerHTML = '<p class="small">Couldn\'t load the QR maker (no internet?). Use "Text the link" instead.</p>';
    }
  },
  sendlink() {
    const link = A.sendlink.link;
    const text = `Hockey Stats setup link — tap it, then in Safari tap Share → Add to Home Screen:\n${link}`;
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => alert('Link copied.'));
  },
  async rotate() {
    if (!confirm('Reset access? Every other phone (like Kyla\'s) will stop syncing until you share a new QR code with them.')) return;
    try {
      const j = await api({ action: 'rotate' });
      db.settings.key = j.key; db.settings.lastSyncError = null; saveDb();
      alert('Done. Other phones are disconnected. Use "Share access" to reconnect anyone who should still have it.');
      render();
    } catch (e) { alert('Could not reset: ' + e.message); }
  },
  export() {
    const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hockey-stats-backup-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
};

const CHANGE = {
  season: el => { ui.seasonId = el.value; render(); },
  metric: el => { ui.chartMetric = el.value; render(); },
  me: el => { db.settings.deviceName = el.value.trim(); saveDb(); },
  photo: el => {
    const file = el.files && el.files[0]; if (!file) return;
    const p = db.players.find(x => x.id === el.dataset.id);
    const img = new Image();
    img.onload = () => {
      const size = 240, cv = document.createElement('canvas'); cv.width = cv.height = size;
      const s = Math.min(img.width, img.height);
      cv.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      p.photo = cv.toDataURL('image/jpeg', 0.75); touch('players', p); render();
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  },
  import: el => {
    const file = el.files && el.files[0]; if (!file) return;
    file.text().then(txt => {
      const d = JSON.parse(txt);
      if (!d || d.v !== 1) throw new Error('Not a Hockey Stats backup');
      merge({ players: d.players, seasons: d.seasons, games: d.games }, true);
      alert('Backup restored.'); render();
    }).catch(e => alert('Could not restore: ' + e.message));
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = A[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el && CHANGE[el.dataset.change]) CHANGE[el.dataset.change](el);
});

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`) && window.QRCode) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}

/* ============================== Keep screen awake ============================== */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* not supported or not allowed right now */ }
}

/* ============================== Google Sheet sync ============================== */
let syncTimer = null, syncing = false;
function scheduleSync(delay = 4000) {
  if (!db.settings.url || syncTimer) return;
  syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, delay);
}
async function api(payload) {
  const res = await fetch(db.settings.url, { method: 'POST', body: JSON.stringify({ ...payload, key: db.settings.key }), redirect: 'follow' });
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); }
  catch (e) { throw new Error('Unexpected reply from Google. Check the Web App URL and that it is deployed with access set to "Anyone".'); }
  if (!j.ok) { const err = new Error(j.error || 'Sync failed'); err.code = j.code; throw err; }
  return j;
}
function summaryRow(g) {
  const s = stats(g), se = seasonOf(g.seasonId);
  return {
    player: playerName(g.playerId), season: se.label || '', score: scoreText(g), result: resultLabel(g),
    toi: fmtT(s.toi), shifts: s.nShifts, avgShift: fmtT(s.avgShift), longest: fmtT(s.longest),
    goal: s.goal, ast: s.ast, pts: s.pts, pm: s.pm, gfOn: s.gfOn, gaOn: s.gaOn, hit: s.hit, pim: s.pim, shot: s.shot, rush: s.rush, blk: s.blk,
    so: s.soAtt ? `${s.soGoals}/${s.soAtt}${g.so.res ? ' ' + g.so.res : ''}` : (g.so && g.so.res ? g.so.res : '')
  };
}
function merge(data, force) {
  let changed = false;
  for (const kind of ['players', 'seasons', 'games']) {
    for (const rec of data[kind] || []) {
      if (!rec || !rec.id) continue;
      const i = db[kind].findIndex(x => x.id === rec.id);
      if (i < 0) { db[kind].push(rec); changed = true; }
      else if ((rec.updatedAt || 0) > (db[kind][i].updatedAt || 0) || (force && (rec.updatedAt || 0) >= (db[kind][i].updatedAt || 0))) { db[kind][i] = rec; changed = true; }
    }
  }
  if (!db.settings.activePlayerId && players()[0]) db.settings.activePlayerId = players()[0].id;
  saveDb();
  return changed;
}
async function syncNow(manual) {
  if (syncing || !db.settings.url) return;
  if (!navigator.onLine) { refreshSyncLine(); return; }
  syncing = true; ui.syncState = 'syncing'; refreshSyncLine();
  const keys = Object.keys(db.settings.dirty);
  const sent = {}, out = { players: [], seasons: [], games: [] };
  for (const k of keys) {
    const [kind, id] = k.split(':');
    const rec = (db[kind] || []).find(x => x.id === id);
    if (!rec || rec.draft) continue;
    sent[k] = rec.updatedAt;
    out[kind].push(kind === 'games' ? { rec, summary: summaryRow(rec) } : { rec });
  }
  try {
    const j = await api({ action: 'sync', device: db.settings.deviceName, ...out });
    const changed = merge(j.data || {});
    for (const k of keys) {
      const [kind, id] = k.split(':');
      const rec = (db[kind] || []).find(x => x.id === id);
      if (!rec || rec.updatedAt === sent[k]) delete db.settings.dirty[k];
    }
    db.settings.lastSync = Date.now(); db.settings.lastSyncError = null; db.settings.badKey = false; saveDb();
    ui.syncState = '';
    if (changed && !['game', 'edit', 'newgame', 'finish', 'connect'].includes(ui.view) && modal.hidden) render();
  } catch (e) {
    ui.syncState = '';
    db.settings.badKey = e.code === 'BAD_KEY';
    db.settings.lastSyncError = e.code === 'BAD_KEY'
      ? "This phone's access was reset. Ask for a new QR code, then use Settings → Connect."
      : e.message === 'Failed to fetch' || e.name === 'TypeError' ? 'No connection to Google right now — will retry.' : (e.message || 'Sync failed');
    saveDb();
    if (manual) alert('Sync problem: ' + db.settings.lastSyncError);
  } finally {
    syncing = false;
    refreshSyncLine();
    if (Object.keys(db.settings.dirty).length && db.settings.lastSyncError !== null && !/reset/.test(db.settings.lastSyncError)) scheduleSync(30000);
    else if (Object.keys(db.settings.dirty).length) scheduleSync(8000);
  }
}
function refreshSyncLine() {
  document.querySelectorAll('.sync-line').forEach(el => { el.outerHTML = syncLine(); });
}
window.addEventListener('online', () => { db.settings.lastSyncError = null; syncNow(); });
window.addEventListener('offline', refreshSyncLine);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (ui.view === 'game') { wakeLock = null; keepAwake(true); render(); }
    syncNow();
  } else if (db.settings.url && Object.keys(db.settings.dirty).length && navigator.sendBeacon) {
    // App going to the background: last-chance push so nothing is stranded.
    syncNow();
  }
});

/* ============================== Start ============================== */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('hashchange', () => { if (checkHashConnect()) render(); });
checkHashConnect();
if (ui.view !== 'connect' && myLiveGame()) ui.view = 'game';
render();
syncNow();
