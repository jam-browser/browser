'use strict';
const { app, BrowserWindow, ipcMain, Menu, clipboard, session, webContents, safeStorage, powerMonitor, protocol, net } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createJamServer } = require('../server/jam-server');
const { startRelayTunnel } = require('../server/relay-tunnel');
const { startBeacon, startScanner } = require('../server/nearby');
const { pairWithHost } = require('../server/pair-client');
const { isPrivateIp } = require('../server/jam-server');
const { sameSite, httpsUpgrade } = require('../shared/site');
// HTTPS 우선: 이 탭에서 https 로 바꿔 연 주소 (실패하면 원래 http 로) · https 가 안 되는 사이트
const httpsTried = new Map(); // webContentsId → { https, http, host }
const httpOnlyHosts = new Set();
const { setupVault } = require('./vault');
const { setupJamFiles, SCHEME: JAMFILE } = require('./jamfiles');
const { setupSiteGuard } = require('./siteguard');
const { setupFriendStatus } = require('./friend-status');
let siteGuard = null;
let friendStatus = null; // 친구 상태 (온라인 · 보는 사이트)

// 같이 보는 파일: jamfile://<파일ID>/ (앱 준비 전에 등록해야 함)
protocol.registerSchemesAsPrivileged([{ scheme: JAMFILE, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const DEFAULT_PORT = 3030;
let mainWindow = null;
let jamServer = null;
let relayTunnel = null; // 인터넷용 중계 서버로 가는 터널
let relayKey = null;
let vaultApi = null;
let beacon = null; // 근처 알림 (호스트일 때)
let scanner = null; // 근처 Jam 찾기
let nearbyVisible = true;
// 세부 설정 (앱 화면에서 받음, shared/prefs.js). 받기 전에는 기본값
const PREFS = require('../shared/prefs');
let prefs = PREFS.clean({});
let jamFilesApi = null;
let nearbyList = [];
let pairing = null; // 진행 중인 근처 페어링
let pendingCapture = null; // 화면 미러링: 앱이 방금 요청한 탭 캡처 { wcId, until }
const beaconId = crypto.randomBytes(12).toString('base64url');

// 웹사이트에는 일반 Chromium 브라우저로 보이게 한다 (UA 에 붙는 "Electron/x" · "jam-browser/x" 를 빼서,
// 그 이름을 보고 막거나 다르게 보여 주는 사이트 대비). 버전도 실제 Chrome 처럼 주 버전만 남긴다 (Chrome/156.0.0.0).
// 단, Google 로그인 화면은 반대로 이 모양을 막아서 원래 UA 를 씀 (아래 isGoogleSignin).
// 원래 UA (… jam-browser/x Chrome/… Electron/x …) — Google 로그인 화면에서만 씀
const ELECTRON_UA = app.userAgentFallback;
const CHROME_UA = app.userAgentFallback
  .replace(/\s+(Electron|jam-browser|Jam ?Browser)\/\S+/gi, '')
  .replace(/Chrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0');
app.userAgentFallback = CHROME_UA;

// Google 로그인 "안전하지 않은 브라우저" 대책: UA 문자열만 Chrome 처럼 바꾸면, 요청 헤더(Sec-CH-UA)와
// navigator.userAgentData 의 브랜드 목록에는 여전히 "Chromium" 만 있어서 내장 브라우저로 보인다.
// → 웹페이지 탭마다 브랜드 목록에 실제 Chrome 처럼 "Google Chrome" 을 넣는다 (헤더 · 자바스크립트 모두, 버전은 실제 엔진 버전)
let uaHints = null; // 앱 화면에서 읽은 실제 값 (OS 버전 · CPU 등)
function chromeUaMetadata() {
  const full = process.versions.chrome;
  const major = full.split('.')[0];
  const h = uaHints || {};
  const keep = (list) => (Array.isArray(list) ? list : []).filter((b) => b && b.brand && !/Google Chrome|Electron/i.test(b.brand));
  const brands = keep(h.brands);
  const fullList = keep(h.fullVersionList);
  if (!brands.length) brands.push({ brand: 'Not=A?Brand', version: '24' }, { brand: 'Chromium', version: major });
  if (!fullList.length) fullList.push(...brands.map((b) => ({ brand: b.brand, version: b.brand === 'Chromium' ? full : `${b.version}.0.0.0` })));
  const platform = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || 'Windows';
  return {
    brands: [...brands, { brand: 'Google Chrome', version: major }],
    fullVersionList: [...fullList, { brand: 'Google Chrome', version: full }],
    fullVersion: full,
    platform,
    platformVersion: h.platformVersion || (platform === 'Windows' ? '15.0.0' : ''),
    architecture: h.architecture || 'x86',
    model: '',
    mobile: false,
    bitness: h.bitness || '64',
    wow64: false,
  };
}
// Google 로그인 화면(accounts.google.*)에서는 이 브라우저의 원래 모습(Electron 그대로의 UA)을 보여 준다
//  Google 은 "Chrome 과 똑같이 생긴" UA 를 쓰는 Electron 브라우저(가짜 Chrome)를 막고("안전하지 않은 브라우저"),
//  Firefox 로 꾸며도 페이지 안의 Chromium 흔적과 어긋나서 들쭉날쭉 막는다.
//  UA 에 제품 이름(jam-browser/… · Electron/…)이 그대로 있는 원래 모습은 통과 (다른 Electron 브라우저들의 실측과 이 앱 실측).
//  로그인을 마치고 다른 주소로 가면 다시 Chrome 모양으로
const isGoogleSignin = (u) => {
  try {
    const h = new URL(u).hostname;
    return /^accounts\.google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h) || h === 'accounts.youtube.com';
  } catch {
    return false;
  }
};
const identityOf = new Map(); // webContents id → 'chrome' | 'native'
function setIdentity(contents, mode) {
  identityOf.set(contents.id, mode);
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
  } catch (e) {
    console.error('UA 설정 실패:', e.message); // 개발자 도구가 이미 붙어 있는 경우 등
    return Promise.resolve();
  }
  // native: UA 만 원래대로 (브랜드 정보는 엔진 기본값 그대로 — 꾸미지 않음)
  const params = mode === 'native' ? { userAgent: ELECTRON_UA } : { userAgent: CHROME_UA, userAgentMetadata: chromeUaMetadata() };
  return contents.debugger.sendCommand('Emulation.setUserAgentOverride', params).catch((e) => console.error('UA 설정 실패:', e.message));
}
function applyChromeIdentity(contents) {
  setIdentity(contents, 'chrome');
  applyPasskeyPolicy(contents);
  contents.once('destroyed', () => {
    identityOf.delete(contents.id);
    passkeyScripts.delete(contents.id);
  });
}

// 패스키 끄기 (설정 → 보안 · 개인정보, 기본 끔): 사이트가 패스키(WebAuthn) 창 — Windows Hello · 보안 키 — 을 띄우지 못하게.
//  페이지에는 "이 기기에서 패스키를 쓸 수 없음" 으로 보여서 Google 등이 묻지 않고 비밀번호 단계로 감.
//  모든 프레임에서 페이지 스크립트보다 먼저 실행 (탭마다 붙어 있는 디버거로 등록)
const PASSKEY_OFF = `(() => { try {
  const no = () => Promise.resolve(false);
  const C = window.PublicKeyCredential;
  if (C) {
    for (const k of ['isUserVerifyingPlatformAuthenticatorAvailable', 'isConditionalMediationAvailable']) { try { Object.defineProperty(C, k, { value: no, configurable: true, writable: true }); } catch {} }
    if (C.getClientCapabilities) { try { Object.defineProperty(C, 'getClientCapabilities', { value: () => Promise.resolve({ conditionalGet: false, conditionalCreate: false, passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: false, hybridTransport: false }), configurable: true, writable: true }); } catch {} }
  }
  const P = window.CredentialsContainer && CredentialsContainer.prototype;
  if (P) {
    const deny = () => Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
    for (const k of ['get', 'create']) {
      const orig = P[k];
      if (typeof orig !== 'function') continue;
      try { Object.defineProperty(P, k, { value: function (o) { return o && o.publicKey ? deny() : orig.apply(this, arguments); }, configurable: true, writable: true }); } catch {}
    }
  }
} catch {} })();`;
const passkeyScripts = new Map(); // webContents id → 등록한 스크립트 id (끔일 때만)
function applyPasskeyPolicy(contents) {
  if (!contents || contents.isDestroyed() || !contents.debugger.isAttached()) return;
  const id = passkeyScripts.get(contents.id);
  const dbg = contents.debugger;
  if (prefs.passkeys === 'on') {
    if (id && id !== 'pending') {
      passkeyScripts.delete(contents.id);
      dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }).catch(() => {});
    }
    return;
  }
  if (id) return;
  passkeyScripts.set(contents.id, 'pending');
  dbg.sendCommand('Page.enable')
    .catch(() => {})
    .then(() => dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PASSKEY_OFF }))
    .then((r) => {
      // 등록하는 사이에 "켬" 으로 바뀌었으면 바로 뺌
      if (prefs.passkeys === 'on') {
        passkeyScripts.delete(contents.id);
        return dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: r.identifier }).catch(() => {});
      }
      passkeyScripts.set(contents.id, r.identifier);
    })
    .catch(() => passkeyScripts.delete(contents.id));
}
// 엔진 기본 브랜드 (Google Chrome 을 넣지 않은 것) → Sec-CH-UA 헤더 값
function nativeBrandsHeader() {
  const major = process.versions.chrome.split('.')[0];
  const list = ((uaHints && uaHints.brands) || [{ brand: 'Not=A?Brand', version: '24' }, { brand: 'Chromium', version: major }]).filter((b) => !/Google Chrome/i.test(b.brand));
  return list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}
// 요청 헤더: 로그인 화면을 연 탭의 요청은 원래 UA + 꾸미지 않은 브랜드. 막 나온 첫 요청은 Chrome 모양으로 되돌림
//  (탭 UA 바꾸기는 페이지 이동과 같이 진행되므로, 바뀌기 전에 나가는 요청을 여기서 맞춤)
function signinHeaders(d, h) {
  if (!Number.isInteger(d.webContentsId)) return false;
  const mode = identityOf.get(d.webContentsId);
  const uaKey = Object.keys(h).find((k) => k.toLowerCase() === 'user-agent');
  const chKey = Object.keys(h).find((k) => k.toLowerCase() === 'sec-ch-ua');
  if (mode === 'native') {
    if (uaKey) h[uaKey] = ELECTRON_UA;
    if (chKey) h[chKey] = nativeBrandsHeader();
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'sec-ch-ua-full-version-list') delete h[k];
    return true;
  }
  if (mode === 'chrome' && uaKey && h[uaKey] !== CHROME_UA && /Electron\//.test(h[uaKey])) {
    h[uaKey] = CHROME_UA;
    if (d.url.startsWith('https:')) {
      const m = chromeUaMetadata();
      h['sec-ch-ua'] = m.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
      h['sec-ch-ua-mobile'] = '?0';
      h['sec-ch-ua-platform'] = `"${m.platform}"`;
    }
    return true;
  }
  return false;
}

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

// 자동 테스트(화면 밖 창)에서는 메인 프로세스 오류를 오류 창 대신 로그로 → 테스트 실행기가 로그에서 찾아 실패로 처리
// (오류 창이 떠 있으면 사람 화면을 가리고, 테스트는 알 수 없음)
if (process.env.JAM_TEST_OFFSCREEN === '1') {
  process.on('uncaughtException', (err) => console.error(`[JAM-MAIN-ERROR] ${err && err.stack ? err.stack : err}`));
  process.on('unhandledRejection', (err) => console.error(`[JAM-MAIN-ERROR] (promise) ${err && err.stack ? err.stack : err}`));
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
  // Jam 테스트 환경(npm run jam)에서는 창 제목에 [host] · [guest] 를 붙여 구분한다
  const devInstance = !app.isPackaged && process.env.JAM_DEV_INSTANCE;
  if (devInstance) {
    mainWindow.setTitle(`Jam Browser [${devInstance}]`);
    mainWindow.on('page-title-updated', (e) => e.preventDefault());
  }
  // 웹페이지 탭(webview)이 붙을 때마다 확장 프로그램(chrome.tabs 등)이 알 수 있게 등록
  const win = mainWindow;
  win.webContents.on('did-attach-webview', (_e, wc) => extensions?.addTab(wc, win));
  if (offscreen) {
    mainWindow.showInactive();
    // 자동 테스트: 앱 화면의 오류도 로그로 남겨 테스트가 알아채게
    mainWindow.webContents.on('console-message', (e) => {
      const level = e.level ?? e.params?.level;
      if (level === 'error' || level === 3) console.error(`[JAM-RENDERER-ERROR] ${e.message ?? e.params?.message}`);
    });
  }
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 웹페이지 탭에 넣을 브랜드 정보의 실제 값(OS 버전 · CPU)을 이 엔진에서 읽어 둠
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents
      .executeJavaScript(`navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList']).then((v) => ({ ...v, brands: navigator.userAgentData.brands })) : null`)
      .then((v) => {
        if (v) uaHints = v;
      })
      .catch(() => {});
  });
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
  // 웹페이지용 webview에 보안 설정 + Jam 스크립트(커서/스크롤 동기화)를 주입
  contents.on('will-attach-webview', (_ev, webPreferences) => {
    delete webPreferences.preloadURL;
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  if (contents.getType() === 'webview') {
    applyChromeIdentity(contents);
    // HTTPS 우선: https 로 바꿔 연 주소가 실패하면 그 사이트는 http 로 (이 앱을 켜 둔 동안 기억)
    const httpsFallback = (_e, code, _desc, url, isMainFrame) => {
      if (isMainFrame === false || code === -3) return; // -3 = 사용자가 멈춤 · 다른 이동
      const t = httpsTried.get(contents.id);
      if (!t || !url || !url.startsWith('https://') || new URL(url).hostname !== t.host) return;
      httpsTried.delete(contents.id);
      httpOnlyHosts.add(t.host);
      console.log(`[https-first] ${t.host} 는 https 가 안 돼서 http 로 열어요 (${code})`);
      contents.loadURL(t.http).catch(() => {});
    };
    contents.on('did-fail-provisional-load', httpsFallback);
    contents.on('did-fail-load', httpsFallback);
    contents.on('did-navigate', (_e, url) => {
      const t = httpsTried.get(contents.id);
      if (t && !String(url).startsWith(`https://${t.host}`)) httpsTried.delete(contents.id);
    });
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
      if (!current || !/^(https?|jamfile):/i.test(current) || sameSite(target, current)) return;
      event.preventDefault();
      contents.hostWebContents?.send('nav-blocked', target);
    });
    const id = contents.id;
    contents.once('destroyed', () => lockedJamTabs.delete(id));

    // 소리 나는 탭 표시용: 소리가 나기 시작/멈추면 앱 UI 에 알린다 (음소거는 탭마다 앱 UI 에서)
    contents.on('audio-state-changed', (e) => {
      contents.hostWebContents?.send('tab-audio', { wcId: id, audible: !!e.audible });
    });
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
      limits: PREFS.serverLimits(prefs),
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
    relayTunnel.setPresence(null); // 다른 기기에서 이어 보기 목록에서 지움
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

// ---------- 다른 기기에서 이어 보기 (같은 브라우저 계정) ----------
// 호스트: 중계 서버에 무작위 ID + 암호문(초대 링크)을 맡김. 계정 키는 메인 프로세스 밖으로 나가지 않음
const PRESENCE = require('../shared/presence');
ipcMain.handle('resume:publish', (e, { link, title } = {}) => {
  if (!fromApp(e) || !relayTunnel) return { ok: false, reason: relayTunnel ? 'forbidden' : 'no-relay' };
  if (!link) {
    relayTunnel.setPresence(null);
    return { ok: true };
  }
  const p = vaultApi && vaultApi.presence();
  if (!p || !prefs.resumePublish) return { ok: false, reason: p ? 'off' : 'locked' };
  if (typeof link !== 'string' || !/^jamrs?:\/\/[^\s]{8,400}$/.test(link)) return { ok: false, reason: 'bad-link' };
  const blob = PRESENCE.seal(p.key, { v: 1, link, title: String(title || '').slice(0, 120), device: os.hostname().slice(0, 40), at: Date.now() });
  p.key.fill(0);
  relayTunnel.setPresence({ id: p.id, blob });
  return { ok: true };
});
// 다른 기기: 중계 서버마다 내 ID 로 찾아보고, 이 PC 에서 풀어 봄
function getJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ status: 0 });
    }
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(u, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
        if (body.length > 8192) req.destroy();
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0 }));
  });
}
ipcMain.handle('resume:find', async (e, { relayUrls } = {}) => {
  if (!fromApp(e)) return { found: [] };
  const p = vaultApi && vaultApi.presence();
  if (!p) return { found: [], reason: 'locked' };
  const urls = (Array.isArray(relayUrls) ? relayUrls : []).filter((u) => typeof u === 'string').slice(0, 8);
  const found = [];
  const unsupported = [];
  await Promise.all(urls.map(async (relay) => {
    const url = PRESENCE.lookupUrl(relay, p.id);
    if (!url) return;
    const r = await getJson(url);
    if (r.status === 200 && r.json && typeof r.json.blob === 'string') {
      const o = PRESENCE.open(p.key, r.json.blob);
      if (o && typeof o.link === 'string' && /^jamrs?:\/\//.test(o.link)) found.push({ relay, link: o.link, title: o.title || '', device: o.device || '', at: Number(o.at) || 0 });
    } else if (r.status === 200 && !r.json) unsupported.push(relay); // 예전 중계 서버 (1.0.4 이하)
  }));
  p.key.fill(0);
  return { found, unsupported };
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
  const wc = Number.isInteger(Number(wcId)) ? webContents.fromId(Number(wcId)) : null;
  if (!wc || wc.getType() !== 'webview' || wc.hostWebContents !== mainWindow.webContents) throw new Error('탭을 찾을 수 없어요');
  pendingCapture = { wcId: wc.id, until: Date.now() + 10000 }; // 이 탭에 대한 캡처 요청 한 번만 허락 (권한 처리기에서 확인)
  mirrorWcId = wc.id; // 원격 조작은 이 탭에만 들어간다
  return wc.getMediaSourceId(mainWindow.webContents);
});
ipcMain.handle('mirror:end', (e) => {
  if (!fromApp(e)) return;
  mirrorWcId = null;
});

// ---------- 화면 미러링: 참여자의 조작 넣기 ----------
// 운영체제 입력(SendInput)이 아니라 Chromium 안의 입력 이벤트로 미러링 중인 그 탭에만 들어간다.
// → 다른 프로그램(키로거 등) · 앱 화면 · 다른 탭은 이 입력을 받지도 보지도 못한다.
// 누르기 · 떼기 · 키는 넣기 전에 그 탭 안 스크립트에 "지금 그 자리에 뭐가 있나"를 물어보고,
// 로그인 · 결제 · 계정 · 개인정보 쪽 버튼이나 비밀 입력 칸이면 넣지 않는다 (shared/mirror.js 의 remoteVerdict).
const MIRROR = require('../shared/mirror');
let mirrorWcId = null;
const remoteMarks = new Map(); // wcId → Map(출처 → 마지막 원격 입력 시각)
const probes = new Map();
let probeSeq = 0;
const originOfUrl = (u) => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.origin : x.protocol;
  } catch {
    return '';
  }
};
function markRemote(wc) {
  let m = remoteMarks.get(wc.id);
  if (!m) remoteMarks.set(wc.id, (m = new Map()));
  m.set(originOfUrl(wc.getURL()), Date.now());
}
/** 이 탭 · 이 사이트에 최근 ms 안에 다른 컴퓨터의 입력이 들어왔나 (비밀번호 저장 제안 · 자동 입력을 막는 데 씀) */
function remoteTouched(wcId, url, ms) {
  if (ms === undefined) ms = prefs.noPwSaveAfterRemoteMin * 60e3; // 설정: 원격 조작 뒤 비밀번호 저장 안 묻는 시간 (0 = 끔)
  if (!ms) return false;
  const m = remoteMarks.get(wcId);
  const at = m && m.get(originOfUrl(url));
  return !!at && Date.now() - at < ms;
}
ipcMain.on('mirror:probe-result', (e, r) => {
  const pr = probes.get(r && r.id);
  if (!pr || e.sender.id !== pr.wcId) return;
  probes.delete(r.id);
  clearTimeout(pr.timer);
  pr.resolve(r.d || null);
});
function probeTab(wc, q) {
  return new Promise((resolve) => {
    const id = ++probeSeq;
    const timer = setTimeout(() => {
      probes.delete(id);
      resolve(null); // 답이 없으면 막는 쪽으로
    }, 400);
    probes.set(id, { wcId: wc.id, resolve, timer });
    wc.send('mirror:probe', { id, ...q });
  });
}
const INPUT_TYPES = new Set(['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel', 'keyDown', 'keyUp', 'char']);
function cleanInput(ev) {
  if (!ev || typeof ev !== 'object' || !INPUT_TYPES.has(ev.type)) return null;
  const out = { type: ev.type };
  if (ev.type.startsWith('mouse')) {
    const x = Math.round(Number(ev.x));
    const y = Math.round(Number(ev.y));
    if (!(x >= 0 && x <= 16384 && y >= 0 && y <= 16384)) return null;
    Object.assign(out, { x, y });
    if (ev.type === 'mouseDown' || ev.type === 'mouseUp') {
      out.button = ev.button === 'middle' ? 'middle' : 'left';
      out.clickCount = Math.min(3, Math.max(1, Math.round(Number(ev.clickCount) || 1)));
    }
    if (ev.type === 'mouseWheel') {
      out.deltaX = Math.max(-2000, Math.min(2000, Math.round(Number(ev.deltaX) || 0)));
      out.deltaY = Math.max(-2000, Math.min(2000, Math.round(Number(ev.deltaY) || 0)));
      out.canScroll = true;
    }
  } else {
    const k = String(ev.keyCode || '');
    if (ev.type === 'char' ? [...k].length !== 1 : !MIRROR.ELECTRON_KEYS.has(k)) return null;
    out.keyCode = k;
    out.modifiers = Array.isArray(ev.modifiers) && ev.modifiers.includes('shift') ? ['shift'] : [];
  }
  return out;
}
ipcMain.handle('mirror:input', async (e, ev, code) => {
  if (!fromApp(e) || !mirrorWcId) return { ok: false, reason: 'off' };
  const { webContents } = require('electron');
  const wc = webContents.fromId(mirrorWcId);
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== mainWindow.webContents) return { ok: false, reason: 'off' };
  const out = cleanInput(ev);
  if (!out) return { ok: false, reason: 'bad' };
  if (out.type !== 'mouseMove' && out.type !== 'mouseWheel') {
    const d = await probeTab(wc, { kind: out.type, x: out.x, y: out.y });
    const v = MIRROR.remoteVerdict(d, out.type, typeof code === 'string' ? code : '');
    // 설정으로 끈 보호는 통과 (🔑 비밀번호 뱅크 · 확인 못 한 곳은 항상 막음)
    if (!v.ok && !prefs.remoteBlockSensitive && ['button', 'login', 'frame'].includes(v.reason)) v.ok = true;
    if (!v.ok && !prefs.remoteBlockSecret && v.reason === 'secret') v.ok = true;
    if (!v.ok) {
      if (!wc.isDestroyed()) wc.send('mirror:disarm');
      return v;
    }
  }
  if (wc.isDestroyed()) return { ok: false, reason: 'off' };
  markRemote(wc);
  wc.sendInputEvent(out);
  return { ok: true };
});

// ---------- 근처 찾기 (UDP 3032, 같은 네트워크) ----------
function updateBeacon() {
  // 호스트 서버가 켜져 있는 동안 (방이 생기면 그때부터 알림에 실림)
  const hosting = !!jamServer;
  if (!hosting || !nearbyVisible || !prefs.nearbyAnnounce) {
    if (beacon) beacon.close();
    beacon = null;
    return;
  }
  if (beacon) return;
  beacon = startBeacon({
    id: beaconId,
    port: jamServer.port,
    appVersion: app.getVersion(),
    intervalMs: prefs.nearbyIntervalSec * 1000,
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
  if (scanner || !prefs.nearbyScan) return;
  scanner = startScanner({
    log: (m) => console.log(`[nearby] ${m}`),
    onChange: (list) => {
      nearbyList = list.filter((x) => x.id !== beaconId); // 내가 연 Jam 은 빼고
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nearby', nearbyList);
    },
  });
}
ipcMain.handle('nearby:list', (e) => (fromApp(e) ? nearbyList : []));

// ---------- 세부 설정: 앱 화면이 시작할 때 · 바꿀 때마다 보냄 → 바로 적용 ----------
function applyPrefs(prev) {
  if (jamServer) jamServer.setLimits(PREFS.serverLimits(prefs));
  if (!prev || prev.passkeys !== prefs.passkeys) {
    for (const wc of webContents.getAllWebContents()) if (wc.getType() === 'webview') applyPasskeyPolicy(wc);
  }
  if (updater) {
    updater.autoDownload = prefs.updateAuto;
    if (verifiedVersion) updater.autoInstallOnAppQuit = prefs.updateInstall !== 'manual';
    if (!prev || prev.updateCheckHours !== prefs.updateCheckHours || prev.updateAuto !== prefs.updateAuto) scheduleUpdateChecks();
  }
  if (jamFilesApi) jamFilesApi.setLimits(prefs);
  if (siteGuard) siteGuard.applyPrefs();
  if (friendStatus && prev && (prev.friendStatus !== prefs.friendStatus || prev.friendShowJam !== prefs.friendShowJam)) friendStatus.changed();
  // 근처 알림: 끄거나 간격이 바뀌면 다시 시작
  if (beacon && (!prefs.nearbyAnnounce || (prev && prev.nearbyIntervalSec !== prefs.nearbyIntervalSec))) {
    beacon.close();
    beacon = null;
  }
  updateBeacon();
  if (!prefs.nearbyScan && scanner) {
    scanner.close();
    scanner = null;
    nearbyList = [];
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nearby', nearbyList);
  } else startNearbyScanner();
}
ipcMain.handle('prefs:set', (e, v) => {
  if (!fromApp(e)) return null;
  const prev = prefs;
  prefs = PREFS.clean(v);
  applyPrefs(prev);
  return prefs;
});
ipcMain.handle('prefs:server-limits', (e) => (fromApp(e) && jamServer ? jamServer.limits() : null)); // 테스트 · 확인용
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
// 자동 업데이트 (설정 → 업데이트)
//  - 새 버전을 받으면 릴리스의 서명 파일(.sig)을 받아 앱 안의 공개키(update-key.pub.pem)로 확인한 뒤에만 설치해요
//    (확인 전에는 "끌 때 설치" 도 꺼 둠 → 서명이 안 맞으면 받은 파일을 지우고 설치하지 않음)
//  - 설치 시점: 앱을 끌 때(기본) · 쓰지 않을 때 자동으로 다시 켜서(Jam 중이 아닐 때) · 내가 누를 때만
let updater = null;
let updateTimer = null;
let verifiedVersion = null;
let appBusy = false; // 앱 화면이 알려 줌: Jam 중이면 자동 재시작 안 함
const { verifyFile } = require('../shared/update-sign');
function scheduleUpdateChecks() {
  clearInterval(updateTimer);
  if (updater && prefs.updateAuto) updateTimer = setInterval(() => updater.checkForUpdates().catch(() => {}), prefs.updateCheckHours * 3600e3);
}
function setupAutoUpdate() {
  // 테스트 전용: 화면 밖 테스트 모드에서만 다른 업데이트 주소를 쓸 수 있음
  const testFeed = process.env.JAM_TEST_OFFSCREEN === '1' ? process.env.JAM_UPDATE_FEED : '';
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  updater = autoUpdater;
  if (testFeed) autoUpdater.setFeedURL({ provider: 'generic', url: testFeed });
  autoUpdater.autoDownload = prefs.updateAuto;
  autoUpdater.autoInstallOnAppQuit = false; // 서명을 확인한 뒤에 켬
  autoUpdater.on('checking-for-update', () => pushUpdate({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => pushUpdate({ state: 'latest', version: app.getVersion() }));
  autoUpdater.on('update-available', (info) => pushUpdate({ state: autoUpdater.autoDownload ? 'downloading' : 'available', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => pushUpdate({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', async (info) => {
    verifiedVersion = null;
    autoUpdater.autoInstallOnAppQuit = false;
    pushUpdate({ state: 'verifying', version: info.version });
    const file = info.downloadedFile;
    const name = path.basename(String((info.files && info.files[0] && info.files[0].url) || file));
    const sigUrl = testFeed ? `${testFeed.replace(/\/+$/, '')}/${name}.sig` : `https://github.com/jam-browser/browser/releases/download/v${info.version}/${name}.sig`;
    try {
      const res = await net.fetch(sigUrl);
      if (!res.ok) throw new Error(`서명 파일을 받지 못했어요 (${res.status})`);
      const pub = fs.readFileSync(path.join(__dirname, 'update-key.pub.pem'), 'utf8');
      const v = await verifyFile(pub, info.version, file, await res.text());
      if (!v.ok) throw new Error(v.reason);
      verifiedVersion = info.version;
      autoUpdater.autoInstallOnAppQuit = prefs.updateInstall !== 'manual';
      console.log(`[update] ${info.version} 서명 확인됨`);
      pushUpdate({ state: 'ready', version: info.version, verified: true, install: prefs.updateInstall });
    } catch (e) {
      console.log(`[update] ${info.version} 서명 확인 실패: ${e.message}`);
      try {
        fs.unlinkSync(file);
      } catch {}
      pushUpdate({ state: 'error', version: info.version, verifyFailed: true, message: `업데이트 서명 확인 실패: ${e.message} — 설치하지 않았어요` });
    }
  });
  autoUpdater.on('error', (e) => pushUpdate({ state: 'error', message: String(e?.message || e).slice(0, 200) }));
  const check = (manual) => {
    if (manual === true) autoUpdater.autoDownload = true; // 직접 누른 확인은 받기까지
    autoUpdater.checkForUpdates().catch(() => {});
  };
  if (prefs.updateAuto) setTimeout(check, 5000);
  scheduleUpdateChecks();
  ipcMain.on('update:check', (e) => fromApp(e) && check(true));
  ipcMain.on('update:install', (e) => {
    if (fromApp(e) && verifiedVersion) autoUpdater.quitAndInstall(false, true);
  });
  // 쓰지 않을 때 자동으로 다시 켜서 설치 (설정: 쓰지 않을 때) — Jam 중이면 기다림
  setInterval(() => {
    if (!verifiedVersion || prefs.updateInstall !== 'idle' || appBusy) return;
    if (powerMonitor.getSystemIdleTime() < prefs.updateIdleMin * 60) return;
    console.log(`[update] ${prefs.updateIdleMin}분 동안 쓰지 않아서 ${verifiedVersion} 로 다시 켜요`);
    autoUpdater.quitAndInstall(true, true);
  }, 60e3).unref();
}
ipcMain.on('app:busy', (e, b) => {
  if (fromApp(e)) appBusy = !!b;
});
ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, update: updateState }));

// ======================================================================
// Chrome 확장 프로그램 (Chrome 웹 스토어에서 설치)
// ======================================================================
let extensions = null;
let quitting = false;
let extTabReq = 0;
const pendingExtTabs = new Map(); // 요청 번호 → resolve

// 확장 프로그램이 chrome.tabs.create 로 탭을 열 때: 앱 UI 에 새 탭을 만들게 하고 webContents 를 받는다
function createTabForExtension(details) {
  if (!mainWindow) return Promise.reject(new Error('창이 없어요'));
  const reqId = ++extTabReq;
  const win = mainWindow;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingExtTabs.delete(reqId);
      reject(new Error('탭을 만들지 못했어요'));
    }, 10000);
    pendingExtTabs.set(reqId, (wcId) => {
      clearTimeout(timer);
      const wc = Number.isInteger(wcId) ? webContents.fromId(wcId) : null;
      if (wc) resolve([wc, win]);
      else reject(new Error('탭을 찾지 못했어요'));
    });
    win.webContents.send('ext:create-tab', { reqId, url: details.url, active: details.active !== false });
  });
}
ipcMain.on('ext:tab-created', (_e, { reqId, wcId }) => {
  const done = pendingExtTabs.get(reqId);
  pendingExtTabs.delete(reqId);
  if (done) done(wcId);
});
// 앱이 "지금 탭" 을 알려 줄 때는, 확장 프로그램 시스템이 그걸 다시 "이 탭을 골라" 로 되돌려 보내지 않게 막는다.
// (되돌아온 알림이 늦게 도착하면 그 사이 바꾼 탭에서 이전 탭으로 끌려가고, 그게 또 되돌아와서 탭이 끝없이 왔다갔다 했음)
let appActivatingTab = false;
ipcMain.on('ext:tab-activated', (e, wcId) => {
  // 아직 webview 가 안 붙은 탭이면 id 가 null → fromId 가 예외를 던져 오류 창이 뜨던 문제
  if (!fromApp(e) || !Number.isInteger(wcId)) return;
  const wc = webContents.fromId(wcId);
  if (!wc || !extensions) return;
  appActivatingTab = true;
  try {
    extensions.selectTab(wc);
  } finally {
    appActivatingTab = false;
  }
});

// 웹 스토어에서 "Chrome에 추가"를 누르면 한 번 더 묻는다
async function confirmExtensionInstall({ localizedName, manifest, browserWindow }) {
  const perms = [...(manifest.permissions || []), ...(manifest.host_permissions || [])]
    .filter((p) => typeof p === 'string');
  const allSites = perms.some((p) => p === '<all_urls>' || /^\*:\/\/\*\//.test(p) || /^https?:\/\/\*\//.test(p));
  const lines = [
    '확장 프로그램은 설치한 내 PC의 탭에서만 동작해요. 다른 Jam 참여자에게는 설치되지 않아요.',
  ];
  if (allSites) lines.push('⚠️ 이 확장 프로그램은 모든 웹사이트의 내용을 읽고 바꿀 수 있어요 (Jam 탭 포함).');
  if (perms.length) lines.push('', '요청하는 권한: ' + perms.slice(0, 12).join(', ') + (perms.length > 12 ? ' …' : ''));
  const { response } = await dialog.showMessageBox(browserWindow || mainWindow, {
    type: 'question',
    buttons: ['추가', '취소'],
    defaultId: 1,
    cancelId: 1,
    title: '확장 프로그램 추가',
    message: `"${localizedName}" 을(를) 추가할까요?`,
    detail: lines.join('\n'),
    noLink: true,
  });
  return { action: response === 0 ? 'allow' : 'deny' };
}

function setupExtensions(ses) {
  extensions = new ElectronChromeExtensions({
    session: ses,
    createTab: createTabForExtension,
    // 확장 프로그램이 직접 탭을 고를 때만 앱에 알림 (앱이 알려 준 것의 메아리는 보내지 않음)
    selectTab: (wc) => !appActivatingTab && mainWindow?.webContents.send('ext:select-tab', wc.id),
    removeTab: (wc) => mainWindow?.webContents.send('ext:close-tab', wc.id),
  });
  // 앱 UI 창(기본 세션)에 확장 아이콘 줄을 보여 준다
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);
  session.defaultSession.registerPreloadScript({
    id: 'jam-toolbar',
    type: 'frame',
    filePath: path.join(__dirname, 'generated', 'toolbar-preload.js'),
  });
  installChromeWebStore({ session: ses, beforeInstall: confirmExtensionInstall }).catch((e) =>
    console.error('Chrome 웹 스토어 준비 실패:', e)
  );
  // 아이콘 우클릭 → "Remove extension" 은 지금 세션에서만 내리므로, 파일도 지워서 다시 켜도 안 돌아오게 한다
  // (자동 업데이트도 내렸다가 바로 다시 올리므로, 몇 초 뒤에도 없을 때만 지운다)
  ses.extensions.on('extension-unloaded', (_e, ext) => {
    if (quitting) return;
    setTimeout(() => {
      if (quitting || ses.extensions.getExtension(ext.id)) return;
      uninstallExtension(ext.id, { session: ses }).catch(() => {});
    }, 5000);
  });
}
app.on('before-quit', () => {
  quitting = true;
  if (friendStatus) friendStatus.goodbye(); // 친구에게 바로 오프라인으로
});

ipcMain.on('jam:lock', (_e, { wcId, locked }) => {
  if (locked) lockedJamTabs.add(wcId);
  else lockedJamTabs.delete(wcId);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const ses = session.fromPartition('persist:jam');
  ses.setUserAgent(CHROME_UA);
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
  // 사이트 보호: 추적기 · 광고 차단, 서드파티 쿠키, 사이트 권한(위치 · 알림 · 카메라 · 마이크 …)
  siteGuard = setupSiteGuard({ app, ipcMain, net, webContents, getWindow: () => mainWindow, getPrefs: () => prefs, testMode: process.env.JAM_TEST_OFFSCREEN === '1' });
  siteGuard.attach(ses, { headerHook: signinHeaders });
  siteGuard.applyPrefs();
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    notifyClipboard(wc, permission);
    if (ALLOWED_PERMISSIONS.has(permission) || mirrorCapture(wc, permission, details, true)) return callback(true);
    siteGuard.requestPermission(wc, permission, details || {}, callback); // 사이트마다 묻고 기억 (그 밖의 권한은 거절)
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    notifyClipboard(wc, permission);
    return ALLOWED_PERMISSIONS.has(permission) || mirrorCapture(wc, permission, { securityOrigin: origin, ...details }) ||
      siteGuard.checkPermission(wc, permission, origin, details || {});
  });
  setupDownloads(ses);
  setupExtensions(ses);
  // 브라우저 계정 · 비밀번호 뱅크 · 친구 (모두 이 PC 안에서만, 메인 프로세스가 키를 들고 있음)
  // 같이 보는 파일 (메모리에만, jamfile:// 로 보여 줌)
  jamFilesApi = setupJamFiles({ ipcMain, dialog, getWindow: () => mainWindow, getSession: () => ses, appDir: path.join(__dirname, '..') });
  jamFilesApi.attach(ses);
  jamFilesApi.setLimits(prefs);
  // 요청 검사는 하나로 (세션마다 리스너가 하나뿐): jamfile:// 를 웹페이지가 불러오는 것 막기 + HTTPS 우선 + 추적기 · 광고 차단
  ses.webRequest.onBeforeRequest({ urls: ['jamfile://*/*', 'http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
    // Google 로그인 화면으로 가거나 나오는 페이지 이동: 그 탭의 UA 를 먼저 바꾼 뒤 이어서 처리
    if (d.resourceType === 'mainFrame' && Number.isInteger(d.webContentsId)) {
      const wc = webContents.fromId(d.webContentsId);
      if (wc && !wc.isDestroyed() && wc.getType() === 'webview') {
        const want = isGoogleSignin(d.url) ? 'native' : 'chrome';
        // 요청을 붙잡고 기다리면 안 됨 (UA 바꾸기가 이 페이지 이동이 끝나기를 기다려서 서로 멈춤) → 같이 진행.
        // 이 요청의 헤더는 signinHeaders 가 맞춰 줌
        if (identityOf.get(wc.id) !== want) setIdentity(wc, want);
      }
    }
    handleRequest(d, cb);
  });
  function handleRequest(d, cb) {
    if (d.url.startsWith('jamfile:')) return cb({ cancel: jamFilesApi.blockedRequest(d) });
    let blocked = null;
    try {
      blocked = siteGuard.onRequest(d);
    } catch (e) {
      console.error('차단 검사 오류:', e.message);
    }
    if (blocked) return cb(blocked);
    if (prefs.httpsFirst && d.resourceType === 'mainFrame' && d.method === 'GET' && d.url.startsWith('http:')) {
      const up = httpsUpgrade(d.url);
      let host = '';
      try {
        host = new URL(d.url).hostname;
      } catch {}
      const wc = d.webContentsId ? webContents.fromId(d.webContentsId) : null;
      if (up && host && !httpOnlyHosts.has(host) && wc && wc.getType() === 'webview') {
        httpsTried.set(wc.id, { https: up, http: d.url, host });
        return cb({ redirectURL: up });
      }
    }
    cb({});
  }
  vaultApi = setupVault({ app, ipcMain, safeStorage, clipboard, dialog, powerMonitor, getWindow: () => mainWindow, remoteTouched, getPrefs: () => prefs, fetch: (u, o) => net.fetch(u, o), onFriendsChanged: () => friendStatus && friendStatus.changed() });
  friendStatus = setupFriendStatus({
    ipcMain,
    vaultApi,
    getPrefs: () => prefs,
    powerMonitor,
    fromApp,
    send: (ch, data) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send(ch, data),
    fetch: (u, o) => net.fetch(u, o),
  });
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
