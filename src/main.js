/**
 * RTXSwitch — main process
 * Forces Windows apps & games onto the dedicated NVIDIA GPU using the official
 * per-app GPU preference system (HKCU\Software\Microsoft\DirectX\UserGpuPreferences).
 * No admin rights required — everything lives under HKCU, exactly what
 * Settings > System > Display > Graphics writes.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REG_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const ICON_DIR = path.join(app.getPath('userData'), 'icon-cache');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let iconMemCache = new Map(); // exePath -> dataUrl

/* ------------------------------------------------------------------ */
/* Settings (window behaviour prefs persisted in userData)             */
/* ------------------------------------------------------------------ */
function loadSettings() {
  try {
    return { closeToTray: true, launchAtStartup: false, scanProgramFiles: false, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { closeToTray: true, launchAtStartup: false, scanProgramFiles: false };
  }
}
function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch };
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2)); } catch {}
  applySettings(merged);
  return merged;
}
function applySettings(s) {
  app.setLoginItemSettings({ openAtLogin: !!s.launchAtStartup, path: process.execPath });
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
function ps(script) {
  // Run a PowerShell snippet, return trimmed stdout (UTF-8).
  return new Promise((resolve) => {
    const cmd = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 45000 },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
}
function regQueryAll() {
  // Parse `reg query` output -> { exePath: modeNumber }
  // Only plain exe paths are handled; UWP package ids (!App) and global
  // settings rows (DirectXUserGlobalSettings etc.) are left untouched.
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', REG_KEY], { windowsHide: true }, (err, stdout) => {
      const out = {};
      if (err || !stdout) return resolve(out);
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^\s*(.+?)\s{2,}REG_SZ\s+(\S+)/i);
        if (m) {
          const name = m[1].trim();
          if (!name.toLowerCase().endsWith('.exe')) continue;
          const g = m[2].match(/GpuPreference\s*=\s*(\d)/i);
          if (g) out[name] = parseInt(g[1], 10);
        }
      }
      resolve(out);
    });
  });
}
function regSetValue(exePath, mode) {
  // Preserve unrelated directives (e.g. SwapEffectUpgradeEnable=0;) —
  // swap only the GpuPreference segment, append if missing.
  return new Promise((resolve, reject) => {
    execFile('reg.exe', ['query', REG_KEY, '/v', exePath], { windowsHide: true }, (err, stdout) => {
      let data = '';
      if (!err && stdout) {
        const m = String(stdout).match(/^\s*.+?\s{2,}REG_SZ\s+(.+?)\s*$/im);
        if (m && m[1]) data = m[1].trim();
      }
      const seg = `GpuPreference=${mode};`;
      if (/GpuPreference\s*=\s*\d+;/i.test(data)) {
        data = data.replace(/GpuPreference\s*=\s*\d+;/i, seg);
      } else {
        data = data.endsWith(';') || data === '' ? data + seg : data + ';' + seg;
      }
      execFile('reg.exe', ['add', REG_KEY, '/v', exePath, '/t', 'REG_SZ', '/d', data, '/f'],
        { windowsHide: true }, (err2) => err2 ? reject(err2) : resolve());
    });
  });
}
function regDeleteValue(exePath) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', ['delete', REG_KEY, '/v', exePath, '/f'], { windowsHide: true },
      (err, stdout, stderr) => {
        // "unable to find" is fine — deleting a non-existent entry is success for us
        if (err && !/unable to find/i.test(stderr + stdout)) reject(err); else resolve();
      });
  });
}
const fileExists = (p) => { try { return p && fs.statSync(p).isFile(); } catch { return false; } };
const BAD_NAME = /(uninstall|unins\d*|setup|installer|installutil|crashpad|crash[_-]?handler|UnityCrashHandler|elevation|helper|update(?!r)|reporter|dxsetup|vcredist|dotnetfx|directxsetup|redist|bootstrap|launcher\.tmp)/i;
const isBadExe = (p) => BAD_NAME.test(path.basename(p)) || /\\windows\\|\\appdata\\local\\temp\\/i.test(p);

/* ------------------------------------------------------------------ */
/* GPU detection                                                       */
/* ------------------------------------------------------------------ */
async function detectGpus() {
  const raw = await ps(
    `ConvertTo-Json -InputObject @(Get-CimInstance -ClassName Win32_VideoController | Select-Object Name,AdapterCompatibility,DriverVersion,AdapterRAM,Status,PNPDeviceID)`
  );
  let controllers = [];
  try { const j = JSON.parse(raw || '[]'); controllers = Array.isArray(j) ? j : [j]; } catch {}

  // NVIDIA details (exact VRAM + driver) — AdapterRAM is unreliable >4GB
  const smi = await ps(
    `$out = & nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>$null; ConvertTo-Json -InputObject @($out)`
  );
  let smiLines = [];
  try { smiLines = JSON.parse(smi || '[]') || []; if (!Array.isArray(smiLines)) smiLines = [smiLines]; } catch {}

  const nvidiaInfo = smiLines.filter(Boolean).map((l) => {
    const [name, mem, drv] = String(l).split(',').map((s) => s.trim());
    return { name, vramMb: parseInt(String(mem).replace(/[^\d]/g, ''), 10) || null, driver: drv };
  });

  const gpus = controllers.filter(c => c && c.Name).map((c, i) => {
    const name = String(c.Name);
    const vendor = /nvidia/i.test(name) ? 'NVIDIA'
      : /amd|radeon|ati/i.test(name) ? 'AMD'
      : /intel/i.test(name) ? 'Intel'
      : (c.AdapterCompatibility || 'Other');
    let type = 'integrated';
    if (vendor === 'NVIDIA') type = 'dedicated';
    else if (/virtual|indirect display|basic render/i.test(name)) type = 'virtual';
    else if (vendor === 'AMD' && /Radeon\s*(\(TM\)\s*)?(RX\s*\d|PRO|VII)/i.test(name) && !/M(obile)?\s*$|(\d{3}M)/.test(name)) type = 'dedicated';
    else if (vendor === 'AMD' && /\b(WX\s*\d{4})\b/i.test(name)) type = 'dedicated';
    else if (vendor === 'Intel' && /\bArc\b/i.test(name)) type = 'dedicated';
    else if (vendor === 'Intel' && /(Iris|UHD|HD Graphics|Graphics \d{3}|Integrated)/i.test(name)) type = 'integrated';
    const nv = nvidiaInfo.find(n => n.name && name && n.name.toLowerCase() === name.toLowerCase());
    const vramMb = nv?.vramMb || (c.AdapterRAM ? Math.round(c.AdapterRAM / (1024 * 1024)) : null);
    return {
      id: i, name, vendor, type,
      vramMb: vramMb && vramMb > 0 ? vramMb : null,
      driver: nv?.driver || c.DriverVersion || null,
      status: c.Status || 'OK',
    };
  });

  // Pick the "high performance" GPU: NVIDIA first, then most VRAM.
  // Prefer a real known iGPU for the "power saving" card; skip virtual adapters.
  let hpg = gpus.find(g => g.vendor === 'NVIDIA') || gpus.filter(g => g.type === 'dedicated').sort((a, b) => (b.vramMb || 0) - (a.vramMb || 0))[0];
  const realIgpu = (g) => g && g.type === 'integrated' && /radeon|uhd|iris|vega|graphics/i.test(g.name);
  let lpg = gpus.find((g) => g !== hpg && realIgpu(g))
    || gpus.find((g) => g !== hpg && g.type === 'integrated')
    || gpus.find((g) => g !== hpg && g.type !== 'virtual')
    || null;
  return { gpus, highPerf: hpg || null, lowPerf: lpg || null, osVersion: os.release() };
}

/* ------------------------------------------------------------------ */
/* App discovery                                                       */
/* ------------------------------------------------------------------ */
function prettyName(exePath) {
  const base = path.basename(exePath, path.extname(exePath));
  return base.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}
async function resolveShortcuts(dirs) {
  const dirList = dirs.filter(d => { try { return fs.existsSync(d); } catch { return false; } });
  if (!dirList.length) return [];
  const psScript = `
    $sh = New-Object -ComObject WScript.Shell
    $dirs = @(${dirList.map((d) => `'${d.replace(/'/g, "''")}'`).join(',')})
    $out = foreach ($d in $dirs) {
      Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        try {
          $t = $sh.CreateShortcut($_.FullName).TargetPath
          if ($t -and ($t.ToLower().EndsWith('.exe'))) {
            [PSCustomObject]@{ exe = $t; name = [IO.Path]::GetFileNameWithoutExtension($_.BaseName) }
          }
        } catch {}
      }
    }
    ConvertTo-Json -InputObject @($out) -Depth 2`;
  const raw = await ps(psScript);
  try {
    const j = JSON.parse(raw || '[]');
    return (Array.isArray(j) ? j : [j]).filter(x => x && x.exe).map(x => ({ exe: x.exe, name: x.name }));
  } catch { return []; }
}
function scanExeDirs(dirs, depth, found) {
  // Walk shallowly, collect exe files (depth relative to each game/app folder root)
  for (const root of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(root, e.name);
      if (e.isDirectory()) {
        if (depth > 0) scanExeDirs([p], depth - 1, found);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
        found.push(p);
      }
    }
  }
}
function readSteamLibraries() {
  const steamApps = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam', 'steamapps');
  const vdfPath = path.join(steamApps, 'libraryfolders.vdf');
  const libs = new Set();
  try {
    const vdf = fs.readFileSync(vdfPath, 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      libs.add(m[1].replace(/\\\\/g, '\\'));
    }
  } catch {}
  libs.add('C:\\Program Files (x86)\\Steam');
  return [...libs].map(l => path.join(l, 'steamapps', 'common'));
}
async function discoverApps(sendProgress) {
  const seen = new Set();
  const apps = [];
  const ownDir = path.dirname(process.execPath).toLowerCase();
  const add = (exePath, name, source) => {
    if (!exePath || typeof exePath !== 'string') return;
    const norm = path.normalize(exePath);
    const lower = norm.toLowerCase();
    if (seen.has(lower)) return;
    if (!fileExists(norm)) return;
    if (isBadExe(norm)) return;
    if (lower.startsWith(ownDir)) return; // never list ourselves / our helpers
    seen.add(lower);
    apps.push({ exePath: norm, name: name || prettyName(norm), source, publisher: guessPublisher(norm), exists: true });
  };
  const guessPublisher = (p) => {
    const parts = p.split('\\');
    if (/steamapps\\common/i.test(p)) return 'Steam';
    if (/epic games/i.test(p)) return 'Epic Games';
    const pf = parts.findIndex(s => /^program files/i.test(s));
    return pf >= 0 && parts[pf + 1] ? parts[pf + 1] : '';
  };

  sendProgress?.({ stage: 'shortcuts', label: 'Scanning Start Menu shortcuts…' });
  const startMenuDirs = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  for (const s of await resolveShortcuts(startMenuDirs)) add(s.exe, s.name, 'startmenu');

  sendProgress?.({ stage: 'steam', label: 'Scanning Steam libraries…' });
  const steamExes = [];
  scanExeDirs(readSteamLibraries(), 1, steamExes);
  steamExes.forEach((e) => add(e, prettyName(e), 'steam'));

  sendProgress?.({ stage: 'epic', label: 'Scanning Epic Games…' });
  const epicExes = [];
  scanExeDirs([path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Epic Games')], 1, epicExes);
  epicExes.forEach((e) => add(e, prettyName(e), 'epic'));

  const settings = loadSettings();
  if (settings.scanProgramFiles) {
    sendProgress?.({ stage: 'pf', label: 'Scanning Program Files…' });
    const pfExes = [];
    scanExeDirs(
      [process.env['ProgramFiles'] || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'],
      1, pfExes
    );
    pfExes.forEach((e) => add(e, prettyName(e), 'programfiles'));
  }

  sendProgress?.({ stage: 'prefs', label: 'Reading GPU preferences…' });
  const prefs = await regQueryAll();
  // Managed entries (set previously, possibly from anywhere) not discovered by scan.
  // Include even if the exe has vanished so the user can still reset them.
  for (const [exePath, mode] of Object.entries(prefs)) {
    const lower = exePath.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      const exists = fileExists(exePath);
      apps.push({
        exePath: path.normalize(exePath),
        name: prettyName(exePath),
        source: exists ? 'managed' : 'missing',
        publisher: '',
        exists,
      });
    }
  }
  // Custom entries saved by user (userData/custom-apps.json)
  for (const e of loadCustomApps()) add(e.exePath, e.name, 'custom');

  return apps;
}
function customAppsFile() { return path.join(app.getPath('userData'), 'custom-apps.json'); }
function loadCustomApps() {
  try { return JSON.parse(fs.readFileSync(customAppsFile(), 'utf8')) || []; } catch { return []; }
}
function saveCustomApps(list) {
  try { fs.writeFileSync(customAppsFile(), JSON.stringify(list, null, 2)); } catch {}
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */
/* app.getFileIcon must NOT be called concurrently on Windows — batches
   of parallel native extractions can hang forever. Serialize every call
   through a single queue. */
let iconQueue = Promise.resolve();
function getIconDataUrl(exePath) {
  const run = async () => {
    const norm = path.normalize(exePath);
    if (iconMemCache.has(norm)) return iconMemCache.get(norm);
    const key = crypto.createHash('sha1').update(norm.toLowerCase()).digest('hex');
    const cached = path.join(ICON_DIR, `${key}.png`);
    try {
      if (fs.existsSync(cached)) {
        const url = `data:image/png;base64,${fs.readFileSync(cached).toString('base64')}`;
        iconMemCache.set(norm, url);
        return url;
      }
    } catch {}
    if (!fileExists(norm)) return null;
    try {
      const icon = await app.getFileIcon(norm, { size: 'large' }); // 48px
      const png = icon.toPNG();
      try { fs.mkdirSync(ICON_DIR, { recursive: true }); fs.writeFileSync(cached, png); } catch {}
      const url = `data:image/png;base64,${png.toString('base64')}`;
      iconMemCache.set(norm, url);
      return url;
    } catch { return null; }
  };
  const result = iconQueue.then(run, run);
  iconQueue = result.then(() => undefined, () => undefined); // keep chain alive
  return result;
}

/* ------------------------------------------------------------------ */
/* Window / tray                                                       */
/* ------------------------------------------------------------------ */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 780, minWidth: 960, minHeight: 640,
    frame: false, show: false,
    backgroundColor: '#0a0c10',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    title: 'RTXSwitch',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus(); });
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', false));
  mainWindow.on('close', (e) => {
    if (loadSettings().closeToTray && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return;
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('window:state', mainWindow.isMaximized());
  });
  // surface renderer errors in the terminal (dev debugging aid)
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });
}
function createTray() {
  try {
    tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.ico'));
    tray.setToolTip('RTXSwitch — GPU preference manager');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open RTXSwitch', click: () => { showWindow(); } },
      { type: 'separator' },
      { label: 'Quit RTXSwitch', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('double-click', () => showWindow());
  } catch {}
}
function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: String((err && err.message) || err) });
const wrap = (fn) => async (_e, ...args) => { try { return ok(await fn(...args)); } catch (err) { return fail(err); } };

ipcMain.handle('gpu:getInfo', wrap(() => detectGpus()));
ipcMain.handle('apps:list', wrap(async (_filter) => {
  const send = (p) => mainWindow?.webContents?.send('scan:progress', p);
  const apps = await discoverApps(send);
  const prefs = await regQueryAll();
  return apps.map((a) => ({ ...a, mode: prefs[a.exePath] !== undefined ? prefs[a.exePath] : 0 }));
}));
ipcMain.handle('apps:getIcons', wrap(async (exePaths) => {
  const entries = await Promise.all((exePaths || []).map(async (p) => [p, await getIconDataUrl(p)]));
  return Object.fromEntries(entries.filter(([, v]) => v));
}));
ipcMain.handle('prefs:set', wrap(async (exePath, mode) => { await regSetValue(exePath, mode); return true; }));
ipcMain.handle('prefs:setBulk', wrap(async (items) => {
  for (const [exePath, mode] of items) { try { await regSetValue(exePath, mode); } catch {} }
  return true;
}));
ipcMain.handle('prefs:remove', wrap(async (exePath) => { await regDeleteValue(exePath); return true; }));
ipcMain.handle('prefs:removeBulk', wrap(async (exePaths) => {
  for (const p of exePaths) { try { await regDeleteValue(p); } catch {} }
  return true;
}));
ipcMain.handle('apps:addCustom', wrap(async (exePath) => {
  if (!fileExists(exePath)) throw new Error('File not found');
  const list = loadCustomApps();
  if (!list.some((x) => x.exePath.toLowerCase() === exePath.toLowerCase())) {
    list.push({ exePath: path.normalize(exePath), name: prettyName(exePath) });
    saveCustomApps(list);
  }
  return true;
}));
ipcMain.handle('apps:pickExe', wrap(async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add an app or game',
    filters: [{ name: 'Programs', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return path.normalize(res.filePaths[0]);
}));
ipcMain.handle('apps:removeCustom', wrap(async (exePath) => {
  saveCustomApps(loadCustomApps().filter((x) => x.exePath.toLowerCase() !== exePath.toLowerCase()));
  return true;
}));
ipcMain.handle('shell:openGraphicsSettings', wrap(async () => { await shell.openExternal('ms-settings:graphics'); return true; }));
ipcMain.handle('shell:revealInExplorer', wrap(async (p) => { shell.showItemInFolder(p); return true; }));
ipcMain.handle('app:launch', wrap(async (exePath) => {
  if (!fileExists(exePath)) throw new Error('File not found');
  const { spawn: sp } = require('child_process');
  sp(exePath, [], { cwd: path.dirname(exePath), detached: true, stdio: 'ignore' }).unref();
  return true;
}));
ipcMain.handle('settings:get', wrap(() => loadSettings()));
ipcMain.handle('settings:set', wrap((patch) => saveSettings(patch)));
ipcMain.handle('app:info', wrap(() => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform })));
ipcMain.handle('file:resolveDropped', wrap(async (name) => name)); // real resolution happens in preload via webUtils

/* window controls */
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => { if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); });
ipcMain.on('window:close', () => mainWindow?.close());

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    applySettings(loadSettings());
    createWindow();
    createTray();
    powerMonitor.on('resume', () => mainWindow?.webContents?.send('system:resumed'));
  });
  app.on('before-quit', () => { isQuitting = true; });
  app.on('window-all-closed', () => { if (process.platform !== 'win32') app.quit(); else if (isQuitting) app.quit(); });
  app.on('activate', () => { if (!mainWindow) createWindow(); });
}
