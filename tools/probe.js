#!/usr/bin/env node
/** One-off CDP probe: inspect why icons are missing. */
'use strict';
const PORT = 9222;
let msgId = 0;
const pending = new Map();
let ws;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evalJs = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return res.result?.value ?? res;
};

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!target) { console.error('no page target'); process.exit(1); }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };

  console.log('rows:', await evalJs(`document.querySelectorAll('#app-list .row').length`));
  console.log('rows with img:', await evalJs(`document.querySelectorAll('#app-list .row img').length`));
  console.log('apps:', await evalJs(`state.apps.length`));
  console.log('iconCache size:', await evalJs(`iconCache.size`));
  const probe = await evalJs(`window.rtx.getIcons([state.apps[0].exePath]).then(r => JSON.stringify({ok:r.ok, keys:Object.keys(r.data||{}), err:r.error||null, sample: r.data && Object.values(r.data)[0] ? Object.values(r.data)[0].slice(0,40) : null}))`);
  console.log('getIcons probe:', probe);
  const pendingCalc = await evalJs(`state.apps.filter(a => a.exists !== false && !iconCache.has(a.exePath)).length`);
  console.log('pending (would fetch):', pendingCalc);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
