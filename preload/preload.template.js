/*
 * karaTin preload — runs in the isolated world of every worker view.
 *
 * 1. Exposes window.AndroidBridge (postMessage/log/reportLoginState) in this
 *    world, exactly like Android's @JavascriptInterface, so login_hooks.js
 *    runs UNCHANGED.
 * 2. Evals the verbatim login_hooks.js (inlined at build time by
 *    scripts/inline-hooks.js). Isolated worlds share the DOM, so the script
 *    sees the real page (React, shadow DOM, document.cookie).
 * 3. Exposes window.__kara in the MAIN world (via contextBridge) so the main
 *    process can call fillEmail/fillPassword/fillOtp through
 *    webContents.executeJavaScript("window.__kara.fillEmail(...)").
 */
const { contextBridge, ipcRenderer } = require('electron');

const BRIDGE = {
  postMessage: (json) => {
    try { ipcRenderer.send('kara:bridge', String(json)); } catch (e) { /* gone */ }
  },
  log: (level, msg) => {
    try { ipcRenderer.send('kara:log', String(level), String(msg)); } catch (e) { /* gone */ }
  },
  reportLoginState: (ok, detail) => {
    try { ipcRenderer.send('kara:login-state', !!ok, String(detail || '')); } catch (e) { /* gone */ }
  },
};

// The automation script reads window.AndroidBridge in its own world.
window.AndroidBridge = BRIDGE;
try { contextBridge.exposeInMainWorld('AndroidBridge', BRIDGE); } catch (e) { /* ignore */ }

// ---- login_hooks.js (verbatim, inlined at build time) ----
const __HOOKS_SRC__ = /*__HOOKS__*/;
try {
  (0, eval)(__HOOKS_SRC__);
} catch (e) {
  try { ipcRenderer.send('kara:log', 'error', 'hooks init failed: ' + (e && e.message)); } catch (e2) { /* ignore */ }
}

// Main-world callable surface for the automation engine.
function __auto() { return window.__cursorAuto || null; }
try {
  contextBridge.exposeInMainWorld('__kara', {
    fillEmail: (email) => { const a = __auto(); if (a) a.fillEmail(email); },
    fillPassword: (pw) => { const a = __auto(); if (a) a.fillPassword(pw); },
    fillOtp: (code) => { const a = __auto(); if (a) a.fillOtp(code); },
    scan: () => { const a = __auto(); if (a) a.scan(); },
  });
} catch (e) { /* ignore */ }

// Renderer UI bridge (used by the app's own window; harmless in worker views).
try {
  contextBridge.exposeInMainWorld('karaApi', {
    invoke: (ch, ...args) => ipcRenderer.invoke(ch, ...args),
    send: (ch, ...args) => ipcRenderer.send(ch, ...args),
    on: (ch, cb) => ipcRenderer.on(ch, (_e, data) => { try { cb(data); } catch (e2) { /* ignore */ } }),
  });
} catch (e) { /* ignore */ }
