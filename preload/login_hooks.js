/*
 * Cursor login automation, injected into every committed navigation by LoginAutomator.
 *
 * This is a port of the "NUGHAboli" Chrome extension content scripts into a single page-world
 * script that talks to the native side over window.AndroidBridge:
 *   - content.js      -> AuthKit fill (email/password/OTP), pageKind, error classification,
 *                        shadow-DOM error walking, findSubmit.
 *   - content-main.js -> fetch/XHR JSON sniffing for auth errors, forwarded via window.postMessage.
 *
 * The extension used chrome.runtime request/response messaging (background <-> content). WebView
 * has no synchronous return channel for async work, so instead:
 *   - Native drives fills by calling window.__cursorAuto.fillEmail/fillPassword/fillOtp(...).
 *   - JS reports everything back through AndroidBridge.postMessage(JSON.stringify({event, ...})):
 *       'shell.ready' | 'auth.page' | 'auth.fill'
 *   - The network hook posts window.postMessage({type:'CURSOR_AUTH_JSON', payload}); a listener in
 *     this same script classifies it and folds any error into the next 'auth.page' report.
 *
 * Injection is idempotent: the shell object is created once; later injections only re-scan.
 */
(function () {
  'use strict';

  var BRIDGE = window.AndroidBridge;

  function send(event, data) {
    if (!BRIDGE || !BRIDGE.postMessage) return;
    var payload = data || {};
    payload.event = event;
    payload.url = window.location.href;
    try {
      BRIDGE.postMessage(JSON.stringify(payload));
    } catch (e) {
      /* the bridge is gone; nothing to do */
    }
  }

  function log(level, message) {
    try {
      if (BRIDGE && BRIDGE.log) BRIDGE.log(level, String(message));
    } catch (e) {
      /* ignore */
    }
  }

  function reportLoginState(loggedIn, detail) {
    try {
      if (BRIDGE && BRIDGE.reportLoginState) BRIDGE.reportLoginState(loggedIn, detail);
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------------------------------------
   * xAI login-RPC network verdict.
   * The sign-in page submits via POST /api/rpc with {"rpc":"createSession",...}.
   * Watching the actual API response (instead of only page text):
   *   - 2xx + cookieSetterUrl  → the page redirects itself and the session-cookie
   *     flow harvests (nothing to do here except log).
   *   - error ACCOUNT_INVALID_CREDENTIALS → instant invalid verdict, fed into the
   *     normal error pipeline so the native side finishes the combo immediately.
   * Safe to reference netError/report here: this only ever runs async (on a fetch
   * response), long after the whole script has been evaluated.
   * ------------------------------------------------------------------------------------------- */
  function handleLoginRpc(data, status) {
    try {
      if (!data || typeof data !== 'object') return;
      if (data.cookieSetterUrl) {
        log('info', 'login RPC ok (cookieSetterUrl present, status ' + status + ')');
        return;
      }
      var errText = String(data.error || data.message || '');
      if (/ACCOUNT_INVALID_CREDENTIALS/i.test(errText)) {
        log('info', 'login RPC verdict: invalid credentials (network)');
        setNetError({ kind: 'invalid', error: 'Wrong email address or password.' });
        report(true);
        return;
      }
      if (errText) {
        var cls = classifyError(errText);
        if (cls) {
          log('info', 'login RPC verdict from network: ' + cls.kind);
          setNetError(cls);
          report(true);
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  function isLoginRpcCall(url, body) {
    try {
      return String(url || '').indexOf('/api/rpc') !== -1 &&
        String(body || '').indexOf('createSession') !== -1;
    } catch (e) {
      return false;
    }
  }

  /* ---------------------------------------------------------------------------------------------
   * content-main.js port: fetch / XHR JSON sniffing.
   * Hooked once per document; safe because the whole script is guarded by __cursorAuto below.
   * ------------------------------------------------------------------------------------------- */
  function installNetworkHooks() {
    if (window.__cursorMainHook) return;
    window.__cursorMainHook = true;

    var emit = function (payload) {
      try {
        window.postMessage({ type: 'CURSOR_AUTH_JSON', payload: payload }, '*');
      } catch (e) {
        /* ignore */
      }
    };

    var sniff = function (res, isLoginRpc) {
      try {
        var ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
        if (ct.indexOf('json') === -1) return;
        res.clone().json().then(function (data) {
          emit(data);
          if (isLoginRpc) handleLoginRpc(data, res.status);
        }).catch(function () {});
      } catch (e) {
        /* ignore */
      }
    };

    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function () {
        var loginRpc = false;
        try {
          var fUrl = arguments[0];
          var fBody = arguments[1] && arguments[1].body;
          if (fUrl && typeof fUrl === 'object' && fUrl.url) fUrl = fUrl.url;
          loginRpc = isLoginRpcCall(fUrl, fBody);
        } catch (e) {
          /* ignore */
        }
        var p = origFetch.apply(this, arguments);
        try {
          p.then(function (res) { sniff(res, loginRpc); }).catch(function () {});
        } catch (e) {
          /* ignore */
        }
        return p;
      };
    }

    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__cursorUrl = String(url || '');
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      var xLoginRpc = false;
      try {
        xLoginRpc = isLoginRpcCall(self.__cursorUrl, arguments[0]);
      } catch (e) {
        /* ignore */
      }
      this.addEventListener('loadend', function () {
        try {
          var text = self.responseText || '';
          if (!text || (text[0] !== '{' && text[0] !== '[')) return;
          var data = JSON.parse(text);
          emit(data);
          if (xLoginRpc) handleLoginRpc(data, self.status);
        } catch (e) {
          /* ignore */
        }
      });
      return origSend.apply(this, arguments);
    };
  }

  installNetworkHooks();

  if (window.__cursorAuto) {
    window.__cursorAuto.scan();
    return;
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var ERROR_SEL = [
    '.ak-ErrorMessage',
    '.ak-Alert',
    '.ak-FieldError',
    '.ak-FormError',
    "[class*='ErrorMessage']",
    "[class*='error-message']",
    "[class*='ErrorText']",
    "[class*='field-error']",
    "[class*='FormError']",
    "[role='alert']",
    "[aria-live='assertive']",
    "[aria-live='polite']",
    "[data-testid*='error']",
    '[data-error]',
    "[data-slot='error']",
    ".ak-Callout[data-type='error']",
    "[class*='Callout'][class*='error']"
  ].join(',');

  function nativeSet(el, value) {
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function visible(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function q(sel) {
    var nodes = [].slice.call(document.querySelectorAll(sel));
    for (var i = 0; i < nodes.length; i++) {
      if (visible(nodes[i])) return nodes[i];
    }
    return null;
  }

  function walkErrorNodes(root, out) {
    if (!root) return;
    try {
      var found = root.querySelectorAll(ERROR_SEL);
      for (var i = 0; i < found.length; i++) out.push(found[i]);
    } catch (e) {
      /* ignore */
    }
    var nodes;
    try {
      nodes = root.querySelectorAll('*');
    } catch (e2) {
      return;
    }
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].shadowRoot) walkErrorNodes(nodes[j].shadowRoot, out);
    }
  }

  function urlErrorText() {
    try {
      var u = new URL(location.href);
      var keys = ['error', 'error_description', 'error_code', 'errorCode', 'code'];
      return keys
        .map(function (k) { return u.searchParams.get(k) || ''; })
        .filter(function (v) { return v && !/^[-0-9a-f]{8,}$/i.test(v); })
        .join(' ');
    } catch (e) {
      return '';
    }
  }

  function errorText() {
    var nodes = [];
    walkErrorNodes(document, nodes);
    var dom = nodes.map(function (n) { return n.textContent || ''; }).join(' ');
    return [dom, urlErrorText()].join(' ').replace(/\s+/g, ' ').trim();
  }

  function fields() {
    var path = location.pathname || '';
    var otpInputs = [].slice.call(document.querySelectorAll('input')).some(function (el) {
      if (!visible(el)) return false;
      var maxL = el.maxLength;
      var label = (el.getAttribute('aria-label') || '').toLowerCase();
      var type = (el.type || '').toLowerCase();
      var placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      var name = (el.name || '').toLowerCase();
      var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (type === 'email' || type === 'password' || ac.indexOf('username') !== -1 || ac.indexOf('password') !== -1) {
        return false;
      }
      if (ac === 'one-time-code' || name === 'code' || /otp|one.?time|verification.?code/.test(label + placeholder + name)) {
        return true;
      }
      if (maxL === 1 || maxL === 4 || maxL === 6 || label.indexOf('digit') !== -1) return true;
      if ((type === 'tel' || type === 'text') && (label.indexOf('code') !== -1 || placeholder.indexOf('code') !== -1 || placeholder.indexOf('otp') !== -1)) {
        return true;
      }
      return false;
    });
    return {
      email: Boolean(q('input[name="email"], input[type="email"], input[autocomplete="username"]')),
      password: Boolean(q('input[name="password"], input[type="password"], input[autocomplete="current-password"]')),
      otp: Boolean(path.indexOf('radar-challenge') !== -1 || /otp|mfa|code|verify|challenge|2fa|verification|authenticator|security/i.test(path) || otpInputs)
    };
  }

  // Cloudflare Turnstile: only a VISIBLE, unsolved, interactive checkbox widget
  // blocks the flow. Hidden/invisible widgets (0x0 iframe, display:none) solve
  // themselves on submit and must NOT stall automation. Solved = the
  // cf-turnstile-response input carries a token. The widget IFRAME is preferred
  // for clicking: a trusted .click() on the iframe element is delivered into
  // the iframe's document and ticks the box (a click on the wrapper div would
  // not cross into it).
  function firstVisible(sel) {
    try {
      var cands = document.querySelectorAll(sel);
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (!el) continue;
        var st = null;
        try { st = window.getComputedStyle(el); } catch (e2) { /* ignore */ }
        if (st && (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0)) continue;
        if (st && st.position !== 'fixed' && el.offsetParent === null) continue;
        var r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 20) return el;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function visibleTurnstileWidget() {
    try {
      var resp = document.querySelector('input[name="cf-turnstile-response"]');
      if (resp && resp.value) return null;
      return firstVisible('iframe[src*="challenges.cloudflare.com"]') ||
             firstVisible('.cf-turnstile');
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function turnstilePending() {
    return visibleTurnstileWidget() !== null;
  }

  // Auto-click the Turnstile checkbox (like the old app): a trusted .click() on
  // the widget iframe element is delivered into the iframe and ticks the box.
  // Throttled to one attempt per 3s; the patient native wait stays as fallback
  // for challenges that still need a manual tick.
  var turnstileLastClick = 0;
  function maybeClickTurnstile() {
    try {
      var w = visibleTurnstileWidget();
      if (!w) return;
      var now = Date.now();
      if (now - turnstileLastClick < 3000) return;
      turnstileLastClick = now;
      log('info', 'turnstile checkbox auto-click');
      w.click();
    } catch (e) {
      /* ignore */
    }
  }

  function pageKind() {
    var path = location.pathname || '';
    var host = location.hostname || '';
    var f = fields();
    if (/radar-challenge|otp|mfa|code|verify|challenge|2fa|verification|authenticator|security/i.test(path)) return 'otp';
    if (turnstilePending()) return 'turnstile';
    if (path.indexOf('/success') !== -1) return 'success';
    // xAI OAuth consent screen (accounts.x.ai/oauth2/consent) - needs the approve button clicked
    if (path.indexOf('/oauth2/consent') !== -1 || path.indexOf('/oauth2/authorize') !== -1) return 'consent';
    if (host.indexOf('cursor.com') !== -1 && host.indexOf('authenticator') === -1) {
      if (f.email) return 'email';
      if (f.password) return 'password';
      return 'cursor';
    }
    if (path.indexOf('/password') !== -1 || f.password) return 'password';
    if (f.email) return 'email';
    return 'unknown';
  }

  function classifyError(text) {
    var e = String(text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'");
    if (!e.trim()) return null;
    // Phone/SMS/MFA challenge rate-limit is a dead-end. Narrow to phone/mfa/challenge context so
    // generic "too many attempts" login throttling isn't misclassified as permanently blocked.
    if (
      e.indexOf('too many challenges') !== -1 ||
      e.indexOf('challenges sent') !== -1 ||
      /too many (codes?|sms|otp|verification codes)/.test(e) ||
      (e.indexOf('contact your admin') !== -1 && /phone|challenge|sms|mfa|otp|code/.test(e))
    ) {
      return { kind: 'blocked', error: 'too many challenges (phone/sms)' };
    }
    if (
      /radar[_ ]?(email|sms)[_ ]?challenge/.test(e) ||
      e.indexOf('email_verification') !== -1 ||
      e.indexOf('mfa_challenge') !== -1
    ) {
      return null;
    }
    if (
      e.indexOf('access blocked') !== -1 ||
      e.indexOf('access has been blocked') !== -1 ||
      e.indexOf('sign-in was not successful') !== -1 ||
      e.indexOf('sign in was not successful') !== -1 ||
      e.indexOf("sign-in didn't go through") !== -1 ||
      e.indexOf("sign in didn't go through") !== -1 ||
      e.indexOf('policy_denied') !== -1 ||
      e.indexOf('policy denied') !== -1 ||
      e.indexOf('action_denied') !== -1 ||
      e.indexOf('action denied') !== -1 ||
      e.indexOf('this action has been blocked') !== -1 ||
      e.indexOf('account locked') !== -1 ||
      e.indexOf('account disabled') !== -1 ||
      e.indexOf('account suspended') !== -1
    ) {
      return { kind: 'blocked', error: 'access blocked (policy)' };
    }
    if (
      e.indexOf('invalid email or password') !== -1 ||
      e.indexOf('invalid_email_password') !== -1 ||
      e.indexOf('invalid credentials') !== -1 ||
      e.indexOf('invalid_credentials') !== -1 ||
      e.indexOf('incorrect email or password') !== -1 ||
      e.indexOf('incorrect password') !== -1 ||
      e.indexOf('wrong email or password') !== -1 ||
      e.indexOf('wrong email address or password') !== -1 ||
      e.indexOf('wrong password') !== -1 ||
      e.indexOf('email or password is incorrect') !== -1 ||
      e.indexOf('email or password is invalid') !== -1 ||
      e.indexOf('password is incorrect') !== -1 ||
      e.indexOf('the email or password you entered') !== -1 ||
      e.indexOf('password_failed') !== -1 ||
      e.indexOf('no account found') !== -1 ||
      e.indexOf('user not found') !== -1 ||
      e.indexOf('user_not_found') !== -1
    ) {
      return { kind: 'invalid', error: 'invalid email or password' };
    }
    return null;
  }

  function classifyNetwork(data) {
    if (!data || typeof data !== 'object') return null;
    var nest = data.error && typeof data.error === 'object' ? data.error : null;
    var code = String(
      data.code || data.error_code || data.errorCode ||
      (typeof data.error === 'string' ? data.error : '') || (nest && nest.code) || ''
    );
    var msg = String(
      data.message || data.error_description || data.errorDescription || (nest && nest.message) || ''
    );
    return classifyError(code + ' ' + msg);
  }

  function waitFor(fn, timeoutMs, step) {
    step = step || 200;
    var end = Date.now() + timeoutMs;
    return new Promise(function (resolve) {
      var tick = function () {
        var v;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() >= end) return resolve(null);
        setTimeout(tick, step);
      };
      tick();
    });
  }

  /* ---------------------------------------------------------------------------------------------
   * Primary submit-button cache.
   * The old approach searched the DOM for the submit button AFTER filling the fields,
   * which is fragile (React may re-render, labels vary). Instead we capture the page's
   * main submit button during the scan — before any filling — and the submit step
   * clicks the already-known element (re-validated), falling back to a fresh search
   * only if the cached node is gone.
   * ------------------------------------------------------------------------------------------- */
  var cachedSubmit = null;

  function submitButtonFilter(b) {
    var t = (b.textContent || b.value || '').trim().toLowerCase();
    if (/google|github|apple|gitlab|passkey|sso|oauth/.test(t)) return false;
    if (/sign[- ]?in code|email code|send code|text (me )?a code|sms|phone/.test(t)) return false;
    return true;
  }

  function scoreSubmitButton(b) {
    var t = (b.textContent || b.value || '').trim().toLowerCase();
    var score = 0;
    if (/sign[- ]?in|log[- ]?in/.test(t) && t.length < 30) score += 3;
    else if (/continue|next|verify|confirm|submit/.test(t) && t.length < 30) score += 2;
    if (b.type === 'submit' || b.getAttribute('type') === 'submit') score += 2;
    if (/go back|cancel|forgot/.test(t)) score -= 5;
    return score;
  }

  // includeDisabled=true for caching (button may enable after fill); the click
  // path always re-validates visibility (which excludes disabled).
  function findPrimarySubmit(includeDisabled) {
    var buttons = [].slice.call(document.querySelectorAll("button, [role='button'], input[type='submit']"));
    var vis = buttons.filter(function (b) {
      if (!includeDisabled && (b.disabled || b.readOnly)) return false;
      if (!b) return false;
      var s;
      try { s = getComputedStyle(b); } catch (e) { return false; }
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      var r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return true;
    }).filter(submitButtonFilter);
    var best = null, bestScore = 0;
    for (var i = 0; i < vis.length; i++) {
      var sc = scoreSubmitButton(vis[i]);
      if (sc > bestScore) { bestScore = sc; best = vis[i]; }
    }
    return best;
  }

  function refreshSubmitCache(kind) {
    if (kind !== 'email' && kind !== 'password') { cachedSubmit = null; return; }
    var b = findPrimarySubmit(true);
    if (b) cachedSubmit = b;
  }

  function cachedSubmitValid() {
    return !!(cachedSubmit && document.contains(cachedSubmit) && visible(cachedSubmit));
  }

  function findSubmit(labelRe) {
    var buttons = [].slice.call(document.querySelectorAll("button, [role='button'], input[type='submit']"));
    var vis = buttons.filter(visible).filter(function (b) {
      var t = (b.textContent || b.value || '').trim().toLowerCase();
      if (/google|github|apple|gitlab|passkey|sso|oauth/.test(t)) return false;
      if (/sign[- ]?in code|email code|send code|text (me )?a code|sms|phone/.test(t)) return false;
      return true;
    });
    var labeled = vis.find(function (b) { return labelRe.test((b.textContent || b.value || '').trim()); });
    if (labeled) return labeled;
    return vis.find(function (b) { return b.type === 'submit' || b.getAttribute('type') === 'submit'; }) || null;
  }

  function fillEmail(email) {
    return waitFor(function () {
      return q('input[name="email"], input[type="email"], input[autocomplete="username"]');
    }, 12000).then(function (el) {
      if (!el) return { ok: false, error: 'no email field' };
      nativeSet(el, email);
      return sleep(250).then(function () {
        var hasPassword = Boolean(
          q('input[name="password"], input[type="password"], input[autocomplete="current-password"]')
        );
        if (hasPassword) return { ok: true, hasPassword: true };
        var btn = findSubmit(/continue|next|sign in|log in/i);
        if (btn) btn.click();
        armErrorWatch();
        return { ok: true, hasPassword: false };
      });
    });
  }

  function fillPassword(password) {
    return waitFor(function () {
      return q('input[name="password"], input[type="password"], input[autocomplete="current-password"]');
    }, 15000).then(function (el) {
      if (!el) return { ok: false, error: 'no password field' };
      nativeSet(el, password);
      return sleep(300).then(function () {
        // Prefer the button cached during the page scan; fall back to a fresh search.
        var btn = cachedSubmitValid() ? cachedSubmit : findSubmit(/sign[- ]?in|log[- ]?in|continue|next/i);
        if (btn) {
          btn.click();
        } else {
          // Fallbacks: Enter key on the password field, then form submit.
          try {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          } catch (e) { /* ignore */ }
          try {
            el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          } catch (e2) { /* ignore */ }
          if (el.form && el.form.requestSubmit) {
            try { el.form.requestSubmit(); } catch (e3) { /* ignore */ }
          }
        }
        armErrorWatch();
        return { ok: true };
      });
    });
  }

  function fillOtp(code) {
    var clean = String(code || '').replace(/\D/g, '');
    if (clean.length < 4) return Promise.resolve({ ok: false, error: 'otp too short' });
    return waitFor(function () {
      var found = [].slice.call(document.querySelectorAll('input')).filter(function (el) {
        var lbl = (el.getAttribute('aria-label') || '').toLowerCase();
        return visible(el) && (el.maxLength === 1 || lbl.indexOf('digit') !== -1 || lbl.indexOf('code') !== -1);
      });
      return found.length >= 4 ? found : null;
    }, 8000).then(function (boxes) {
      var filled = false;
      var chain = Promise.resolve();
      if (boxes) {
        boxes.forEach(function (box, i) {
          chain = chain.then(function () {
            nativeSet(box, clean[i] || '');
            return sleep(40);
          });
        });
        filled = true;
        return chain.then(finishOtp).then(function () { return { ok: true }; });
      }
      return waitFor(function () {
        return q('input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]') ||
          q('input[type="text"], input[type="tel"]') ||
          q('input[placeholder*="code"], input[placeholder*="Code"], input[placeholder*="OTP"]');
      }, 8000).then(function (el) {
        if (el) {
          nativeSet(el, clean);
          filled = true;
        } else {
          var btn = findSubmit(/verify|continue|submit|confirm/i);
          if (btn) { btn.click(); filled = true; }
        }
        return finishOtp(filled);
      }).then(function () { return { ok: true }; });
    });

    function finishOtp(wasFilled) {
      return sleep(300).then(function () {
        if (wasFilled === false) {
          var btn = findSubmit(/verify|continue|submit|confirm/i);
          if (btn) btn.click();
        } else {
          var btn2 = findSubmit(/verify|continue|submit|confirm/i);
          if (btn2) btn2.click();
        }
        armErrorWatch();
      });
    }
  }

  var lastSig = '';
  var errorWatch = 0;
  var netError = null;
  var netErrorAt = 0;

  // A network-derived error is only trustworthy for a short window: the native
  // side consumes it within a second of report(true). Expiring it stops a stale
  // (or unrelated-endpoint) error from killing the combo long after the fact.
  function setNetError(err) {
    netError = err;
    netErrorAt = Date.now();
  }

  function armErrorWatch() {
    if (errorWatch) clearInterval(errorWatch);
    var end = Date.now() + 25000;
    errorWatch = setInterval(function () {
      report(true);
      if (Date.now() >= end) {
        clearInterval(errorWatch);
        errorWatch = 0;
      }
    }, 300);
  }

  function currentError() {
    if (netError && Date.now() - netErrorAt > 15000) netError = null;
    return classifyError(errorText()) || netError;
  }

  function isLoggedIn(kind) {
    var href = location.href.toLowerCase();
    if (href.indexOf('/api/auth/callback') !== -1) return true;
    if (kind === 'success') return true;
    if (href.indexOf('cursor.com/dashboard') !== -1 || href.indexOf('cursor.com/settings') !== -1) return true;
    if (href.indexOf('cursor.com/agents') !== -1 || href.indexOf('cursor.com/') !== -1 && kind === 'cursor') return true;
    var markers = document.querySelectorAll(
      "[data-testid*='user-menu' i], [aria-label*='account' i], [href*='logout' i], [href*='sign-out' i]"
    );
    return kind === 'cursor' && markers.length > 0;
  }

  // xAI OAuth consent screen: auto-click the "Sign in" approve button (exact text match
  // avoids hitting "Sign in with another account"). Retries every 3s until navigation.
  var consentLastClick = 0;
  function maybeClickConsent(kind) {
    if (kind !== 'consent') return;
    var now = Date.now();
    if (now - consentLastClick < 3000) return;
    try {
      var buttons = [].slice.call(document.querySelectorAll("button, [role='button'], input[type='submit']"));
      for (var i = 0; i < buttons.length; i++) {
        var t = (buttons[i].textContent || buttons[i].value || '').trim().toLowerCase();
        if (t === 'sign in' && visible(buttons[i])) {
          consentLastClick = now;
          log('info', 'consent approve clicked');
          buttons[i].click();
          return;
        }
      }
      // fallback: authorize/allow style buttons
      for (var j = 0; j < buttons.length; j++) {
        var u = (buttons[j].textContent || buttons[j].value || '').trim().toLowerCase();
        if ((u === 'authorize' || u === 'allow' || u === 'continue') && visible(buttons[j])) {
          consentLastClick = now;
          log('info', 'consent fallback clicked: ' + u);
          buttons[j].click();
          return;
        }
      }
    } catch (e) { /* ignore */ }
  }

  function report(force) {
    var kind = pageKind();
    maybeClickConsent(kind);
    maybeClickTurnstile();
    refreshSubmitCache(kind);
    var f = fields();
    var err = currentError();
    var fatal = err && (err.kind === 'invalid' || err.kind === 'blocked');
    var sig = kind + '|' + f.email + '|' + f.password + '|' + f.otp + '|' + (err ? err.kind : '');
    if (!force && !fatal && sig === lastSig) return;
    lastSig = sig;
    send('auth.page', { kind: kind, fields: f, error: err });
    reportLoginState(isLoggedIn(kind), kind);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== 'CURSOR_AUTH_JSON') return;
    var err = classifyNetwork(e.data.payload);
    if (!err) return;
    setNetError(err);
    report(true);
  });

  window.__cursorAuto = {
    version: 1,

    scan: function () { scheduleScan(); },

    state: function () { report(true); },

    ping: function () { report(true); },

    fillEmail: function (email) {
      fillEmail(email).then(function (r) {
        send('auth.fill', { field: 'email', ok: !!(r && r.ok), hasPassword: !!(r && r.hasPassword), error: r && r.error });
      });
    },

    fillPassword: function (password) {
      fillPassword(password).then(function (r) {
        send('auth.fill', { field: 'password', ok: !!(r && r.ok), error: r && r.error });
      });
    },

    fillOtp: function (code) {
      fillOtp(code).then(function (r) {
        send('auth.fill', { field: 'otp', ok: !!(r && r.ok), error: r && r.error });
      });
    },

    wipe: function () {
      try { localStorage.clear(); } catch (e) { /* ignore */ }
      try { sessionStorage.clear(); } catch (e2) { /* ignore */ }
      try {
        document.cookie.split(';').forEach(function (c) {
          var n = c.split('=')[0].trim();
          if (!n) return;
          document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
          document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.cursor.com';
          document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.cursor.sh';
          document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.authenticate.cursor.sh';
          document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.accounts.x.ai';
          document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.x.ai';
        });
      } catch (e3) { /* ignore */ }
      try {
        if (indexedDB && indexedDB.databases) {
          indexedDB.databases().then(function (dbs) {
            (dbs || []).forEach(function (d) {
              if (d && d.name) indexedDB.deleteDatabase(d.name);
            });
          });
        }
      } catch (e4) { /* ignore */ }
    }
  };

  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      scanTimer = null;
      report(false);
    }, 200);
  }

  var moTick = 0;
  var mo = new MutationObserver(function () {
    if (moTick) return;
    moTick = setTimeout(function () {
      moTick = 0;
      report(false);
    }, 200);
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
  });

  window.addEventListener('load', scheduleScan);
  send('shell.ready', { version: 1 });
  report(true);
  setTimeout(function () { report(false); }, 800);
  setTimeout(function () { report(false); }, 2500);
})();
