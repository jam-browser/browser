'use strict';
/**
 * Jam 보안 (Node 쪽: 서버 + 테스트). 앱 화면 쪽은 같은 규칙을 WebCrypto로 구현한다 (src/renderer/app.js).
 *
 *  초대 코드 = jam://호스트주소:포트/방코드/비밀키
 *   - 비밀키(32바이트)는 초대 코드에만 들어 있고, 네트워크로는 절대 보내지 않는다 (방을 만든 호스트 PC 안에서만 서버에 전달)
 *   - 참여할 때: 서버가 준 일회용 nonce 에 비밀키로 서명(HMAC)해서 "키를 안다"는 것만 증명
 *   - 그 뒤 모든 메시지는 비밀키에서 만든 AES-256-GCM 키로 암호화 + 위변조 검사
 *     (보내는 방향을 AAD로 넣어서 서버→클라이언트 메시지를 되돌려 보내는 공격도 막는다)
 */
const crypto = require('crypto');

const INFO_ENC = Buffer.from('jam-browser v1 enc');
const INFO_AUTH = Buffer.from('jam-browser v1 auth');
const C2S = Buffer.from('c2s');
const S2C = Buffer.from('s2c');

function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function deriveKeys(secretB64u) {
  const secret = Buffer.from(String(secretB64u), 'base64url');
  if (secret.length !== 32) throw new Error('bad secret');
  return {
    enc: Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), INFO_ENC, 32)),
    auth: Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), INFO_AUTH, 32)),
  };
}

function makeProof(keys, nonce, code) {
  return crypto.createHmac('sha256', keys.auth).update(`${nonce}:${code}`).digest('base64url');
}

function checkProof(keys, nonce, code, proof) {
  const expected = Buffer.from(makeProof(keys, nonce, code), 'base64url');
  let got;
  try {
    got = Buffer.from(String(proof), 'base64url');
  } catch {
    return false;
  }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

function seal(keys, obj, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys.enc, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

function open(keys, buf, aad) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 + 16 + 2) throw new Error('short frame');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', keys.enc, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

module.exports = { newSecret, deriveKeys, makeProof, checkProof, seal, open, C2S, S2C };
