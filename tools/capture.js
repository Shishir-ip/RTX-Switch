#!/usr/bin/env node
/**
 * tools/capture.js — automated feature screenshots for the README.
 * Connects to the running RTXSwitch (electron . --remote-debugging-port=9222),
 * drives the UI via CDP Runtime.evaluate, and saves viewport PNGs.
 * Usage: node tools/capture.js [outDir]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'shots'));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error('Page JS error: ' + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  return res.result?.value;
}

async function shot(name) {
  await sleep(650); // let entrance animations settle
  const res = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  console.log('saved', file);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // find the RTXSwitch page target
  let target;
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url) && !/devtools/.test(t.url));
      if (target) break;
    } catch {}
    await sleep(500);
  }
  if (!target) { console.error('RTXSwitch page not found on CDP port', PORT); process.exit(1); }

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
  await send('Page.enable');

  // wait for scan to finish and all icons to load
  await evalJs(`new Promise(res => { const t0 = Date.now();
    const chk = () => {
      const rows = [...document.querySelectorAll('#app-list .row:not(.row--skeleton)')];
      const withImg = rows.filter(r => r.querySelector('img.row-icon')).length;
      if (rows.length && withImg === rows.length) res('icons-done');
      else if (Date.now() - t0 > 10000) res('timeout-rows:' + rows.length + ' icons:' + withImg);
      else setTimeout(chk, 300);
    }; chk(); })`);

  // 1 — main dashboard (GPU cards + full list)
  await evalJs(`(function(){ $$('#filters .filter').forEach(f=>f.classList.remove('is-active'));
    document.querySelector('#filters .filter[data-filter="all"]').classList.add('is-active');
    moveFilterThumb(); const s=document.querySelector('#search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await shot('dashboard');

  // 2 — "On RTX" filter with animated thumb
  await evalJs(`document.querySelector('#filters .filter[data-filter="forced"]').click()`);
  await shot('on-rtx');

  // 3 — live search
  await evalJs(`document.querySelector('#filters .filter[data-filter="all"]').click();
    const s = document.querySelector('#search'); s.value = 'forza';
    s.dispatchEvent(new Event('input', { bubbles: true }));`);
  await shot('search');

  // 4 — bulk actions menu
  await evalJs(`(function(){ const s=document.querySelector('#search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(300);
  await evalJs(`document.querySelector('#btn-bulk').click()`);
  await shot('bulk-menu');

  // 5 — reset confirmation dialog
  await evalJs(`document.querySelector('#bulk-reset').click()`);
  await shot('confirm');
  await evalJs(`closeModal('modal-confirm')`);

  // 6 — settings modal
  await evalJs(`renderSettings(); openModal('modal-settings')`);
  await shot('settings');
  await evalJs(`closeModal('modal-settings')`);

  // 7 — drag & drop overlay
  await evalJs(`document.querySelector('#drop-overlay').hidden = false`);
  await shot('drag-drop');
  await evalJs(`document.querySelector('#drop-overlay').hidden = true`);

  // 8 — success toast
  await evalJs(`document.querySelector('#toasts').innerHTML=''; toast('"Forza Horizon 5" will now run on your RTX GPU')`);
  await shot('toast');

  console.log('all screenshots saved to', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
