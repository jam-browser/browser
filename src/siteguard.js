/**
 * 사이트 보호 (메인 프로세스)
 *  - 추적기 · 광고 차단: EasyPrivacy · uBlock 목록 (Ghostery 차단 엔진, 네트워크 요청만 — 페이지에 스크립트를 넣지 않음)
 *    목록은 하루에 한 번 받아서 이 PC 에 캐시 (받을 때 보내는 건 목록 주소뿐)
 *  - 서드파티 쿠키 차단: 지금 보는 사이트가 아닌 곳으로 가는 요청의 Cookie 를 빼고, 받은 Set-Cookie 를 버림
 *  - 사이트 권한: 위치 · 알림 · 카메라 · 마이크 · 클립보드 읽기 · MIDI 는 사이트(출처)마다 물어보고 기억
 *  - 사이트별 예외 (🛡 끄기 · 쿠키 허용) 와 권한은 userData/site-settings.json 에만 저장
 *
 * 웹페이지(webview) 요청에만 적용. 앱 화면 · 확장 프로그램 · 중계 서버 연결에는 손대지 않음
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { siteOf, localKind } = require('../shared/site');

const LIST_BASE = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';
const LISTS = {
  trackers: [`${LIST_BASE}/easylist/easyprivacy.txt`, `${LIST_BASE}/ublock-origin/privacy.txt`],
  ads: null, // adsAndTrackingLists (엔진 패키지에서)
};
const PERM_KINDS = {
  geolocation: '위치',
  notifications: '알림',
  camera: '카메라',
  microphone: '마이크',
  'clipboard-read': '클립보드 읽기',
  midi: 'MIDI 장치',
};
const TYPE_MAP = {
  mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font',
  object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'csp_report', media: 'media', webSocket: 'websocket', other: 'other',
};
const ASK_TIMEOUT_MS = 60000;

function permKinds(permission, details = {}) {
  if (permission === 'media') {
    const t = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
    const out = [];
    if (t.includes('video')) out.push('camera');
    if (t.includes('audio')) out.push('microphone');
    return out;
  }
  if (permission === 'midiSysex' || permission === 'midi') return ['midi'];
  return PERM_KINDS[permission] ? [permission] : [];
}

function setupSiteGuard({ app, ipcMain, net, webContents, getWindow, getPrefs, testMode = false }) {
  const dir = app.getPath('userData');
  const storeFile = path.join(dir, 'site-settings.json');
  const cacheDir = path.join(dir, 'contentblock');
  let store = { v: 1, sites: {}, perms: {} };
  try {
    const s = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    if (s && s.v === 1) store = { v: 1, sites: s.sites || {}, perms: s.perms || {} };
  } catch {}
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(storeFile + '.tmp', JSON.stringify(store));
        fs.renameSync(storeFile + '.tmp', storeFile);
      } catch (e) {
        console.error('사이트 설정 저장 실패:', e.message);
      }
    }, 200);
  }
  const send = (ch, data) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(ch, data);
  };
  const isApp = (e) => {
    const w = getWindow();
    return w && e.sender === w.webContents;
  };
  const webviewOf = (id) => {
    if (!Number.isInteger(id)) return null;
    const wc = webContents.fromId(id);
    return wc && !wc.isDestroyed() && wc.getType() === 'webview' ? wc : null;
  };
  const originOf = (u) => {
    try {
      const p = new URL(u);
      return p.protocol === 'https:' || p.protocol === 'http:' ? p.origin : null;
    } catch {
      return null;
    }
  };

  // ---------- 추적기 · 광고 차단 엔진 ----------
  let AB = null; // @ghostery/adblocker (처음 쓸 때 불러옴)
  const lib = () => (AB ||= require('@ghostery/adblocker'));
  let engine = null;
  let engineMode = 'off';
  let building = null;
  let refreshTimer = null;
  const cacheFile = (mode) => path.join(cacheDir, `${mode}.bin`);

  function loadCached(mode) {
    try {
      const buf = fs.readFileSync(cacheFile(mode));
      return { engine: lib().FiltersEngine.deserialize(new Uint8Array(buf)), at: fs.statSync(cacheFile(mode)).mtimeMs };
    } catch {
      return null; // 없음 · 엔진 버전이 바뀜 → 새로 받음
    }
  }
  async function build(mode) {
    const { FiltersEngine, adsAndTrackingLists } = lib();
    const cfg = { loadCosmeticFilters: false, loadNetworkFilters: true, loadCSPFilters: false, enableCompression: true };
    // 테스트: 받지 않고 주어진 목록 파일로
    if (testMode && process.env.JAM_TEST_BLOCKLIST) return FiltersEngine.parse(fs.readFileSync(process.env.JAM_TEST_BLOCKLIST, 'utf8'), cfg);
    const urls = mode === 'ads' ? adsAndTrackingLists : LISTS.trackers;
    const fetchImpl = (u) => net.fetch(u, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`${u} ${r.status}`);
      return r;
    });
    const e = await FiltersEngine.fromLists(fetchImpl, urls, cfg);
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile(mode) + '.tmp', Buffer.from(e.serialize()));
      fs.renameSync(cacheFile(mode) + '.tmp', cacheFile(mode));
    } catch {}
    return e;
  }
  function refresh(force = false) {
    const p = getPrefs();
    const mode = p.contentBlock || 'off';
    clearTimeout(refreshTimer);
    if (mode === 'off') {
      engine = null;
      engineMode = 'off';
      return Promise.resolve(null);
    }
    const maxAge = Math.max(1, Number(p.blockListHours) || 24) * 3600e3;
    if (engineMode !== mode) {
      engine = null;
      const c = testMode && process.env.JAM_TEST_BLOCKLIST ? null : loadCached(mode);
      if (c) {
        engine = c.engine;
        if (Date.now() - c.at < maxAge && !force) {
          engineMode = mode;
          refreshTimer = setTimeout(() => refresh(true), maxAge - (Date.now() - c.at));
          return Promise.resolve(engine);
        }
      }
      engineMode = mode;
    } else if (engine && !force) return Promise.resolve(engine);
    if (building) return building;
    building = build(mode)
      .then((e) => {
        if (engineMode === mode) engine = e;
        send('shield:ready', { mode, at: Date.now() });
        return e;
      })
      .catch((e) => {
        console.error('차단 목록 받기 실패 (가지고 있는 목록으로 계속):', e.message || e);
        return engine;
      })
      .finally(() => {
        building = null;
        if (engineMode !== 'off') refreshTimer = setTimeout(() => refresh(true), engine ? maxAge : 10 * 60e3);
      });
    return building;
  }

  // 탭마다 이 페이지에서 막은 수
  const stats = new Map(); // wcId → { n, hosts: Map }
  let statTimer = null;
  const dirty = new Set();
  function bump(wcId, url, local) {
    let s = stats.get(wcId);
    if (!s) stats.set(wcId, (s = { n: 0, hosts: new Map(), local: new Map() }));
    if (local) {
      let lh = '';
      try {
        lh = new URL(url).host;
      } catch {}
      s.local.set(lh, (s.local.get(lh) || 0) + 1);
    }
    s.n++;
    let h = '';
    try {
      h = new URL(url).hostname;
    } catch {}
    s.hosts.set(h, (s.hosts.get(h) || 0) + 1);
    dirty.add(wcId);
    if (!statTimer) {
      statTimer = setTimeout(() => {
        statTimer = null;
        for (const id of dirty) send('shield:count', { wcId: id, n: stats.get(id)?.n || 0 });
        dirty.clear();
      }, 400);
    }
  }
  function resetStats(wcId) {
    if (stats.delete(wcId)) send('shield:count', { wcId, n: 0 });
  }

  const siteEntry = (site) => store.sites[site] || {};
  function topOf(d) {
    const wc = webviewOf(d.webContentsId);
    return wc ? { wc, top: wc.getURL() } : null;
  }

  // onBeforeRequest (main.js 의 하나뿐인 리스너에서 부름). 결과가 있으면 그대로 cb 에
  function onRequest(d) {
    if (d.resourceType === 'mainFrame') {
      if (Number.isInteger(d.webContentsId)) resetStats(d.webContentsId);
      return null; // 페이지 이동 자체는 막지 않음
    }
    const t = topOf(d);
    if (!t) return null;
    const site = siteOf(t.top);
    if (!site) return null;
    // 인터넷 사이트 → 내 PC(루프백) · 같은 네트워크 주소: 막음 (공유기 관리 화면 조작 · 내 PC 의 프로그램 · Jam 서버 찌르기 방지)
    //  페이지 자체가 내 PC · 같은 네트워크에 있으면 그대로. 🛡 에서 사이트마다 허용
    if (getPrefs().blockLocalNet !== false) {
      let reqHost = '';
      let topHost = '';
      try {
        reqHost = new URL(d.url).hostname;
        topHost = new URL(t.top).hostname;
      } catch {}
      const kind = localKind(reqHost);
      if (kind && !localKind(topHost) && !siteEntry(site).localNet) {
        bump(t.wc.id, d.url, kind);
        send('shield:local', { wcId: t.wc.id, url: d.url.slice(0, 200), kind });
        return { cancel: true };
      }
    }
    if (!engine || engineMode === 'off' || siteEntry(site).shieldOff) return null;
    let source = t.top;
    try {
      if (d.frame && d.frame.url) source = d.frame.url;
    } catch {}
    const { Request } = lib();
    const req = Request.fromRawDetails({ url: d.url, sourceUrl: source, type: TYPE_MAP[d.resourceType] || 'other' });
    const r = engine.match(req);
    if (r.redirect && r.redirect.dataUrl) {
      bump(t.wc.id, d.url);
      return { redirectURL: r.redirect.dataUrl };
    }
    if (r.match) {
      bump(t.wc.id, d.url);
      return { cancel: true };
    }
    return null;
  }

  // ---------- 서드파티 쿠키 ----------
  function thirdParty(d) {
    if (d.resourceType === 'mainFrame') return null;
    if (getPrefs().thirdPartyCookies !== 'block') return null;
    const t = topOf(d);
    if (!t) return null;
    const top = siteOf(t.top);
    const req = siteOf(d.url);
    if (!top || !req || top === req || siteEntry(top).cookies3p) return null;
    return t;
  }
  // headerHook(d, headers) → true 면 바꿈 (세션마다 리스너가 하나뿐이라 다른 헤더 손질도 여기서 함께: Google 로그인 화면 UA)
  function attach(ses, { headerHook = null } = {}) {
    ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
      const h = { ...d.requestHeaders };
      let changed = false;
      if (headerHook) {
        try {
          changed = !!headerHook(d, h);
        } catch (e) {
          console.error('헤더 손질 오류:', e.message);
        }
      }
      if (thirdParty(d)) {
        for (const k of Object.keys(h)) {
          if (k.toLowerCase() === 'cookie') {
            delete h[k];
            changed = true;
          }
        }
      }
      cb(changed ? { requestHeaders: h } : {});
    });
    ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
      if (!d.responseHeaders || !thirdParty(d)) return cb({});
      const h = { ...d.responseHeaders };
      let changed = false;
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === 'set-cookie') {
          delete h[k];
          changed = true;
        }
      }
      cb(changed ? { responseHeaders: h } : {});
    });
  }

  // ---------- 사이트 권한 ----------
  const pending = new Map(); // id → { wcId, origin, kinds, callbacks, timer }
  let askSeq = 0;
  const decided = (origin, kind) => (store.perms[origin] || {})[kind];

  function finish(id, allow) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    for (const cb of p.callbacks) {
      try {
        cb(allow);
      } catch {}
    }
    send('perm:closed', { id });
  }
  // true = 여기서 처리함 (callback 은 나중에라도 꼭 부름)
  function requestPermission(wc, permission, details, callback) {
    const kinds = permKinds(permission, details);
    const host = wc && !wc.isDestroyed() && wc.getType() === 'webview' ? wc : null;
    const origin = originOf(details.requestingUrl || (host && host.getURL()));
    if (!kinds.length || !host || !origin) return callback(false);
    const vals = kinds.map((k) => decided(origin, k));
    if (vals.includes('deny')) return callback(false);
    if (vals.every((v) => v === 'allow')) return callback(true);
    if (getPrefs().permPrompt === 'deny') return callback(false);
    // 같은 탭 · 같은 출처 · 같은 권한을 이미 묻는 중이면 그 답을 같이 씀 (요청을 쏟아내도 창은 하나)
    for (const p of pending.values()) {
      if (p.wcId === host.id && p.origin === origin && p.kinds.join() === kinds.join()) {
        p.callbacks.push(callback);
        return;
      }
    }
    const id = ++askSeq;
    const p = { wcId: host.id, origin, kinds, callbacks: [callback], timer: setTimeout(() => finish(id, false), ASK_TIMEOUT_MS) };
    pending.set(id, p);
    host.once('destroyed', () => finish(id, false));
    send('perm:ask', { id, wcId: host.id, origin, kinds, labels: kinds.map((k) => PERM_KINDS[k]) });
  }
  function checkPermission(wc, permission, origin, details = {}) {
    const kinds = permKinds(permission, details);
    if (!kinds.length) return false;
    if (wc && !wc.isDestroyed() && wc.getType() !== 'webview') return false;
    const o = originOf(origin || details.requestingUrl || details.securityOrigin);
    return !!o && kinds.every((k) => decided(o, k) === 'allow');
  }
  ipcMain.on('perm:answer', (e, { id, decision } = {}) => {
    if (!isApp(e)) return;
    const p = pending.get(id);
    if (!p) return;
    if (decision === 'allow' || decision === 'deny') {
      store.perms[p.origin] = { ...(store.perms[p.origin] || {}) };
      for (const k of p.kinds) store.perms[p.origin][k] = decision;
      save();
    }
    finish(id, decision === 'allow' || decision === 'once');
  });

  // ---------- 앱 화면 (🛡 패널 · 설정) ----------
  const handle = (ch, fn) =>
    ipcMain.handle(ch, (e, arg = {}) => {
      if (!isApp(e)) throw new Error('forbidden');
      return fn(arg);
    });
  handle('site:info', ({ wcId }) => {
    const wc = webviewOf(wcId);
    const url = wc ? wc.getURL() : '';
    const site = siteOf(url);
    const origin = originOf(url);
    const s = stats.get(wcId);
    const p = getPrefs();
    return {
      site,
      origin,
      mode: p.contentBlock,
      cookiesMode: p.thirdPartyCookies,
      shieldOff: !!(site && siteEntry(site).shieldOff),
      cookies3p: !!(site && siteEntry(site).cookies3p),
      localNet: !!(site && siteEntry(site).localNet),
      localBlocked: s && s.local ? [...s.local.entries()] : [],
      perms: origin ? { ...(store.perms[origin] || {}) } : {},
      blocked: s ? s.n : 0,
      hosts: s ? [...s.hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) : [],
      ready: !!engine,
      labels: PERM_KINDS,
    };
  });
  handle('site:set', ({ site, origin, key, value }) => {
    if (key === 'shieldOff' || key === 'cookies3p' || key === 'localNet') {
      if (typeof site !== 'string' || !site || site.length > 253) return false;
      const e = { ...(store.sites[site] || {}) };
      if (value) e[key] = true;
      else delete e[key];
      if (Object.keys(e).length) store.sites[site] = e;
      else delete store.sites[site];
    } else if (key === 'perm') {
      const o = originOf(origin);
      const { kind, v } = value || {};
      if (!o || !PERM_KINDS[kind]) return false;
      const e = { ...(store.perms[o] || {}) };
      if (v === 'allow' || v === 'deny') e[kind] = v;
      else delete e[kind];
      if (Object.keys(e).length) store.perms[o] = e;
      else delete store.perms[o];
    } else return false;
    save();
    return true;
  });
  handle('site:list', () => ({ sites: store.sites, perms: store.perms, labels: PERM_KINDS }));
  handle('site:clear-all', () => {
    store = { v: 1, sites: {}, perms: {} };
    save();
    return true;
  });
  handle('shield:refresh', () => refresh(true).then((e) => ({ ok: !!e })));

  return {
    onRequest,
    attach,
    requestPermission,
    checkPermission,
    applyPrefs: () => refresh(false),
    // 테스트 · 확인용
    _state: () => ({ mode: engineMode, ready: !!engine }),
  };
}

module.exports = { setupSiteGuard, permKinds, PERM_KINDS };
