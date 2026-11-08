// Hub for Lovable — main process.
// One window. The UI (card row, grid, input bar) is a normal web page in ui/.
// The focused card shows the real Lovable editor in a native WebContentsView
// layered on top of the card's body. Other cards show snapshots.

const { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, Notification, session, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const DOM = require('./lovable-dom');

// The app used to be called "Lovable Hub". Move its data folder (login, project list, screenshots) to the new
// name once, so nobody has to log in again. Runs before anything else touches the folder.
try {
  const appData = app.getPath('appData');
  const oldDir = path.join(appData, 'Lovable Hub'), newDir = path.join(appData, 'Hub for Lovable');
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
} catch (e) { console.error('could not move the old data folder:', e.message); }

const MAX_LIVE = 5;               // live Lovable editors kept in memory (8 GB Mac: ~100 MB each measured; lower to 3 if the Mac gets slow)
const POLL_MS = 2500;             // how often we check whether an agent is working
const PARTITION = 'persist:lovable';
const HOME_ID = '__home';         // pseudo project: Lovable's dashboard / login page, shown when there's no project list yet
const EDITOR_URL = id => id === HOME_ID ? 'https://lovable.dev/dashboard' : `https://lovable.dev/projects/${id}`;

let win = null;
const views = new Map();          // id -> { view, lastUsed, status, sawWorking, idleTicks, ready }
let focusedId = null;
let focusedBounds = null;
let viewVisible = false;

// ---------- storage ----------
const dataDir = () => app.getPath('userData');
const snapDir = () => path.join(dataDir(), 'snapshots');
const localProjectsFile = () => path.join(dataDir(), 'projects.local.json');

function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, data) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); } }

// The project list comes from the logged-in Lovable account (see "account" below) and is cached here.
const cacheFile = () => path.join(dataDir(), 'projects.cache.json');   // { workspaces: [{id,name,count}], projects: [...] }
const settingsFile = () => path.join(dataDir(), 'settings.json');     // { workspaces: [ids picked in the menu; empty = all] }
const HOME = { id: HOME_ID, name: 'Lovable', home: true };

function workspaceInfo() {
  const cache = readJSON(cacheFile(), null);
  const list = (cache && cache.workspaces) || [];
  const st = readJSON(settingsFile(), {});
  let selected = Array.isArray(st.workspaces) ? st.workspaces : (st.workspace && st.workspace !== 'all' ? [st.workspace] : []);   // old setting: one workspace
  selected = selected.filter(id => list.some(w => w.id === id));
  if (selected.length === list.length) selected = [];   // everything picked = all
  const name = !list.length ? 'Not logged in' : !selected.length ? 'All workspaces'
    : selected.length === 1 ? list.find(w => w.id === selected[0]).name : `${selected.length} workspaces`;
  return { selected, name, list, loggedIn: !!cache };
}

function loadProjects() {
  const cache = readJSON(cacheFile(), null);
  if (!cache || !cache.projects) return [{ ...HOME }];
  const sel = workspaceInfo().selected;
  const local = readJSON(localProjectsFile(), { added: [], names: {}, removed: [] });
  const map = new Map(cache.projects.filter(p => !sel.length || sel.includes(p.workspace_id)).map(p => [p.id, { ...p }]));
  for (const p of local.added || []) if (!map.has(p.id)) map.set(p.id, { ...p });   // added by link (＋), e.g. shared with you
  for (const [id, name] of Object.entries(local.names || {})) if (map.has(id) && !map.get(id).name) map.get(id).name = name;
  for (const id of local.removed || []) map.delete(id);
  const list = [...map.values()];
  if (!list.length) return [{ ...HOME }];
  // attach saved snapshots
  for (const p of list) {
    const f = path.join(snapDir(), p.id + '.jpg');
    if (fs.existsSync(f)) p.snapshot = 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
  }
  return list;
}
function updateLocal(fn) { const l = readJSON(localProjectsFile(), { added: [], names: {}, removed: [] }); fn(l); writeJSON(localProjectsFile(), l); }

// ---------- helpers ----------
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
const exec = (wc, code) => wc.executeJavaScript(code, true).catch(() => null);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setStatus(id, status) {
  const v = views.get(id);
  if (v && v.status === status) return;
  if (v) v.status = status;
  send('status', { id, status });
  showFocused();   // a project that is sending/working stays attached off-screen (see showFocused)
}

async function snapshot(id) {
  const v = views.get(id);
  if (!v || id === HOME_ID) return;
  try {
    const img = await v.view.webContents.capturePage();
    if (img.isEmpty()) return;
    const jpg = img.resize({ width: Math.min(1800, img.getSize().width), quality: 'best' }).toJPEG(88);
    fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(path.join(snapDir(), id + '.jpg'), jpg);
    send('snapshot', { id, dataUrl: 'data:image/jpeg;base64,' + jpg.toString('base64'), at: Date.now() });
  } catch (e) { /* capture can fail while hidden; the next one will work */ }
}

// ---------- Lovable views ----------
function createView(id) {
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, backgroundThrottling: false, contextIsolation: true, sandbox: true }
  });
  view.setBackgroundColor('#0e1222');
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(14);
  const wc = view.webContents;

  // Sign-in popups (Google/GitHub) stay inside the app; everything else opens in your normal browser.
  wc.setWindowOpenHandler(({ url }) => {
    // includes auth.lovable.dev (Lovable's Google sign-in popup) and Firebase auth pages
    // Also the project's own sign-in (Supabase, the preview itself, Apple/Microsoft) and about:blank, which
    // OAuth libraries open first and navigate afterwards. Otherwise it opens in your browser, where the
    // login never reaches the app (separate session).
    if (url === 'about:blank' || /^https:\/\/(([a-z0-9-]+\.)*(lovable\.dev|lovable\.app|lovableproject\.com|supabase\.co|firebaseapp\.com|google\.com)|github\.com|appleid\.apple\.com|login\.microsoftonline\.com)(\/|$)/.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, webPreferences: { partition: PARTITION } } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (win) => {
    // Lovable's preview sign-in ends on http://127.0.0.1/iframe-oauth/callback (nothing listens there inside the app).
    // Send it to the project's own host instead: that page hands the login back to the project.
    let origin = null;
    // The project's own host has no page for /iframe-oauth/callback (404), so we do what that page would do:
    // store the session where the project's sign-in keeps it, close the popup, reload the preview.
    let sawCallback = false, closing = false;
    const handoff = async (p) => {
      if (closing) return; closing = true;
      try {
        const at = p.get('access_token'), rt = p.get('refresh_token');
        if (!at || !rt) return;
        const c = JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString());
        const ref = new URL(c.iss).hostname.split('.')[0];
        const exp = Number(p.get('expires_in')) || 3600;
        const session = { access_token: at, refresh_token: rt, token_type: p.get('token_type') || 'bearer', expires_in: exp,
          expires_at: Math.floor(Date.now() / 1000) + exp,
          user: { id: c.sub, aud: c.aud, role: c.role, email: c.email, phone: c.phone || '', app_metadata: c.app_metadata || {},
            user_metadata: c.user_metadata || {}, is_anonymous: !!c.is_anonymous } };
        const code = 'localStorage.setItem(' + JSON.stringify('sb-' + ref + '-auth-token') + ',' + JSON.stringify(JSON.stringify(session)) + ')';
        for (const f of wc.mainFrame.framesInSubtree) {
          try {
            if (new URL(f.url).origin === origin) {
              await f.executeJavaScript(code);
              const keys = await f.executeJavaScript('Object.keys(localStorage).join(", ")');
            }
          } catch (err) { console.log('[popup] handoff frame error', err.message); }
        }
        sawCallback = true;
      } catch (err) { console.log('[popup] handoff failed', err.message); }
      if (!win.isDestroyed()) win.close();
    };
    const fix = (e, url) => {
      try {
        const x = new URL(url);
        if (/\/~oauth\//.test(x.pathname) && x.protocol === 'https:') origin = x.origin;
        if (x.hostname === '127.0.0.1' && x.pathname.startsWith('/iframe-oauth/') && origin) {
          e.preventDefault();
          handoff(new URLSearchParams(x.hash.replace(/^#/, '')));
        }
      } catch (_) {}
    };
    win.webContents.on('will-navigate', fix);
    win.webContents.on('will-redirect', fix);
    // Once the popup has finished the callback and lands in the app itself, close it and reload the project's
    // preview so it picks up the new login (the popup stored it for the same site).
    win.webContents.on('did-navigate', (_e, url) => {
      try {
        const x = new URL(url);
        if (x.pathname.startsWith('/iframe-oauth/')) sawCallback = true;
        else if (sawCallback && !x.pathname.startsWith('/~oauth') && !x.pathname.startsWith('/__l5e')) setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 400);
      } catch (_) {}
    });
    win.on('closed', () => {
      if (!sawCallback || !origin || wc.isDestroyed()) return;
      for (const f of wc.mainFrame.framesInSubtree) {
        try { if (new URL(f.url).origin === origin) f.executeJavaScript("location.replace('/')").catch(() => {}); } catch (_) {}
      }
    });
    win.webContents.on('did-start-navigation', (_e, url, _ip, main) => { if (main) fix({ preventDefault() {} }, url); });
  });
  wc.on('will-navigate', (e, url) => {
    // keep the card on Lovable; open other sites outside
    if (!/^https:\/\/([a-z0-9-]+\.)*(lovable\.dev|lovable\.app|google\.com|github\.com|supabase\.co)\//.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  wc.on('page-title-updated', (_e, title) => {
    const name = title.replace(/\s*[-|–—]\s*Lovable.*$/i, '').trim();
    if (name && !/^lovable$/i.test(name)) send('title', { id, name });
  });
  wc.on('did-finish-load', async () => {
    const entry = views.get(id); if (entry) entry.ready = true;
    const login = await exec(wc, DOM.IS_LOGIN_PAGE);
    send('login', { id, needsLogin: !!login });
  });
  // our shortcuts work even while you type inside Lovable
  wc.on('before-input-event', (e, input) => { if (handleKey(input)) e.preventDefault(); });

  wc.loadURL(EDITOR_URL(id));
  const entry = { view, lastUsed: Date.now(), status: 'idle', sawWorking: false, idleTicks: 0, ready: false };
  views.set(id, entry);
  evictIfNeeded();
  return entry;
}

function ensureView(id) {
  const v = views.get(id) || createView(id);
  v.lastUsed = Date.now();
  return v;
}

function evictIfNeeded() {
  if (views.size <= MAX_LIVE) return;
  const candidates = [...views.entries()]
    .filter(([id, v]) => id !== focusedId && v.status !== 'working' && v.status !== 'sending')
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (views.size > MAX_LIVE && candidates.length) {
    const [id, v] = candidates.shift();
    snapshot(id).finally(() => {
      try { win.contentView.removeChildView(v.view); } catch {}
      v.view.webContents.close();
    });
    views.delete(id);
    send('live', { id, live: false });
  }
}

// A project that is not in front is normally hidden, and a page that was never shown has no size (0x0), so Lovable's chat
// box can't be found. A project that is sending or working therefore stays attached with the real size, underneath
// the project in front (same bounds, so it is covered).
function showFocused() {
  if (!win || win.isDestroyed()) return;
  for (const [id, v] of views) {
    const attached = win.contentView.children.includes(v.view);
    const front = id === focusedId && viewVisible && focusedBounds;
    const busy = v.status === 'sending' || v.status === 'working';
    if (front) {
      const kids = win.contentView.children;
      if (!attached || kids[kids.length - 1] !== v.view) win.contentView.addChildView(v.view);   // on top
      v.view.setBounds(focusedBounds);
      v.view.setVisible(true);
      v.shown = true; v.parked = false;
      continue;
    }
    const wasShown = v.shown;
    if (v.shown) {
      // a hidden view can't receive keys, so hand focus back to the hub
      // (isFocused() isn't reliable here: the hidden view can stay first responder and swallow keys)
      v.shown = false;
      win.webContents.focus();
    }
    if (busy && viewVisible && focusedBounds) {
      if (!attached || !v.parked) win.contentView.addChildView(v.view, 0);   // at the bottom, under the front project
      v.view.setBounds(focusedBounds);
      v.view.setVisible(true);
      v.parked = true;
    } else if (attached && (v.parked || wasShown)) {
      v.view.setVisible(false);
      v.parked = false;
    }
  }
}

// ---------- keyboard (also while typing inside Lovable) ----------
function handleKey(input) {
  const ctrl = input.control;
  if (input.type === 'keyUp' && input.key === 'Control') { send('key', { action: 'ctrl-up' }); return false; }
  if (input.type !== 'keyDown') return false;
  // ⌃Tab needs press + release, so it's handled here. ⌘G, ⌘⌥←/→ and ⌘L live in the "Go" menu,
  // which works no matter which part of the window has keyboard focus.
  if (ctrl && input.key === 'Tab') { send('key', { action: input.shift ? 'switch-prev' : 'switch-next' }); win.webContents.focus(); return true; }
  // ⌘⌥←/→ are caught here too, not only by the Go menu. After a switch, macOS can leave keyboard focus
  // on the Lovable view that was just hidden; the key then never reaches the menu and macOS beeps.
  if (input.meta && input.alt && !ctrl && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
    send('key', { action: input.key === 'ArrowRight' ? 'next' : 'prev' });
    return true;
  }
  // ⌘⇧F: fill-window mode (caught here so it also works while typing inside Lovable)
  if (input.meta && input.shift && !input.alt && !ctrl && input.key.toLowerCase() === 'f') { send('key', { action: 'full' }); return true; }
  return false;
}

// ---------- ⌃ release for the ⌃Tab switcher ----------
// Electron gets the ⌃ press but never the release, so a small helper (modwatch.js) reports the key state.
let modWatch = null;
function startModWatch() {
  if (process.platform !== 'darwin') return;
  const { spawn } = require('child_process');
  // in the packaged app modwatch.js is unpacked next to app.asar, because osascript can't read inside the archive
  const script = path.join(__dirname, 'modwatch.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  modWatch = spawn('osascript', ['-l', 'JavaScript', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let buf = '';
  modWatch.stderr.on('data', d => {        // JXA's console.log writes to stderr
    buf += d; const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) if (l.trim() === 'ctrl:0') send('key', { action: 'ctrl-up' });
  });
  modWatch.on('exit', () => { modWatch = null; });
}
app.on('will-quit', () => { if (modWatch) modWatch.kill(); });

// ---------- account: project list from Lovable, workspaces, log out ----------
// Lovable's pages send a login token with every call to api.lovable.dev. The app borrows the newest one
// (kept in memory only, never saved) to ask Lovable for your workspaces and projects.
let token = null, refreshing = null, lastRefresh = 0;

function watchToken() {
  session.fromPartition(PARTITION).webRequest.onBeforeSendHeaders({ urls: ['https://api.lovable.dev/*'] }, (d, cb) => {
    const a = d.requestHeaders.Authorization || d.requestHeaders.authorization;
    if (a && a.startsWith('Bearer ') && a !== token) {
      const first = !token; token = a;
      if (first || Date.now() - lastRefresh > 5 * 60e3) refreshProjects();
    }
    cb({});
  });
}

async function api(url) {
  if (!token) return null;
  const r = await session.fromPartition(PARTITION).fetch('https://api.lovable.dev' + url, { headers: { Authorization: token }, cache: 'no-store' });
  if (r.status === 401) { token = null; return null; }
  return r.ok ? r.json() : null;
}

// Credits left per workspace (memory only). Lovable's own editor asks /workspaces/{id}/credit-balance, so the app does too.
const credits = {};
let creditsBusy = false, creditsAgain = false, creditsShapeLogged = false;
function pickBalance(r) {
  if (typeof r === 'number') return r;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.limit === 'number' && typeof r.used === 'number') return r.limit - r.used;
  for (const k of ['total_remaining', 'remaining', 'available', 'balance', 'credits_remaining', 'credits', 'total']) {
    if (r[k] != null) { const n = pickBalance(r[k]); if (n != null) return n; }
  }
  return null;
}
const shapeOf = (o, d = 0) => (o && typeof o === 'object' && d < 2) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shapeOf(v, d + 1)])) : typeof o;
async function refreshCredits() {
  if (!token) return;
  if (creditsBusy) { creditsAgain = true; return; }
  creditsBusy = true;
  try {
    for (const w of workspaceInfo().list) {
      if (w.mine === false) continue;
      const r = await api(`/workspaces/${encodeURIComponent(w.id)}/credit-balance`);
      if (!r) continue;
      const n = pickBalance(r);
      if (n == null || !creditsShapeLogged) { creditsShapeLogged = true; console.log('[credits] response keys:', JSON.stringify(shapeOf(r)), n == null ? '(no balance found)' : ''); }   // key names only, no values
      if (n != null) credits[w.id] = n;
    }
    send('credits', credits);
  } catch (e) { console.error('credits refresh failed:', e.message); }
  finally { creditsBusy = false; if (creditsAgain) { creditsAgain = false; refreshCredits(); } }
}

setInterval(refreshCredits, 90e3);   // also catches credits spent elsewhere (Lovable in a browser, a teammate's prompt)

function refreshProjects() {
  if (refreshing || !token) return refreshing;
  refreshing = (async () => {
    try {
      const ws = await api('/user/workspaces');
      if (!ws || !Array.isArray(ws.workspaces)) return false;
      const roleOf = w => (w.membership && w.membership.role) || w.role || w.user_role || null;
      if (ws.workspaces[0] && !roleOf(ws.workspaces[0])) console.log('[workspaces] no role field found; keys:', Object.keys(ws.workspaces[0]).join(', '));   // key names only
      // mine = you own (or administer) it. Workspaces where you are only a contributor don't count for your credits.
      const workspaces = ws.workspaces.map(w => ({ id: w.id, name: w.name, count: w.num_projects, mine: !roleOf(w) || /^(owner|admin)/i.test(roleOf(w)) }));
      const projects = [];
      for (const w of workspaces) {
        let cursor = null;
        do {
          const r = await api(`/v2/workspaces/${encodeURIComponent(w.id)}/projects?sort_by=last_edited_at&sort_order=desc&limit=100` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
          if (!r) return false;
          for (const p of r.projects || []) if (!p.is_deleted) {
            projects.push({ id: p.id, workspace_id: w.id, name: p.display_name || p.name || '', last_edited_at: p.last_edited_at, screenshot: p.latest_screenshot_url || null });
          }
          cursor = r.has_more ? r.next_cursor : null;
        } while (cursor);
      }
      const before = JSON.stringify(readJSON(cacheFile(), null));
      const next = { workspaces, projects };
      lastRefresh = Date.now();
      if (before !== JSON.stringify(next)) { writeJSON(cacheFile(), next); sendProjects(); }
      refreshCredits();
      return true;
    } catch (e) { console.error('project refresh failed:', e.message); return false; }
    finally { refreshing = null; }
  })();
  return refreshing;
}

function sendProjects(extra = {}) { send('projects', { projects: loadProjects(), workspace: workspaceInfo(), ...extra }); }

function setWorkspaces(ids) {
  const st = { ...readJSON(settingsFile(), {}), workspaces: ids };
  delete st.workspace;
  writeJSON(settingsFile(), st);
  sendProjects();
}
// Pick one workspace, pick more, click again to un-pick. Nothing picked (or everything picked) = all.
function toggleWorkspace(id) {
  const info = workspaceInfo();
  const sel = new Set(info.selected);
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  setWorkspaces(sel.size === info.list.length ? [] : [...sel]);
}

// The menu closes after each click on macOS, so it opens again at the same spot: picking several is quick.
function popupWorkspaceMenu(x, y) {
  const again = fn => () => { fn(); setTimeout(() => popupWorkspaceMenu(x, y), 60); };
  const info = workspaceInfo();
  const total = info.list.reduce((n, w) => n + (w.count || 0), 0);
  const items = info.list.length ? [
    { label: `All workspaces (${total})`, type: 'checkbox', checked: !info.selected.length, click: again(() => setWorkspaces([])) },
    { type: 'separator' },
    ...info.list.map(w => ({ label: `${w.name} (${w.count ?? '?'})${w.mine === false ? ' · shared with you' : ''}`, type: 'checkbox', checked: info.selected.includes(w.id), click: again(() => toggleWorkspace(w.id)) })),
    { type: 'separator' },
    { label: 'Refresh Project List', click: () => refreshProjects() },
    { label: 'Log Out…', click: logout }
  ] : [{ label: 'Log in to Lovable in the card first', enabled: false }];
  Menu.buildFromTemplate(items).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

async function logout() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Log Out', 'Cancel'], defaultId: 0, cancelId: 1,
    message: 'Log out of Lovable?',
    detail: 'The app forgets your login, project list and screenshots. Your projects on Lovable are not touched.'
  });
  if (response !== 0) return;
  for (const [, v] of views) { try { win.contentView.removeChildView(v.view); } catch {} v.view.webContents.close(); }
  views.clear(); focusedId = null; token = null;
  for (const k of Object.keys(credits)) delete credits[k];
  send('credits', credits);
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
  for (const f of [cacheFile(), localProjectsFile(), settingsFile()]) fs.rmSync(f, { force: true });
  fs.rmSync(snapDir(), { recursive: true, force: true });
  updateBadge();
  sendProjects({ reset: true });
}

// ---------- status polling ----------
async function pollStatuses() {
  for (const [id, v] of views) {
    if (!v.ready) continue;
    const working = await exec(v.view.webContents, DOM.IS_AGENT_WORKING);
    if (working) {
      v.sawWorking = true; v.idleTicks = 0;
      setStatus(id, 'working');
    } else if (v.status === 'working' || v.status === 'sending') {
      v.idleTicks++;
      const waiting = v.preparing && Date.now() - (v.preparedAt || 0) < 300000;   // still queued behind other projects
      if (v.status === 'sending' && !v.sawWorking && !waiting && Date.now() - (v.sentAt || 0) > 45000) {
        setStatus(id, 'idle'); // never saw it start: the card shows Lovable itself
        if (v.lastMode !== 'chat') send('send-problem', { id });
      } else if (v.sawWorking && v.idleTicks >= 2) {
        v.sawWorking = false;
        setStatus(id, 'done');
        onDone(id);
      }
    }
  }
  setTimeout(pollStatuses, POLL_MS);
}

async function onDone(id) {
  for (const ms of [0, 3000, 10000, 30000, 60000]) setTimeout(refreshCredits, ms);   // the balance can settle a while after the answer
  await sleep(2500);          // let the preview rebuild
  await snapshot(id);
  const p = loadProjects().find(x => x.id === id);
  const name = (p && p.name) || 'Project';
  if (!win.isFocused() && Notification.isSupported()) {
    const n = new Notification({ title: `${name} is done`, body: 'Lovable finished your change.', silent: false });
    n.on('click', () => { win.show(); send('key', { action: 'goto', id }); });
    n.show();
  }
  updateBadge();
}
function updateBadge() {
  if (!app.dock) return;
  const done = [...views.values()].filter(v => v.status === 'done').length;
  app.dock.setBadge(done ? String(done) : '');
}

// ---------- Build / Chat mode ----------
// mode is 'build' or 'chat'. "chat" = whichever option isn't Build (Lovable may call it Chat or Plan).
async function setMode(wc, mode) {
  const isBuild = l => /^build$/i.test(l || '');
  const wanted = l => l != null && (mode === 'build' ? isBuild(l) : !isBuild(l));
  const now = await exec(wc, DOM.READ_MODE);
  if (now == null) { console.log('[mode] dropdown not found'); return { ok: false }; }
  if (wanted(now)) return { ok: true, label: now };
  await exec(wc, DOM.OPEN_MODE_MENU);
  await sleep(350);
  const opts = (await exec(wc, DOM.READ_MODE_OPTIONS)) || [];
  const pick = mode === 'build' ? opts.find(isBuild) : (opts.find(o => /^(chat|plan|ask)$/i.test(o)) || opts.find(o => !isBuild(o)));
  console.log('[mode] was', now, '| options', JSON.stringify(opts), '| picking', pick);
  if (!pick || !(await exec(wc, DOM.PICK_MODE_OPTION.replace('__LABEL__', JSON.stringify(pick))))) {
    await exec(wc, DOM.CLOSE_MENU);
    return { ok: false };
  }
  await sleep(300);
  const after = await exec(wc, DOM.READ_MODE);
  console.log('[mode] now', after);
  return { ok: wanted(after), label: after };
}

// ---------- sending a prompt into Lovable's chat ----------
async function sendPrompt(id, text, mode) {
  try { return await sendPromptInner(id, text, mode); }
  finally { if (win && !win.isDestroyed()) win.webContents.focus(); }   // sending briefly focuses the project's page; give the keyboard back
}
async function sendPromptInner(id, text, mode) {
  const v = ensureView(id);
  const wc = v.view.webContents;
  v.preparing = false; v.lastMode = mode;
  setStatus(id, 'sending');
  v.sentAt = Date.now(); v.sawWorking = false; v.idleTicks = 0;

  // wait for the editor and its chat box (first load can take a while)
  const t0 = Date.now();
  let found = false;
  while (Date.now() - t0 < 45000) {
    if (v.ready) {
      if (await exec(wc, DOM.IS_LOGIN_PAGE)) { setStatus(id, 'idle'); return { ok: false, reason: 'login' }; }
      if (await exec(wc, DOM.FOCUS_CHAT_INPUT)) { found = true; break; }
    }
    await sleep(700);
  }
  if (!found) { setStatus(id, 'idle'); return { ok: false, reason: 'no-input' }; }

  // switch Lovable's Build / Chat dropdown first; never send in the wrong mode
  let modeLabel = null;
  if (mode) {
    const m = await setMode(wc, mode);
    if (!m.ok) { setStatus(id, 'idle'); return { ok: false, reason: 'mode' }; }
    modeLabel = m.label;
  }

  // type it like a person would, then press Enter
  wc.focus();
  await exec(wc, DOM.FOCUS_CHAT_INPUT);
  await wc.insertText(text);
  await sleep(250);
  const typed = await exec(wc, DOM.READ_CHAT_INPUT);
  if (!typed || !typed.trim()) { setStatus(id, 'idle'); return { ok: false, reason: 'no-input' }; }

  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await sleep(1200);
  let left = await exec(wc, DOM.READ_CHAT_INPUT);
  if (left && left.trim()) {            // Enter didn't send → try the send button
    await exec(wc, DOM.CLICK_SEND);
    await sleep(1200);
    left = await exec(wc, DOM.READ_CHAT_INPUT);
  }
  if (left && left.trim()) { setStatus(id, 'idle'); return { ok: false, reason: 'not-sent' }; }
  return { ok: true, modeLabel };
}

// ---------- IPC ----------
ipcMain.handle('projects', () => ({ projects: loadProjects(), workspace: workspaceInfo() }));
ipcMain.handle('credits', () => credits);
ipcMain.on('warm', (_e, id) => { if (id === HOME_ID) ensureView(id); });   // start loading the login page early
ipcMain.on('workspace-menu', (_e, { x, y }) => popupWorkspaceMenu(x, y));

ipcMain.handle('focus', (_e, { id, bounds }) => {
  focusedId = id;
  // the Lovable home card is only needed until the project list is there
  if (id !== HOME_ID && views.has(HOME_ID)) {
    const h = views.get(HOME_ID); views.delete(HOME_ID);
    try { win.contentView.removeChildView(h.view); } catch {}
    h.view.webContents.close();
  }
  if (bounds) focusedBounds = roundBounds(bounds);
  const v = ensureView(id);
  viewVisible = true;
  showFocused();
  send('live', { id, live: true });
  if (v.status === 'done') { setStatus(id, 'idle'); updateBadge(); }
  return { status: v.status };
});
ipcMain.on('bounds', (_e, bounds) => { focusedBounds = roundBounds(bounds); if (viewVisible) showFocused(); });
ipcMain.handle('hide', async (_e, { capture } = {}) => {
  if (capture && focusedId && views.has(focusedId)) await snapshot(focusedId);
  viewVisible = false; showFocused();
});
ipcMain.on('show', () => { viewVisible = true; showFocused(); });
ipcMain.on('focus-view', () => { const v = views.get(focusedId); if (v) v.view.webContents.focus(); });
// Load all targets at the same time (older projects can take a while), then the UI sends to them one after another.
ipcMain.handle('prepare-send', (_e, ids) => {
  for (const id of ids) { const v = ensureView(id); v.preparing = true; v.preparedAt = Date.now(); v.sentAt = Date.now(); setStatus(id, 'sending'); }
});
ipcMain.handle('send', (_e, { id, text, mode }) => sendPrompt(id, text, mode));
ipcMain.on('reload', () => { const v = views.get(focusedId); if (v) v.view.webContents.reload(); });
ipcMain.on('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('add-project', (_e, { id, name }) => {
  updateLocal(l => { l.removed = (l.removed || []).filter(x => x !== id); if (!l.added.some(p => p.id === id)) l.added.push({ id, name: name || '', last_edited_at: new Date().toISOString() }); });
  return loadProjects();
});
ipcMain.on('rename', (_e, { id, name }) => updateLocal(l => { l.names = l.names || {}; l.names[id] = name; }));

function roundBounds(b) { return { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) }; }

// ---------- app ----------
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },     // needed for ⌘C / ⌘V / ⌘Z
    { label: 'Go', submenu: [
      { label: 'Next Project', accelerator: 'CmdOrCtrl+Alt+Right', click: () => send('key', { action: 'next' }) },
      { label: 'Previous Project', accelerator: 'CmdOrCtrl+Alt+Left', click: () => send('key', { action: 'prev' }) },
      { label: 'All Projects', accelerator: 'CmdOrCtrl+G', click: () => { win.webContents.focus(); send('key', { action: 'grid' }); } },
      { label: 'Input Bar', accelerator: 'CmdOrCtrl+L', click: () => { win.webContents.focus(); send('key', { action: 'focus-input' }); } }
    ]},
    { label: 'Account', submenu: [
      { label: 'Refresh Project List', click: () => refreshProjects() },
      { type: 'separator' },
      { label: 'Log Out…', click: logout }
    ]},
    { label: 'View', submenu: [
      { label: 'Reload Project', accelerator: 'CmdOrCtrl+R', click: () => { const v = views.get(focusedId); if (v) v.view.webContents.reload(); } },
      { label: 'Reload Hub', accelerator: 'CmdOrCtrl+Shift+R', click: () => win.webContents.reload() },
      { label: 'Fill Window', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('key', { action: 'full' }) },
      { type: 'separator' },
      { label: 'Developer Tools (Project)', accelerator: 'CmdOrCtrl+Alt+I', click: () => { const v = views.get(focusedId); if (v) v.view.webContents.openDevTools({ mode: 'detach' }); } },
      { label: 'Developer Tools (Hub)', accelerator: 'CmdOrCtrl+Alt+J', click: () => win.webContents.openDevTools({ mode: 'detach' }) },
      { type: 'separator' }, { role: 'togglefullscreen' }
    ]},
    { role: 'windowMenu' }
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 980, minHeight: 640,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b1020',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.on('before-input-event', (e, input) => { if (handleKey(input)) e.preventDefault(); });
  win.on('focus', () => { updateBadge(); if (Date.now() - lastRefresh > 2 * 60e3) refreshProjects(); });
}

// Look like a normal Chrome so sign-in pages (e.g. Google) don't refuse the app.
app.userAgentFallback = app.userAgentFallback.replace(/\s?Electron\/\S+/, '').replace(/\s?(hub-for-lovable|Hub for Lovable|lovable-hub)\/\S+/i, '');

app.whenReady().then(() => {
  session.fromPartition(PARTITION).setUserAgent(app.userAgentFallback);
  // no passkeys in this app: makes Google sign-in ask for the password instead of hanging (see no-passkeys.js)
  session.fromPartition(PARTITION).registerPreloadScript({ type: 'frame', id: 'no-passkeys', filePath: path.join(__dirname, 'no-passkeys.js') });
  watchToken();
  buildMenu();
  createWindow();
  startModWatch();
  pollStatuses();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
