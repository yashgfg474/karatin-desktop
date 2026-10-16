// Settings + hit persistence. Replaces Android SharedPreferences.
// The Telegram bot token is encrypted at rest via safeStorage (DPAPI on Windows).
'use strict';

const { app, safeStorage } = require('electron');
const Store = require('electron-store');

const DEFAULTS = {
  startUrl: 'https://accounts.x.ai/sign-in?email=true',
  workerCount: 4,
  chatId: '',
  paidOnly: false,
  combosText: '',
};

let store = null;

function init() {
  store = new Store({ name: 'karatin-config', defaults: DEFAULTS });
}

function getSettings() {
  const s = {
    startUrl: store.get('startUrl', DEFAULTS.startUrl),
    workerCount: Math.min(4, Math.max(1, store.get('workerCount', DEFAULTS.workerCount) | 0)),
    chatId: store.get('chatId', ''),
    paidOnly: !!store.get('paidOnly', false),
    combosText: store.get('combosText', ''),
    hasToken: !!store.get('tgTokenEnc', ''),
  };
  return s;
}

function saveSettings(patch) {
  for (const k of ['startUrl', 'workerCount', 'chatId', 'paidOnly', 'combosText']) {
    if (patch[k] !== undefined) store.set(k, patch[k]);
  }
  if (patch.token !== undefined) {
    if (patch.token) {
      const enc = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(String(patch.token)).toString('base64')
        : Buffer.from(String(patch.token), 'utf8').toString('base64');
      store.set('tgTokenEnc', enc);
      store.set('tgTokenDpapi', safeStorage.isEncryptionAvailable() ? 1 : 0);
    } else {
      store.delete('tgTokenEnc');
      store.delete('tgTokenDpapi');
    }
  }
}

function getToken() {
  const enc = store.get('tgTokenEnc', '');
  if (!enc) return '';
  try {
    const buf = Buffer.from(enc, 'base64');
    if (store.get('tgTokenDpapi', 0) && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString('utf8');
  } catch (e) {
    return '';
  }
}

// Hit log (append-only JSON lines, mirrors HitStore).
const fs = require('fs');
const path = require('path');
function hitsFile() {
  return path.join(app.getPath('userData'), 'hits.jsonl');
}
function appendHit(hit) {
  try {
    fs.appendFileSync(hitsFile(), JSON.stringify({ t: Date.now(), ...hit }) + '\n');
  } catch (e) { /* ignore */ }
}

module.exports = { init, getSettings, saveSettings, getToken, appendHit };
