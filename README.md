# karaTin Desktop

Windows desktop port of the karaTin login checker (Electron).

## Run (dev)

```bash
npm ci
npm start
```

## Build the .exe

Push a `v*` tag (or run the workflow manually) — GitHub Actions builds on
`windows-latest` and uploads the portable `.exe` (+ NSIS installer) as the
`karatin-win` artifact.

First launch on Windows shows a SmartScreen "Unknown publisher" prompt
(the build is unsigned) — click **More info → Run anyway**.

## How it works

- 1–4 worker views (`worker-N` cookie partitions, in-memory) in a 2×2 grid.
- `preload/login_hooks.js` (verbatim from the Android app) drives each page;
  the main-process state machine (`main/automator.js`) talks the same
  `auth.page` / `auth.fill` JSON bridge.
- Valid logins pull plan/usage from cursor.com APIs and report via Telegram
  (Netscape cookies + full dump), then the partition is wiped before the next combo.
- Cloudflare Turnstile is manual — tick the checkbox in the visible cell.
