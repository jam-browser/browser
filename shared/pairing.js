'use strict';
/**
 * 근처 Jam 페어링 (초대 링크 없이, 같은 네트워크에서)  — Node 전용 (호스트 Jam 서버 · 메인 프로세스 · 테스트)
 *
 *   참여자 → 서버: 임시 공개 키 A (X25519)
 *   서버 → 참여자: 임시 공개 키 B
 *   둘 다: th  = SHA-256("jam-pair v1" | A | B | 서버 nonce | 방 코드)        ← 이 연결의 기록
 *          K   = HKDF(X25519 공유값, th, "jam-pair key")                    ← 둘만 아는 임시 키
 *          SAS = HKDF(X25519 공유값, th, "jam-pair sas") → 6자리 숫자         ← 화면에 띄워 사람이 비교
 *
 * 중간에서 누가 가로채 각자와 따로 키 교환을 하면 A·B 가 달라져 양쪽 6자리가 달라진다 (블루투스 페어링과 같은 원리).
 * 브라우저 계정이 있으면 th 에 Ed25519 서명을 붙여 친구임을 증명한다 (shared/identity.js signPair).
 */
const crypto = require('crypto');

const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

function newEphemeral() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { pub: b64u(publicKey.export({ type: 'spki', format: 'der' }).subarray(X25519_SPKI.length)), priv: privateKey };
}

function peerKey(pubB64) {
  const raw = unb64u(pubB64);
  if (raw.length !== 32) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** a = 참여자 공개 키, b = 서버 공개 키 (둘 다 base64url) */
function transcript(a, b, nonce, code) {
  return crypto.createHash('sha256').update(`jam-pair v1|${a}|${b}|${nonce}|${String(code).toUpperCase()}`).digest('hex');
}

/** 내 임시 개인 키 + 상대 공개 키 → { key, sas } (상대 키가 이상하면 null) */
function derive(myPriv, theirPubB64, th) {
  const pk = peerKey(theirPubB64);
  if (!pk) return null;
  let shared;
  try {
    shared = crypto.diffieHellman({ privateKey: myPriv, publicKey: pk });
  } catch {
    return null;
  }
  if (shared.every((x) => x === 0)) return null; // 작은 위수 점(약한 키) 거절
  const salt = Buffer.from(th, 'hex');
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('jam-pair key'), 32));
  const sasBytes = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('jam-pair sas'), 4));
  shared.fill(0);
  const sas = String(sasBytes.readUInt32BE(0) % 1000000).padStart(6, '0');
  return { key, sas };
}

function sealBox(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('jam-pair box'));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}

function openBox(key, box) {
  const buf = unb64u(box);
  if (buf.length < 29 || buf.length > 8192) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAAD(Buffer.from('jam-pair box'));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

const formatSas = (sas) => `${String(sas).slice(0, 3)} ${String(sas).slice(3)}`;

module.exports = { newEphemeral, transcript, derive, sealBox, openBox, formatSas, peerKey };
