// WorkerManager — port of ParallelLoginCoordinator.
// Owns N WebContentsViews in a 2x2 grid, each with an isolated cookie partition
// ("worker-N", non-persist) and its own Automator. Routes bridge IPC to the
// right worker by webContents id.
'use strict';

const { WebContentsView } = require('electron');
const path = require('path');
const { Automator } = require('./automator');
const { splitEvenly, parseCombos } = require('./splitter');
const store = require('./store');

const TOP_BAR_H = 148; // must match renderer top bar height
const AUTH_HOSTS = new Set([
  'cursor.com',
  'www.cursor.com',
  'accounts.x.ai',
  'x.ai',
  'authenticate.cursor.sh',
  'authenticator.cursor.sh',
  'cursor.sh',
]);

function hostAllowed(url) {
  try { return AUTH_HOSTS.has(new URL(url).hostname); } catch (e) { return false; }
}

class WorkerManager {
  constructor(win, sendToRenderer) {
    this.win = win;
    this.send = sendToRenderer;
    this.workers = []; // { view, automator, status, email }
    this.counters = { ok: 0, invalid: 0, blocked: 0, otp: 0, error: 0, skip: 0 };
    this.running = false;
  }

  workerCount() {
    return Math.min(4, Math.max(1, store.getSettings().workerCount | 0));
  }

  ensureWorkers(n) {
    // Grow/shrink the view pool to n.
    while (this.workers.length < n) this.addWorker(this.workers.length);
    while (this.workers.length > n) this.removeWorker();
    this.layout();
  }

  addWorker(i) {
    const preload = path.join(__dirname, '..', 'preload', 'preload.gen.js');
    const view = new WebContentsView({
      webPreferences: {
        partition: `worker-${i}`, // non-persist: in-memory, nothing on disk
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const wc = view.webContents;
    const self = this;

    wc.on('will-navigate', (e, url) => { if (!hostAllowed(url)) e.preventDefault(); });
    wc.setWindowOpenHandler(({ url }) => {
      if (hostAllowed(url)) wc.loadURL(url);
      return { action: 'deny' };
    });

    const automator = new Automator(i, view, {
      startUrl: store.getSettings().startUrl,
      onEvent: (idx, ev) => self.onWorkerEvent(idx, ev),
    });

    this.win.contentView.addChildView(view);
    this.workers.push({ view, automator, status: 'idle', email: '' });
    this.sendStatus();
  }

  removeWorker() {
    const w = this.workers.pop();
    if (!w) return;
    try { w.automator.stop(); } catch (e) { /* ignore */ }
    try { this.win.contentView.removeChildView(w.view); } catch (e) { /* ignore */ }
    try { w.view.webContents.close(); } catch (e) { /* ignore */ }
  }

  layout() {
    const [W, H] = this.win.getContentSize();
    const n = this.workers.length;
    const cols = n > 1 ? 2 : 1;
    const rows = n > 2 ? 2 : 1;
    const cw = Math.floor(W / cols);
    const ch = Math.floor((H - TOP_BAR_H) / rows);
    this.workers.forEach((w, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      // Last row with odd count: stretch.
      const span = (rows === 2 && n === 3 && i === 2) ? 2 : 1;
      w.view.setBounds({ x: c * cw, y: TOP_BAR_H + r * ch, width: cw * span, height: ch });
    });
  }

  gridInfo() {
    const n = this.workers.length;
    return { n, cols: n > 1 ? 2 : 1, rows: n > 2 ? 2 : 1, topBar: TOP_BAR_H };
  }

  /* ---------------- run control ---------------- */

  start() {
    if (this.running) return;
    const settings = store.getSettings();
    const combos = parseCombos(settings.combosText);
    if (!combos.length) {
      this.send('kara:toast', { text: 'Paste combos in Settings first.' });
      return;
    }
    this.ensureWorkers(this.workerCount());
    // Refresh start URL per worker (settings may have changed).
    for (const w of this.workers) w.automator.startUrl = settings.startUrl;
    const chunks = splitEvenly(combos, this.workers.length);
    this.counters = { ok: 0, invalid: 0, blocked: 0, otp: 0, error: 0, skip: 0 };
    this.running = true;
    this.workers.forEach((w, i) => w.automator.startQueue(chunks[i] || []));
    this.send('kara:run-state', { running: true });
    this.sendStatus();
  }

  stop() {
    this.running = false;
    for (const w of this.workers) w.automator.stop();
    this.send('kara:run-state', { running: false });
    this.sendStatus();
  }

  submitOtp(index, code) {
    const w = this.workers[index];
    if (w) w.automator.submitOtp(code);
  }

  /* ---------------- events ---------------- */

  onWorkerEvent(index, ev) {
    const w = this.workers[index];
    if (!w) return;
    if (ev.type === 'status') {
      w.status = ev.status;
      w.email = ev.email || w.email;
    } else if (ev.type === 'verdict') {
      if (this.counters[ev.verdict] !== undefined) this.counters[ev.verdict] += 1;
      if (ev.verdict === 'otp') this.counters.otp += 1;
    } else if (ev.type === 'queue-done') {
      if (this.workers.every((x) => x.automator.done)) {
        this.running = false;
        this.send('kara:run-state', { running: false });
      }
    }
    this.sendStatus();
    if (ev.type === 'otp-needed') {
      this.send('kara:toast', { text: `Worker ${index + 1}: OTP needed for ${ev.email}` });
    }
  }

  sendStatus() {
    this.send('kara:status', {
      grid: this.gridInfo(),
      workers: this.workers.map((w, i) => ({ index: i, status: w.status, email: w.email })),
      counters: { ...this.counters },
      running: this.running,
    });
  }

  // Route a bridge JSON message from a view to its worker's automator.
  routeBridge(webContentsId, json) {
    const i = this.workers.findIndex((w) => w.view.webContents.id === webContentsId);
    if (i === -1) return;
    let msg;
    try { msg = JSON.parse(json); } catch (e) { return; }
    const auto = this.workers[i].automator;
    if (msg.event === 'auth.page') auto.onAuthPage(msg);
    else if (msg.event === 'auth.fill') auto.onAuthFill(msg);
    else if (msg.event === 'shell.ready') auto.onShellReady();
  }

  routeLoginState(webContentsId, ok, detail) {
    const i = this.workers.findIndex((w) => w.view.webContents.id === webContentsId);
    if (i === -1) return;
    this.workers[i].automator.onLoginState(!!ok, detail);
  }
}

module.exports = { WorkerManager, TOP_BAR_H };
