'use strict';
/* global jamApp, JamSite */

// 홈·검색·새 탭 주소는 설정(customize.js 의 ui)에서 가져온다
const DEFAULT_PORT = 3030;
const { sameSite, isSensitiveUrl } = JamSite;

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================================================================
// 유틸
// ======================================================================
function isWebUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}
const isShareable = (u) => isWebUrl(u) && !isSensitiveUrl(u);

function toUrl(input) {
  const t = input.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return 'https://' + t;
  return ui.searchUrl(t);
}

// 해시(#)만 다른 주소는 같은 문서로 본다
function sameDoc(a, b) {
  if (!a || !b) return false;
  return a.split('#')[0].replace(/\/$/, '') === b.split('#')[0].replace(/\/$/, '');
}

function prettyUrl(u) {
  try {
    const p = new URL(u);
    return p.hostname.replace(/^www\./, '') + (p.pathname === '/' ? '' : p.pathname);
  } catch {
    return u;
  }
}

// 사이트 아이콘: 외부 아이콘 서비스로 방문 사이트를 보내지 않도록, 내가 직접 방문한 페이지가 알려준
// 아이콘 주소만 내 PC에 기억해 두고 쓴다. 모르는 사이트는 첫 글자 아이콘을 그린다 (네트워크 요청 없음)
const faviconCache = (() => {
  try {
    return JSON.parse(localStorage.getItem('jam-favicons')) || {};
  } catch {
    return {};
  }
})();
let faviconSaveTimer = null;
function rememberFavicon(pageUrl, iconUrl) {
  let host;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return;
  }
  if (!iconUrl || !/^(https?:|data:image\/)/i.test(iconUrl) || iconUrl.length > 2000) return;
  if (faviconCache[host] === iconUrl) return;
  faviconCache[host] = iconUrl;
  const keys = Object.keys(faviconCache);
  if (keys.length > 800) delete faviconCache[keys[0]];
  clearTimeout(faviconSaveTimer);
  faviconSaveTimer = setTimeout(() => {
    try { localStorage.setItem('jam-favicons', JSON.stringify(faviconCache)); } catch {}
  }, 1000);
}
function letterIcon(host) {
  const letter = (host.replace(/^www\./, '')[0] || '?').toUpperCase();
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="hsl(${h},55%,45%)"/><text x="16" y="22" font-family="Segoe UI,sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${letter.replace(/[<&>]/g, '')}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function faviconFor(u) {
  try {
    const host = new URL(u).hostname;
    return faviconCache[host] || letterIcon(host);
  } catch {
    return letterIcon('?');
  }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(text, actions = []) {
  const t = el(
    'div',
    { class: 'toast' },
    el('span', {}, text),
    actions.map((a) =>
      el('button', {
        class: 'toast-btn',
        onclick: () => {
          a.fn();
          t.remove();
        },
      }, a.label)
    )
  );
  $('#toasts').append(t);
  setTimeout(() => t.remove(), actions.length ? 6000 : 3200);
}

const toastedOnce = new Set();
function toastOnce(key, text) {
  if (toastedOnce.has(key)) return;
  toastedOnce.add(key);
  toast(text);
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      last = Date.now();
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...lastArgs);
      }, wait);
    }
  };
}

// ======================================================================
// 탭 관리
// ======================================================================
const tabs = [];
let activeTab = null;
let tabSeq = 0;

function createTab(url = ui.newTabUrl(), { activate = true } = {}) {
  const webview = document.createElement('webview');
  webview.setAttribute('partition', 'persist:jam');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('src', url);
  webview.classList.add('inactive');

  const tab = { id: ++tabSeq, webview, url, title: '새 탭', favicon: null, loading: true, ready: false };
  wireWebview(tab);
  tabs.push(tab);
  $('#views').append(webview);
  if (activate) activateTab(tab);
  else renderTabs();
  return tab;
}

function wireWebview(tab) {
  const wv = tab.webview;
  wv.addEventListener('dom-ready', () => {
    tab.ready = true;
    updateToolbar();
    ui.onDomReady(tab);
    if (tab === jam.tab) onJamTabReady();
  });
  wv.addEventListener('did-start-loading', () => {
    tab.loading = true;
    renderTabs();
  });
  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false;
    renderTabs();
    updateToolbar();
  });
  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title;
    renderTabs();
    ui.onTitle(tab);
    if (tab === jam.tab) onJamTabTitle(tab);
  });
  wv.addEventListener('page-favicon-updated', (e) => {
    tab.favicon = e.favicons && e.favicons[0];
    if (isWebUrl(tab.url) && !isSensitiveUrl(tab.url)) rememberFavicon(tab.url, tab.favicon);
    renderTabs();
  });
  const onNav = (url, inPage) => {
    tab.url = url;
    if (!inPage) onSafetyNavigated(tab);
    ui.onNavigated(tab, url, inPage);
    if (tab === activeTab) updateToolbar();
    if (tab === jam.tab) onJamTabNavigated(tab, url);
  };
  wv.addEventListener('did-navigate', (e) => onNav(e.url, false));
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame) onNav(e.url, true);
  });
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel.startsWith('jam:clipboard')) onSafetyPageEvent(tab, e.channel, e.args[0]); // 모든 탭
    else if (tab === jam.tab) onJamPageEvent(tab, e.channel, e.args[0]);
  });
  wv.addEventListener('did-stop-loading', () => {
    if (tab === jam.tab) checkLoginFinished();
  });
  wv.addEventListener('did-change-theme-color', (e) => ui.onThemeColor(tab, e.themeColor));
  wv.addEventListener('found-in-page', (e) => ui.onFound(tab, e.result));
  // 웹페이지 전체 화면(동영상 등): 브라우저 UI 를 숨긴다
  wv.addEventListener('enter-html-full-screen', () => document.body.classList.add('fullscreen'));
  wv.addEventListener('leave-html-full-screen', () => document.body.classList.remove('fullscreen'));
}

// Jam 동기화로 Jam 탭을 이동 (내가 누른 이동이 아니라는 표시를 남겨, 다운로드 링크면 막는다)
function followNavigate(url) {
  if (!jam.tab) return;
  jam.lastSyncedUrl = url;
  if (jam.tab.ready) jamApp.markRemoteNav(jam.tab.webview.getWebContentsId());
  navigateTab(jam.tab, url);
}

function navigateTab(tab, url) {
  tab.url = url;
  if (tab.ready) tab.webview.loadURL(url).catch(() => {});
  else tab.webview.setAttribute('src', url);
  if (tab === activeTab) updateToolbar();
}

function activateTab(tab) {
  const wasJam = activeTab && activeTab === jam.tab;
  activeTab = tab;
  for (const t of tabs) t.webview.classList.toggle('inactive', t !== tab);
  if (jam.active) {
    if (wasJam && tab !== jam.tab) hideMyCursor(); // Jam 탭을 떠나면 커서 숨김
    sendPresence();
  }
  renderTabs();
  updateToolbar();
  updateDrift();
  renderMinimap();
  ui.afterActivate(tab);
  if (typeof updateClipSiteBanner === 'function') updateClipSiteBanner();
  renderLoginBanner();
  renderFollowFrame();
}

function closeTab(tab) {
  if (tab === jam.tab) {
    if (!confirm('Jam 탭을 닫으면 Jam에서 나가게 돼요. 계속할까요?')) return;
    leaveJam({ ask: false });
  }
  ui.onClose(tab);
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.webview.remove();
  if (tabs.length === 0) createTab();
  else if (tab === activeTab) activateTab(tabs[Math.min(i, tabs.length - 1)]);
  else renderTabs();
}

function renderTabs() {
  $('#tabs').replaceChildren(
    ...tabs.map((t) => {
      const fav = t.favicon ? el('img', { class: 'fav', src: t.favicon, alt: '' }) : el('span', { class: 'fav placeholder' });
      if (fav.tagName === 'IMG') fav.addEventListener('error', () => fav.replaceWith(el('span', { class: 'fav placeholder' })));
      const node = el(
        'div',
        {
          class: `tab${t === activeTab ? ' active' : ''}${t === jam.tab ? ' jam' : ''}${t.loading ? ' loading' : ''}`,
          title: t.title,
          onclick: () => activateTab(t),
          onauxclick: (e) => e.button === 1 && closeTab(t),
        },
        fav,
        t === jam.tab ? el('span', { class: 'jam-badge' }, 'JAM') : null,
        el('span', { class: 'title' }, t.title || prettyUrl(t.url)),
        el('button', {
          class: 'close',
          title: '탭 닫기',
          onclick: (e) => {
            e.stopPropagation();
            closeTab(t);
          },
        }, '✕')
      );
      ui.decorateTab(t, node); // 고정 · 드래그 정렬 · 우클릭 메뉴 (customize.js)
      return node;
    })
  );
}

function updateToolbar() {
  const t = activeTab;
  if (!t) return;
  if (document.activeElement !== $('#url')) $('#url').value = ui.toolbarUrl(t);
  $('#back').disabled = !(t.ready && t.webview.canGoBack());
  $('#forward').disabled = !(t.ready && t.webview.canGoForward());
  $('#jam-tab-flag').hidden = t !== jam.tab;
  $('#lock-flag').hidden = !(t === jam.tab && jam.active && !jam.canCrossSite());
  $('#add-to-queue').disabled = !jam.active || !isShareable(t.url);
}

// ---------- 주소창 / 버튼 ----------
$('#url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = toUrl($('#url').value);
  if (!url || !activeTab) return;
  if (activeTab === jam.tab && jam.active && jam.follow && !jam.canGo(url)) {
    blockedNav(url);
    return;
  }
  navigateTab(activeTab, url);
  activeTab.webview.focus();
});
$('#url').addEventListener('focus', () => $('#url').select());
$('#back').addEventListener('click', () => activeTab?.webview.goBack());
$('#forward').addEventListener('click', () => activeTab?.webview.goForward());
$('#reload').addEventListener('click', () => activeTab?.webview.reload());
$('#new-tab').addEventListener('click', () => createTab());

jamApp.onOpenTab((url) => createTab(url));
jamApp.onNavBlocked((url) => blockedNav(url));
jamApp.onShortcut((action) => {
  const i = tabs.indexOf(activeTab);
  switch (action) {
    case 'new-tab': createTab(); break;
    case 'close-tab': if (activeTab) closeTab(activeTab); break;
    case 'focus-url': $('#url').focus(); break;
    case 'next-tab': activateTab(tabs[(i + 1) % tabs.length]); break;
    case 'prev-tab': activateTab(tabs[(i - 1 + tabs.length) % tabs.length]); break;
    case 'reload': activeTab?.webview.reload(); break;
    case 'back': activeTab?.webview.goBack(); break;
    case 'forward': activeTab?.webview.goForward(); break;
    case 'devtools': activeTab?.webview.openDevTools(); break;
    case 'toggle-panel': togglePanel(); break;
    case 'lock': account.lockNow(); break;
    case 'vault': account.open(); break;
    default: ui.shortcut(action);
  }
});
document.addEventListener('keydown', (e) => {
  if (ui.handleKey(e)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && e.shiftKey && key === 'l') { e.preventDefault(); account.lockNow(); }
  else if (ctrl && e.shiftKey && key === 'p') { e.preventDefault(); account.open(); }
  else if (ctrl && key === 't') { e.preventDefault(); createTab(); }
  else if (ctrl && key === 'w') { e.preventDefault(); if (activeTab) closeTab(activeTab); }
  else if (ctrl && key === 'l') { e.preventDefault(); $('#url').focus(); }
  else if (ctrl && key === 'j') { e.preventDefault(); togglePanel(); }
});
// 내 커서 숨기기: 마우스가 웹페이지 밖(앱 UI, 창 밖)에 있거나 다른 프로그램으로 넘어가면
function hideMyCursor() {
  if (!jam.active || !jam.cursorShown) return;
  jam.cursorShown = false;
  sendCursor({ type: 'cursor', x: null });
}
// 웹페이지(webview) 위의 움직임은 앱 문서로 오지 않으므로, 여기로 오면 = 앱 UI 위에 있다는 뜻
document.addEventListener('mousemove', hideMyCursor, { passive: true });
document.documentElement.addEventListener('mouseleave', hideMyCursor);
window.addEventListener('blur', hideMyCursor);

function blockedNav(url) {
  toast('🔒 다른 사이트로 이동하려면 호스트의 권한이 필요해요', [
    { label: '개인 탭에서 열기', fn: () => createTab(url) },
    ...(jam.active && isShareable(url)
      ? [{ label: '대기열에 추가', fn: () => jam.send({ type: 'queue:add', url, title: prettyUrl(url) }) }]
      : []),
  ]);
}

// ======================================================================
// Jam 상태
// ======================================================================
const jam = {
  ws: null,
  active: false,
  you: null,
  room: null,
  tab: null, // Jam과 연결된 탭 (다른 탭은 개인 탭)
  follow: true, // 페이지 따라가기
  followScroll: false, // 스크롤 따라가기
  hosting: false,
  serverUrl: '',
  code: '',
  lastSyncedUrl: null,
  invite: '',
  ad: false, // 내가 광고를 보는 중인지
  media: null, // { url, playing, time, rate, by, receivedAt }
  lastTickSent: 0,
  myView: null,
  lockedWcId: null,
  cursorShown: false,
  requests: new Map(), // 호스트: 참여 요청
  followingId: null, // 화면을 따라가고 있는 사람
  unread: 0,

  isHost() {
    return !!(this.room && this.you && this.room.hostId === this.you.id);
  },
  me() {
    return this.room?.members.find((m) => m.id === this.you?.id);
  },
  member(id) {
    return this.room?.members.find((m) => m.id === id);
  },
  canCrossSite() {
    if (!this.room) return false;
    return this.isHost() || this.room.settings.allowAllCrossSite || !!this.me()?.canCrossSite;
  },
  // 같은 사이트 안은 누구나, 다른 사이트는 권한이 있어야
  canGo(url) {
    return this.canCrossSite() || !this.room?.current || sameSite(url, this.room.current.url);
  },
  send(msg) {
    const ws = this.ws;
    const keys = this.keys;
    if (!ws || !keys || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    // 암호화는 비동기라서, 보내는 순서가 바뀌지 않도록 줄을 세운다
    this.outQueue = (this.outQueue || Promise.resolve())
      .then(async () => {
        const buf = await sealMsg(keys, msg);
        if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      })
      .catch(() => {});
    return this.outQueue;
  },
};

// ======================================================================
// 암호화 (shared/jam-crypto.js 와 같은 규칙을 WebCrypto 로)
//  - 초대 코드 안의 비밀키는 네트워크로 보내지 않고, 서버가 준 nonce 에 서명해서 "안다"는 것만 증명
//  - 인증 뒤 모든 메시지는 AES-256-GCM 으로 암호화 + 위변조 검사
// ======================================================================
const te = new TextEncoder();
const td = new TextDecoder();
const AAD_C2S = te.encode('c2s');
const AAD_S2C = te.encode('s2c');

function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const newSecret = () => b64u(crypto.getRandomValues(new Uint8Array(32)));

async function deriveKeys(secret) {
  const raw = unb64u(secret);
  if (raw.length !== 32) throw new Error('bad secret');
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) });
  const enc = await crypto.subtle.deriveKey(params('jam-browser v1 enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const authBits = await crypto.subtle.deriveBits(params('jam-browser v1 auth'), base, 256);
  const auth = await crypto.subtle.importKey('raw', authBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { enc, auth };
}
async function makeProof(keys, nonce, code) {
  return b64u(await crypto.subtle.sign('HMAC', keys.auth, te.encode(`${nonce}:${code}`)));
}
async function sealMsg(keys, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD_C2S }, keys.enc, te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out.buffer;
}
async function openMsg(keys, buf) {
  const b = new Uint8Array(buf);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: AAD_S2C }, keys.enc, b.subarray(12));
  return JSON.parse(td.decode(pt));
}

try {
  $('#name').value = localStorage.getItem('jam-name') || '';
  $('#server-url').value = localStorage.getItem('jam-server') || '';
} catch {}

function myName() {
  const name = $('#name').value.trim();
  if (!name) {
    toast('먼저 이름을 입력해 주세요');
    $('#name').focus();
    return null;
  }
  try { localStorage.setItem('jam-name', name); } catch {}
  return name;
}

// ======================================================================
// 서버 연결
// ======================================================================
const connError = (message, code) => Object.assign(new Error(message), { code });

/**
 * hello: { type: 'create' | 'join', name, code?, resume?, url?, title? }
 * secret: 초대 코드의 비밀키 (create 일 때만 같은 PC의 서버로 전달, join 은 서명만 보냄)
 */
async function connect(serverUrl, hello, { secret, onPending } = {}) {
  let keys;
  try {
    keys = await deriveKeys(secret);
  } catch {
    throw connError('초대 코드의 비밀키가 올바르지 않아요', 'bad-secret');
  }
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(serverUrl);
    } catch {
      return reject(connError('서버 주소가 올바르지 않아요', 'bad-url'));
    }
    ws.binaryType = 'arraybuffer';
    ws.early = [];
    let settled = false;
    let timer;
    const fail = (message, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      reject(connError(message, code));
    };
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail('서버에 연결할 수 없어요 (시간 초과)', 'timeout'), ms);
    };
    arm(7000);

    let chain = Promise.resolve();
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        // 인증 전 평문: hello(nonce) / 오류
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'hello' && typeof msg.nonce === 'string') {
          chain = chain.then(async () => {
            let first;
            if (hello.type === 'create') {
              first = { ...hello, secret }; // 같은 PC 의 내 서버에만 보냄
            } else {
              // 참여: 비밀키는 보내지 않고 증명(proof)만. 이름·재접속 토큰은 암호화해서 (중계 서버도 못 봄)
              // 브라우저 계정에 로그인되어 있으면 이 연결의 nonce + 방 코드에 서명해 신원을 증명 (친구 확인용, 공개 키 + 서명만)
              const inner = { name: hello.name, resume: hello.resume || null };
              const id = window.account ? await account.signJoin(msg.nonce, hello.code) : null;
              if (id) inner.id = id;
              const sealed = new Uint8Array(await sealMsg(keys, inner));
              let bin = '';
              for (const b of sealed) bin += String.fromCharCode(b);
              first = { type: 'join', code: hello.code, proof: await makeProof(keys, msg.nonce, hello.code), p: btoa(bin) };
            }
            ws.send(JSON.stringify(first));
          });
        } else if (msg.type === 'error') fail(msg.message, msg.code);
        return;
      }
      chain = chain.then(async () => {
        let msg;
        try {
          msg = await openMsg(keys, e.data);
        } catch {
          return; // 키가 다르거나 위조된 메시지 → 무시
        }
        if (!settled) {
          if (msg.type === 'welcome') {
            settled = true;
            clearTimeout(timer);
            resolve({ ws, welcome: msg, keys });
          } else if (msg.type === 'pending') {
            arm(130000); // 호스트 승인 대기
            onPending?.();
          } else if (msg.type === 'error') fail(msg.message, msg.code);
          return;
        }
        if (jam.ws === ws) handleMessage(msg);
        else ws.early.push(msg); // 환영 직후, 화면 준비 전에 온 메시지
      });
    });
    ws.addEventListener('close', () => {
      if (!settled) fail('서버에 연결할 수 없어요', 'closed');
      else if (jam.ws === ws) reconnect();
    });
    ws.addEventListener('error', () => {});
  });
}

// 와이파이가 잠깐 끊기는 등 연결이 끊어지면 같은 코드로 다시 참여한다 (재접속 토큰이 있어 승인 없이 복귀)
async function reconnect() {
  jam.ws = null;
  const name = jam.you?.name;
  for (let i = 1; i <= 5; i++) {
    $('#jam-status-text').textContent = `다시 연결 중… (${i}/5)`;
    await sleep(1000 * i);
    if (!jam.active) return;
    try {
      const { ws, welcome, keys } = await connect(
        jam.serverUrl,
        { type: 'join', name, code: jam.code, resume: jam.resume },
        { secret: jam.secret }
      );
      if (!jam.active) return ws.close();
      adoptWelcome(ws, welcome, keys);
      toast('Jam에 다시 연결됐어요');
      return;
    } catch (err) {
      if (['bad-invite', 'rejected', 'bad-secret'].includes(err.code)) break;
    }
  }
  if (!jam.active) return;
  toast('Jam 연결이 끊어졌어요');
  cleanupJam();
}

const RELAY_PORT = 3031;

// 중계 서버 주소 → ws://주소:포트 또는 wss://주소 (https:// 나 wss:// 로 쓰면 암호화 연결)
function normalizeRelay(input) {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return null;
  const secure = /^(wss|https):\/\//i.test(s);
  s = s.replace(/^(wss?|https?):\/\//i, '');
  if (!/^[^\s/]+$/.test(s)) return null;
  if (!secure && !/:\d+$/.test(s)) s += ':' + RELAY_PORT;
  return `${secure ? 'wss' : 'ws'}://${s}`;
}

// 같은 네트워크: jam://호스트:포트/방코드/비밀키
// 중계 서버:    jamr://중계주소:포트/경로/방코드/비밀키   (암호화 연결이면 jamrs://)
function parseInvite(text) {
  const t = text.trim();
  const r = t.match(/^(jamrs?):\/\/([^/\s]+)\/([a-z0-9]{6,16})\/([A-Za-z0-9]{4,8})\/([A-Za-z0-9_-]{43})\/?$/i);
  if (r) {
    const scheme = r[1].toLowerCase() === 'jamrs' ? 'wss' : 'ws';
    let host = r[2];
    if (scheme === 'ws' && !/:\d+$/.test(host)) host += ':' + RELAY_PORT;
    return { server: `${scheme}://${host}/join/${r[3]}`, code: r[4].toUpperCase(), secret: r[5], relay: true };
  }
  const m = t.match(/^(?:jam:\/\/)?([^/\s]+)\/([A-Za-z0-9]{4,8})\/([A-Za-z0-9_-]{43})\/?$/i);
  if (!m) return null;
  let host = m[1];
  if (!/:\d+$/.test(host)) host += ':' + DEFAULT_PORT;
  return { server: `ws://${host}`, code: m[2].toUpperCase(), secret: m[3] };
}

async function startJam() {
  const name = myName();
  if (!name) return;
  const btn = $('#start-jam');
  btn.disabled = true;
  btn.textContent = 'Jam 준비 중…';
  try {
    // 항상 내 PC가 호스트(서버). 중계 서버 주소가 있으면 인터넷 친구용 길도 연다
    const relayInput = $('#server-url').value.trim();
    try { localStorage.setItem('jam-server', relayInput); } catch {}
    const relayUrl = relayInput ? normalizeRelay(relayInput) : null;
    if (relayInput && !relayUrl) throw new Error('중계 서버 주소 형식이 올바르지 않아요 (예: relay.example.com:3031)');
    const { port, addresses, relay } = await jamApp.startHost({ relayUrl });
    jam.hosting = true;
    const serverUrl = `ws://127.0.0.1:${port}`;
    const ips = addresses.length ? addresses : ['127.0.0.1'];
    let inviteHost = `jam://${ips[0]}:${port}`;
    let altHosts = ips.slice(1).map((ip) => `jam://${ip}:${port}`);
    if (relay?.route) {
      const u = new URL(relay.url);
      inviteHost = `${u.protocol === 'wss:' ? 'jamrs' : 'jamr'}://${u.host}/${relay.route}`;
      altHosts = ips.map((ip) => `jam://${ip}:${port}`); // 같은 네트워크 친구는 직접 연결도 가능
    } else if (relay?.error) {
      toast(`⚠️ 중계 서버에 연결하지 못했어요 (${relay.error}). 같은 네트워크용 초대 코드만 만들어요`);
    }

    const access = account.accessMode();
    if (access === 'friends' && !account.isUnlocked()) {
      throw new Error('"친구만" Jam 은 브라우저 계정에 로그인해야 열 수 있어요 (👤 버튼)');
    }
    const tab = activeTab && isShareable(activeTab.url) ? activeTab : createTab(ui.homeUrl());
    const secret = newSecret(); // 이 Jam만의 비밀키 (초대 코드에만 들어감)
    const { ws, welcome, keys } = await connect(
      serverUrl,
      // allow: 친구 신원 지문 목록 → 내 PC 의 Jam 서버에만 전달 (참여자 · 중계 서버로는 나가지 않음)
      { type: 'create', name, url: tab.url, title: tab.title, access, allow: account.friendFps() },
      { secret }
    );
    jam.serverUrl = serverUrl;
    jam.secret = secret;
    enterJam(ws, welcome, tab, keys);
    const code = welcome.room.code;
    jam.invite = `${inviteHost}/${code}/${secret}`;
    $('#invite-alt').textContent = altHosts.length
      ? `${relay?.route ? '같은 네트워크 친구용' : '다른 네트워크 주소'}: ${altHosts.map((h) => `${h}/${code}/${secret}`).join(', ')}`
      : '';
    renderJam();
    toast('Jam을 시작했어요! 초대 코드를 친구에게 보내세요');
  } catch (err) {
    console.error(err);
    toast(err.message || 'Jam을 시작하지 못했어요');
    if (jam.active) cleanupJam();
    if (jam.hosting) {
      jam.hosting = false;
      jamApp.stopHost();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Jam 시작하기';
  }
}

async function joinJam() {
  const name = myName();
  if (!name) return;
  const inv = parseInvite($('#invite').value);
  if (!inv) {
    toast('초대 코드 형식이 올바르지 않아요. 호스트가 보낸 코드 전체(jam://주소/코드/비밀키)를 붙여 넣으세요');
    return;
  }
  const btn = $('#join-jam');
  btn.disabled = true;
  btn.textContent = '연결 중…';
  try {
    const { ws, welcome, keys } = await connect(
      inv.server,
      { type: 'join', name, code: inv.code },
      {
        secret: inv.secret,
        onPending: () => {
          btn.textContent = '호스트의 승인을 기다리는 중…';
          toast('참여 요청을 보냈어요. 호스트가 수락하면 들어가요');
        },
      }
    );
    jam.serverUrl = inv.server;
    jam.secret = inv.secret;
    const tab = createTab(welcome.room.current?.url || ui.homeUrl());
    enterJam(ws, welcome, tab, keys);
    jam.invite = $('#invite').value.trim();
    $('#invite-alt').textContent = '';
    renderJam();
    const hostName = welcome.room.members.find((m) => m.id === welcome.room.hostId)?.name || '친구';
    toast(`${hostName}님의 Jam에 참여했어요`);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Jam에 참여하지 못했어요');
    if (jam.active) cleanupJam();
  } finally {
    btn.disabled = false;
    btn.textContent = '참여하기';
  }
}

function adoptWelcome(ws, welcome, keys) {
  jam.ws = ws;
  jam.keys = keys;
  jam.outQueue = null;
  jam.you = welcome.you;
  jam.resume = welcome.resume;
  jam.room = welcome.room;
  jam.code = welcome.room.code;
  const m = welcome.room.media;
  jam.media = m ? { ...m, receivedAt: performance.now() - (m.age || 0) } : null;
  renderJam();
  applyLock();
  sendPresence();
  if (jam.myView) publishViewport(jam.myView);
  refreshAllViews();
  applyMedia();
  for (const msg of ws.early.splice(0)) handleMessage(msg);
}

function enterJam(ws, welcome, tab, keys) {
  // 방 정보를 먼저 채운 뒤에 active 로 바꿔야 화면 그리기가 빈 방을 만나지 않는다
  jam.you = welcome.you;
  jam.room = welcome.room;
  jam.tab = tab;
  jam.lastSyncedUrl = tab.url;
  jam.myView = null;
  jam.loginWait = null;
  jam.active = true;
  $('#chat').replaceChildren();
  addSystem('Jam에 오신 걸 환영해요. JAM 탭에서는 같은 사이트 안이라면 누구나 페이지를 넘길 수 있어요.');
  jam.requests = new Map();
  renderRequests();
  activateTab(tab);
  adoptWelcome(ws, welcome, keys);
  if (tab.ready) onJamTabReady();
}

async function leaveJam({ ask = true } = {}) {
  if (!jam.active) return;
  if (jam.isHost()) {
    if (ask && !confirm('Jam을 종료할까요? 모든 참여자의 연결이 끊어져요.')) return;
    // 종료 알림이 암호화되어 실제로 나간 뒤에 연결을 닫는다
    await Promise.race([jam.send({ type: 'end' }), sleep(1000)]);
  }
  cleanupJam();
}

function cleanupJam() {
  const ws = jam.ws;
  jam.ws = null; // close 이벤트에서 다시 연결하지 않도록 먼저 비운다
  if (ws) {
    try { ws.close(); } catch {}
  }
  if (jam.tab && jam.tab.ready) jam.tab.webview.send('jam:clear');
  if (jam.lockedWcId != null) jamApp.setLock(jam.lockedWcId, false);
  jam.lockedWcId = null;
  Object.assign(jam, {
    active: false, room: null, you: null, tab: null, media: null, ad: false, myView: null, loginWait: null,
    keys: null, secret: null, resume: null, requests: new Map(), followingId: null,
  });
  renderLoginBanner();
  renderRequests();
  if (jam.hosting) {
    jam.hosting = false;
    setTimeout(() => jamApp.stopHost(), 500); // 종료 메시지가 전달될 시간을 잠깐 준다
  }
  renderTabs();
  updateToolbar();
  updateDrift();
  renderJam();
}

// ======================================================================
// Jam 탭 ↔ 서버
// ======================================================================
function onJamTabReady() {
  applyLock();
  refreshAllViews();
  if (jam.followingId) setTimeout(syncToFollowed, 400);
}

// 다른 사이트 이동 잠금 (메인 프로세스 + 페이지 링크 표시)
function applyLock() {
  const tab = jam.tab;
  if (!jam.active || !tab || !tab.ready) return;
  const locked = !jam.canCrossSite();
  const wcId = tab.webview.getWebContentsId();
  jam.lockedWcId = wcId;
  jamApp.setLock(wcId, locked);
  tab.webview.send('jam:policy', { locked });
  updateToolbar();
}

function myPresence() {
  const url = jam.tab?.url;
  const priv = !!jam.loginWait || (!!url && isWebUrl(url) && isSensitiveUrl(url));
  return {
    url: priv ? null : url,
    title: priv ? '' : jam.tab?.title || '',
    ad: jam.ad,
    private: priv,
    away: activeTab !== jam.tab,
  };
}
function sendPresence() {
  if (!jam.active || !jam.tab) return;
  jam.send({ type: 'presence', ...myPresence() });
  renderMembers();
}

// ----------------------------------------------------------------------
// 로그인 처리: 각자 자기 로그인 창을 보고, 로그인이 끝나야 Jam 화면/영상을 따라간다
//  - Jam 탭이 로그인·인증 페이지로 가면 "로그인 대기" 상태가 된다 (동기화 멈춤, 주소 공유 안 함)
//  - 로그인 뒤 갈 곳(임시 메인)은 Jam이 지금 보고 있는 페이지 — Jam이 그새 이동했으면 최신 페이지
//  - 로그인 페이지를 벗어나 일반 페이지에 안정적으로 도착하면 Jam 페이지로 자동 이동 + 영상 위치 맞춤
// ----------------------------------------------------------------------
let loginTimer = null;

function enterLoginWait(url) {
  if (!jam.loginWait) {
    jam.loginWait = { since: Date.now() };
    toast('🔐 로그인이 필요해요. 내 로그인 창은 나만 보여요 — 로그인을 마치면 Jam 화면으로 자동으로 이동해요');
  }
  jam.loginWait.at = url;
  renderLoginBanner();
}

function checkLoginFinished() {
  clearTimeout(loginTimer);
  const tab = jam.tab;
  if (!jam.active || !jam.loginWait || !tab || !isShareable(tab.url)) return;
  // 로그인 과정 중간 페이지를 지나가는 경우를 피하려고, 일반 페이지에 잠시 머무는지 확인한다
  loginTimer = setTimeout(() => {
    if (!jam.active || !jam.loginWait || !isShareable(jam.tab.url) || jam.tab.loading) return;
    finishLoginWait(true);
  }, 1500);
}

function finishLoginWait(auto) {
  jam.loginWait = null;
  renderLoginBanner();
  const cur = jam.room?.current;
  if (cur && jam.follow && !sameDoc(jam.tab.url, cur.url)) {
    jam.lastSyncedUrl = cur.url;
    followNavigate(cur.url);
  }
  applyMedia();
  sendPresence();
  updateDrift();
  if (auto) toast('✅ 로그인 완료! Jam 화면으로 이동했어요');
}

function renderLoginBanner() {
  const b = $('#login-banner');
  const show = jam.active && jam.loginWait && activeTab === jam.tab;
  b.hidden = !show;
  if (!show) return;
  const cur = jam.room?.current;
  $('#login-target').textContent = cur ? cur.title || prettyUrl(cur.url) : 'Jam 페이지';
}

function onJamTabNavigated(tab, url) {
  if (!jam.active) return;
  jam.myView = null;
  clearTimeout(loginTimer);
  sendPresence();
  refreshAllViews();
  renderMinimap();
  if (!isShareable(url)) {
    if (isWebUrl(url)) enterLoginWait(url);
    return updateDrift();
  }
  if (jam.loginWait) {
    // 로그인 중에 거쳐가는 일반 페이지는 공유하지 않는다. 로드가 끝나면 checkLoginFinished 가 판단
    updateDrift();
    if (sameDoc(url, jam.room.current?.url)) finishLoginWait(true);
    return;
  }
  if (url === jam.lastSyncedUrl) return updateDrift();
  // 따라가기를 켜 둔 상태에서, 이동할 수 있는 곳이면 모두 함께 이동
  if (jam.follow && jam.canGo(url)) {
    jam.lastSyncedUrl = url;
    jam.room.current = { url, title: tab.title, by: jam.you.id };
    jam.send({ type: 'navigate', url, title: tab.title });
    renderNow();
  }
  updateDrift();
}

function onJamTabTitle(tab) {
  if (!jam.active) return;
  if (jam.room.current && jam.room.current.url === tab.url && isShareable(tab.url)) {
    jam.room.current.title = tab.title;
    jam.send({ type: 'title', url: tab.url, title: tab.title });
    renderNow();
  }
  sendPresence();
}

const publishViewport = throttle((v) => {
  const url = jam.tab?.url;
  if (!jam.active || !isShareable(url)) return;
  jam.send({ type: 'viewport', url, vx: v.vx, vy: v.vy, vw: v.vw, vh: v.vh, top: v.top, bot: v.bot, w: v.w, h: v.h, z: v.z });
}, 150);
const sendScroll = throttle((m) => jam.send(m), 100);
const sendCursor = throttle((m) => jam.send(m), 40);

function onJamPageEvent(tab, channel, data) {
  if (!jam.active) return;
  const url = tab.url;
  switch (channel) {
    case 'jam:viewport': {
      if (data.user && jam.followingId) stopFollow('직접 스크롤해서 따라가기를 멈췄어요');
      jam.myView = data;
      renderMinimap();
      renderMembers();
      publishViewport(data);
      // 내가 직접 스크롤했고 Jam 페이지에 있으면 → 스크롤 따라가기를 켠 사람들이 따라온다
      if (data.user && jam.follow && isShareable(url) && sameDoc(url, jam.room.current?.url)) {
        sendScroll({ type: 'scroll', url, x: data.sx, y: data.sy, top: data.top });
      }
      break;
    }
    case 'jam:cursor':
      if (!data) {
        jam.cursorShown = false;
        sendCursor({ type: 'cursor', x: null });
      } else if (isShareable(url) && activeTab === tab) {
        jam.cursorShown = true;
        sendCursor({ type: 'cursor', url, x: data.x, y: data.y, a: data.a });
      }
      break;
    case 'jam:click':
      if (isShareable(url)) jam.send({ type: 'click', url, x: data.x, y: data.y, a: data.a });
      break;
    case 'jam:view-pos': {
      // 다른 사람 사각형이 내 문서에서 실제로 그려진 위치 (미니맵용)
      const m = jam.member(data.id);
      if (m) m.localPos = data;
      renderMinimap();
      break;
    }
    case 'jam:debug':
      window.__jamDebug = data;
      break;
    case 'jam:blocked':
      blockedNav(data);
      break;
    case 'jam:ad':
      jam.ad = !!data;
      sendPresence();
      if (jam.ad) toastOnce('ad', '📺 광고가 끝나면 Jam 재생 위치로 자동으로 따라가요');
      break;
    case 'jam:media':
      if (isShareable(url)) publishMedia(url, data);
      break;
    case 'jam:media-tick':
      // 마지막으로 재생을 조작한 사람이 4초마다 기준 시간을 알려준다
      if (jam.media?.by === jam.you.id && sameDoc(jam.media.url, url) && Date.now() - jam.lastTickSent > 4000) {
        publishMedia(url, data);
      }
      break;
    case 'jam:media-init':
      if (jam.media && sameDoc(jam.media.url, url)) applyMedia();
      else if (jam.room.current?.by === jam.you.id && sameDoc(jam.room.current.url, url) && isShareable(url)) {
        publishMedia(url, data); // 내가 모두를 이 영상으로 데려왔으면 내가 기준이 된다
      }
      break;
    case 'jam:media-ready':
      applyMedia();
      break;
  }
}

function publishMedia(url, s) {
  jam.media = { url, playing: s.playing, time: s.time, rate: s.rate, by: jam.you.id, receivedAt: performance.now() };
  jam.lastTickSent = Date.now();
  jam.send({ type: 'media', url, playing: s.playing, time: s.time, rate: s.rate });
}

function applyMedia() {
  const m = jam.media;
  const tab = jam.tab;
  if (!m || !tab?.ready || !jam.follow || !sameDoc(m.url, tab.url) || jam.ad || jam.loginWait) return;
  const elapsed = m.playing ? ((performance.now() - m.receivedAt) / 1000) * m.rate : 0;
  tab.webview.send('jam:media-apply', { playing: m.playing, time: m.time + elapsed, rate: m.rate });
}

// 다른 사람의 화면 사각형을 내 페이지에 그린다 (같은 페이지를 볼 때만)
function refreshView(m) {
  const tab = jam.tab;
  if (!tab?.ready || !m || m.id === jam.you?.id) return;
  const v = m.view;
  if (v && sameDoc(v.url, tab.url)) {
    tab.webview.send('jam:view', { id: m.id, name: m.name, color: m.color, ...v });
  } else {
    tab.webview.send('jam:view-remove', m.id);
  }
}
function refreshAllViews() {
  if (!jam.active || !jam.room) return;
  for (const m of jam.room.members) refreshView(m);
}

function handleMessage(msg) {
  if (!jam.active) return;
  const tab = jam.tab;
  switch (msg.type) {
    case 'members': {
      jam.room.members = msg.members;
      jam.room.hostId = msg.hostId;
      renderJam();
      applyLock();
      refreshAllViews();
      break;
    }
    case 'presence': {
      const m = jam.member(msg.id);
      if (m) m.presence = msg.presence;
      renderMembers();
      renderOverlay();
      if (msg.id === jam.followingId) syncToFollowed();
      break;
    }
    case 'viewport': {
      const m = jam.member(msg.by);
      if (!m) break;
      m.view = msg.url
        ? { url: msg.url, vx: msg.vx, vy: msg.vy, vw: msg.vw, vh: msg.vh, top: msg.top, bot: msg.bot, w: msg.w, h: msg.h, z: msg.z }
        : null;
      if (!m.view) m.localPos = null;
      refreshView(m);
      renderMinimap();
      renderMembers();
      renderOverlay();
      if (msg.by === jam.followingId) syncToFollowed();
      break;
    }
    case 'left': {
      if (tab?.ready) {
        tab.webview.send('jam:cursor-remove', msg.id);
        tab.webview.send('jam:view-remove', msg.id);
      }
      if (msg.id === jam.followingId) stopFollow('따라가던 사람이 나가서 멈췄어요');
      break;
    }
    case 'navigate': {
      jam.room.current = { url: msg.url, title: msg.title, by: msg.by };
      if (jam.follow && tab) {
        if (jam.loginWait || (isWebUrl(tab.url) && isSensitiveUrl(tab.url))) {
          renderLoginBanner(); // 로그인 중에는 이동하지 않고, 로그인 뒤 갈 곳만 최신으로 바꿔둔다
        } else {
          jam.lastSyncedUrl = msg.url;
          if (tab.url !== msg.url) followNavigate(msg.url);
        }
      }
      renderNow();
      updateDrift();
      break;
    }
    case 'current':
      jam.room.current = msg.current;
      renderNow();
      updateDrift();
      break;
    case 'scroll':
      if (jam.followScroll && jam.follow && !jam.loginWait && tab?.ready && sameDoc(msg.url, tab.url)) {
        tab.webview.send('jam:scroll-to', { x: msg.x, y: msg.y, top: msg.top });
      }
      break;
    case 'cursor': {
      if (!tab?.ready) break;
      const m = jam.member(msg.by);
      if (msg.x == null || !m || !sameDoc(msg.url, tab.url)) tab.webview.send('jam:cursor-remove', msg.by);
      else tab.webview.send('jam:cursor', { id: m.id, name: m.name, color: m.color, x: msg.x, y: msg.y, a: msg.a });
      break;
    }
    case 'click': {
      const m = jam.member(msg.by);
      if (tab?.ready && m && sameDoc(msg.url, tab.url)) tab.webview.send('jam:click', { color: m.color, x: msg.x, y: msg.y, a: msg.a });
      break;
    }
    case 'media':
      jam.media = { ...msg, receivedAt: performance.now() - (msg.age || 0) };
      applyMedia();
      break;
    case 'chat':
      addChat(msg);
      break;
    case 'system':
      addSystem(msg.text);
      break;
    case 'reaction':
      floatReaction(msg.emoji, msg.color);
      break;
    case 'queue':
      jam.room.queue = msg.queue;
      renderQueue();
      break;
    case 'settings':
      jam.room.settings = msg.settings;
      renderJam();
      applyLock();
      break;
    case 'error':
      toast(msg.message);
      break;
    case 'join-request':
      jam.requests.set(msg.id, msg);
      renderRequests();
      break;
    case 'join-cancel':
      jam.requests.delete(msg.id);
      renderRequests();
      break;
    case 'kicked':
      toast('호스트가 Jam에서 내보냈어요');
      cleanupJam();
      break;
    case 'ended':
      toast('호스트가 Jam을 종료했어요');
      cleanupJam();
      break;
  }
}

// ======================================================================
// 화면 그리기
// ======================================================================
function renderJam() {
  $('#jam-idle').hidden = jam.active;
  $('#jam-active').hidden = !jam.active;
  $('#jam-status').classList.toggle('live', jam.active);
  $('#jam-status-text').textContent = jam.active ? `Jam · ${jam.room.members.length}명` : 'Jam';
  updateToolbar();
  renderTabs();
  renderMinimap();
  if (!jam.active) return;

  $('#room-code').textContent = jam.room.code;
  $('#invite-text').textContent = jam.invite;
  $('#leave-jam').textContent = jam.isHost() ? 'Jam 종료' : '나가기';
  $('#member-count').textContent = `${jam.room.members.length}명`;

  const allow = $('#allow-all');
  allow.checked = jam.room.settings.allowAllCrossSite;
  allow.disabled = !jam.isHost();
  $('#allow-all-row').title = jam.isHost() ? '' : '호스트만 바꿀 수 있어요';
  $('#follow').checked = jam.follow;
  $('#follow-scroll').checked = jam.followScroll;
  $('#my-perm').textContent = jam.canCrossSite()
    ? '🌐 나는 다른 사이트로도 이동할 수 있어요'
    : '🔒 나는 같은 사이트 안에서만 이동할 수 있어요 (다른 사이트는 호스트 권한 필요)';

  const ra = $('#access-live');
  ra.value = jam.room.settings.access || (jam.room.settings.requireApproval === false ? 'open' : 'approval');
  ra.disabled = !jam.isHost();
  $('#approval-row').title = jam.isHost() ? '' : '호스트만 바꿀 수 있어요';

  renderMembers(true);
  renderNow();
  renderQueue();
  updateDrift();
  renderOverlay();
  renderRequests();
  renderFollowFrame();
}

function statusOf(m) {
  const p = m.id === jam.you.id ? myPresence() : m.presence || {};
  const cur = jam.room.current;
  let text;
  if (p.private) text = '🔐 로그인 중 · 끝나면 따라와요';
  else if (p.ad) text = '📺 광고 보는 중 · 끝나면 따라와요';
  else if (p.away) text = '💤 개인 탭 보는 중';
  else if (p.url && cur && !sameDoc(p.url, cur.url)) text = `↗ 다른 페이지: ${p.title || prettyUrl(p.url)}`;
  else text = '같이 보는 중';
  const view = m.id === jam.you.id ? jam.myView : m.view;
  if (view) text += ` · ${resolutionText(view)}`;
  return text;
}

function resolutionText(v) {
  return `${v.w}×${v.h}${v.z && v.z !== 1 ? ` · ${Math.round(v.z * 100)}%` : ''}`;
}

let membersKey = '';
function renderMembers(force = false) {
  if (!jam.active || !jam.room) return;
  const host = jam.isHost();
  const rows = jam.room.members.map((m) => ({
    m,
    status: statusOf(m),
    canView: m.id !== jam.you.id && m.view && jam.tab && sameDoc(m.view.url, jam.tab.url),
  }));
  // 내용이 같으면 다시 그리지 않는다 (버튼 클릭이 끊기지 않게)
  const key = JSON.stringify([host, jam.room.hostId, jam.room.settings, rows.map((r) => [r.m.id, r.m.name, r.m.canCrossSite, r.status, !!r.canView, !!r.m.friend, !!r.m.verified])]);
  if (!force && key === membersKey) return;
  membersKey = key;

  $('#members').replaceChildren(
    ...rows.map(({ m, status, canView }) => {
      const isMe = m.id === jam.you.id;
      const isRoomHost = m.id === jam.room.hostId;
      const crossOk = isRoomHost || jam.room.settings.allowAllCrossSite || m.canCrossSite;
      return el(
        'li',
        { class: 'member' },
        el('span', { class: 'avatar', style: { background: m.color } }, [...m.name][0]?.toUpperCase() || '?'),
        el(
          'div',
          { class: 'info' },
          el(
            'div',
            { class: 'name' },
            m.name,
            isMe ? el('span', { class: 'muted' }, ' (나)') : null,
            isRoomHost ? el('span', { class: 'tag' }, '👑') : null,
            m.friend
              ? el('span', { class: 'badge-friend', title: '호스트의 친구 (서명으로 본인 확인됨)' }, '⭐')
              : m.verified
                ? el('span', { class: 'badge-friend', title: '브라우저 계정 서명으로 본인 확인됨' }, '🔏')
                : null,
            el('span', { class: `perm ${crossOk ? 'on' : ''}`, title: crossOk ? '다른 사이트 이동 가능' : '같은 사이트 안에서만 이동' }, crossOk ? '🌐' : '🔒')
          ),
          el('div', { class: 'status' }, status)
        ),
        el(
          'div',
          { class: 'actions' },
          canView
            ? el('button', {
                class: 'mini-btn',
                title: `${m.name}님이 보는 곳으로 내 화면 이동`,
                onclick: () => jam.tab.webview.send('jam:scroll-to-view', { id: m.id, ...m.view }),
              }, '보기')
            : null,
          host && !isRoomHost
            ? el('button', {
                class: `mini-btn ${m.canCrossSite ? 'active' : ''}`,
                title: m.canCrossSite ? '다른 사이트 이동 권한 거두기' : '다른 사이트 이동 권한 주기',
                onclick: () => jam.send({ type: 'perm', id: m.id, canCrossSite: !m.canCrossSite }),
              }, m.canCrossSite ? '권한 ✓' : '권한')
            : null,
          host && !isMe
            ? el('button', {
                class: 'mini-btn danger',
                title: '내보내기',
                onclick: () => confirm(`${m.name}님을 Jam에서 내보낼까요?`) && jam.send({ type: 'kick', id: m.id }),
              }, '✕')
            : null
        )
      );
    })
  );
}

function renderNow() {
  if (!jam.active) return;
  const cur = jam.room.current;
  const box = $('#now-page');
  if (!cur) {
    box.replaceChildren(el('span', { class: 'muted' }, '아직 없음'));
    return;
  }
  const by = jam.member(cur.by);
  box.replaceChildren(
    el('img', { class: 'fav', src: faviconFor(cur.url), alt: '' }),
    el(
      'div',
      { class: 'meta' },
      el('div', { class: 't' }, cur.title || prettyUrl(cur.url)),
      el('div', { class: 'u' }, prettyUrl(cur.url), by ? ` · ${by.name}님이 이동` : '')
    )
  );
}

function renderQueue() {
  if (!jam.active) return;
  const q = jam.room.queue;
  $('#queue-empty').hidden = q.length > 0;
  $('#queue-next').disabled = q.length === 0 || !jam.canGo(q[0].url);
  $('#queue').replaceChildren(
    ...q.map((item, i) => {
      const allowed = jam.canGo(item.url);
      return el(
        'li',
        { class: 'q-item' },
        el('span', { class: 'num' }, i + 1),
        el(
          'div',
          { class: 'meta', title: item.url },
          el('div', { class: 't' }, item.title || prettyUrl(item.url)),
          el('div', { class: 'by' }, el('i', { style: { background: item.color } }), `${item.addedByName}님이 추가`)
        ),
        el('button', {
          title: allowed ? '지금 다 같이 보기' : '다른 사이트라 호스트 권한이 필요해요',
          disabled: !allowed,
          onclick: () => jam.send({ type: 'queue:play', id: item.id }),
        }, allowed ? '▶' : '🔒'),
        jam.isHost() || item.addedBy === jam.you.id
          ? el('button', { title: '대기열에서 빼기', onclick: () => jam.send({ type: 'queue:remove', id: item.id }) }, '✕')
          : null
      );
    })
  );
}

// 오른쪽 가장자리 미니맵: 페이지 전체에서 각자 보고 있는 영역
function renderMinimap() {
  const map = $('#minimap');
  const show = jam.active && activeTab === jam.tab && jam.myView && isShareable(jam.tab.url);
  map.hidden = !show;
  if (!show) return;
  const box = (v, color, label, isMe, onclick) =>
    el('div', {
      class: `mm-box${isMe ? ' me' : ''}`,
      title: label,
      style: {
        top: `${v.vy * 100}%`,
        height: `max(${v.vh * 100}%, 4px)`,
        left: `${v.vx * 100}%`,
        width: `max(${v.vw * 100}%, 30%)`,
        borderColor: color,
        background: isMe ? 'transparent' : `${color}55`,
      },
      onclick,
    });
  const others = jam.room.members.filter((m) => m.id !== jam.you.id && m.view && sameDoc(m.view.url, jam.tab.url));
  map.replaceChildren(
    ...others.map((m) =>
      box(m.localPos || m.view, m.color, `${m.name} · ${resolutionText(m.view)} (클릭하면 이곳으로 이동)`, false, () =>
        jam.tab.webview.send('jam:scroll-to-view', { id: m.id, ...m.view })
      )
    ),
    box(jam.myView, '#ffffff', `나 · ${resolutionText(jam.myView)}`, true)
  );
}

function updateDrift() {
  const banner = $('#drift-banner');
  const cur = jam.room?.current;
  const show = jam.active && !jam.loginWait && activeTab === jam.tab && cur && jam.tab && !sameDoc(jam.tab.url, cur.url);
  banner.hidden = !show;
  if (!show) return;
  const name = cur.title || prettyUrl(cur.url);
  const url = jam.tab.url;
  if (isWebUrl(url) && isSensitiveUrl(url)) $('#drift-text').textContent = `🔒 로그인 중 · Jam은 "${name}"에 있어요`;
  else if (!jam.follow) $('#drift-text').textContent = `혼자 둘러보는 중 · Jam은 "${name}"에 있어요`;
  else if (!jam.canGo(url)) $('#drift-text').textContent = `다른 사이트는 나만 보고 있어요 · Jam은 "${name}"에 있어요`;
  else $('#drift-text').textContent = `Jam은 지금 "${name}" 페이지에 있어요`;
}

// ======================================================================
// Jam 오버레이 + 사람 따라가기
//  - 패널을 숨겨도 페이지 아래에 작은 오버레이가 떠 있고, 사람을 누르면 그 사람이 보는 곳을 계속 따라간다
//  - 직접 스크롤하거나 테두리 라벨을 누르면 멈춘다
// ======================================================================
let overlayKey = '';
function renderOverlay() {
  const ov = $('#jam-overlay');
  ov.hidden = !jam.active;
  if (!jam.active) return;
  const others = jam.room.members.filter((m) => m.id !== jam.you.id);
  const unread = jam.unread && $('#jam-panel').classList.contains('collapsed') ? jam.unread : 0;
  const key = JSON.stringify([others.map((m) => [m.id, m.name, m.color, statusOf(m)]), jam.followingId, unread]);
  if (key === overlayKey) return;
  overlayKey = key;
  $('#ov-unread').hidden = !unread;
  $('#ov-unread').textContent = String(unread);
  $('#ov-people').replaceChildren(
    ...(others.length
      ? others.map((m) => {
          const p = m.presence || {};
          const st = p.private ? '🔐' : p.ad ? '📺' : p.away ? '💤' : '';
          const following = jam.followingId === m.id;
          return el(
            'button',
            {
              class: `ov-person${following ? ' following' : ''}`,
              style: { background: m.color, '--ring': m.color },
              title: `${m.name} · ${statusOf(m)}\n${following ? '클릭하면 따라가기를 멈춰요' : '클릭하면 이 사람이 보는 곳을 따라가요'}`,
              onclick: () => toggleFollow(m.id),
            },
            [...m.name][0]?.toUpperCase() || '?',
            st ? el('span', { class: 'st' }, st) : null
          );
        })
      : [el('span', { class: 'ov-empty' }, '친구를 기다리는 중…')])
  );
}

function toggleFollow(id) {
  if (jam.followingId === id) stopFollow();
  else startFollow(id);
}

function startFollow(id) {
  const m = jam.member(id);
  if (!m) return;
  jam.followingId = id;
  if (activeTab !== jam.tab) activateTab(jam.tab);
  syncToFollowed();
  renderOverlay();
  renderFollowFrame();
  toast(`👁 ${m.name}님이 보는 곳을 따라가요 · 직접 스크롤하면 멈춰요`);
}

function stopFollow(reason) {
  if (!jam.followingId) return;
  jam.followingId = null;
  renderOverlay();
  renderFollowFrame();
  if (reason) toast(reason);
}

function syncToFollowed() {
  const m = jam.member(jam.followingId);
  const tab = jam.tab;
  if (!m || !tab) return stopFollow();
  const p = m.presence || {};
  if (p.private) return renderFollowFrame(); // 상대가 로그인 중이면 기다린다
  const url = p.url || m.view?.url;
  if (url && isShareable(url) && !sameDoc(url, tab.url)) {
    followNavigate(url); // 그 사람이 있는 페이지로 (나만 이동, 다른 사람에게 퍼지지 않음)
  } else if (m.view && tab.ready && sameDoc(m.view.url, tab.url)) {
    tab.webview.send('jam:follow-view', { id: m.id, ...m.view });
  }
  renderFollowFrame();
}

function renderFollowFrame() {
  const m = jam.active && jam.member(jam.followingId);
  const show = !!m && activeTab === jam.tab;
  $('#follow-frame').hidden = !show;
  if (!show) return;
  $('#follow-frame').style.setProperty('--follow', m.color);
  const p = m.presence || {};
  $('#follow-label').textContent = p.private
    ? `👁 ${m.name}님이 로그인 중이에요 · 끝나면 계속 따라가요 (누르면 그만)`
    : `👁 ${m.name}님 화면 따라가는 중${m.view ? ` · ${resolutionText(m.view)}` : ''} (누르면 그만)`;
}
$('#follow-label').addEventListener('click', () => stopFollow('따라가기를 멈췄어요'));

// ---------- 패널 숨기기 ----------
function setPanelHidden(hidden) {
  $('#jam-panel').classList.toggle('collapsed', hidden);
  try { localStorage.setItem('jam-panel-hidden', hidden ? '1' : '0'); } catch {}
  if (!hidden) jam.unread = 0;
  renderOverlay();
}
const togglePanel = () => setPanelHidden(!$('#jam-panel').classList.contains('collapsed'));
try {
  if (localStorage.getItem('jam-panel-hidden') === '1') $('#jam-panel').classList.add('collapsed');
} catch {}
document.querySelectorAll('.panel-close').forEach((b) => b.addEventListener('click', () => setPanelHidden(true)));
$('#ov-panel').addEventListener('click', togglePanel);

// 호스트: 참여 요청 카드 (수락 / 거절)
function renderRequests() {
  const box = $('#join-requests');
  const list = jam.active && jam.isHost() ? [...(jam.requests || new Map()).values()] : [];
  box.hidden = list.length === 0;
  box.replaceChildren(
    ...list.map((r) =>
      el(
        'div',
        { class: 'req-card' },
        el(
          'div',
          { class: 'req-text' },
          el('b', {}, r.name),
          '님이 Jam에 들어오려고 해요',
          el('div', { class: 'muted small' }, String(r.ip).startsWith('relay:') ? `인터넷(중계 서버)으로 접속 · ${r.ip.slice(6)}` : `같은 네트워크에서 접속 · ${r.ip}`),
          r.friend
            ? el('div', { class: 'req-id friend' }, `⭐ 내 친구 ${account.friendName(r.fp) || ''} (서명으로 본인 확인됨)`)
            : r.fp
              ? el('div', { class: 'req-id', title: '친구로 추가하지 않은 브라우저 계정이에요' }, `🔏 브라우저 계정 확인됨 · 지문 ${account.fpPretty(r.fp).slice(0, 14)}…`)
              : el('div', { class: 'req-id unverified' }, '⚠️ 신원 확인 안 됨 (브라우저 계정 없이 접속) · 이름은 누구나 쓸 수 있어요')
        ),
        el(
          'div',
          { class: 'req-actions' },
          el('button', { class: 'mini-btn active', onclick: () => answerRequest(r.id, true) }, '수락'),
          el('button', { class: 'mini-btn danger', onclick: () => answerRequest(r.id, false) }, '거절')
        )
      )
    )
  );
}
function answerRequest(id, ok) {
  jam.send({ type: 'approve', id, ok });
  jam.requests.delete(id);
  renderRequests();
}

function chatScroll() {
  const c = $('#chat');
  c.scrollTop = c.scrollHeight;
}
function addChat(msg) {
  $('#chat').append(el('li', {}, el('span', { class: 'who', style: { color: msg.color } }, msg.name), msg.text));
  chatScroll();
  // 패널을 숨겨 둔 상태면 오버레이에 읽지 않은 수 + 짧은 알림
  if ($('#jam-panel').classList.contains('collapsed') && msg.by !== jam.you?.id) {
    jam.unread++;
    renderOverlay();
    toast(`💬 ${msg.name}: ${msg.text.length > 60 ? msg.text.slice(0, 60) + '…' : msg.text}`);
  }
}
function addSystem(text) {
  $('#chat').append(el('li', { class: 'system' }, text));
  chatScroll();
}

function floatReaction(emoji, color) {
  const r = el(
    'div',
    { class: 'reaction', style: { left: `${10 + Math.random() * 80}%` } },
    emoji,
    el('span', { class: 'who', style: { background: color } })
  );
  $('#reaction-layer').append(r);
  setTimeout(() => r.remove(), 2500);
}

// ======================================================================
// Jam UI 이벤트
// ======================================================================
$('#start-jam').addEventListener('click', startJam);
$('#join-jam').addEventListener('click', joinJam);
$('#invite').addEventListener('keydown', (e) => e.key === 'Enter' && joinJam());
$('#leave-jam').addEventListener('click', () => leaveJam());
$('#copy-invite').addEventListener('click', async () => {
  await jamApp.copy(jam.invite);
  toast('초대 코드를 복사했어요');
});
$('#jam-status').addEventListener('click', togglePanel);
$('#access-live').addEventListener('change', (e) => {
  const access = e.target.value;
  if (access === 'friends' && !account.isUnlocked()) {
    toast('"친구만" 으로 바꾸려면 브라우저 계정에 로그인해야 해요');
    e.target.value = jam.room.settings.access || 'approval';
    return;
  }
  // 친구만으로 바꿀 때 지금 친구 목록도 함께 (내 PC 의 서버에만)
  jam.send(access === 'friends' ? { type: 'settings', access, allow: account.friendFps() } : { type: 'settings', access });
});

function rejoinJamPage() {
  const cur = jam.room?.current;
  if (!cur || !jam.tab) return;
  jam.lastSyncedUrl = cur.url;
  followNavigate(cur.url);
}

$('#follow').addEventListener('change', (e) => {
  jam.follow = e.target.checked;
  if (jam.follow && jam.room?.current && jam.tab && !sameDoc(jam.tab.url, jam.room.current.url)) rejoinJamPage();
  if (jam.follow) applyMedia();
  updateDrift();
});
$('#follow-scroll').addEventListener('change', (e) => {
  jam.followScroll = e.target.checked;
});
$('#allow-all').addEventListener('change', (e) => {
  jam.send({ type: 'settings', allowAllCrossSite: e.target.checked });
});

$('#login-skip').addEventListener('click', () => finishLoginWait(false));

$('#drift-join').addEventListener('click', () => {
  if (!jam.follow) {
    jam.follow = true;
    $('#follow').checked = true;
  }
  rejoinJamPage();
  activateTab(jam.tab);
});

$('#add-to-queue').addEventListener('click', () => {
  if (!jam.active || !activeTab || !isShareable(activeTab.url)) return;
  jam.send({ type: 'queue:add', url: activeTab.url, title: activeTab.title });
  toast('대기열에 추가했어요');
});
$('#queue-next').addEventListener('click', () => jam.send({ type: 'queue:next' }));

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  jam.send({ type: 'chat', text });
  input.value = '';
});
$('#reactions').addEventListener('click', (e) => {
  const emoji = e.target.closest('button')?.dataset.emoji;
  if (emoji) jam.send({ type: 'reaction', emoji });
});

// ======================================================================
// 시작
// ======================================================================
// customize.js 까지 모두 읽은 뒤에 시작 (지난번 탭 복원 등)
// 브라우저 계정이 있으면 잠금을 푼 뒤에 탭을 연다 (지난번 탭 · 기록이 잠금 화면 뒤에서 열리지 않게)
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await account.gate();
  } catch (e) {
    console.error(e);
  }
  ui.boot();
  renderJam();
});
