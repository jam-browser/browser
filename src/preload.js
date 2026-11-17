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
  // 자동 업데이트
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.send('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
});

// 브라우저 계정 · 비밀번호 뱅크 · 친구
// (금고 키와 사이트 비밀번호는 메인 프로세스에만 있다. 여기로는 목록·상태만 온다)
contextBridge.exposeInMainWorld('jamVault', {
  status: () => ipcRenderer.invoke('vault:status'),
  create: (name, password) => ipcRenderer.invoke('vault:create', { name, password }),
  unlock: (password, secretKey) => ipcRenderer.invoke('vault:unlock', { password, secretKey }),
  lock: () => ipcRenderer.invoke('vault:lock'),
  activity: () => ipcRenderer.invoke('vault:activity'),
  verify: (password) => ipcRenderer.invoke('vault:verify', { password }),
  changePassword: (oldPassword, newPassword) => ipcRenderer.invoke('vault:change-password', { oldPassword, newPassword }),
  setAutoLock: (autoLockMinutes) => ipcRenderer.invoke('vault:settings', { autoLockMinutes }),
  exportBackup: () => ipcRenderer.invoke('vault:export'),
  importBackup: () => ipcRenderer.invoke('vault:import'),
  deleteAccount: () => ipcRenderer.invoke('vault:delete-account'),
  logins: () => ipcRenderer.invoke('vault:logins'),
  saveLogin: (entry) => ipcRenderer.invoke('vault:login-save', entry),
  deleteLogin: (id) => ipcRenderer.invoke('vault:login-delete', { id }),
  copyPassword: (id) => ipcRenderer.invoke('vault:login-copy', { id }),
  revealPassword: (id, password) => ipcRenderer.invoke('vault:login-reveal', { id, password }),
  generate: (length) => ipcRenderer.invoke('vault:generate', { length }),
  identity: () => ipcRenderer.invoke('identity:get'),
  signJoin: (nonce, code) => ipcRenderer.invoke('identity:sign-join', { nonce, code }),
  friends: () => ipcRenderer.invoke('friends:list'),
  addFriend: (code, name) => ipcRenderer.invoke('friends:add', { code, name }),
  removeFriend: (fp) => ipcRenderer.invoke('friends:remove', { fp }),
  saveCapture: (captureId) => ipcRenderer.invoke('pw:save-capture', { captureId }),
  discardCapture: (captureId) => ipcRenderer.invoke('pw:discard-capture', { captureId }),
  onLocked: (cb) => ipcRenderer.on('vault:locked', (_e, info) => cb(info)),
  onOfferSave: (cb) => ipcRenderer.on('pw:offer-save', (_e, info) => cb(info)),
});
