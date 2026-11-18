'use strict';
const fs = require('fs');
const PORT = 9222; let msgId = 0; const pending = new Map(); let ws;
const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 25000);
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
(async () => {
  const name = process.argv[2], file = process.argv[3];
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url) && !/devtools/.test(t.url));
  if (!target) throw new Error('no page target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
  if (process.argv[4]) await send('Runtime.evaluate', { expression: process.argv[4], awaitPromise: true, returnByValue: true });
  await new Promise(r => setTimeout(r, 800));
  const res = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  console.log('saved', file);
  clearTimeout(timeout); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
