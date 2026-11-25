/**
 * 친구 상태 (온라인 · 자리 비움 · 보는 사이트) — 친구 둘만 풀 수 있는 암호문을 중계 서버 메모리에 잠깐 맡김
 *
 *  친구 코드에 이미 들어 있는 Ed25519 공개 키 → X25519 로 바꿔서, 친구마다 둘만 아는 공유 비밀(ss)을 만듦
 *    (새로 친구 코드를 주고받을 필요 없음. 계정 신원 키 하나로 서명 · 상태 둘 다)
 *
 *    ss = X25519(내 개인 키, 친구 공개 키) = X25519(친구 개인 키, 내 공개 키)
 *    key(A→B) = HKDF(ss, "key|A|B")            — A 가 B 에게 보이는 상태의 암호 키 (방향마다 따로)
 *    id(A→B, 시간대) = HKDF(ss, "id|A|B|시간대") — 중계 서버가 보는 값. 1시간마다 바뀌어서 오래 이어 붙여 보기 어려움
 *
 *  중계 서버는 무작위처럼 보이는 ID 와 암호문만 봐요 (누가 누구 친구인지 · 무슨 사이트인지 모름)
 *  서로 친구로 추가해야 보여요 (한쪽만 추가하면 ss 를 만들 수는 있어도 상대가 올리지 않음)
 */
'use strict';
const crypto = require('crypto');

const AAD = Buffer.from('jam-fstatus-v1');
const SALT = Buffer.from('jam-friend-status-v1');
const EPOCH_MS = 3600e3;
const MAX_BLOB = 1024;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const P = (1n << 255n) - 19n;

const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');

const modPow = (b, e, m) => {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
};
const leToBig = (buf) => {
  let n = 0n;
  for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]);
  return n;
};
const bigToLe = (n, len) => {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
};

/** Ed25519 공개 키(32바이트 raw, base64url) → X25519 공개 키 raw: u = (1 + y) / (1 - y) mod p */
function edPubToX(pubB64u) {
  const raw = Buffer.from(String(pubB64u || ''), 'base64url');
  if (raw.length !== 32) return null;
  const yb = Buffer.from(raw);
  yb[31] &= 0x7f;
  const y = leToBig(yb);
  if (y >= P) return null;
  const den = (1n - y + P) % P;
  if (den === 0n) return null;
  const u = ((1n + y) * modPow(den, P - 2n, P)) % P;
  return bigToLe(u, 32);
}

/** Ed25519 개인 키(PKCS8 DER base64) → X25519 개인 키 (SHA-512(시드) 앞 32바이트, X25519 가 알아서 클램핑) */
function edPrivToX(privB64) {
  const der = Buffer.from(String(privB64 || ''), 'base64');
  if (der.length < 32) return null;
  const seed = der.subarray(der.length - 32);
  const h = crypto.createHash('sha512').update(seed).digest().subarray(0, 32);
  try {
    return crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, h]), format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  } finally {
    h.fill(0);
  }
}

/** 나와 친구 둘만 아는 32바이트 (친구 공개 키가 이상하면 null) */
function pairSecret(myPrivB64, friendPub) {
  const xp = edPubToX(friendPub);
  const mine = edPrivToX(myPrivB64);
  if (!xp || !mine) return null;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([X_SPKI, xp]), format: 'der', type: 'spki' });
    const ss = crypto.diffieHellman({ privateKey: mine, publicKey: pub });
    if (ss.every((b) => b === 0)) return null; // 작은 위수 점
    return ss;
  } catch {
    return null;
  }
}

const hk = (ss, info, len = 32) => Buffer.from(crypto.hkdfSync('sha256', ss, SALT, Buffer.from(info), len));
const epochOf = (now) => Math.floor(now / EPOCH_MS);

/** 내가 친구에게 올릴 곳: { id, key } (지금 시간대) */
function outbox(ss, myPub, friendPub, now = Date.now()) {
  return { id: hk(ss, `id|${myPub}|${friendPub}|${epochOf(now)}`).toString('base64url'), key: hk(ss, `key|${myPub}|${friendPub}`) };
}
/** 친구가 나에게 올린 곳: 시계가 조금 달라도 찾게 앞뒤 시간대까지 { key, ids } */
function inbox(ss, myPub, friendPub, now = Date.now()) {
  const e = epochOf(now);
  return {
    key: hk(ss, `key|${friendPub}|${myPub}`),
    ids: [e - 1, e, e + 1].map((x) => hk(ss, `id|${friendPub}|${myPub}|${x}`).toString('base64url')),
  };
}

const STATES = new Set(['online', 'away']);
/** 올리는 내용은 정해진 모양만 (다른 값이 섞여 나가지 않게) */
function clean(st) {
  const o = { v: 1, at: Number(st && st.at) || Date.now(), st: STATES.has(st && st.st) ? st.st : 'online' };
  const site = st && typeof st.site === 'string' ? st.site.trim().toLowerCase() : '';
  if (site && site.length <= 80 && /^[a-z0-9.-]+(:\d{1,5})?$/.test(site)) o.site = site;
  if (st && st.jam === true) o.jam = true;
  return o;
}

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(clean(obj)))), c.final()]);
  const out = Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
  if (out.length > MAX_BLOB) throw new Error('status too large');
  return out;
}
function open(key, blob) {
  try {
    if (typeof blob !== 'string' || blob.length > MAX_BLOB) return null;
    const b = Buffer.from(blob, 'base64url');
    if (b.length < 12 + 16 + 2) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAAD(AAD);
    d.setAuthTag(b.subarray(b.length - 16));
    const o = JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'));
    return o && typeof o === 'object' && o.v === 1 ? clean(o) : null;
  } catch {
    return null;
  }
}

// ws(s)://host:port → http(s)://host:port/friends/<put|get>
function endpoint(relayWs, what) {
  const m = /^(wss?):\/\/([^\s/]+)$/i.exec(String(relayWs || ''));
  if (!m || (what !== 'put' && what !== 'get')) return null;
  return `${m[1].toLowerCase() === 'wss' ? 'https' : 'http'}://${m[2]}/friends/${what}`;
}

module.exports = { pairSecret, outbox, inbox, seal, open, clean, endpoint, edPubToX, edPrivToX, EPOCH_MS, MAX_BLOB, ID_RE, X_SPKI };
