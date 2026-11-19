/**
 * 다른 기기에서 이어 보기 (같은 브라우저 계정) — 중계 서버에는 무작위 ID 와 암호문만
 *
 *   계정 신원 개인 키 ─HKDF→ presenceId  (중계 서버가 보는 값, 32바이트 무작위처럼 보임)
 *                     ─HKDF→ presenceKey (AES-256-GCM, 이 계정 기기들만 앎)
 *
 *  호스트 기기: Jam 을 여는 동안 중계 서버에 { presenceId: seal(presenceKey, {link, title, …}) } 를 맡김 (메모리에만, 호스트 연결이 끊기면 지워짐)
 *  다른 기기:   같은 계정으로 잠금을 풀면 presenceId 로 찾아서 presenceKey 로 풀고 → 초대 링크로 참여 (호스트는 같은 계정 서명이면 승인 없이)
 *  공개 키로는 두 값을 만들 수 없어서, 친구(공개 키를 아는 사람)도 내 Jam 을 찾지 못해요
 */
'use strict';
const crypto = require('crypto');

const AAD = Buffer.from('jam-presence-v1');
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_BLOB = 2048;

function derive(privB64) {
  if (!privB64 || typeof privB64 !== 'string') return null;
  const ikm = Buffer.from(privB64, 'base64');
  const salt = Buffer.from('jam-browser');
  const id = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('jam-presence-id'), 32)).toString('base64url');
  const key = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('jam-presence-key'), 32));
  return { id, key };
}

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
  const out = Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
  if (out.length > MAX_BLOB) throw new Error('presence too large');
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
    const pt = Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
    const o = JSON.parse(pt.toString('utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

// ws(s)://host:port → http(s)://host:port/presence/<id>
function lookupUrl(relayWs, id) {
  const m = /^(wss?):\/\/([^\s/]+)$/i.exec(String(relayWs || ''));
  if (!m || !ID_RE.test(id)) return null;
  return `${m[1].toLowerCase() === 'wss' ? 'https' : 'http'}://${m[2]}/presence/${id}`;
}

module.exports = { derive, seal, open, lookupUrl, ID_RE, MAX_BLOB };
