// Port of NetscapeCookies — builds a Netscape HTTP Cookie File from the
// partition's cookie jar (same format the Android app sends to Telegram).
'use strict';

function buildNetscape(cookies, header /* "email · plan=… · paid" */) {
  const lines = [];
  if (header) {
    lines.push('# ' + header);
    lines.push('');
  }
  lines.push('# Netscape HTTP Cookie File');
  for (const c of cookies || []) {
    const domain = c.hostOnly ? c.domain : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
    const tailmatch = (!c.hostOnly).toString().toUpperCase();
    const expires = c.session ? 0 : Math.floor(c.expirationDate || 0);
    lines.push([
      domain,
      tailmatch,
      c.path || '/',
      (c.secure ? 'TRUE' : 'FALSE'),
      String(expires),
      c.name,
      c.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

// "name=value; name=value" header for API calls.
function cookieHeader(cookies) {
  return (cookies || []).map((c) => c.name + '=' + c.value).join('; ');
}

// Find the session token cookie (new Auth.js names first, legacy WorkOS last).
function findSessionCookie(cookies) {
  const names = ['__Secure-authjs.session-token', 'authjs.session-token', 'WorkosCursorSessionToken'];
  for (const n of names) {
    const hit = (cookies || []).find((c) => c.name === n);
    if (hit) return hit;
  }
  return null;
}

// Legacy bearer model: substring after the last '::' (WorkOS-era cookies).
function bearerFromValue(value) {
  const v = String(value || '');
  const idx = v.lastIndexOf('::');
  return idx >= 0 ? v.slice(idx + 2) : v;
}

module.exports = { buildNetscape, cookieHeader, findSessionCookie, bearerFromValue };
