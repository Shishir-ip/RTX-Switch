'use strict';
const PORT = 9222; let msgId = 0; const pending = new Map(); let ws;
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  console.log(JSON.stringify({
    filter: await evalJs(`state.filter`),
    query: await evalJs(`state.query`),
    activeChip: await evalJs(`document.querySelector('#filters .filter.is-active')?.dataset.filter`),
    rows: await evalJs(`document.querySelectorAll('#app-list .row').length`),
    imgs: await evalJs(`document.querySelectorAll('#app-list .row img').length`),
  }));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
