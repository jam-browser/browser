'use strict';
/**
 * Jam 신원 (친구 확인용, Node 전용: 서버 · 메인 프로세스 · 테스트)
 *
 * - 브라우저 계정을 만들 때 Ed25519 키 쌍을 만든다. 비밀 키는 비밀번호 뱅크 안에 암호화되어 이 PC 에만 있다
 * - 친구 코드 = 공개 키 (+ 보여줄 이름). 서로 친구 코드를 주고받아 등록
 * - "친구만" Jam 에 들어갈 때: 호스트 서버가 준 일회용 값(nonce)과 방 코드에 서명해서 "그 공개 키의 주인"임을 증명
 *   → 이름을 흉내 내거나 예전 서명을 다시 써도 통과하지 못한다
 * - 이 서명과 공개 키는 방 키로 암호화된 참여 메시지 안에 들어가서, 중계 서버는 볼 수 없다
 */
const crypto = require('crypto');

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // Ed25519 공개 키 DER 머리
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

function newIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length);
  return { pub: b64u(pubRaw), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}

function publicKeyFrom(pub) {
  const raw = unb64u(pub);
  if (raw.length !== 32) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** 공개 키 지문 (사람이 비교하기 쉬운 24글자) */
function fingerprint(pub) {
  const raw = unb64u(pub);
  if (raw.length !== 32) return null;
  const h = crypto.createHash('sha256').update(raw).digest().subarray(0, 15);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of h) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

const joinMessage = (nonce, code) => Buffer.from(`jam-join|${nonce}|${String(code).toUpperCase()}`);

function signJoin(privB64, nonce, code) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
  return b64u(crypto.sign(null, joinMessage(nonce, code), key));
}

function verifyJoin(pub, sig, nonce, code) {
  const key = publicKeyFrom(pub);
  if (!key) return false;
  const s = unb64u(sig);
  if (s.length !== 64) return false;
  try {
    return crypto.verify(null, joinMessage(nonce, code), key, s);
  } catch {
    return false;
  }
}

// 친구 코드: jamfriend:<공개키>/<이름(선택)>
function friendCode(pub, name) {
  return `jamfriend:${pub}${name ? '/' + encodeURIComponent(String(name).slice(0, 24)) : ''}`;
}
function parseFriendCode(text) {
  const m = /^jamfriend:([A-Za-z0-9_-]{43})(?:\/(.*))?$/.exec(String(text || '').trim());
  if (!m || !publicKeyFrom(m[1])) return null;
  let name = '';
  try {
    name = m[2] ? decodeURIComponent(m[2]).replace(/\s+/g, ' ').trim().slice(0, 24) : '';
  } catch {}
  return { pub: m[1], name, fp: fingerprint(m[1]) };
}

// 근처 페어링: 이 연결의 기록(th, SHA-256 hex)에만 서명 (shared/pairing.js)
const pairMessage = (th) => Buffer.from(`jam-pair|${th}`);
function signPair(privB64, th) {
  if (!/^[0-9a-f]{64}$/.test(String(th))) throw new Error('bad transcript');
  const key = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
  return b64u(crypto.sign(null, pairMessage(th), key));
}
function verifyPair(pub, sig, th) {
  const key = publicKeyFrom(pub);
  const s = unb64u(sig);
  if (!key || s.length !== 64 || !/^[0-9a-f]{64}$/.test(String(th))) return false;
  try {
    return crypto.verify(null, pairMessage(th), key, s);
  } catch {
    return false;
  }
}

module.exports = { newIdentity, fingerprint, signJoin, verifyJoin, signPair, verifyPair, friendCode, parseFriendCode, publicKeyFrom };
