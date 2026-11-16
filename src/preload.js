'use strict';
// 앱 UI(renderer)에 노출하는 최소한의 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jamApp', {
  startHost: (opts) => ipcRenderer.invoke('jam:host-start', opts || {}),
  stopHost: () => ipcRenderer.invoke('jam:host-stop'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  onOpenTab: (cb) => ipcRenderer.on('open-tab', (_e, url) => cb(url)),
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, action) => cb(action)),
  onNavBlocked: (cb) => ipcRenderer.on('nav-blocked', (_e, url) => cb(url)),
  setLock: (wcId, locked) => ipcRenderer.send('jam:lock', { wcId, locked: !!locked }),
  // 클립보드 경고
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  clearClipboard: () => ipcRenderer.invoke('clipboard:clear'),
  onClipboardWritten: (cb) => ipcRenderer.on('clipboard-written', (_e, wcId) => cb(wcId)),
  // 다운로드 / 격리
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  releaseDownload: (id) => ipcRenderer.invoke('downloads:release', id),
  deleteDownload: (id) => ipcRenderer.invoke('downloads:delete', id),
  showDownload: (id) => ipcRenderer.invoke('downloads:show', id),
  openDownload: (id) => ipcRenderer.invoke('downloads:open', id),
  onDownload: (cb) => ipcRenderer.on('download:update', (_e, rec) => cb(rec)),
  onDownloadBlocked: (cb) => ipcRenderer.on('download-blocked', (_e, info) => cb(info)),
  markRemoteNav: (wcId) => ipcRenderer.send('jam:remote-nav', wcId),
  // 창
  toggleFullscreen: () => ipcRenderer.send('window:fullscreen'),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, on) => cb(on)),
  // 확장 프로그램 (chrome.tabs)
  onExtCreateTab: (cb) => ipcRenderer.on('ext:create-tab', (_e, req) => cb(req)),
  extTabCreated: (reqId, wcId) => ipcRenderer.send('ext:tab-created', { reqId, wcId }),
  onExtSelectTab: (cb) => ipcRenderer.on('ext:select-tab', (_e, wcId) => cb(wcId)),
  onExtCloseTab: (cb) => ipcRenderer.on('ext:close-tab', (_e, wcId) => cb(wcId)),
  extTabActivated: (wcId) => ipcRenderer.send('ext:tab-activated', wcId),
  // 자동 업데이트
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.send('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
});
