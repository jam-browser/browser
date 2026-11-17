'use strict';
const { app, BrowserWindow, ipcMain, Menu, clipboard, session, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createJamServer } = require('../server/jam-server');
const { startRelayTunnel } = require('../server/relay-tunnel');
const { startBeacon, startScanner } = require('../server/nearby');
const { pairWithHost } = require('../server/pair-client');
const { isPrivateIp } = require('../server/jam-server');
const { sameSite } = require('../shared/site');
const { setupVault } = require('./vault');

const DEFAULT_PORT = 3030;
let mainWindow = null;
let jamServer = null;
let relayTunnel = null; // 인터넷용 중계 서버로 가는 터널
let relayKey = null;
let vaultApi = null;
let beacon = null; // 근처 알림 (호스트일 때)
let scanner = null; // 근처 Jam 찾기
let nearbyVisible = true;
let nearbyList = [];
let pairing = null; // 진행 중인 근처 페어링
let pendingCapture = null; // 화면 미러링: 앱이 방금 요청한 탭 캡처 { wcId, until }
const beaconId = crypto.randomBytes(12).toString('base64url');

// Jam 탭의 webContents id → 다른 사이트 이동이 잠겨 있는지
const lockedJamTabs = new Set();

// 웹페이지가 요청할 수 있는 권한 (카메라·마이크·위치·알림 등은 모두 거절)
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  // 사설망 주소(192.168.x, 10.x, 172.16-31.x)를 먼저 보여준다
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

function createWindow() {
  // 자동 테스트용: 창을 화면 밖에 띄우고 포커스를 뺏지 않는다 (작업 중인 화면을 가리지 않게)
  const offscreen = process.env.JAM_TEST_OFFSCREEN === '1';
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    ...(offscreen ? { x: -6000, y: 0, show: false } : {}),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121212',
    title: 'Jam Browser',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      ...(offscreen ? { backgroundThrottling: false } : {}),
    },
  });
  if (offscreen) mainWindow.showInactive();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('fullscreen', true));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('fullscreen', false));
}

// 단축키: 웹페이지(webview)에 포커스가 있어도 동작하도록 main 프로세스에서 가로챈다
function shortcutFor(input) {
  if (input.type !== 'keyDown') return null;
  const key = input.key.toLowerCase();
  const ctrl = input.control || input.meta;
  if (ctrl && input.shift && key === 't') return 'reopen-tab';
  if (ctrl && input.shift && key === 'b') return 'toggle-bookmarks';
  if (ctrl && input.shift && key === 'l') return 'lock';
  if (ctrl && input.shift && key === 'p') return 'vault';
  if (ctrl && key === 'd') return 'bookmark';
  if (ctrl && key === 'h') return 'history';
  if (ctrl && key === 'f') return 'find';
  if (ctrl && (key === '=' || key === '+')) return 'zoom-in';
  if (ctrl && key === '-') return 'zoom-out';
  if (ctrl && key === '0') return 'zoom-reset';
  if (ctrl && key === ',') return 'settings';
  if (key === 'f11') return 'fullscreen';
  if (ctrl && key === 't') return 'new-tab';
  if (ctrl && key === 'w') return 'close-tab';
  if (ctrl && key === 'l') return 'focus-url';
  if (ctrl && key === 'j') return 'toggle-panel';
  if (ctrl && key === 'tab') return input.shift ? 'prev-tab' : 'next-tab';
  if ((ctrl && key === 'r') || key === 'f5') return 'reload';
  if (input.alt && key === 'arrowleft') return 'back';
  if (input.alt && key === 'arrowright') return 'forward';
  if (key === 'f12') return 'devtools';
  // Esc 를 길게 누르면(자동 반복) 화면 미러링 조작 권한을 모두 회수
  if (key === 'escape' && input.isAutoRepeat) return 'revoke-control';
  return null;
}

app.on('web-contents-created', (_e, contents) => {
  // 소리 끄기: 앱 창과 모든 웹페이지의 오디오를 음소거
  contents.setAudioMuted(true);

  // 웹페이지용 webview에 보안 설정 + Jam 스크립트(커서/스크롤 동기화)를 주입
  contents.on('will-attach-webview', (_ev, webPreferences) => {
    delete webPreferences.preloadURL;
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  if (contents.getType() === 'webview') {
    // 새 창(target=_blank, window.open)은 새 탭(개인 탭)으로 연다
    contents.setWindowOpenHandler(({ url }) => {
      const host = contents.hostWebContents;
      if (host && /^https?:/i.test(url)) host.send('open-tab', url);
      return { action: 'deny' };
    });

    // 권한 없는 사람이 Jam 탭에서 다른 사이트로 넘어가는 것을 막는다.
    // (링크 클릭, 스크립트 이동 모두 해당. 앱이 직접 loadURL 하는 동기화 이동은 이 이벤트가 생기지 않는다)
    contents.on('will-navigate', (event, legacyUrl) => {
      if (!lockedJamTabs.has(contents.id)) return;
      const target = event.url || legacyUrl;
      const current = contents.getURL();
      if (!current || !/^https?:/i.test(current) || sameSite(target, current)) return;
      event.preventDefault();
      contents.hostWebContents?.send('nav-blocked', target);
    });
    const id = contents.id;
    contents.once('destroyed', () => lockedJamTabs.delete(id));
  }

  contents.on('before-input-event', (event, input) => {
    const action = shortcutFor(input);
    if (!action) return;
    const target = contents.getType() === 'webview' ? contents.hostWebContents : contents;
    if (!target) return;
    event.preventDefault();
    target.send('shortcut', action);
  });

  // 앱 UI 창 자체는 다른 주소로 이동하지 않게 막는다
  if (contents.getType() === 'window') {
    contents.on('will-navigate', (e) => e.preventDefault());
  }
});

// relayUrl 을 주면 중계 서버로 가는 터널도 연다 (인터넷으로 함께하기)
ipcMain.handle('jam:host-start', async (_e, opts = {}) => {
  if (!jamServer) {
    relayKey = crypto.randomBytes(24).toString('base64url');
    jamServer = await createJamServer({
      port: DEFAULT_PORT,
      localCreateOnly: true, // 내 PC 호스트: 방은 이 앱만 만들 수 있다 (중앙 서버 없음)
      relayKey,
      log: (m) => console.log(`[jam] ${m}`),
    });
  }
  let relay = null;
  // 중계 서버 주소 목록: 위에서부터 시도해서 처음 열리는 곳을 쓴다 (예전 방식 relayUrl 하나도 받음)
  const isWs = (u) => typeof u === 'string' && /^wss?:\/\/[^\s/]+$/i.test(u);
  const urls = [...(Array.isArray(opts.relayUrls) ? opts.relayUrls : []), opts.relayUrl].filter(isWs).slice(0, 8);
  if (relayTunnel) relayTunnel.close();
  relayTunnel = null;
  const errors = [];
  for (const relayUrl of urls) {
    try {
      relayTunnel = await startRelayTunnel({ relayUrl, localPort: jamServer.port, relayKey, log: (m) => console.log(`[relay] ${m}`) });
      relay = { url: relayUrl, route: relayTunnel.route, skipped: errors };
      break;
    } catch (err) {
      errors.push({ url: relayUrl, error: err.message });
    }
  }
  if (!relay && errors.length) relay = { error: errors.map((e) => e.error).join(' / '), skipped: errors };
  updateBeacon();
  return { port: jamServer.port, addresses: lanAddresses(), relay };
});

ipcMain.handle('jam:host-stop', async () => {
  if (relayTunnel) {
    relayTunnel.close();
    relayTunnel = null;
  }
  if (beacon) {
    beacon.close();
    beacon = null;
  }
  if (jamServer) {
    const s = jamServer;
    jamServer = null;
    await s.close();
  }
});

// ---------- 중계 서버 상태 확인 ----------
// ws://주소:포트 → http://주소:포트/version 을 짧게 확인 (앱 화면은 http 요청을 못 하므로 여기서)
function probeRelay(wsUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(wsUrl.replace(/^ws/i, 'http'));
    } catch {
      return resolve({ url: wsUrl, ok: false, error: 'bad-url' });
    }
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const started = Date.now();
    const req = mod.get({ hostname: u.hostname, port: u.port || undefined, path: '/version', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d.slice(0, 64)));
      res.on('end', () => {
        const version = body.trim().slice(0, 32);
        const ok = res.statusCode === 200 && /^\d+\.\d+\.\d+/.test(version);
        resolve({ url: wsUrl, ok, version: ok ? version : null, ms: Date.now() - started, error: ok ? null : `HTTP ${res.statusCode}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ url: wsUrl, ok: false, error: e.message === 'timeout' ? 'timeout' : e.code || e.message }));
  });
}
const fromApp = (e) => mainWindow && e.sender === mainWindow.webContents;
ipcMain.handle('relay:probe', async (e, urls) => {
  if (!fromApp(e) || !Array.isArray(urls)) return [];
  return Promise.all(urls.filter((u) => typeof u === 'string' && /^wss?:\/\/[^\s/]+$/i.test(u)).slice(0, 8).map((u) => probeRelay(u)));
});

// ---------- 화면 미러링: 그 탭(webview)만 잡는 화면 소스 ID ----------
// 앱 화면 · 다른 탭 · 바탕화면은 잡히지 않는다. 오디오는 앱에서 요청하지 않는다
ipcMain.handle('mirror:source-id', (e, wcId) => {
  if (!fromApp(e)) throw new Error('forbidden');
  const { webContents } = require('electron');
  const wc = webContents.fromId(Number(wcId));
  if (!wc || wc.getType() !== 'webview' || wc.hostWebContents !== mainWindow.webContents) throw new Error('탭을 찾을 수 없어요');
  pendingCapture = { wcId: wc.id, until: Date.now() + 10000 }; // 이 탭에 대한 캡처 요청 한 번만 허락 (권한 처리기에서 확인)
  return wc.getMediaSourceId(mainWindow.webContents);
});

// ---------- 근처 찾기 (UDP 3032, 같은 네트워크) ----------
function updateBeacon() {
  // 호스트 서버가 켜져 있는 동안 (방이 생기면 그때부터 알림에 실림)
  const hosting = !!jamServer;
  if (!hosting || !nearbyVisible) {
    if (beacon) beacon.close();
    beacon = null;
    return;
  }
  if (beacon) return;
  beacon = startBeacon({
    id: beaconId,
    port: jamServer.port,
    appVersion: app.getVersion(),
    log: (m) => console.log(`[nearby] ${m}`),
    getRooms: () => {
      if (!jamServer || !nearbyVisible) return [];
      return [...jamServer.rooms.values()].map((r) => ({
        code: r.code,
        name: r.members.get(r.hostId)?.name || '호스트',
        access: r.settings.access,
        n: r.members.size,
      }));
    },
  });
}
function startNearbyScanner() {
  if (scanner) return;
  scanner = startScanner({
    log: (m) => console.log(`[nearby] ${m}`),
    onChange: (list) => {
      nearbyList = list.filter((x) => x.id !== beaconId); // 내가 연 Jam 은 빼고
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nearby', nearbyList);
    },
  });
}
ipcMain.handle('nearby:list', (e) => (fromApp(e) ? nearbyList : []));
ipcMain.handle('nearby:visible', (e, on) => {
  if (!fromApp(e)) return;
  nearbyVisible = !!on;
  updateBeacon();
  return nearbyVisible;
});
// 링크 없이 근처 Jam 에 페어링: 확인 코드(6자리)는 앱 화면에 보내고, 끝나면 { secret, ticket } 을 돌려준다
ipcMain.handle('nearby:pair', async (e, opts = {}) => {
  if (!fromApp(e)) throw new Error('forbidden');
  const ip = String(opts.ip || '');
  const port = Number(opts.port);
  const code = String(opts.code || '').toUpperCase();
  if (!isPrivateIp(ip) || !/^[\d.:a-f]+$/i.test(ip) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Z0-9]{4,8}$/.test(code)) {
    throw new Error('근처 Jam 정보가 올바르지 않아요');
  }
  if (pairing) pairing.cancel();
  const host = ip.includes(':') ? `[${ip}]` : ip;
  pairing = pairWithHost({
    url: `ws://${host}:${port}`,
    code,
    name: String(opts.name || '').slice(0, 24),
    signer: async (th) => (vaultApi ? vaultApi.signPair(th) : null),
    onSas: (sas) => e.sender.send('nearby:pair-sas', sas),
    onPending: () => e.sender.send('nearby:pair-pending'),
  });
  const mine = pairing;
  try {
    return await mine.promise;
  } catch (err) {
    return { error: err.message, code: err.code };
  } finally {
    if (pairing === mine) pairing = null;
  }
});
ipcMain.handle('nearby:pair-cancel', (e) => {
  if (fromApp(e) && pairing) pairing.cancel();
});

// (최신 Electron 에서는 클립보드 함수가 Promise 를 돌려줄 수 있어 await 로 통일)
ipcMain.handle('clipboard:write', async (_e, text) => {
  await clipboard.writeText(String(text));
});
ipcMain.handle('clipboard:read', async () => String((await clipboard.readText()) || '').slice(0, 4000));
ipcMain.handle('clipboard:clear', async () => {
  await clipboard.clear();
});

// ======================================================================
// 다운로드 + 격리 (확인 전 보관)
//  - 실행되거나 설치될 수 있는 파일(exe, msi, bat, ps1, zip …)은 다운로드 폴더에
//    "원래이름.다운로드확인전" 처럼 한국어 확장자를 붙여 저장한다 → Windows가 실행 파일로 인식하지 않아 더블클릭해도 실행되지 않음
//  - 사용자가 직접 "실행 가능하게 풀기"를 눌러 확인해야 원래 이름(원래 확장자)으로 바뀐다
//  - 모든 다운로드에는 "인터넷에서 받은 파일" 표시(Mark of the Web)를 붙여 Windows SmartScreen 검사가 적용되게 한다
// ======================================================================
const fs = require('fs');
const { dialog, shell } = require('electron');

const RISKY_EXT = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'bat', 'cmd', 'com', 'scr', 'pif',
  'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'cpl', 'msc', 'msp', 'mst', 'jar', 'reg',
  'lnk', 'url', 'scf', 'inf', 'dll', 'sys', 'ocx', 'chm', 'application', 'gadget', 'iso', 'img', 'vhd', 'vhdx',
  'apk', 'xapk', 'dmg', 'pkg', 'deb', 'rpm', 'sh', 'run', 'appimage', 'zip', '7z', 'rar', 'cab', 'gz', 'tgz',
  'xz', 'bz2', 'tar', 'docm', 'xlsm', 'pptm', 'dotm', 'xlam', 'ppam',
]);
const downloads = new Map();
const remoteNavAt = new Map(); // Jam 동기화로 이동한 탭(webContents id) → 시각
ipcMain.on('jam:remote-nav', (_e, wcId) => remoteNavAt.set(wcId, Date.now()));
let downloadSeq = 0;
const HOLD_EXT = '.다운로드확인전'; // 확인 전까지 붙여 두는 확장자
let quarantineDir = ''; // 확인 전 파일 목록(index.json)을 두는 곳
let indexFile = '';

const extOf = (name) => (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const safeName = (name) => (name || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'download';

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function markOfTheWeb(file, url) {
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${url}\r\n`);
  } catch {
    // NTFS가 아닌 드라이브 등에서는 표시를 붙일 수 없다 (격리 자체는 그대로 유지)
  }
}

function publicRecord(r) {
  const { item, ...rest } = r;
  return rest;
}
function pushDownload(r) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download:update', publicRecord(r));
}
function saveIndex() {
  const list = [...downloads.values()].filter((r) => r.quarantined && r.state === 'completed').map(publicRecord);
  try {
    fs.writeFileSync(indexFile, JSON.stringify(list, null, 2));
  } catch {}
}

function setupDownloads(ses) {
  quarantineDir = path.join(app.getPath('userData'), 'quarantine');
  indexFile = path.join(quarantineDir, 'index.json');
  fs.mkdirSync(quarantineDir, { recursive: true });
  // 이전에 격리해 둔 파일 목록 불러오기
  try {
    for (const r of JSON.parse(fs.readFileSync(indexFile, 'utf8'))) {
      if (fs.existsSync(r.savePath)) {
        r.id = ++downloadSeq;
        downloads.set(r.id, r);
      }
    }
  } catch {}

  ses.on('will-download', (_event, item, wc) => {
    const name = safeName(item.getFilename());
    // Jam이 나를 데려간 링크가 파일 다운로드였다면 → 내가 누른 게 아니므로 받지 않는다
    const remoteAt = wc && remoteNavAt.get(wc.id);
    if (remoteAt && Date.now() - remoteAt < 10000) {
      item.cancel();
      if (mainWindow) mainWindow.webContents.send('download-blocked', { name, url: item.getURL() });
      return;
    }
    const risky = RISKY_EXT.has(extOf(name));
    const savePath = uniquePath(app.getPath('downloads'), risky ? `${name}${HOLD_EXT}` : name);
    item.setSavePath(savePath);
    const r = {
      id: ++downloadSeq, name, url: item.getURL(), savePath, quarantined: risky, state: 'progressing',
      received: 0, total: item.getTotalBytes(), at: Date.now(), item,
    };
    downloads.set(r.id, r);
    pushDownload(r);
    let last = 0;
    item.on('updated', (_e, state) => {
      r.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      r.received = item.getReceivedBytes();
      r.total = item.getTotalBytes();
      if (Date.now() - last > 250) {
        last = Date.now();
        pushDownload(r);
      }
    });
    item.once('done', (_e, state) => {
      r.state = state; // completed | cancelled | interrupted
      r.received = item.getReceivedBytes();
      delete r.item;
      if (state === 'completed') markOfTheWeb(savePath, r.url);
      if (r.quarantined) saveIndex();
      pushDownload(r);
    });
  });
}

ipcMain.handle('downloads:list', () => [...downloads.values()].map(publicRecord));

ipcMain.handle('downloads:release', async (_e, id) => {
  const r = downloads.get(id);
  if (!r || !r.quarantined || r.state !== 'completed') return null;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '실행 가능하게 풀기',
    message: `"${r.name}" 파일을 실행할 수 있는 상태로 바꿀까요?`,
    detail:
      `받은 곳: ${r.url}\n\n` +
      '출처를 확실히 믿을 수 있을 때만 푸세요. 누군가 설치하라고 시킨 파일이거나, ' +
      '인증·보안 확인을 위해 받으라고 한 파일이라면 해킹일 수 있어요.\n\n' +
      `풀면 끝에 붙은 "${HOLD_EXT}" 가 빠지고 원래 이름이 돼요. Windows 보안 검사(SmartScreen)는 그대로 적용돼요.`,
    buttons: ['실행 가능하게 풀기', '그대로 두기'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return publicRecord(r);
  const dest = uniquePath(path.dirname(r.savePath), r.name); // 같은 폴더에서 이름만 원래대로
  try {
    fs.renameSync(r.savePath, dest);
  } catch {
    fs.copyFileSync(r.savePath, dest); // 다른 드라이브면 복사 후 삭제
    fs.unlinkSync(r.savePath);
  }
  markOfTheWeb(dest, r.url); // 복사로 옮긴 경우에도 표시가 남도록 다시 붙인다
  Object.assign(r, { quarantined: false, released: true, savePath: dest });
  saveIndex();
  pushDownload(r);
  return publicRecord(r);
});

ipcMain.handle('downloads:delete', async (_e, id) => {
  const r = downloads.get(id);
  if (!r) return false;
  if (r.item) {
    r.item.cancel();
    return true;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    message: `"${r.name}" 파일을 삭제할까요?`,
    detail: '삭제하면 되돌릴 수 없어요.',
    buttons: ['삭제', '취소'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return false;
  try {
    fs.unlinkSync(r.savePath);
  } catch {}
  downloads.delete(id);
  saveIndex();
  if (mainWindow) mainWindow.webContents.send('download:update', { id, removed: true });
  return true;
});

ipcMain.handle('downloads:show', (_e, id) => {
  const r = downloads.get(id);
  if (r && fs.existsSync(r.savePath)) shell.showItemInFolder(r.savePath);
});

// 격리된 파일이나 실행 파일은 여기서 열지 않는다 (폴더에서 보기만)
ipcMain.handle('downloads:open', async (_e, id) => {
  const r = downloads.get(id);
  if (!r || r.quarantined || r.state !== 'completed' || RISKY_EXT.has(extOf(r.name))) return false;
  await shell.openPath(r.savePath);
  return true;
});

ipcMain.on('window:fullscreen', () => {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ======================================================================
// 자동 업데이트 (GitHub 릴리스)
//  - 설치된 앱에서만 동작 (npm start 개발 실행에서는 꺼짐)
//  - 새 버전을 백그라운드로 받고(파일 해시 sha512 확인), 다 받으면 화면에 "재시작해서 업데이트" 알림
//  - 사용자가 재시작하지 않아도 앱을 끌 때 자동 설치
// ======================================================================
let updateState = { state: 'idle' };
function pushUpdate(state) {
  updateState = state;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update', state);
}
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => pushUpdate({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => pushUpdate({ state: 'latest', version: app.getVersion() }));
  autoUpdater.on('update-available', (info) => pushUpdate({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => pushUpdate({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => pushUpdate({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (e) => pushUpdate({ state: 'error', message: String(e?.message || e).slice(0, 200) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, 4 * 60 * 60 * 1000); // 4시간마다
  ipcMain.on('update:check', check);
  ipcMain.on('update:install', () => autoUpdater.quitAndInstall(false, true));
}
ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, update: updateState }));

ipcMain.on('jam:lock', (_e, { wcId, locked }) => {
  if (locked) lockedJamTabs.add(wcId);
  else lockedJamTabs.delete(wcId);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const ses = session.fromPartition('persist:jam');
  // iframe 안에서 클립보드에 쓰는 경우까지 잡기 위해, 클립보드 쓰기 권한 요청도 앱에 알린다
  const notifyClipboard = (wc, permission) => {
    if (permission !== 'clipboard-sanitized-write' || !wc) return;
    const host = wc.hostWebContents;
    if (host) setTimeout(() => host.send('clipboard-written', wc.id), 150);
  };
  // 화면 미러링: 앱이 방금(10초 안) 그 탭에 대해 요청한 "영상만" 캡처만 허락. 웹페이지가 스스로 요청한 화면 캡처는 거절
  const mirrorCapture = (wc, permission, details = {}, consume = false) => {
    if (permission !== 'display-capture' || !pendingCapture || !wc) return false;
    const ok = wc.id === pendingCapture.wcId && Date.now() < pendingCapture.until &&
      String(details.securityOrigin || details.requestingUrl || '').startsWith('file://') === true &&
      !(details.mediaTypes || []).includes('audio');
    if (ok && consume) pendingCapture = null;
    return ok;
  };
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    notifyClipboard(wc, permission);
    callback(ALLOWED_PERMISSIONS.has(permission) || mirrorCapture(wc, permission, details, true));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    notifyClipboard(wc, permission);
    return ALLOWED_PERMISSIONS.has(permission) || mirrorCapture(wc, permission, { securityOrigin: origin, ...details });
  });
  setupDownloads(ses);
  // 브라우저 계정 · 비밀번호 뱅크 · 친구 (모두 이 PC 안에서만, 메인 프로세스가 키를 들고 있음)
  vaultApi = setupVault({ app, ipcMain, safeStorage, clipboard, dialog, powerMonitor, getWindow: () => mainWindow });
  createWindow();
  startNearbyScanner();
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (relayTunnel) relayTunnel.close();
  if (beacon) beacon.close();
  if (scanner) scanner.close();
  if (pairing) pairing.cancel();
  if (jamServer) await jamServer.close();
  app.quit();
});
