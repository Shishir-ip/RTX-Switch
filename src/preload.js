const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rtx', {
  // data
  getGpuInfo: () => ipcRenderer.invoke('gpu:getInfo'),
  listApps: () => ipcRenderer.invoke('apps:list'),
  getIcons: (paths) => ipcRenderer.invoke('apps:getIcons', paths),
  setPref: (exePath, mode) => ipcRenderer.invoke('prefs:set', exePath, mode),
  setPrefBulk: (items) => ipcRenderer.invoke('prefs:setBulk', items),
  removePref: (exePath) => ipcRenderer.invoke('prefs:remove', exePath),
  removePrefBulk: (paths) => ipcRenderer.invoke('prefs:removeBulk', paths),
  addCustomApp: (p) => ipcRenderer.invoke('apps:addCustom', p),
  pickExe: () => ipcRenderer.invoke('apps:pickExe'),
  removeCustomApp: (p) => ipcRenderer.invoke('apps:removeCustom', p),
  openGraphicsSettings: () => ipcRenderer.invoke('shell:openGraphicsSettings'),
  revealInExplorer: (p) => ipcRenderer.invoke('shell:revealInExplorer', p),
  launchApp: (p) => ipcRenderer.invoke('app:launch', p),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  // drag & drop: File.path was removed in Electron >= 32, use webUtils
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },

  // window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  onWindowState: (cb) => ipcRenderer.on('window:state', (_e, maximized) => cb(maximized)),

  // events
  onScanProgress: (cb) => ipcRenderer.on('scan:progress', (_e, p) => cb(p)),
  onSystemResumed: (cb) => ipcRenderer.on('system:resumed', () => cb()),
});
