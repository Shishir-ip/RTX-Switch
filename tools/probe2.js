'use strict';
const PORT = 9222;
let msgId = 0; const pending = new Map(); let ws;
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const out = await evalJs(`Promise.race([
    Promise.all(state.apps.filter(a=>a.exists!==false).slice(0,14).map(a=>window.rtx.getIcons([a.exePath]).then(r=>({n:a.name, ok:r.ok, got:!!Object.values(r.data||{})[0], err:(r.error||'').slice(0,60)})))),
    new Promise(res => setTimeout(()=>res('TIMEOUT 8s'), 8000))
  ]).then(v => typeof v === 'string' ? v : JSON.stringify(v))`);
  console.log(out);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
