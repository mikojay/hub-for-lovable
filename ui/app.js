// Hub for Lovable UI: card row, ⌘G grid / ⌃Tab switcher, one input bar.
(() => {
  const hub = window.hub;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hub:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('hub:' + k, JSON.stringify(v)); } catch {} }
  };

  const S = {
    projects: [], order: [], idx: 0,
    status: {},          // id -> idle | sending | working | done | login
    snaps: {},           // id -> dataUrl (our own fresh capture)
    mru: store.get('mru', []),
    targets: [],         // extra @ projects
    mention: null,
    overlay: null,       // { mode: 'grid' | 'switch', list, idx, q }
    opening: null,       // { mode, steps, ctrlUp } while the overlay waits for the view to hide
    settleTimer: null,
    viewShown: false,
    ws: null,
    loginStarted: false, // logged out: false = start screen, true = Lovable's login page is showing            // { current, name, list, loggedIn } from the main process
    full: store.get('full', false),  // fill-window mode
    mode: store.get('mode', 'build'),           // 'build' | 'chat' for prompts sent from the input bar
    chatLabel: store.get('chatLabel', 'Chat')   // Lovable's own name for the non-Build mode, once seen
  };

  // ---------- helpers ----------
  const disp = p => p ? (p.name || ('Untitled · ' + p.id.slice(0, 6))) : '—';
  const hue = id => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const grad = id => { const h = hue(id); return `linear-gradient(135deg,hsl(${h} 70% 55%),hsl(${(h + 40) % 360} 70% 40%))`; };
  const mono = (p, cls = '') => {
    const l = ((p.name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
    return `<div class="mono ${cls}" style="background:${grad(p.id)}">${esc(l)}</div>`;
  };
  const ago = iso => {
    if (!iso) return ''; const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now'; const m = s / 60, h = m / 60, d = h / 24;
    if (m < 60) return Math.floor(m) + 'm ago'; if (h < 24) return Math.floor(h) + 'h ago'; if (d < 30) return Math.floor(d) + 'd ago';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const byId = id => S.projects.find(p => p.id === id);
  const loggedOut = () => S.projects.length === 1 && !!S.projects[0].home;
  const cur = () => S.order[S.idx];
  const img = p => S.snaps[p.id] || p.snapshot || p.screenshot || null;
  function toast(t, err) { const el = $('toast'); el.textContent = t; el.classList.toggle('err', !!err); el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3200); }
  function touchMru(id) { S.mru = [id, ...S.mru.filter(x => x !== id)].slice(0, 80); store.set('mru', S.mru); }

  // ---------- card row ----------
  function geometry() {
    const r = $('stage').getBoundingClientRect();
    if (S.full || loggedOut()) return { W: r.width - 16, H: r.height - 6, top: 2, cx: r.width / 2, gap: 24, side: 1 };
    const W = Math.min(r.width * 0.84, 1700);
    const H = r.height - 16;
    return { W, H, top: 8, cx: r.width / 2, gap: 22, side: 0.86 };
  }
  function renderCards() {
    const stage = $('stage');
    const g = geometry();
    const existing = new Map([...stage.children].map(el => [el.dataset.id, el]));
    S.order.forEach((p, i) => {
      let el = existing.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'card'; el.dataset.id = p.id;
        el.addEventListener('click', () => { const j = S.order.findIndex(x => x.id === p.id); if (j !== S.idx) go(j); });
        stage.appendChild(el);
      }
      existing.delete(p.id);
      const k = i - S.idx;
      const ak = Math.abs(k);
      const s = k === 0 ? 1 : g.side;
      const sign = Math.sign(k);
      const dx = k === 0 ? 0 : sign * (g.W / 2 + g.gap + (g.W * s) / 2) + sign * (ak - 1) * (g.W * s + g.gap);
      el.style.top = g.top + 'px';
      el.style.width = g.W + 'px';
      el.style.height = g.H + 'px';
      el.style.left = (g.cx - g.W / 2) + 'px';
      el.style.transform = `translateX(${dx}px) scale(${s})`;
      el.className = 'card' + (k === 0 ? ' focus' : ak <= 2 ? ' side' : ' far') + (S.status[p.id] === 'done' ? ' donecard' : '');
      el.style.zIndex = String(10 - ak);
      if (ak <= 3) el.innerHTML = cardHTML(p, k === 0);
    });
    existing.forEach(el => el.remove());
    renderActivity();
  }
  // title-bar chips: every project that's working, sending or done (done clears when you open it)
  function renderActivity() {
    const rank = { working: 0, sending: 0, done: 1 };
    const items = S.order.filter(p => S.status[p.id] in rank).sort((a, b) => rank[S.status[a.id]] - rank[S.status[b.id]]);
    const MAX = 4, shown = items.slice(0, MAX), rest = items.slice(MAX);
    const label = st => st === 'done' ? 'done' : st === 'sending' ? 'sending' : 'working';
    $('activity').innerHTML = shown.map(p => {
      const st = S.status[p.id];
      return `<button class="act ${st}${p.id === cur()?.id ? ' cur' : ''}" data-go="${p.id}" title="${esc(disp(p))} is ${label(st)} · click to open">`
        + (st === 'done' ? '<span class="ck">✓</span>' : '<span class="dot"></span>') + mono(p) + `<span class="nm">${esc(disp(p))}</span></button>`;
    }).join('') + (rest.length ? `<span class="act more" title="${esc(rest.map(p => disp(p) + ' (' + label(S.status[p.id]) + ')').join(', '))}">+${rest.length}</span>` : '');
  }
  $('activity').addEventListener('click', e => {
    const b = e.target.closest('[data-go]'); if (!b) return;
    const i = S.order.findIndex(p => p.id === b.dataset.go);
    if (i >= 0 && i !== S.idx) go(i, { instant: true });
  });

  function pill(id) {
    const st = S.status[id];
    if (st === 'working') return '<span class="pill working"><span class="dot"></span>Working</span>';
    if (st === 'sending') return '<span class="pill sending"><span class="dot"></span>Sending</span>';
    if (st === 'done') return '<span class="pill done">Done ✓</span>';
    if (st === 'login') return '<span class="pill login">Log in once</span>';
    return '';
  }
  function cardHTML(p, focus) {
    const src = img(p);
    return `<div class="grab"></div>
      <div class="hdr">${mono(p)}<span class="nm">${esc(disp(p))}</span><span class="sub">${ago(p.last_edited_at)}</span>${pill(p.id)}</div>
      <div class="body" data-body="${p.id}">
        ${src ? `<img src="${esc(src)}" alt="">` : ''}
        ${!src ? `<div class="ph">${mono(p, 'big')}<div>${esc(disp(p))}</div></div>` : ''}
        ${focus ? `<div class="loading">Opening Lovable…</div>` : ''}
      </div>`;
  }
  function focusedBodyRect() {
    const p = cur(); if (!p) return null;
    const el = document.querySelector(`[data-body="${p.id}"]`);
    if (!el) return null;
    // use the card's final layout position (ignores the slide animation's transform)
    const card = el.parentElement, st = $('stage').getBoundingClientRect();
    return { x: st.left + card.offsetLeft + card.clientLeft + el.offsetLeft, y: st.top + card.offsetTop + card.clientTop + el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
  }

  // ---------- switching ----------
  async function go(i, { instant } = {}) {
    if (!S.order.length) return;
    i = (i + S.order.length) % S.order.length;
    if (S.viewShown) { S.viewShown = false; await hub.hide(true); }
    const moved = i !== S.idx;
    S.idx = i;
    const p = cur();
    store.set('sel', p.id); touchMru(p.id);
    renderCards(); renderChips(); renderTitle();
    clearTimeout(S.settleTimer);
    S.settleTimer = setTimeout(async () => {
      if (S.overlay || S.mention || (loggedOut() && !S.loginStarted)) return;
      // measure only after the card has finished sliding into the centre
      const res = await hub.focus(p.id, focusedBodyRect());
      S.viewShown = true;
      if (S.status[p.id] === 'done') { S.status[p.id] = 'idle'; renderCards(); }
      setTimeout(() => { const r = focusedBodyRect(); if (r && S.viewShown) hub.setBounds(r); }, 400); // safety re-sync
      return res;
    }, moved ? 360 : 0);
  }
  const step = d => go(S.idx + d);

  // ---------- fill-window mode ----------
  const svg = d => `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON_EXPAND = svg('<path d="M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5 9.5 6.5M2.5 13.5l4-4"/>');   // arrows out to the corners
  const ICON_SHRINK = svg('<path d="M9.5 3v3.5H13M6.5 13V9.5H3M9.5 6.5l4-4M6.5 9.5l-4 4"/>');        // arrows in to the centre
  function applyFull() {
    document.body.classList.toggle('full', S.full);
    $('fullBtn').classList.toggle('on', S.full);
    $('fullBtn').innerHTML = S.full ? ICON_SHRINK : ICON_EXPAND;
    $('fullBtn').title = S.full ? 'Back to cards (⌘⇧F)' : 'Fill the window (⌘⇧F)';
  }
  function toggleFull() {
    S.full = !S.full; store.set('full', S.full);
    applyFull(); renderCards();
    // the stage resize also re-syncs the view, this just makes it immediate
    requestAnimationFrame(() => { const r = focusedBodyRect(); if (r && S.viewShown) hub.setBounds(r); });
  }
  function hideView() { if (S.viewShown) { S.viewShown = false; return hub.hide(false); } return Promise.resolve(); }
  function showView() { if (S.overlay || S.mention || (loggedOut() && !S.loginStarted)) return; const p = cur(); if (!p) return; hub.focus(p.id, focusedBodyRect()); S.viewShown = true; }

  function renderLogin() {
    const out = loggedOut();
    document.body.classList.toggle('loggedout', out);
    $('welcome').classList.toggle('hidden', !out || S.loginStarted);
    $('stage').style.visibility = out && !S.loginStarted ? 'hidden' : '';
    $('backBtn').classList.toggle('hidden', !(out && S.loginStarted));
    if (out && !S.loginStarted) hub.warm('__home');
    if (!out) S.loginStarted = false;
  }
  $('loginBtn').addEventListener('click', () => { S.loginStarted = true; renderLogin(); renderTitle(); go(S.idx, { instant: true }); });
  $('backBtn').addEventListener('click', () => { S.loginStarted = false; hideView(); renderLogin(); renderTitle(); });

  function renderTitle() {
    if (loggedOut()) { $('title').textContent = S.loginStarted ? 'Log in to Lovable' : ''; return; }
    const p = cur();
    $('title').innerHTML = p ? `${mono(p)}<span>${esc(disp(p))}</span><span class="k">${S.idx + 1}/${S.order.length}</span>` : 'Hub for Lovable';
  }

  // ---------- overlay: ⌘G grid and ⌃Tab switcher ----------
  async function openOverlay(mode, dir = 1) {
    // Hiding the view waits for a screenshot. ⌃ can be released (or Tab tapped again) during that wait,
    // so remember those and apply them once the switcher is open.
    if (S.opening) { if (mode === 'switch' && S.opening.mode === 'switch') S.opening.steps += dir; return; }
    S.opening = { mode, steps: 0, ctrlUp: false };
    if (S.viewShown) { S.viewShown = false; await hub.hide(true); }
    const pending = S.opening; S.opening = null;
    let list;
    if (mode === 'switch') {
      const rank = new Map(S.mru.map((id, i) => [id, i]));
      list = [...S.order].sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
    } else list = [...S.order];
    const curIdx = list.findIndex(p => p.id === cur()?.id);
    S.overlay = { mode, all: list, list, q: '', idx: mode === 'switch' ? (curIdx + dir + list.length) % list.length : Math.max(curIdx, 0) };
    $('overlay').classList.remove('hidden');
    $('overlay').classList.toggle('switch', mode === 'switch');
    $('osearch').classList.toggle('hidden', mode === 'switch');
    $('osearch').value = '';
    $('ohint').innerHTML = mode === 'switch'
      ? 'Keep holding <b>⌃</b> and tap <b>Tab</b> · release to open · <b>Esc</b> cancel'
      : 'Arrow keys to move · <b>↵</b> open · <b>Esc</b> close · type to filter';
    if (mode === 'grid') $('osearch').focus(); else document.activeElement?.blur();
    renderOverlay();
    if (mode === 'switch') {
      if (pending.steps) moveOverlay(pending.steps);
      if (pending.ctrlUp) closeOverlay(true);   // ⌃ was already released: open the pick right away
    }
  }
  function renderOverlay() {
    const o = S.overlay; if (!o) return;
    $('ogrid').innerHTML = o.list.map((p, i) => {
      const src = img(p);
      return `<div class="tile ${i === o.idx ? 'on' : ''}" data-i="${i}">
        <div class="img">${src ? `<img src="${esc(src)}" alt="">` : mono(p, 'big')}</div>
        <div class="meta">${mono(p)}<span class="nm">${esc(disp(p))}</span>${pill(p.id) || `<span class="k">${ago(p.last_edited_at)}</span>`}</div>
      </div>`;
    }).join('') || '<div class="k">No project matches.</div>';
    const on = $('ogrid').querySelector('.tile.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function moveOverlay(d) {
    const o = S.overlay; if (!o || !o.list.length) return;
    o.idx = (o.idx + d + o.list.length) % o.list.length; renderOverlay();
  }
  function gridCols() { const t = $('ogrid').querySelector('.tile'); if (!t) return 1; return Math.max(1, Math.round($('ogrid').clientWidth / (t.getBoundingClientRect().width + 16))); }
  function closeOverlay(commit) {
    const o = S.overlay; if (!o) return;
    S.overlay = null; $('overlay').classList.add('hidden');
    const p = o.list[o.idx];
    const i = p ? S.order.findIndex(x => x.id === p.id) : -1;
    if (commit && i >= 0 && i !== S.idx) go(i, { instant: true });
    else showView();
  }
  $('ogrid').addEventListener('click', e => { const t = e.target.closest('.tile'); if (!t || !S.overlay) return; S.overlay.idx = +t.dataset.i; closeOverlay(true); });
  $('osearch').addEventListener('input', e => {
    const o = S.overlay; if (!o) return;
    o.q = e.target.value.toLowerCase().trim();
    o.list = o.all.filter(p => !o.q || disp(p).toLowerCase().includes(o.q));
    o.idx = 0; renderOverlay();
  });

  // ---------- input bar ----------
  function renderChips() {
    const p = cur();
    const extra = S.targets.map(byId).filter(Boolean);
    // the more projects are tagged, the shorter the chips: full names, then shortened names, then just the icons
    // (the name shows again while the mouse is over a chip). More than 8: the rest is counted as "+N".
    const MAX_CHIPS = 8, shown = extra.slice(0, MAX_CHIPS), more = extra.length - shown.length;
    $('chips').dataset.n = extra.length <= 2 ? 'few' : extra.length === 3 ? 'some' : 'many';
    $('chips').innerHTML = (p && !S.targets.includes(p.id) && !extra.length ? `<span class="chip">${mono(p)}<span class="nm">${esc(disp(p))}</span></span>` : '')
      + shown.map(q => `<span class="chip extra">${mono(q)}<span class="nm">${esc(disp(q))}</span><button data-x="${q.id}">×</button></span>`).join('')
      + (more > 0 ? `<span class="chip more">+${more}</span>` : '');
  }
  $('chips').addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (!b) return; S.targets = S.targets.filter(x => x !== b.dataset.x); renderChips(); });

  function autosize() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; $('sendBtn').disabled = !t.value.trim(); }

  function updateMention() {
    const t = $('input'); const before = t.value.slice(0, t.selectionStart);
    const m = before.match(/(^|\s)@([^\n@]{0,40})$/);
    if (!m) { if (S.mention) { S.mention = null; $('pop').classList.add('hidden'); showView(); } return; }
    const q = m[2].toLowerCase().trim();
    const rank = new Map(S.mru.map((id, i) => [id, i]));
    const matches = S.order.filter(p => disp(p).toLowerCase().includes(q));
    const opts = matches.filter(p => !S.targets.includes(p.id))   // already tagged projects are not offered again
      .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9)).slice(0, 8);
    const first = !S.mention;
    S.mention = { start: before.length - m[2].length - 1, opts, idx: Math.min(S.mention?.idx || 0, Math.max(opts.length - 1, 0)) };
    if (first) hideView();   // the native Lovable view would sit on top of the popup
    $('pop').innerHTML = opts.length ? opts.map((p, i) => `<div class="opt ${i === S.mention.idx ? 'on' : ''}" data-m="${p.id}">${mono(p)}<span>${esc(disp(p))}</span><span class="sub">${ago(p.last_edited_at)}</span></div>`).join('')
      : `<div class="opt"><span class="sub">${matches.length ? 'Already added' : `No project matches “${esc(q)}”`}</span></div>`;
    $('pop').classList.remove('hidden');
  }
  function pickMention(id) {
    const t = $('input');
    if (S.mention) { const end = t.selectionStart; t.value = t.value.slice(0, S.mention.start) + t.value.slice(end); t.selectionStart = t.selectionEnd = S.mention.start; }
    if (!S.targets.includes(id)) S.targets.push(id);
    S.mention = null; $('pop').classList.add('hidden');
    renderChips(); autosize(); t.focus(); showView();
  }
  $('pop').addEventListener('mousedown', e => { const o = e.target.closest('[data-m]'); if (o) { e.preventDefault(); pickMention(o.dataset.m); } });

  // ---------- Build / Chat toggle ----------
  function renderMode() {
    $('chatModeBtn').textContent = S.chatLabel;
    for (const b of $('mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === S.mode);
    $('input').placeholder = S.mode === 'chat' ? `${S.chatLabel}: ask without changing code…  (@ to add projects)` : 'Ask me anything…  (@ to add projects)';
  }
  function setMode(m) { S.mode = m; store.set('mode', m); renderMode(); }
  $('mode').addEventListener('mousedown', e => e.preventDefault());   // keep typing focus in the input
  $('mode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });

  async function sendNow() {
    const t = $('input');
    const text = t.value.replace(/(^|\s)@\S*$/, '').trim();
    if (!text) return;
    const ids = S.targets.length ? [...S.targets] : [cur()?.id].filter(Boolean);
    if (ids.some(id => byId(id)?.home)) return toast('Log in to Lovable first, then pick a project.', true);
    t.value = ''; autosize(); S.targets = []; renderChips();
    for (const id of ids) { S.status[id] = 'sending'; }
    renderCards();
    await hub.prepareSend(ids);   // all projects start loading now
    // One after another. Each project is brought to the front first: a page that was never shown has no size,
    // so Lovable's chat box can't be found, and Lovable only starts working once its page is "active".
    const origin = cur()?.id;
    for (const id of ids) {
      if (SHOW_SWITCH && cur()?.id !== id) await bringToFront(id);
      const res = await hub.send(id, text, S.mode);
      if (SHOW_SWITCH && res && res.ok) await waitStarted(id);
      const name = disp(byId(id));
      if (res && res.ok && S.mode === 'chat' && res.modeLabel && res.modeLabel !== S.chatLabel) {
        S.chatLabel = res.modeLabel; store.set('chatLabel', res.modeLabel); renderMode();
      }
      if (res && res.ok) toast(`Sent to ${name}` + (S.mode === 'chat' ? ` (${S.chatLabel})` : ''));
      else {
        try { await navigator.clipboard.writeText(text); } catch {}
        const why = res?.reason === 'login' ? 'log in to Lovable in that card first'
          : res?.reason === 'no-input' ? "couldn't find Lovable's chat box"
          : res?.reason === 'mode' ? `couldn't switch Lovable to ${S.mode === 'chat' ? S.chatLabel : 'Build'}, nothing was sent`
          : "Lovable didn't take the message";
        toast(`${name}: ${why}. Prompt copied, paste it with ⌘V.`, true);
        if (S.status[id] === 'sending') S.status[id] = 'idle';
      }
    }
    if (SHOW_SWITCH && origin && cur()?.id !== origin) await bringToFront(origin);   // back where you were
    renderCards();
    t.focus();
  }
  const SHOW_SWITCH = false;  // true: you see each project come to the front while it gets its prompt (the safe fallback). false: send in the background
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function bringToFront(id) {
    if (S.overlay) closeOverlay(false);
    const i = S.order.findIndex(p => p.id === id);
    if (i < 0) return;
    go(i);
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !(S.viewShown && cur()?.id === id)) await sleep(100);
    await sleep(300);
  }
  // after sending, give the project a moment to actually start before moving on
  async function waitStarted(id) {
    const max = S.mode === 'chat' ? 4000 : 12000, t0 = Date.now();
    while (Date.now() - t0 < max && S.status[id] !== 'working' && S.status[id] !== 'done') await sleep(300);
  }

  $('input').addEventListener('input', () => { autosize(); updateMention(); });
  $('input').addEventListener('keydown', e => {
    if (S.mention && S.mention.opts.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); S.mention.idx = (S.mention.idx + 1) % S.mention.opts.length; return updateMention(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); S.mention.idx = (S.mention.idx - 1 + S.mention.opts.length) % S.mention.opts.length; return updateMention(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(S.mention.opts[S.mention.idx].id); }
      if (e.key === 'Escape') { e.preventDefault(); S.mention = null; $('pop').classList.add('hidden'); return showView(); }
    }
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey) { e.preventDefault(); return setMode(S.mode === 'build' ? 'chat' : 'build'); }
    if (e.key === 'Backspace' && !e.target.value && S.targets.length) { S.targets.pop(); renderChips(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow(); }
    if (e.key === 'Escape') { e.target.blur(); hub.focusView(); }
  });
  $('input').addEventListener('blur', () => setTimeout(() => { if (S.mention && document.activeElement !== $('input')) { S.mention = null; $('pop').classList.add('hidden'); showView(); } }, 150));
  $('sendBtn').addEventListener('click', sendNow);
  $('prevBtn').addEventListener('click', () => step(-1));
  $('nextBtn').addEventListener('click', () => step(1));
  $('gridBtn').addEventListener('click', () => S.overlay ? closeOverlay(false) : openOverlay('grid'));
  $('fullBtn').addEventListener('click', toggleFull);
  $('extBtn').addEventListener('click', () => { const p = cur(); if (p) hub.openExternal(`https://lovable.dev/projects/${p.id}`); });

  // add project by link
  $('addBtn').addEventListener('click', () => { $('addForm').classList.toggle('hidden'); if (!$('addForm').classList.contains('hidden')) $('addInput').focus(); });
  $('addForm').addEventListener('submit', async e => {
    e.preventDefault();
    const m = $('addInput').value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!m) return toast('That doesn\'t look like a Lovable project link.', true);
    const id = m[0].toLowerCase();
    S.projects = await hub.addProject(id, '');
    buildOrder(id);
    $('addInput').value = ''; $('addForm').classList.add('hidden');
    go(S.order.findIndex(p => p.id === id), { instant: true });
  });

  // ---------- workspaces / project list from Lovable ----------
  function renderWs() {
    const w = S.ws;
    $('wsBtn').textContent = (w && w.loggedIn ? w.name : 'Not logged in') + ' ▾';
  }
  // ---------- credits left (next to the workspace button) ----------
  let creditMap = {}, shownCredits = null, creditAnim = null;
  const fmtCredits = n => Number.isInteger(n) ? String(n) : n.toFixed(1);
  function creditTotal() {
    const w = S.ws; if (!w || !w.loggedIn) return null;
    const ids = w.list.filter(x => x.mine !== false).map(x => x.id);   // overall = your own workspaces, whatever is picked in the menu
    const have = ids.filter(id => typeof creditMap[id] === 'number');
    return have.length ? have.reduce((n, id) => n + creditMap[id], 0) : null;
  }
  function stopCreditAnim() { if (creditAnim) { cancelAnimationFrame(creditAnim); creditAnim = null; } $('credits').classList.remove('spend'); }
  function countDown(from, to) {
    stopCreditAnim();
    const el = $('credits'), d = $('creditsDelta'), t0 = performance.now(), dur = 1200;
    el.classList.add('spend');
    d.textContent = '−' + fmtCredits(Math.round((from - to) * 10) / 10);
    d.classList.remove('go'); void d.offsetWidth; d.classList.add('go');
    const tick = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      $('creditsNum').textContent = fmtCredits(Math.round((from + (to - from) * e) * 10) / 10);
      if (k < 1) creditAnim = requestAnimationFrame(tick);
      else { creditAnim = null; setTimeout(() => { if (!creditAnim) el.classList.remove('spend'); }, 600); }
    };
    creditAnim = requestAnimationFrame(tick);
  }
  function renderCredits(animate) {
    const t = creditTotal(), el = $('credits');
    el.classList.toggle('hidden', t == null);
    if (t == null) { stopCreditAnim(); shownCredits = null; return; }
    const w = S.ws;
    const parts = w.list.filter(x => x.mine !== false && typeof creditMap[x.id] === 'number');
    $('creditsBreak').innerHTML = parts.length > 1 ? parts.map(x => `<span class="cpart"><span class="cn">${esc(x.name)}</span> <b>${fmtCredits(creditMap[x.id])}</b></span>`).join('') : '';   // shown on hover
    if (creditAnim && t === shownCredits) return;
    if (animate && shownCredits != null && t < shownCredits) { const from = shownCredits; shownCredits = t; return countDown(from, t); }
    stopCreditAnim(); $('creditsNum').textContent = fmtCredits(t); shownCredits = t;
  }
  hub.on('credits', map => { creditMap = map || {}; renderCredits(true); });

  $('wsBtn').addEventListener('click', () => { const r = $('wsBtn').getBoundingClientRect(); hub.workspaceMenu(r.left, r.bottom + 4); });

  hub.on('projects', ({ projects, workspace, reset }) => {
    if (reset) { S.snaps = {}; S.status = {}; S.targets = []; S.mru = []; store.set('mru', []); }
    const before = cur()?.id;
    S.projects = projects; S.ws = workspace;
    buildOrder(before);
    renderLogin(); renderWs(); renderChips(); renderCredits(false);
    if (cur()?.id === before && !reset) { renderCards(); renderTitle(); }   // same project still in front: no reload
    else { S.viewShown = false; go(S.idx, { instant: true }); }
  });

  // ---------- keys ----------
  function handleAction(a, payload) {
    if (loggedOut()) return;
    if (a === 'switch-next' || a === 'switch-prev') {
      const d = a === 'switch-next' ? 1 : -1;
      if (S.overlay?.mode === 'switch') moveOverlay(d); else openOverlay('switch', d);
    } else if (a === 'ctrl-up') {
      if (S.overlay?.mode === 'switch') closeOverlay(true);
      else if (S.opening?.mode === 'switch') S.opening.ctrlUp = true;
    }
    else if (a === 'grid') { S.overlay ? closeOverlay(false) : openOverlay('grid'); }
    else if (a === 'full') toggleFull();
    else if (a === 'next') step(1);
    else if (a === 'prev') step(-1);
    else if (a === 'focus-input') { if (!S.overlay) $('input').focus(); }
    else if (a === 'goto') { const i = S.order.findIndex(p => p.id === payload.id); if (i >= 0) go(i, { instant: true }); }
  }
  hub.on('send-problem', ({ id }) => toast(`${disp(byId(id))} didn't start working. Open the project to check.`, true));
  hub.on('key', k => handleAction(k.action, k));
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); return handleAction(e.shiftKey ? 'switch-prev' : 'switch-next'); }
    // ⌘G, ⌘⌥←/→ and ⌘L come from the app's Go menu (main.js)
    const o = S.overlay;
    if (o) {
      if (e.key === 'Escape') { e.preventDefault(); return closeOverlay(false); }
      if (e.key === 'Enter') { e.preventDefault(); return closeOverlay(true); }
      if (e.key === 'ArrowRight') { e.preventDefault(); return moveOverlay(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); return moveOverlay(-1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveOverlay(gridCols()); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveOverlay(-gridCols()); }
    }
  });
  document.addEventListener('keyup', e => { if (e.key === 'Control') handleAction('ctrl-up'); });

  // ---------- events from the main process ----------
  hub.on('status', ({ id, status }) => {
    const prev = S.status[id];
    S.status[id] = status;
    if (status === 'done' && id === cur()?.id && S.viewShown) S.status[id] = 'idle'; // you're looking at it
    if (status === 'done' && prev !== 'done' && id !== cur()?.id) toast(`${disp(byId(id))} is done ✓  (⌃Tab to jump)`);
    if (status === 'working' && prev !== 'working' && prev !== 'sending' && id !== cur()?.id) toast(`${disp(byId(id))} started working`);
    renderCards(); if (S.overlay) renderOverlay();
  });
  hub.on('snapshot', ({ id, dataUrl }) => { S.snaps[id] = dataUrl; renderCards(); if (S.overlay) renderOverlay(); });
  hub.on('title', ({ id, name }) => { const p = byId(id); if (p && !p.name) { p.name = name; hub.rename(id, name); renderCards(); renderTitle(); renderChips(); } });
  hub.on('login', ({ id, needsLogin }) => {
    if (needsLogin && byId(id)?.home) return;
    if (needsLogin) { S.status[id] = 'login'; toast('Log in to Lovable in this card once. The app remembers it.'); }
    else if (S.status[id] === 'login') S.status[id] = 'idle';
    renderCards();
  });

  // keep the native view glued to the focused card
  let rz = null;
  new ResizeObserver(() => {
    renderCards();
    clearTimeout(rz);
    rz = setTimeout(() => { const r = focusedBodyRect(); if (r) hub.setBounds(r); }, 60);
  }).observe($('stage'));

  // broken remote screenshots: drop the image so the placeholder shows (inline handlers are blocked by the CSP)
  document.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);

  // ---------- boot ----------
  function buildOrder(preferId) {
    S.order = [...S.projects].sort((a, b) => new Date(b.last_edited_at || 0) - new Date(a.last_edited_at || 0));
    const want = preferId || store.get('sel', null);
    const i = S.order.findIndex(p => p.id === want);
    S.idx = i >= 0 ? i : 0;
  }
  (async () => {
    applyFull(); renderMode();
    const init = await hub.projects();
    S.projects = init.projects; S.ws = init.workspace; renderWs(); renderLogin();
    hub.credits().then(m => { creditMap = m || {}; renderCredits(false); });
    buildOrder();
    renderCards(); renderChips(); renderTitle(); autosize();
    go(S.idx, { instant: true });
    $('input').focus();
  })();
})();
