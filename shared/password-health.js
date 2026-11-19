/**
 * 비밀번호 점검 (메인 프로세스에서만 씀 — 비밀번호는 앱 화면으로 가지 않음)
 *  - strength(pw, ctx) : 0~4 점수와 이유 (길이 · 글자 종류 · 흔한 비밀번호 · 반복/연속 · 사이트 이름/아이디 포함)
 *  - review(logins)    : [{ id, origin, username, pw }] → { [id]: { score, weak, reasons, reusedWith: [id…] } }
 *  - hibpPrefix(pw)    : 유출 확인(k-익명성)용 SHA-1 앞 5자리와 나머지 — 서버에는 앞 5자리만 보냄
 */
'use strict';
const crypto = require('crypto');

// 아주 흔한 비밀번호 (유출 목록 상위 + 한국에서 흔한 것). 소문자로 비교
const COMMON = new Set([
  '123456', '123456789', '12345678', 'password', 'qwerty', '1234567', '111111', '1234567890', '123123', 'abc123',
  '1234', 'password1', 'iloveyou', '1q2w3e4r', '000000', 'qwerty123', 'zaq12wsx', 'dragon', 'sunshine', 'princess',
  'letmein', '654321', 'monkey', '27653', '1qaz2wsx', '123321', 'qwertyuiop', 'superman', 'asdfghjkl', 'football',
  'baseball', 'welcome', 'admin', 'admin123', 'login', 'master', 'hello', 'freedom', 'whatever', 'qazwsx',
  'trustno1', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'q1w2e3r4', '1q2w3e4r5t', 'qwer1234', 'asdf1234', 'zxcvbnm', 'asdfasdf',
  'a123456', 'a12345678', 'aa123456', 'abcd1234', 'qwe123', 'gkswl', 'tkfkdgo', 'dkssud', 'love1234', 'sarang',
  'saranghae', 'korea', 'korea123', 'samsung', 'naver', 'naver123', 'google', 'google123', 'test', 'test1234',
]);
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', '1qaz2wsx3edc', 'qazwsxedc'];

function hasSequence(pw) {
  const s = pw.toLowerCase();
  // abcd · 1234 · 4321 처럼 4글자 이상 연속
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    const prev = i > 1 ? s.charCodeAt(i - 1) - s.charCodeAt(i - 2) : d;
    run = (d === 1 || d === -1) && d === prev ? run + 1 : d === 1 || d === -1 ? 2 : 1;
    if (run >= 4) return true;
  }
  for (const row of KEYBOARD_ROWS) {
    for (let i = 0; i + 4 <= row.length; i++) if (s.includes(row.slice(i, i + 4))) return true;
  }
  return false;
}

function strength(pw, ctx = {}) {
  pw = String(pw || '');
  const reasons = [];
  const lower = pw.toLowerCase();
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const unique = new Set(pw).size;
  // 대략적인 엔트로피 (글자 종류 × 길이), 반복이 많으면 깎음
  const pool = (/[a-z]/.test(pw) ? 26 : 0) + (/[A-Z]/.test(pw) ? 26 : 0) + (/[0-9]/.test(pw) ? 10 : 0) + (/[^A-Za-z0-9]/.test(pw) ? 33 : 0);
  let bits = pw.length ? Math.log2(Math.max(pool, 2)) * Math.min(pw.length, unique * 2) : 0;

  const stripped = lower.replace(/[^a-z0-9]/g, '');
  const base = lower.replace(/[\d!@#$%^&*._-]+$/g, '').replace(/^[\d]+/, '');
  if (COMMON.has(lower) || COMMON.has(stripped) || (base.length >= 4 && COMMON.has(base))) {
    reasons.push('아주 흔한 비밀번호');
    bits = Math.min(bits, 10);
  }
  if (pw.length < 8) reasons.push('8자보다 짧음');
  else if (pw.length < 12 && kinds < 3) reasons.push('짧고 글자 종류가 적음');
  if (pw.length && unique <= Math.max(2, pw.length / 4)) {
    reasons.push('같은 글자 반복');
    bits = Math.min(bits, 20);
  }
  if (/^[a-z]{3,10}[!@#._-]?((19|20)\d\d|\d{1,4})[!@#.]?$/i.test(pw)) {
    reasons.push('단어 + 숫자/연도 (예: Summer2024)');
    bits = Math.min(bits, 34);
  }
  if (hasSequence(pw)) {
    reasons.push('연속된 글자 (1234 · abcd · qwer)');
    bits -= 12;
  }
  const words = [];
  try {
    if (ctx.origin) words.push(...new URL(ctx.origin).hostname.split('.').filter((w) => w.length >= 4 && !['www', 'com', 'net', 'org'].includes(w)));
  } catch {}
  if (ctx.username) words.push(String(ctx.username).toLowerCase().split('@')[0]);
  if (words.some((w) => w && w.length >= 4 && lower.includes(w.toLowerCase()))) {
    reasons.push('사이트 이름이나 아이디가 들어 있음');
    bits -= 15;
  }
  const score = bits < 28 ? 0 : bits < 36 ? 1 : bits < 50 ? 2 : bits < 64 ? 3 : 4;
  return { score, weak: score <= 1 || reasons.length > 0 && score <= 2, reasons };
}

function review(logins) {
  const out = {};
  const byPw = new Map();
  for (const l of logins) {
    if (!l.pw) continue;
    const h = crypto.createHash('sha256').update(l.pw).digest('hex');
    if (!byPw.has(h)) byPw.set(h, []);
    byPw.get(h).push(l.id);
    out[l.id] = { ...strength(l.pw, l), reusedWith: [] };
  }
  for (const ids of byPw.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) out[id].reusedWith = ids.filter((x) => x !== id);
  }
  return out;
}

function hibpPrefix(pw) {
  const h = crypto.createHash('sha1').update(String(pw), 'utf8').digest('hex').toUpperCase();
  return { prefix: h.slice(0, 5), suffix: h.slice(5) };
}
// "SUFFIX:COUNT" 줄 목록에서 찾기 (Add-Padding 으로 섞인 0 건은 무시)
function hibpCount(body, suffix) {
  for (const line of String(body).split(/\r?\n/)) {
    const [s, c] = line.trim().split(':');
    if (s && s.toUpperCase() === suffix) return Number(c) || 0;
  }
  return 0;
}

module.exports = { strength, review, hibpPrefix, hibpCount, COMMON };
