/**
 * Hockey Stats — Google Sheet sync
 * ---------------------------------
 * Paste this whole file into Extensions → Apps Script in the Google Sheet.
 * Then: run setup(), deploy as a Web App, paste the Web App URL below,
 * and run makeSetupLink(). Full steps are in SETUP.md.
 */

// 1) Your Netlify address (keep the trailing slash).
const APP_URL = 'https://YOUR-SITE-NAME.netlify.app/';

// 2) After Deploy → New deployment, paste the Web App URL here (ends in /exec).
const WEB_APP_URL = '';

const TABS = {
  Games: ['ID', 'Player', 'Season', 'Date', 'Opponent', 'H/A', 'Arena', 'Type', 'Status', 'Score', 'Result',
          'TOI', 'Shifts', 'Avg Shift', 'Longest Shift', 'G', 'A', 'PTS', '+/-', 'GF On Ice', 'GA On Ice',
          'Hits', 'PIM', 'Shot Att', 'Rushes', 'Blocks', 'Shootout', 'Recorded By', 'Notes', 'Updated', 'Deleted', 'JSON'],
  Players: ['ID', 'Name', 'Updated', 'Deleted', 'JSON'],
  Seasons: ['ID', 'Player', 'Season', 'Team', 'Level', 'Jersey', 'Updated', 'Deleted', 'JSON']
};

/** Run once. Creates the tabs and the access key. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const head = TABS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head])
      .setFontWeight('bold').setBackground('#0b3f91').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.hideColumns(head.length); // JSON column holds the full record the app reads back
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KEY')) props.setProperty('KEY', newKey_());
  Logger.log('Setup done.\nAccess key: ' + props.getProperty('KEY'));
}

/** Run after deploying. Prints a link that connects Grandpa's phone in one tap. */
function makeSetupLink() {
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key) throw new Error('Run setup() first.');
  if (!WEB_APP_URL || WEB_APP_URL.indexOf('/exec') < 0) throw new Error('Paste your Web App URL (ending in /exec) into WEB_APP_URL at the top, save, then run this again.');
  if (APP_URL.indexOf('YOUR-SITE-NAME') >= 0) throw new Error('Put your Netlify address into APP_URL at the top, save, then run this again.');
  const m = WEB_APP_URL.match(/\/s\/([^/]+)\/exec/);
  const payload = JSON.stringify({ s: m ? m[1] : WEB_APP_URL, k: key, n: 'Grandpa' });
  const code = Utilities.base64EncodeWebSafe(payload, Utilities.Charset.UTF_8).replace(/=+$/, '');
  Logger.log('Open this link on the iPhone (email or text it to yourself):\n\n' + APP_URL.replace(/#.*$/, '') + '#connect=' + code);
}

/** Emergency reset from the editor: every phone must be reconnected afterwards. */
function resetKey() {
  const k = newKey_();
  PropertiesService.getScriptProperties().setProperty('KEY', k);
  Logger.log('New access key: ' + k + '\nRun makeSetupLink() to get a fresh link.');
}

function doGet() {
  return ContentService.createTextOutput('Hockey Stats sync is running.');
}

function doPost(e) {
  let out;
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const req = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();
    const key = props.getProperty('KEY');
    if (!key) throw err_('The sheet is not set up yet. Run setup() in Apps Script.', 'NO_SETUP');
    if (req.key !== key) throw err_('Access key not accepted.', 'BAD_KEY');

    if (req.action === 'ping') {
      out = { ok: true };
    } else if (req.action === 'rotate') {
      const k = newKey_();
      props.setProperty('KEY', k);
      out = { ok: true, key: k };
    } else if (req.action === 'sync') {
      upsert_('Players', req.players, (r) => [r.id, r.name || '', r.updatedAt || 0, r.deleted ? 'yes' : '']);
      upsert_('Seasons', req.seasons, (r) => [r.id, playerName_(r.playerId, req.players), r.label || '', r.team || '', r.level || '', txt_(r.jersey), r.updatedAt || 0, r.deleted ? 'yes' : '']);
      upsert_('Games', req.games, (r, s) => [
        r.id, s.player || '', s.season || '', r.date || '', txt_(r.opponent), r.homeAway || '', txt_(r.arena), r.type || '', r.status || '',
        txt_(s.score), s.result || '', txt_(s.toi), num_(s.shifts), txt_(s.avgShift), txt_(s.longest),
        num_(s.goal), num_(s.ast), num_(s.pts), num_(s.pm), num_(s.gfOn), num_(s.gaOn),
        num_(s.hit), num_(s.pim), num_(s.shot), num_(s.rush), num_(s.blk), txt_(s.so),
        txt_(r.recordedBy), txt_(r.notes), r.updatedAt || 0, r.deleted ? 'yes' : ''
      ]);
      out = { ok: true, data: readAll_(), serverTime: Date.now() };
    } else {
      throw err_('Unknown request.');
    }
  } catch (x) {
    out = { ok: false, error: String((x && x.message) || x), code: (x && x.code) || '' };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- helpers ---------------- */
function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) { setup(); sh = ss.getSheetByName(name); }
  return sh;
}

// Insert new rows; update existing rows only if the incoming copy is newer.
function upsert_(name, items, rowFn) {
  if (!items || !items.length) return;
  const sh = sheet_(name);
  const head = TABS[name];
  const updCol = head.indexOf('Updated');
  const last = sh.getLastRow();
  const data = last > 1 ? sh.getRange(2, 1, last - 1, head.length).getValues() : [];
  const index = {};
  data.forEach((row, i) => { index[String(row[0])] = i; });
  const appends = [];
  items.forEach(it => {
    const rec = it && it.rec;
    if (!rec || !rec.id) return;
    const json = JSON.stringify(rec);
    if (json.length > 49000) throw err_('A record is too large for one cell (' + rec.id + ').');
    const row = rowFn(rec, it.summary || {});
    row.push(json);
    const i = index[rec.id];
    if (i === undefined) {
      appends.push(row);
      index[rec.id] = -1;
    } else if (i >= 0 && Number(rec.updatedAt || 0) >= Number(data[i][updCol] || 0)) {
      sh.getRange(i + 2, 1, 1, head.length).setValues([row]);
    }
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, head.length).setValues(appends);
}

function readAll_() {
  const out = {};
  Object.keys(TABS).forEach(name => {
    const key = name.toLowerCase();
    const sh = sheet_(name);
    const last = sh.getLastRow();
    const col = TABS[name].length;
    out[key] = [];
    if (last < 2) return;
    sh.getRange(2, col, last - 1, 1).getValues().forEach(r => {
      try { if (r[0]) out[key].push(JSON.parse(r[0])); } catch (e) { /* skip bad row */ }
    });
  });
  return out;
}

function playerName_(id, incoming) {
  const p = (incoming || []).map(x => x.rec).find(x => x && x.id === id);
  if (p) return p.name;
  const sh = sheet_('Players');
  const last = sh.getLastRow();
  if (last < 2) return '';
  const rows = sh.getRange(2, 1, last - 1, 2).getValues();
  const hit = rows.find(r => r[0] === id);
  return hit ? hit[1] : '';
}

// Text that Sheets would otherwise turn into a date/time/formula (e.g. "4–2", "18:42", "=…").
function txt_(v) {
  if (v === null || v === undefined || v === '') return '';
  return "'" + String(v);
}
function num_(v) { return v === null || v === undefined || v === '' ? '' : Number(v); }
function newKey_() { return Utilities.getUuid().replace(/-/g, ''); }
function err_(msg, code) { const e = new Error(msg); e.code = code || ''; return e; }
