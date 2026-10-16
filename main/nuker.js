// Port of SessionNuker — full cookie/session wipe for ONE worker partition.
// Other workers' partitions are untouched (strictly better than Android's
// global CookieManager).
'use strict';

const WIPED_STORAGES = [
  'cookies',
  'localstorage',
  'indexdb',
  'serviceworkers',
  'filesystem',
  'shadercache',
  'cachestorage',
];

async function nukeView(view) {
  const ses = view.webContents.session;
  // 1. In-page clear (mirrors Android's JS wipe; sessionStorage is per-WebContents).
  try {
    await view.webContents.executeJavaScript(
      'try{localStorage.clear()}catch(e){} try{sessionStorage.clear()}catch(e){} "ok"'
    );
  } catch (e) { /* page may be gone */ }

  // 2. Partition storage wipe.
  try {
    await ses.clearStorageData({ storages: WIPED_STORAGES });
  } catch (e) { /* ignore */ }
  try { await ses.clearCache(); } catch (e) { /* ignore */ }
  try { await ses.closeAllConnections(); } catch (e) { /* ignore */ }

  // 3. Belt-and-braces: remove any straggler cookies explicitly.
  try {
    const cookies = await ses.cookies.get({});
    for (const c of cookies) {
      const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + (c.path || '/');
      try { await ses.cookies.remove(url, c.name); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

module.exports = { nukeView };
