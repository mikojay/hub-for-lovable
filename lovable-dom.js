// Everything that depends on how Lovable's editor page is built lives in this file.
// If Lovable changes its interface and sending or the "working" indicator breaks,
// this is the only file that needs fixing.
//
// Each export is a string of JavaScript that runs inside the Lovable editor page.

// Finds Lovable's chat input, focuses it and clears it. Returns true if found.
exports.FOCUS_CHAT_INPUT = `(() => {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 120 && r.height > 14 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const score = el => {
    const hint = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.dataset.placeholder || '')).toLowerCase();
    let s = 0;
    if (/ask|lovable|message|chat|build|prompt|describe/.test(hint)) s += 10;
    if (el.tagName === 'TEXTAREA') s += 3;
    // Lovable's chat sits in the left column, near the bottom
    const r = el.getBoundingClientRect();
    if (r.left < window.innerWidth * 0.5) s += 2;
    if (r.top > window.innerHeight * 0.5) s += 2;
    return s;
  };
  const cands = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
  if (!cands.length) return false;
  cands.sort((a, b) => score(b) - score(a));
  const el = cands[0];
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }
  window.__hubChatInput = el;
  return true;
})()`;

// Returns the current text of the chat input found above ("" if empty, null if lost).
exports.READ_CHAT_INPUT = `(() => {
  const el = window.__hubChatInput;
  if (!el || !el.isConnected) return null;
  return (el.value !== undefined ? el.value : el.innerText) || '';
})()`;

// Fallback when Enter didn't send: click the send button next to the input.
exports.CLICK_SEND = `(() => {
  const el = window.__hubChatInput;
  if (!el) return false;
  let box = el;
  for (let i = 0; i < 6 && box; i++) {
    const btns = [...box.querySelectorAll('button')].filter(b => !b.disabled && b.offsetParent);
    const send = btns.find(b => /send|submit/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.type || '')))
              || btns[btns.length - 1];
    if (send) { send.click(); return true; }
    box = box.parentElement;
  }
  return false;
})()`;

// Is Lovable's agent working right now? Heuristic: while it works, Lovable shows a
// "Stop" control in the chat. Returns true / false.
exports.IS_AGENT_WORKING = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const btns = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
  return btns.some(b => {
    const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')).trim();
    const text = (b.textContent || '').trim();
    return /\\bstop\\b/i.test(label) || /^stop( generating)?$/i.test(text);
  });
})()`;

// Is this the login page rather than the editor?
exports.IS_LOGIN_PAGE = `(() => /\\/(login|signin|sign-in|auth)/i.test(location.pathname) ||
  !!document.querySelector('input[type="password"]'))()`;

// ---------- Build / Chat mode (the dropdown next to Lovable's chat box, e.g. "Build ⌄") ----------
// Shared finder: the mode button is a short-labelled button near the chat input found by FOCUS_CHAT_INPUT.
const FIND_MODE_BUTTON = `
  const MODE_RE = /^(build|chat|plan|agent|ask|edit|visual edits?)$/i;
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const findModeButton = () => {
    let box = window.__hubChatInput;
    for (let i = 0; i < 8 && box; i++, box = box.parentElement) {
      const b = [...box.querySelectorAll('button, [role="button"], [role="combobox"]')]
        .filter(vis).find(b => MODE_RE.test((b.textContent || '').replace(/\\s+/g, ' ').trim()));
      if (b) return b;
    }
    return null;
  };
`;

// Current mode label ("Build", "Plan", …) or null if the dropdown can't be found.
exports.READ_MODE = `(() => { ${FIND_MODE_BUTTON}
  const b = findModeButton(); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null;
})()`;

// Opens the mode dropdown. Lovable's menus open on pointerdown (Radix), so send the whole sequence.
exports.OPEN_MODE_MENU = `(() => { ${FIND_MODE_BUTTON}
  const b = findModeButton(); if (!b) return false;
  const o = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true, view: window };
  b.dispatchEvent(new PointerEvent('pointerdown', o)); b.dispatchEvent(new MouseEvent('mousedown', o));
  b.dispatchEvent(new PointerEvent('pointerup', o)); b.dispatchEvent(new MouseEvent('mouseup', o));
  if (!document.querySelector('[role="menu"], [role="listbox"]')) b.click();
  return true;
})()`;

// Labels of the options in the open dropdown (first line of each item's text).
exports.READ_MODE_OPTIONS = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')].filter(vis)
    .map(el => (el.innerText || el.textContent || '').split('\\n').map(s => s.trim()).filter(Boolean)[0] || '')
    .filter(Boolean);
})()`;

// Clicks the option whose label is exactly __LABEL__ (filled in by main.js). Returns true if clicked.
exports.PICK_MODE_OPTION = `(() => {
  const want = __LABEL__.toLowerCase();
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const item = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')].filter(vis)
    .find(el => ((el.innerText || el.textContent || '').split('\\n').map(s => s.trim()).filter(Boolean)[0] || '').toLowerCase() === want);
  if (!item) return false;
  item.click();
  return true;
})()`;

// Closes an open dropdown without choosing anything.
exports.CLOSE_MENU = `(() => {
  const t = document.activeElement || document.body;
  t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  return true;
})()`;
