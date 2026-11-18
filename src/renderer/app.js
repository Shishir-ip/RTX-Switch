/* RTXSwitch renderer — state, rendering, interactions */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const MODES = { AUTO: 0, IGPU: 1, RTX: 2 };
const MODE_LABEL = { 0: 'AUTO', 1: 'POWER SAVING', 2: 'RTX FORCED' };

const state = {
  apps: [],
  gpuInfo: null,
  filter: 'all',
  query: '',
  loading: true,
  scanning: false,
  settings: { closeToTray: true, launchAtStartup: false, scanProgramFiles: false },
  info: { version: '1.0.0' },
};

/* ---------------------------------------------------------------- */
/* Toasts                                                            */
/* ---------------------------------------------------------------- */
const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5m0 4h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 16v-5m0-4h.01"/><circle cx="12" cy="12" r="9"/></svg>',
};
function toast(msg, kind = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.innerHTML = `<div class="toast-ic">${TOAST_ICONS[kind] || TOAST_ICONS.info}</div><span>${msg}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 3400);
}

/* ---------------------------------------------------------------- */
/* GPU cards                                                         */
/* ---------------------------------------------------------------- */
const GPU_ICONS = {
  NVIDIA: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M13 2 L4 14 H11 L9 22 L20 9 H12 Z" fill="currentColor" stroke="none"/></svg>',
  AMD: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><rect x="8" y="8" width="8" height="8" rx="1.5"/><path d="M3 9V5.5A2.5 2.5 0 0 1 5.5 3H9M15 3h3.5A2.5 2.5 0 0 1 21 5.5V9M21 15v3.5a2.5 2.5 0 0 1-2.5 2.5H15M9 21H5.5A2.5 2.5 0 0 1 3 18.5V15"/></svg>',
  Intel: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><ellipse cx="12" cy="12" rx="9" ry="6.5"/><ellipse cx="12" cy="12" rx="4.5" ry="2.5"/></svg>',
};
function gpuIcon(vendor) { return GPU_ICONS[vendor] || GPU_ICONS.AMD; }

function renderGpuCards() {
  const wrap = $('#gpu-cards');
  const { highPerf, lowPerf, gpus } = state.gpuInfo;
  const cards = [];
  const make = (g, isHpg, idx) => {
    const vram = g.vramMb ? `${(g.vramMb / 1024).toFixed(g.vramMb >= 1024 ? 1 : 0)} GB VRAM` : null;
    const meta = [vram, g.driver ? `Driver ${g.driver}` : null].filter(Boolean).join(' · ');
    return `
      <div class="card-gpu ${isHpg ? 'card-gpu--hpg' : ''}" style="animation-delay:${idx * 90}ms">
        <div class="gpu-ic">${gpuIcon(g.vendor)}</div>
        <div>
          <div class="gpu-name">${esc(g.name)}</div>
          <div class="gpu-meta">${esc(meta || g.vendor)}</div>
        </div>
        <span class="gpu-tag ${isHpg ? 'gpu-tag--hpg' : ''}">${isHpg ? 'HIGH PERFORMANCE' : 'INTEGRATED'}</span>
      </div>`;
  };
  if (highPerf) cards.push(make(highPerf, true, 0));
  if (lowPerf && lowPerf !== highPerf) cards.push(make(lowPerf, false, 1));
  else if (!highPerf && gpus[0]) cards.push(make(gpus[0], false, 0));
  wrap.innerHTML = cards.join('') || '<div class="gpu-skeleton"></div>';
}

/* ---------------------------------------------------------------- */
/* App list                                                          */
/* ---------------------------------------------------------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function visibleApps() {
  const q = state.query.trim().toLowerCase();
  return state.apps.filter((a) => {
    if (q && !a.name.toLowerCase().includes(q) && !a.exePath.toLowerCase().includes(q)) return false;
    switch (state.filter) {
      case 'forced': return a.mode === MODES.RTX;
      case 'igpu': return a.mode === MODES.IGPU;
      case 'auto': return a.mode === MODES.AUTO;
      default: return true;
    }
  });
}

const SOURCE_LABEL = { steam: 'Steam', epic: 'Epic', startmenu: 'App', custom: 'Added', programfiles: 'App', managed: 'Managed', missing: 'Missing' };

function rowHtml(a, i) {
  const badgeCls = a.exists === false ? 'badge--missing'
    : a.mode === MODES.RTX ? 'badge--forced'
    : a.mode === MODES.IGPU ? 'badge--igpu' : 'badge--auto';
  const badgeTxt = a.exists === false ? 'NOT FOUND' : MODE_LABEL[a.mode];
  return `
    <div class="row ${a.mode === MODES.RTX && a.exists !== false ? 'is-forced' : ''}" data-exe="${esc(a.exePath)}" style="--i:${i}" role="listitem">
      ${rowIconHtml(a)}
      <div class="row-main">
        <div class="row-title">${esc(a.name)}<span class="row-source">${SOURCE_LABEL[a.source] || ''}</span></div>
        <div class="row-sub" title="${esc(a.exePath)}">${esc(a.exePath)}</div>
      </div>
      <span class="badge ${badgeCls}"><span class="dot"></span>${badgeTxt}</span>
      <div class="seg" data-mode="${a.mode}" role="radiogroup" aria-label="GPU preference">
        <div class="seg-thumb"></div>
        <button class="seg-opt" data-mode="0" title="Let Windows decide">Auto</button>
        <button class="seg-opt" data-mode="1" title="Power saving — integrated GPU">iGPU</button>
        <button class="seg-opt" data-mode="2" title="High performance — RTX">RTX</button>
      </div>
      <button class="row-action" data-remove title="${a.source === 'custom' ? 'Remove from RTXSwitch' : 'Reset to Windows default'}">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20L18 7M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2"/></svg>
      </button>
    </div>`;
}

function renderList() {
  const list = $('#app-list');
  const apps = visibleApps();
  list.innerHTML = apps.map(rowHtml).join('');
  const empty = $('#empty-state');
  const hasAny = state.apps.length > 0;
  empty.hidden = apps.length > 0;
  if (apps.length === 0 && hasAny) {
    $('#empty-title').textContent = state.query ? `No results for “${state.query}”` : 'Nothing in this filter';
    $('#empty-sub').textContent = state.query ? 'Try a different search term.' : 'Switch filters or add an app manually.';
    $('#empty-add').hidden = false;
  } else if (apps.length === 0 && !hasAny && !state.loading) {
    $('#empty-title').textContent = 'No apps found yet';
    $('#empty-sub').textContent = 'Run a rescan, or add an app manually by picking its .exe file.';
    $('#empty-add').hidden = false;
  }
  updateStats();
}

/* icons: renderer-side cache + background batch fetch */
const iconCache = new Map();
function rowIconHtml(a) {
  const url = iconCache.get(a.exePath);
  if (url) return `<img class="row-icon" src="${url}" alt="" draggable="false">`;
  return `<div class="row-icon row-icon--ph" data-icon-slot>
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>
  </div>`;
}
async function fetchIconSafe(exePath) {
  // never let a stuck native call wedge icon loading
  try {
    const res = await Promise.race([
      window.rtx.getIcons([exePath]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('icon timeout')), 5000)),
    ]);
    if (res && res.ok && res.data) {
      const url = Object.values(res.data)[0];
      if (url) return url;
    }
  } catch {}
  return null;
}
async function loadIcons() {
  const queue = state.apps.filter((a) => a.exists !== false && !iconCache.has(a.exePath));
  let idx = 0;
  const WORKERS = 3;
  const worker = async () => {
    while (idx < queue.length) {
      const a = queue[idx++];
      const url = await fetchIconSafe(a.exePath);
      if (url) {
        iconCache.set(a.exePath, url);
        const slot = document.querySelector(`.row[data-exe="${CSS.escape(a.exePath)}"] [data-icon-slot]`);
        if (slot) {
          const img = document.createElement('img');
          img.className = 'row-icon';
          img.src = url;
          img.alt = '';
          img.draggable = false;
          slot.replaceWith(img);
        }
      }
      await new Promise((r) => setTimeout(r, 10)); // yield so UI stays snappy
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
}

/* ---------------------------------------------------------------- */
/* Stats                                                             */
/* ---------------------------------------------------------------- */
function animateNum(el, target) {
  const start = parseInt(el.textContent, 10) || 0;
  if (start === target) { el.textContent = target; return; }
  const t0 = performance.now();
  const dur = 500;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(start + (target - start) * eased);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function updateStats() {
  animateNum($('#stat-forced-num'), state.apps.filter((a) => a.mode === MODES.RTX).length);
  animateNum($('#stat-total-num'), state.apps.length);
}

/* ---------------------------------------------------------------- */
/* Actions                                                           */
/* ---------------------------------------------------------------- */
async function setMode(exePath, mode) {
  const a = state.apps.find((x) => x.exePath === exePath);
  if (!a || a.mode === mode) return;
  const prev = a.mode;
  a.mode = mode; // optimistic
  renderList();
  loadIcons();
  $('#status-text').textContent = `Setting ${a.name} → ${MODE_LABEL[mode]}…`;
  try {
    await window.rtx.setPref(exePath, mode);
    const name = a.name.length > 34 ? a.name.slice(0, 34) + '…' : a.name;
    if (mode === MODES.RTX) toast(`“${name}” will now run on your RTX GPU`);
    else if (mode === MODES.IGPU) toast(`“${name}” set to power saving (integrated GPU)`, 'info');
    else toast(`“${name}” reset to Windows default`, 'info');
    $('#status-text').textContent = 'Ready';
  } catch (err) {
    a.mode = prev;
    renderList();
    toast(`Failed to update ${a.name}: ${err}`, 'error');
    $('#status-text').textContent = 'Error';
  }
}

async function removeApp(exePath) {
  const a = state.apps.find((x) => x.exePath === exePath);
  if (!a) return;
  try {
    await window.rtx.removePref(exePath);
    if (a.source === 'custom') await window.rtx.removeCustomApp(exePath);
    state.apps = state.apps.filter((x) => x.exePath !== exePath);
    renderList();
    toast(`“${a.name}” removed from the list`, 'info');
  } catch (err) {
    toast(`Failed: ${err}`, 'error');
  }
}

async function refreshApps(showProgress = true) {
  state.scanning = true;
  const status = $('#scan-status');
  if (showProgress) status.hidden = false;
  try {
    const res = await window.rtx.listApps();
    state.apps = res.data;
    renderList();
    loadIcons();
    $('#status-text').textContent = `Found ${state.apps.length} apps`;
  } catch (err) {
    toast(`Scan failed: ${err}`, 'error');
    $('#status-text').textContent = 'Scan error';
  } finally {
    state.scanning = false;
    status.hidden = true;
  }
}

/* ---------------------------------------------------------------- */
/* Modals / menus                                                    */
/* ---------------------------------------------------------------- */
function openModal(id) { $(`#${id}`).hidden = false; }
function closeModal(id) { $(`#${id}`).hidden = true; }
$$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
$$('.modal-backdrop').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) m.hidden = true; }));

let confirmCb = null;
function askConfirm(title, textHtml, yesLabel, cb) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').innerHTML = textHtml;
  $('#confirm-yes').textContent = yesLabel;
  confirmCb = cb;
  openModal('modal-confirm');
}
$('#confirm-yes').addEventListener('click', async () => {
  closeModal('modal-confirm');
  if (confirmCb) await confirmCb();
  confirmCb = null;
});

/* settings */
async function renderSettings() {
  state.settings = (await window.rtx.getSettings()).data;
  $$('.switch[data-setting]').forEach((sw) => {
    sw.classList.toggle('is-on', !!state.settings[sw.dataset.setting]);
  });
  $('#modal-version').textContent = `RTXSwitch v${state.info.version}`;
}
$$('.switch[data-setting]').forEach((sw) => {
  sw.addEventListener('click', async () => {
    const key = sw.dataset.setting;
    const val = !state.settings[key];
    state.settings[key] = val;
    sw.classList.toggle('is-on', val);
    await window.rtx.setSettings({ [key]: val });
    toast(`${{ closeToTray: 'Close to tray', launchAtStartup: 'Launch at startup', scanProgramFiles: 'Deep Program Files scan' }[key]} ${val ? 'enabled' : 'disabled'}`, 'info');
    if (key === 'scanProgramFiles' && val) refreshApps();
  });
});

/* bulk menu */
const bulkMenu = $('#bulk-menu');
$('#btn-bulk').addEventListener('click', (e) => {
  e.stopPropagation();
  bulkMenu.hidden = !bulkMenu.hidden;
});
document.addEventListener('click', (e) => {
  if (!bulkMenu.hidden && !e.target.closest('.menu-anchor')) bulkMenu.hidden = true;
});
$('#bulk-force').addEventListener('click', () => {
  bulkMenu.hidden = true;
  const targets = visibleApps().filter((a) => a.mode !== MODES.RTX && a.exists !== false);
  if (!targets.length) { toast('Everything visible is already on RTX', 'info'); return; }
  askConfirm(
    'Force RTX on all visible apps?',
    `This sets <b>${targets.length} app${targets.length === 1 ? '' : 's'}</b> to <b>High performance (RTX)</b>. Changes apply the next time each app launches.`,
    `Force ${targets.length} app${targets.length === 1 ? '' : 's'}`,
    async () => {
      await window.rtx.setPrefBulk(targets.map((a) => [a.exePath, MODES.RTX]));
      await refreshApps(false);
      toast(`${targets.length} app${targets.length === 1 ? '' : 's'} forced to RTX`);
    }
  );
});
$('#bulk-reset').addEventListener('click', () => {
  bulkMenu.hidden = true;
  const managed = visibleApps().filter((a) => a.mode !== MODES.AUTO);
  if (!managed.length) { toast('No custom preferences to reset', 'info'); return; }
  askConfirm(
    'Reset all preferences?',
    `This removes custom GPU settings for <b>${managed.length} app${managed.length === 1 ? '' : 's'}</b> and hands control back to Windows.`,
    `Reset ${managed.length} app${managed.length === 1 ? '' : 's'}`,
    async () => {
      await window.rtx.removePrefBulk(managed.map((a) => a.exePath));
      await refreshApps(false);
      toast(`Reset ${managed.length} app${managed.length === 1 ? '' : 's'} to Windows default`, 'info');
    }
  );
});

/* ---------------------------------------------------------------- */
/* Drag & drop                                                       */
/* ---------------------------------------------------------------- */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; });
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const files = [...(e.dataTransfer?.files || [])];
  const exes = files.map((f) => window.rtx.pathForFile(f)).filter((p) => p && p.toLowerCase().endsWith('.exe'));
  if (!exes.length) { toast('Drop a .exe file to add it', 'error'); return; }
  for (const p of exes) await window.rtx.addCustomApp(p);
  toast(exes.length === 1 ? 'App added to RTXSwitch' : `${exes.length} apps added to RTXSwitch`);
  await refreshApps(false);
});

/* ---------------------------------------------------------------- */
/* Wiring                                                            */
/* ---------------------------------------------------------------- */
/* filter chips with animated thumb */
function moveFilterThumb() {
  const active = $('#filters .filter.is-active');
  const thumb = $('.filter-thumb');
  if (!active || !thumb) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft}px)`;
}
$('#filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter');
  if (!btn) return;
  $$('#filters .filter').forEach((f) => f.classList.remove('is-active'));
  btn.classList.add('is-active');
  moveFilterThumb();
  state.filter = btn.dataset.filter;
  renderList();
});

/* search */
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value;
    renderList();
  }, 130);
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('#search').focus();
  }
  if (e.key === 'Escape') {
    $$('.modal-backdrop').forEach((m) => (m.hidden = true));
    bulkMenu.hidden = true;
    $('#search').blur();
  }
});

/* buttons */
$('#btn-add').addEventListener('click', async () => {
  const res = await window.rtx.pickExe();
  if (!res.ok || !res.data) return;
  await window.rtx.addCustomApp(res.data);
  await refreshApps(false);
  toast('App added to RTXSwitch');
});
$('#empty-add').addEventListener('click', () => $('#btn-add').click());
$('#btn-refresh').addEventListener('click', () => {
  const icon = $('#btn-refresh svg');
  icon.style.transition = 'transform 0.7s cubic-bezier(0.34,1.56,0.64,1)';
  icon.style.transform = 'rotate(360deg)';
  setTimeout(() => { icon.style.transition = 'none'; icon.style.transform = 'none'; }, 720);
  refreshApps();
});
$('#btn-settings').addEventListener('click', () => { renderSettings(); openModal('modal-settings'); });
$('#open-win-settings').addEventListener('click', () => window.rtx.openGraphicsSettings());

/* list interactions (delegated) */
$('#app-list').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const exe = row.dataset.exe;
  const opt = e.target.closest('.seg-opt');
  if (opt) { setMode(exe, parseInt(opt.dataset.mode, 10)); return; }
  if (e.target.closest('[data-remove]')) { removeApp(exe); return; }
  if (e.target.closest('.row-sub')) window.rtx.revealInExplorer(exe);
});
$('#app-list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.row');
  if (row && !e.target.closest('.seg') && !e.target.closest('.row-action')) {
    // double-click a row (outside controls) → launch the app
    window.rtx.launchApp?.(row.dataset.exe);
  }
});

/* window controls */
$('#tb-min').addEventListener('click', () => window.rtx.minimize());
$('#tb-max').addEventListener('click', () => window.rtx.maximize());
$('#tb-close').addEventListener('click', () => window.rtx.closeWindow());
window.rtx.onWindowState((maximized) => {
  $('#tb-max').innerHTML = maximized
    ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="4" width="12" height="12" rx="1.5"/><path d="M4 8v10a2 2 0 0 0 2 2h10"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
});
window.rtx.onScanProgress((p) => {
  if (p?.label) $('#scan-label').textContent = p.label;
});
window.rtx.onSystemResumed(() => refreshApps(false));

/* skeleton rows while first scan runs */
function showSkeletons() {
  const list = $('#app-list');
  list.innerHTML = Array.from({ length: 9 }, (_, i) => `
    <div class="row row--skeleton" style="--i:${i}">
      <div class="row-icon row-icon--ph"></div>
      <div class="row-main"><div class="row-title">.</div><div class="row-sub">.</div></div>
      <div class="seg"><div class="seg-thumb"></div></div>
    </div>`).join('');
}

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */
(async function init() {
  try {
    const info = await window.rtx.getAppInfo();
    state.info = info.data;
    $('#version-chip').textContent = `v${state.info.version}`;
    $('#modal-version').textContent = `RTXSwitch v${state.info.version}`;
  } catch {}

  // keep the animated filter thumb aligned
  requestAnimationFrame(moveFilterThumb);
  window.addEventListener('resize', moveFilterThumb);
  document.fonts?.ready.then(moveFilterThumb);

  showSkeletons();
  // GPUs and apps in parallel
  window.rtx.getGpuInfo().then((res) => {
    state.gpuInfo = res.data;
    renderGpuCards();
  });
  await refreshApps();
  renderSettings();
})();
