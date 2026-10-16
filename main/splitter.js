// Port of ComboSplitter.splitEvenly — divides the combo list across N workers
// so chunk sizes differ by at most 1 (round-robin).
'use strict';

function splitEvenly(list, n) {
  const count = Math.max(1, Math.min(n | 0, list.length || 1));
  const out = Array.from({ length: count }, () => []);
  for (let i = 0; i < list.length; i++) {
    out[i % count].push(list[i]);
  }
  return out;
}

// "email:password" per line, split on the FIRST ':' (passwords may contain ':').
function parseCombos(text) {
  const combos = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    combos.push({ email: line.slice(0, idx).trim(), password: line.slice(idx + 1) });
  }
  return combos;
}

module.exports = { splitEvenly, parseCombos };
