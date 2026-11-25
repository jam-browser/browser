'use strict';
/**
 * 비밀번호 뱅크 / 브라우저 계정 암호화 (Node 전용, 메인 프로세스에서만 사용)
 *
 * ┌ 마스터 비밀번호 ─┐
 * │  + 개인 salt(32바이트, 계정마다 무작위)
 * │  → scrypt (N=2^17, r=8, p=1: 일부러 느리고 메모리를 많이 쓰는 해시 → 무차별 대입을 어렵게)
 * │  + 개인 비밀 키(160비트, 계정을 만들 때 생성. 이 PC 에는 Windows 계정 암호화로 보관, 다른 PC 에서는 직접 입력)
 * │  → HKDF-SHA256 → 64바이트 → [AES 키 32 | ChaCha 키 32]
 * └───────────────────┘
 *        │ 이중으로 감싼다
 *        ▼
 *   데이터 키(DEK, 32바이트 무작위) = ChaCha20+HMAC( AES-256-GCM( DEK ) )
 *        │ DEK 에서 다시 [AES 키 | ChaCha 키] 를 만들고
 *        ▼
 *   계정 데이터(이름·친구·로그인 목록) = ChaCha20+HMAC( AES-256-GCM( JSON ) )
 *   각 로그인의 비밀번호            = 항목마다 따로 한 번 더 이중 암호화 (풀린 상태에서도 평문으로 들고 있지 않음)
 *
 * - 비밀 키가 없으면 비밀번호를 알아도 못 열고, 비밀번호가 약해도 파일만으로는 대입 공격이 사실상 불가능
 * - 비밀번호 확인용 해시를 따로 저장하지 않음 (DEK 를 푸는 데 성공해야만 맞는 비밀번호)
 * - 모든 단계에 위변조 검사(GCM 인증 태그 / HMAC-SHA256)가 있어 한 바이트만 바뀌어도 열리지 않음
 * - 두 겹은 서로 다른 암호(AES 블록 암호 · ChaCha20 스트림 암호)와 서로 다른 키라서, 한쪽 알고리즘에 약점이 생기거나
 *   한쪽 키가 새도 다른 쪽이 데이터를 지킨다
 *
 * Electron 의 암호 라이브러리(BoringSSL)는 Node 의 cipher API 로 ChaCha20 을 내주지 않아서, 바깥 겹은
 * RFC 8439 ChaCha20 을 여기서 직접 계산하고 HMAC-SHA256 으로 인증한다 (encrypt-then-MAC).
 * test/vault-test.js 가 RFC 8439 시험 벡터 · OpenSSL 의 chacha20 결과와 똑같은지 확인한다.
 */
const crypto = require('crypto');

const FORMAT = 'jam-vault';
const VERSION = 1; // 금고 파일 형식
const SEAL_V = 2; // 이중 암호화 묶음 형식 (2 = AES-256-GCM 안 + ChaCha20/HMAC-SHA256 바깥)
const KDF_DEFAULT = { alg: 'scrypt', N: 1 << 17, r: 8, p: 1 };
const SECRET_KEY_BYTES = 20;
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- 비밀 키 표기 (예: JK1-ABCD-EFGH-…) ----------
function b32encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function formatSecretKey(buf) {
  const s = b32encode(buf); // 20바이트 → 32글자
  return 'JK1-' + s.match(/.{1,4}/g).join('-');
}
function parseSecretKey(text) {
  const s = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^JK1/, '');
  if (s.length !== 32) return null;
  const buf = b32decode(s);
  return buf && buf.length === SECRET_KEY_BYTES ? buf : null;
}

// ---------- 키 만들기 ----------
function scrypt(pw, salt, kdf) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, 64, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

async function deriveMasterKeys(password, salt, secretKey, kdf) {
  if (kdf.alg !== 'scrypt' || kdf.N < 1 << 14 || kdf.r < 8 || kdf.p < 1) throw new VaultError('bad-kdf', '지원하지 않는 설정이에요');
  const pw = Buffer.from(String(password).normalize('NFKC'), 'utf8');
  const stretched = await scrypt(pw, salt, kdf);
  pw.fill(0);
  const okm = Buffer.from(crypto.hkdfSync('sha256', stretched, secretKey, Buffer.from('jam-vault v1 master'), 64));
  stretched.fill(0);
  return { aes: okm.subarray(0, 32), chacha: okm.subarray(32, 64), wipe: () => okm.fill(0) };
}

function dataKeysFrom(dek) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), Buffer.from('jam-vault v1 data'), 64));
  return { aes: okm.subarray(0, 32), chacha: okm.subarray(32, 64), wipe: () => okm.fill(0) };
}

// ---------- ChaCha20 (RFC 8439) ----------
const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
function quarter(x, a, b, c, d) {
  x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16);
  x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
  x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8);
  x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7);
}
/** key 32바이트, nonce 12바이트, counter 32비트 → data 와 XOR (암호화 = 복호화) */
function chacha20(key, nonce, data, counter = 1) {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('chacha20 key/nonce size');
  const state = new Uint32Array(16);
  const x = new Uint32Array(16);
  const block = Buffer.alloc(64);
  const out = Buffer.alloc(data.length);
  state[0] = 0x61707865; state[1] = 0x3320646e; state[2] = 0x79622d32; state[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) state[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 3; i++) state[13 + i] = nonce.readUInt32LE(i * 4);
  for (let off = 0; off < data.length; off += 64) {
    state[12] = counter++;
    x.set(state);
    for (let r = 0; r < 10; r++) {
      quarter(x, 0, 4, 8, 12); quarter(x, 1, 5, 9, 13); quarter(x, 2, 6, 10, 14); quarter(x, 3, 7, 11, 15);
      quarter(x, 0, 5, 10, 15); quarter(x, 1, 6, 11, 12); quarter(x, 2, 7, 8, 13); quarter(x, 3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) block.writeUInt32LE((x[i] + state[i]) >>> 0, i * 4);
    const n = Math.min(64, data.length - off);
    for (let j = 0; j < n; j++) out[off + j] = data[off + j] ^ block[j];
  }
  state.fill(0);
  x.fill(0);
  block.fill(0);
  return out;
}

// 바깥 겹 키 32바이트에서 암호화 키와 인증(HMAC) 키를 따로 만든다
function outerKeys(k) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', k, Buffer.alloc(0), Buffer.from('jam-vault v2 outer'), 64));
  return { enc: okm.subarray(0, 32), mac: okm.subarray(32, 64), wipe: () => okm.fill(0) };
}
const outerMac = (macKey, label, nonce, ct) =>
  crypto.createHmac('sha256', macKey).update(`${label}|L2\0`).update(Buffer.from([SEAL_V])).update(nonce).update(ct).digest();

// ---------- 이중 암호화 (안쪽 AES-256-GCM, 바깥 ChaCha20 + HMAC-SHA256) ----------
function seal2(keys, plaintext, label) {
  const iv1 = crypto.randomBytes(12);
  const c1 = crypto.createCipheriv('aes-256-gcm', keys.aes, iv1);
  c1.setAAD(Buffer.from(`${label}|L1`));
  const ct1 = Buffer.concat([c1.update(plaintext), c1.final()]);
  const inner = Buffer.concat([iv1, c1.getAuthTag(), ct1]);
  const ok = outerKeys(keys.chacha);
  const iv2 = crypto.randomBytes(12);
  const ct2 = chacha20(ok.enc, iv2, inner);
  inner.fill(0);
  const tag2 = outerMac(ok.mac, label, iv2, ct2);
  ok.wipe();
  return Buffer.concat([Buffer.from([SEAL_V]), iv2, tag2, ct2]).toString('base64');
}

function open2(keys, sealed, label) {
  const buf = Buffer.from(String(sealed || ''), 'base64');
  if (buf.length < 1 + 12 + 32 + 12 + 16 || buf[0] !== SEAL_V) throw new VaultError('corrupt', '저장된 데이터가 손상됐어요');
  const ok = outerKeys(keys.chacha);
  try {
    const iv2 = buf.subarray(1, 13);
    const tag2 = buf.subarray(13, 45);
    const ct2 = buf.subarray(45);
    // 먼저 인증 확인 (상수 시간 비교), 맞을 때만 푼다
    if (!crypto.timingSafeEqual(outerMac(ok.mac, label, iv2, ct2), tag2)) throw new Error('outer auth');
    const inner = chacha20(ok.enc, iv2, ct2);
    const d1 = crypto.createDecipheriv('aes-256-gcm', keys.aes, inner.subarray(0, 12));
    d1.setAAD(Buffer.from(`${label}|L1`));
    d1.setAuthTag(inner.subarray(12, 28));
    return Buffer.concat([d1.update(inner.subarray(28)), d1.final()]);
  } catch {
    throw new VaultError('auth', '열 수 없어요');
  } finally {
    ok.wipe();
  }
}

// ---------- 금고 ----------
/**
 * 새 금고 만들기
 * @returns {{ file, secretKey, session }}  file = 디스크에 저장할 객체, secretKey = 사용자에게 한 번 보여줄 비밀 키
 */
async function createVault({ password, doc, kdf = KDF_DEFAULT }) {
  if (String(password || '').length < 10) throw new VaultError('weak', '마스터 비밀번호는 10자 이상이어야 해요');
  const salt = crypto.randomBytes(32);
  const secretKey = crypto.randomBytes(SECRET_KEY_BYTES);
  const dek = crypto.randomBytes(32);
  const mk = await deriveMasterKeys(password, salt, secretKey, kdf);
  const wrapped = seal2(mk, dek, 'dek');
  mk.wipe();
  const session = { dek, dataKeys: dataKeysFrom(dek), doc };
  const file = { format: FORMAT, v: VERSION, kdf: { ...kdf, salt: salt.toString('base64') }, dek: wrapped, data: null };
  file.data = sealDoc(session);
  return { file, secretKey, session };
}

function sealDoc(session) {
  return seal2(session.dataKeys, Buffer.from(JSON.stringify(session.doc), 'utf8'), 'data');
}

/** 금고 열기. 비밀번호나 비밀 키가 틀리면 VaultError('auth') */
async function unlockVault(file, password, secretKey) {
  if (!file || file.format !== FORMAT || file.v !== VERSION) throw new VaultError('corrupt', '금고 파일 형식이 아니에요');
  if (!Buffer.isBuffer(secretKey) || secretKey.length !== SECRET_KEY_BYTES) throw new VaultError('secret-key', '비밀 키가 필요해요');
  const kdf = { alg: file.kdf.alg, N: file.kdf.N, r: file.kdf.r, p: file.kdf.p };
  const mk = await deriveMasterKeys(password, Buffer.from(file.kdf.salt, 'base64'), secretKey, kdf);
  return openWithMasterKeys(file, mk);
}
function openWithMasterKeys(file, mk) {
  let dek;
  try {
    dek = open2(mk, file.dek, 'dek');
  } catch {
    throw new VaultError('auth', '비밀번호나 비밀 키가 맞지 않아요');
  } finally {
    mk.wipe();
  }
  const dataKeys = dataKeysFrom(dek);
  const doc = JSON.parse(open2(dataKeys, file.data, 'data').toString('utf8'));
  return { dek, dataKeys, doc };
}
/** 다른 기기의 금고 파일(같은 DEK)에서 문서만 꺼내기 — 동기화 때 서버 사본을 합치려고 */
function openDocWith(session, otherFile) {
  return JSON.parse(open2(session.dataKeys, otherFile.data, 'data').toString('utf8'));
}

// ---------- 서버 계정 (아이디 · 비밀번호, 중계 서버에 암호문으로 보관) ----------
// 서버 계정은 다른 기기에서 아이디 + 비밀번호만으로 열려야 해서, 비밀 키 자리에 아이디에서 만든 값(공개)을 쓴다.
//  → 금고 형식은 그대로, 강도는 scrypt(N=2^17) + 비밀번호 (Bitwarden 같은 방식). 서버는 암호문과 로그인 확인 값만 가짐.
// scrypt 한 번으로 두 값: 금고 열쇠(위 deriveMasterKeys 와 같은 계산) + 서버 로그인 확인 값 auth (다른 info 의 HKDF
//  → auth 를 알아도 금고 열쇠는 알 수 없음. 서버는 auth 를 한 번 더 해시해서 저장)
const normId = (id) => String(id || '').trim().toLowerCase();
const accountSecret = (id) => crypto.createHash('sha256').update(`jam-account|${normId(id)}`).digest().subarray(0, SECRET_KEY_BYTES);
async function deriveAccountKeys(password, salt, id, kdf) {
  if (kdf.alg !== 'scrypt' || kdf.N < 1 << 14 || kdf.r < 8 || kdf.p < 1) throw new VaultError('bad-kdf', '지원하지 않는 설정이에요');
  const pw = Buffer.from(String(password).normalize('NFKC'), 'utf8');
  const stretched = await scrypt(pw, salt, kdf);
  pw.fill(0);
  const sk = accountSecret(id);
  const okm = Buffer.from(crypto.hkdfSync('sha256', stretched, sk, Buffer.from('jam-vault v1 master'), 64));
  const auth = Buffer.from(crypto.hkdfSync('sha256', stretched, sk, Buffer.from('jam-account v1 auth'), 32));
  stretched.fill(0);
  return { mk: { aes: okm.subarray(0, 32), chacha: okm.subarray(32, 64), wipe: () => okm.fill(0) }, auth };
}
/** 새 서버 계정 금고 → { file, session, auth } */
async function createAccountVault({ id, password, doc, kdf = KDF_DEFAULT }) {
  if (String(password || '').length < 10) throw new VaultError('weak', '비밀번호는 10자 이상이어야 해요');
  const salt = crypto.randomBytes(32);
  const dek = crypto.randomBytes(32);
  const { mk, auth } = await deriveAccountKeys(password, salt, id, kdf);
  const wrapped = seal2(mk, dek, 'dek');
  const mkBytes = mkToBytes(mk);
  mk.wipe();
  const session = { dek, dataKeys: dataKeysFrom(dek), doc };
  const file = { format: FORMAT, v: VERSION, kdf: { ...kdf, salt: salt.toString('base64') }, dek: wrapped, data: null };
  file.data = sealDoc(session);
  return { file, session, auth, mkBytes };
}
/** 서버 계정 금고 열기 → { session, auth }. 비밀번호가 틀리면 VaultError('auth') */
async function unlockAccountVault(file, password, id) {
  if (!file || file.format !== FORMAT || file.v !== VERSION) throw new VaultError('corrupt', '금고 파일 형식이 아니에요');
  const kdf = { alg: file.kdf.alg, N: file.kdf.N, r: file.kdf.r, p: file.kdf.p };
  const { mk, auth } = await deriveAccountKeys(password, Buffer.from(file.kdf.salt, 'base64'), id, kdf);
  try {
    return { session: openWithMasterKeys(file, mk), auth };
  } catch (e) {
    auth.fill(0);
    throw e;
  }
}
/** 서버에서 받은 kdf 로 로그인 확인 값만 (새 기기에서 로그인할 때, 금고 파일을 받기 전) */
async function accountAuth(password, kdf, id) {
  const { mk, auth } = await deriveAccountKeys(password, Buffer.from(kdf.salt, 'base64'), id, { alg: kdf.alg, N: kdf.N, r: kdf.r, p: kdf.p });
  mk.wipe();
  return auth;
}
/** 풀린 금고를 서버 계정 방식으로 다시 감싸기 (이 PC 계정 → 서버 계정 올리기, 서버 계정 비밀번호 바꾸기) → { file, auth, mkBytes } */
async function rewrapForAccount(session, file, { id, password }) {
  if (String(password || '').length < 10) throw new VaultError('weak', '비밀번호는 10자 이상이어야 해요');
  const salt = crypto.randomBytes(32);
  const kdf = { alg: file.kdf.alg, N: file.kdf.N, r: file.kdf.r, p: file.kdf.p };
  const { mk, auth } = await deriveAccountKeys(password, salt, id, kdf);
  const wrapped = seal2(mk, session.dek, 'dek');
  const mkBytes = mkToBytes(mk);
  mk.wipe();
  return { file: { format: FORMAT, v: VERSION, kdf: { ...kdf, salt: salt.toString('base64') }, dek: wrapped, data: sealDoc(session) }, auth, mkBytes };
}

// ---------- 자동 로그인: 금고 열쇠(64바이트)를 Windows 계정 암호화(DPAPI)로 이 PC 에 보관 ----------
const mkToBytes = (mk) => Buffer.concat([mk.aes, mk.chacha]);
const mkFromBytes = (buf) => {
  const b = Buffer.from(buf); // 복사본 (열고 나면 지움)
  if (b.length !== 64) throw new VaultError('bad-key', '저장된 로그인 정보가 이상해요');
  return { aes: b.subarray(0, 32), chacha: b.subarray(32, 64), wipe: () => b.fill(0) };
};
/** 서버가 준 kdf 로 금고 열쇠 + 로그인 확인 값 → { mkBytes, auth } */
async function accountKeys(password, kdf, id) {
  const { mk, auth } = await deriveAccountKeys(password, Buffer.from(kdf.salt, 'base64'), id, { alg: kdf.alg, N: kdf.N, r: kdf.r, p: kdf.p });
  const mkBytes = mkToBytes(mk);
  mk.wipe();
  return { mkBytes, auth };
}
/** 금고 열쇠 바이트로 서버 계정 금고 열기 → session. 비밀번호가 바뀌어 안 맞으면 VaultError('auth') */
function openAccountWith(file, mkBytes) {
  if (!file || file.format !== FORMAT || file.v !== VERSION) throw new VaultError('corrupt', '금고 파일 형식이 아니에요');
  return openWithMasterKeys(file, mkFromBytes(mkBytes));
}

/** 풀린 상태에서 바뀐 내용을 다시 암호화해 새 파일 객체로 */
function saveVault(session, file) {
  return { ...file, data: sealDoc(session) };
}

/** 마스터 비밀번호 바꾸기: 새 salt 로 DEK 만 다시 감싼다 (데이터는 그대로) */
async function changePassword(session, file, newPassword, secretKey) {
  if (String(newPassword || '').length < 10) throw new VaultError('weak', '마스터 비밀번호는 10자 이상이어야 해요');
  const salt = crypto.randomBytes(32);
  const kdf = { alg: file.kdf.alg, N: file.kdf.N, r: file.kdf.r, p: file.kdf.p };
  const mk = await deriveMasterKeys(newPassword, salt, secretKey, kdf);
  const wrapped = seal2(mk, session.dek, 'dek');
  mk.wipe();
  return { ...file, kdf: { ...kdf, salt: salt.toString('base64') }, dek: wrapped, data: sealDoc(session) };
}

// 항목별 비밀번호 (풀린 상태에서도 필요할 때만 잠깐 평문으로)
const sealField = (session, id, text) => seal2(session.dataKeys, Buffer.from(String(text), 'utf8'), `field|${id}`);
const openField = (session, id, sealed) => open2(session.dataKeys, sealed, `field|${id}`).toString('utf8');

function wipeSession(session) {
  if (!session) return;
  session.dek?.fill(0);
  session.dataKeys?.wipe();
  session.doc = null;
}

// ---------- 비밀번호 만들기 ----------
function generatePassword(length = 20) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#$%&*+-=?@^_'];
  const all = sets.join('');
  const n = Math.min(64, Math.max(12, Number(length) || 20));
  const out = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (out.length < n) out.push(all[crypto.randomInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

module.exports = {
  KDF_DEFAULT,
  VaultError,
  createVault,
  unlockVault,
  saveVault,
  changePassword,
  sealField,
  openField,
  wipeSession,
  generatePassword,
  formatSecretKey,
  parseSecretKey,
  // 서버 계정
  createAccountVault,
  unlockAccountVault,
  accountAuth,
  rewrapForAccount,
  accountKeys,
  openAccountWith,
  openDocWith,
  normId,
  // 테스트용
  _internal: { seal2, open2, deriveMasterKeys, deriveAccountKeys, accountSecret, dataKeysFrom, chacha20 },
};
