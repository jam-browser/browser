/**
 * 중계 서버의 브라우저 계정 API (메인 프로세스에서만) — 서버 쪽: jam-browser/backend 의 /account/*
 *  - 비밀번호는 보내지 않음. 보내는 건 아이디 · auth(비밀번호에서 만든 로그인 확인 값) · 암호화된 금고 파일
 *  - 주소: 중계 서버 주소 그대로 ("host:port" · ws(s):// · http(s)://) → http(s)://host:port
 */
'use strict';
const http = require('http');
const https = require('https');

const RELAY_PORT = 3031;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function serverBase(addr) {
  let s = String(addr || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  const secure = /^(wss|https):\/\//i.test(s);
  s = s.replace(/^(wss?|https?):\/\//i, '');
  if (!/^[^\s/]+$/.test(s)) return null;
  if (!secure && !/:\d+$/.test(s) && !/^\[.*\]$/.test(s)) s += ':' + RELAY_PORT;
  return `${secure ? 'https' : 'http'}://${s}`;
}
// 인터넷 주소를 암호화 없이(http) 쓰는지 — 화면에 경고용
function insecureInternet(base) {
  try {
    const u = new URL(base);
    if (u.protocol === 'https:') return false;
    const h = u.hostname.replace(/^\[|\]$/g, '');
    return !(/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|f[cd])/i.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local') || h.endsWith('.localhost'));
  } catch {
    return true;
  }
}

const MESSAGES = {
  'bad-login': '아이디나 비밀번호가 맞지 않아요',
  'id-taken': '이미 있는 아이디예요',
  'bad-invite': '초대 코드가 맞지 않거나 이미 썼어요',
  'signup-closed': '이 서버는 지금 가입을 받지 않아요',
  'slow-down': '시도가 너무 많아요. 잠시 뒤에 다시 해 주세요',
  locked: '로그인 실패가 많아 이 아이디가 잠시 잠겼어요. 잠시 뒤에 다시 해 주세요',
  'bad-token': '서버 로그인이 끝났어요',
  conflict: '다른 기기에서 먼저 바뀌었어요',
};

class AccountError extends Error {
  constructor(code, message, status, body) {
    super(message || MESSAGES[code] || code);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

function request(base, method, path, { body, token, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(path, base);
    } catch {
      return reject(new AccountError('bad-server', '서버 주소가 올바르지 않아요'));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (data) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': data.length });
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = mod.request(u, { method, headers, timeout }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) req.destroy(new Error('too big'));
        else chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
        if (res.statusCode === 304) return resolve({ status: 304, json: null });
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (json === null && text) return reject(new AccountError('not-supported', '이 중계 서버는 브라우저 계정을 몰라요 (중계 서버 1.1.0 부터)', res.statusCode));
          return resolve({ status: res.statusCode, json: json || {} });
        }
        if (res.statusCode === 404 && !json) return reject(new AccountError('not-supported', '이 중계 서버는 브라우저 계정을 몰라요 (중계 서버 1.1.0 부터)', 404));
        const code = (json && json.error) || `http-${res.statusCode}`;
        reject(new AccountError(code, MESSAGES[code] || (json && json.message) || `서버 오류 (${res.statusCode})`, res.statusCode, json));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(new AccountError('offline', `서버에 연결할 수 없어요 (${e.message === 'timeout' ? '시간 초과' : e.code || e.message})`)));
    if (data) req.write(data);
    req.end();
  });
}

const b64 = (buf) => Buffer.from(buf).toString('base64');

function client(base) {
  return {
    base,
    prelogin: (id) => request(base, 'POST', '/account/prelogin', { body: { id } }).then((r) => r.json.kdf),
    register: (id, auth, vault, invite) => request(base, 'POST', '/account/register', { body: { id, auth: b64(auth), vault, invite: invite || undefined } }).then((r) => r.json),
    login: (id, auth) => request(base, 'POST', '/account/login', { body: { id, auth: b64(auth) } }).then((r) => r.json),
    getVault: (token, rev) => request(base, 'GET', `/account/vault${rev ? `?rev=${rev}` : ''}`, { token }).then((r) => (r.status === 304 ? null : r.json)),
    putVault: (token, baseRev, vault) => request(base, 'PUT', '/account/vault', { token, body: { baseRev, vault } }).then((r) => r.json),
    password: (token, auth, newAuth, baseRev, vault) =>
      request(base, 'POST', '/account/password', { token, body: { auth: b64(auth), newAuth: b64(newAuth), baseRev, vault } }).then((r) => r.json),
    logout: (token) => request(base, 'POST', '/account/logout', { token, body: {} }).catch(() => null),
    remove: (token, auth) => request(base, 'POST', '/account/delete', { token, body: { auth: b64(auth) } }).then((r) => r.json),
  };
}

// ---------- 어느 주소로 로그인할지: 온라인이면 원래 주소, 인터넷이 안 되면 같은 네트워크(LAN) 주소 ----------
// LAN 주소는 처음 로그인할 때 서버가 알려 준 것만 쓰고, 그 전에 서버 신원 키 서명(hello)을 확인해요.
// (다른 와이파이에 같은 192.168.x.x 가 있어도 거기로 로그인 값을 보내지 않게)
const crypto = require('crypto');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
async function hello(base, timeout = 3000) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const r = await request(base, 'GET', `/account/hello?nonce=${nonce}`, { timeout });
  return { nonce, key: r.json.key, sig: r.json.sig };
}
function verifyHello(pinnedKey, h) {
  try {
    if (!pinnedKey || h.key !== pinnedKey) return false;
    const pub = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(pinnedKey, 'base64url')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(`jam-relay-hello|${h.nonce}`), pub, Buffer.from(String(h.sig || ''), 'base64url'));
  } catch {
    return false;
  }
}
const isLanBase = (b) => {
  try {
    const h = new URL(b).hostname;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(h); // 사설 주소 (+ 이 PC — 서버를 같은 PC 에서 돌릴 때)
  } catch {
    return false;
  }
};
/**
 * { server(원래 주소), lan: [LAN 주소], key: 처음 받은 서버 키 } → { api, via: 'online' | 'lan', base }
 * 원래 주소가 응답하면(오류 응답이어도) 그 주소. 연결 자체가 안 되면 LAN 주소 중 서버 키가 맞는 곳. 둘 다 안 되면 offline
 */
async function connect({ server, lan = [], key = null } = {}, { timeout = 4000 } = {}) {
  try {
    await hello(server, timeout);
    return { api: client(server), via: 'online', base: server };
  } catch (e) {
    if (e.code !== 'offline') return { api: client(server), via: 'online', base: server }; // 닿기는 함 (예전 서버 등)
  }
  const candidates = (Array.isArray(lan) ? lan : []).filter((b) => typeof b === 'string' && isLanBase(b) && b !== server).slice(0, 4);
  if (key && candidates.length) {
    const found = await Promise.all(candidates.map(async (b) => {
      try {
        return verifyHello(key, await hello(b, 2500)) ? b : null;
      } catch {
        return null;
      }
    }));
    const base = found.find(Boolean);
    if (base) return { api: client(base), via: 'lan', base };
  }
  throw new AccountError('offline', candidates.length && key ? '중계 서버에 연결할 수 없어요 (인터넷 주소 · 같은 네트워크 주소 모두 안 돼요)' : '중계 서버에 연결할 수 없어요');
}

module.exports = { client, connect, hello, verifyHello, serverBase, insecureInternet, AccountError, ID_RE, MESSAGES };
