// karaTin renderer UI — status grid overlays, counters, settings, OTP entry.
'use strict';

const api = window.karaApi;

const $ = (id) => document.getElementById(id);
const cells = Array.from(document.querySelectorAll('.cell'));

function toast(text) {
  const el = $('toast');
  el.textContent = text || '';
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 6000);
}

function renderStatus(s) {
  if (!s) return;
  const c = s.counters || {};
  for (const k of ['ok', 'invalid', 'blocked', 'otp', 'error', 'skip']) {
    const el = $('c-' + k);
    if (el) el.textContent = c[k] || 0;
  }
  const n = (s.grid && s.grid.n) || 4;
  cells.forEach((cell, i) => {
    cell.style.display = i < n ? '' : 'none';
    const w = (s.workers || [])[i];
    const st = cell.querySelector('.st');
    const em = cell.querySelector('.em');
    const otpbox = cell.querySelector('.otpbox');
    if (w) {
      st.textContent = w.status || 'idle';
      em.textContent = w.email || '';
      otpbox.classList.toggle('hidden', w.status !== 'otp');
    } else {
      st.textContent = 'idle';
      em.textContent = '';
      otpbox.classList.add('hidden');
    }
  });
  $('btn-start').disabled = !!s.running;
  $('btn-stop').disabled = !s.running;
}

async function loadSettings() {
  const s = await api.invoke('kara:get-settings');
  $('s-url').value = s.startUrl || '';
  $('s-workers').value = s.workerCount || 4;
  $('s-token').value = '';
  $('s-chat').value = s.chatId || '';
  $('s-paidonly').checked = !!s.paidOnly;
  $('s-combos').value = s.combosText || '';
}

async function saveSettings() {
  const patch = {
    startUrl: $('s-url').value.trim(),
    workerCount: Math.min(4, Math.max(1, parseInt($('s-workers').value, 10) || 4)),
    chatId: $('s-chat').value.trim(),
    paidOnly: $('s-paidonly').checked,
    combosText: $('s-combos').value,
  };
  const token = $('s-token').value;
  if (token) patch.token = token; // empty = keep existing
  await api.invoke('kara:save-settings', patch);
  api.send('kara:workers-changed');
  $('s-token').value = '';
  toast('Settings saved.');
}

$('btn-start').addEventListener('click', () => api.send('kara:start'));
$('btn-stop').addEventListener('click', () => api.send('kara:stop'));
$('btn-settings').addEventListener('click', async () => {
  await loadSettings();
  $('settings-modal').classList.remove('hidden');
});
$('s-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
$('s-save').addEventListener('click', async () => {
  await saveSettings();
  $('settings-modal').classList.add('hidden');
});

cells.forEach((cell, i) => {
  const btn = cell.querySelector('.otpbox button');
  const input = cell.querySelector('.otpbox input');
  const send = () => {
    const code = input.value.trim();
    if (code) api.send('kara:otp', i, code);
    input.value = '';
  };
  btn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
});

api.on('kara:status', renderStatus);
api.on('kara:toast', (d) => toast(d && d.text));
api.on('kara:run-state', (d) => {
  $('btn-start').disabled = !!(d && d.running);
  $('btn-stop').disabled = !(d && d.running);
  if (d && !d.running) toast('Run finished.');
});

api.invoke('kara:get-status');
