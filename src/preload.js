'use strict';
// 앱 UI(renderer)에 노출하는 최소한의 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jamApp', {
  startHost: (opts) => ipcRenderer.invoke('jam:host-start', opts || {}),
  // 중계 서버 목록 상태 · 근처 찾기 · 근처 페어링
  probeRelays: (urls) => ipcRenderer.invoke('relay:probe', urls),
  nearbyList: () => ipcRenderer.invoke('nearby:list'),
  onNearby: (cb) => ipcRenderer.on('nearby', (_e, list) => cb(list)),
  setNearbyVisible: (on) => ipcRenderer.invoke('nearby:visible', !!on),
  pairNearby: (opts) => ipcRenderer.invoke('nearby:pair', opts),
  cancelPair: () => ipcRenderer.invoke('nearby:pair-cancel'),
  onPairSas: (cb) => ipcRenderer.on('nearby:pair-sas', (_e, sas) => cb(sas)),
  onPairPending: (cb) => ipcRenderer.on('nearby:pair-pending', () => cb()),
  // 화면 미러링: 그 탭만 잡는 소스 ID
  mirrorSourceId: (wcId) => ipcRenderer.invoke('mirror:source-id', wcId),
  mirrorInput: (ev, code) => ipcRenderer.invoke('mirror:input', ev, code),
  mirrorEnd: () => ipcRenderer.invoke('mirror:end'),
  // 세부 설정
  setPrefs: (v) => ipcRenderer.invoke('prefs:set', v),
  serverLimits: () => ipcRenderer.invoke('prefs:server-limits'),
  // 같이 보는 파일
  filePick: () => ipcRenderer.invoke('file:pick'),
  fileFromPath: (p, withFolder, net) => ipcRenderer.invoke('file:from-path', p, withFolder, net),
  fileFromWeb: (url) => ipcRenderer.invoke('file:from-web', url),
  fileBytes: (fid) => ipcRenderer.invoke('file:bytes', fid),
  fileStore: (meta, bytes) => ipcRenderer.invoke('file:store', meta, bytes),
  fileHas: (fid) => ipcRenderer.invoke('file:has', fid),
  fileDrop: (fid) => ipcRenderer.invoke('file:drop', fid),
  stopHost: () => ipcRenderer.invoke('jam:host-stop'),
  // 다른 기기에서 이어 보기 (같은 브라우저 계정): 맡기기 · 찾기 — 계정 키는 메인 프로세스에서만 씀
  resumePublish: (arg) => ipcRenderer.invoke('resume:publish', arg || {}),
  resumeFind: (arg) => ipcRenderer.invoke('resume:find', arg || {}),
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
  onTabAudio: (cb) => ipcRenderer.on('tab-audio', (_e, s) => cb(s)),
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
  setBusy: (b) => ipcRenderer.send('app:busy', !!b), // Jam 중이면 자동 업데이트 재시작을 미룸
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
  health: () => ipcRenderer.invoke('vault:health'),
  breachCheck: () => ipcRenderer.invoke('vault:breach-check'),
  identity: () => ipcRenderer.invoke('identity:get'),
  signJoin: (nonce, code) => ipcRenderer.invoke('identity:sign-join', { nonce, code }),
  friends: () => ipcRenderer.invoke('friends:list'),
  addFriend: (code, name) => ipcRenderer.invoke('friends:add', { code, name }),
  removeFriend: (fp) => ipcRenderer.invoke('friends:remove', { fp }),
  saveCapture: (captureId) => ipcRenderer.invoke('pw:save-capture', { captureId }),
  discardCapture: (captureId) => ipcRenderer.invoke('pw:discard-capture', { captureId }),
  onLocked: (cb) => ipcRenderer.on('vault:locked', (_e, info) => cb(info)),
  onOfferSave: (cb) => ipcRenderer.on('pw:offer-save', (_e, info) => cb(info)),
  onLookalike: (cb) => ipcRenderer.on('pw:lookalike', (_e, info) => cb(info)),
});

// 사이트 보호: 🛡 패널 · 사이트 권한 묻기 · 사이트 설정 목록
contextBridge.exposeInMainWorld('jamSite', {
  info: (wcId) => ipcRenderer.invoke('site:info', { wcId }),
  set: (arg) => ipcRenderer.invoke('site:set', arg),
  list: () => ipcRenderer.invoke('site:list'),
  clearAll: () => ipcRenderer.invoke('site:clear-all'),
  refreshLists: () => ipcRenderer.invoke('shield:refresh'),
  answer: (id, decision) => ipcRenderer.send('perm:answer', { id, decision }),
  onAsk: (cb) => ipcRenderer.on('perm:ask', (_e, info) => cb(info)),
  onClosed: (cb) => ipcRenderer.on('perm:closed', (_e, info) => cb(info)),
  onCount: (cb) => ipcRenderer.on('shield:count', (_e, info) => cb(info)),
  onLocal: (cb) => ipcRenderer.on('shield:local', (_e, info) => cb(info)),
});
