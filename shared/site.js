/**
 * 서버(Node) · 메인 프로세스 · 앱 화면이 함께 쓰는 규칙
 *  - siteOf / sameSite : "같은 사이트" 판단 (m.youtube.com 과 www.youtube.com 은 같은 사이트)
 *  - isSensitiveUrl    : 로그인·인증·결제처럼 다른 사람에게 주소를 공유하면 안 되는 페이지
 *
 * 주의: src/webview-preload.js 는 샌드박스라 이 파일을 불러올 수 없어서 siteOf 를 복사해서 쓴다.
 */
(function (root) {
  'use strict';

  // co.kr, or.kr, com.au, co.uk 같은 2단계 도메인
  const SECOND_LEVEL = new Set(['co', 'or', 'go', 'ac', 'ne', 're', 'pe', 'com', 'net', 'org', 'gov', 'edu', 'mil']);

  function siteOf(u) {
    let host;
    try {
      const p = new URL(u);
      if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
      host = p.hostname.toLowerCase();
    } catch {
      return null;
    }
    if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return host;
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const n = parts.length;
    const take = parts[n - 1].length === 2 && SECOND_LEVEL.has(parts[n - 2]) ? 3 : 2;
    return parts.slice(-take).join('.');
  }

  function sameSite(a, b) {
    const x = siteOf(a);
    return !!x && x === siteOf(b);
  }

  const AUTH_HOST = /^(accounts?|login|logins|signin|auth|sso|oauth|kauth|nid|appleid|secure|id)\./i;
  const AUTH_PATH = /\/(login|log-in|signin|sign-in|signup|sign-up|oauth2?|auth|authorize|sso|saml|logout|password|2fa|mfa|verify|checkout|payment|billing)(\/|$|\.|\?)/i;
  const SENSITIVE_PARAMS = new Set([
    'code', 'token', 'access_token', 'id_token', 'refresh_token', 'auth', 'ticket', 'session', 'sid',
    'password', 'otp', 'api_key', 'apikey', 'signature', 'sig', 'jwt', 'saml', 'samlresponse',
  ]);

  function isSensitiveUrl(u) {
    let p;
    try {
      p = new URL(u);
    } catch {
      return true;
    }
    if (AUTH_HOST.test(p.hostname)) return true;
    if (AUTH_PATH.test(p.pathname)) return true;
    for (const k of p.searchParams.keys()) if (SENSITIVE_PARAMS.has(k.toLowerCase())) return true;
    if (/(^|[#&])(access_token|id_token|code|token)=/i.test(p.hash)) return true;
    return false;
  }

  // 같은 페이지(문서)인지 판단하는 열쇠.
  //  - 해시(#)와 끝의 / 는 무시
  //  - 유튜브 영상 페이지는 영상(v)과 재생목록(list)만 본다.
  //    재생목록에서 다음 영상으로 넘어가면 유튜브가 index · pp 같은 값을 스스로 바꾸는데,
  //    이걸 "다른 페이지로 이동"으로 보면 참여자끼리 서로를 계속 다시 불러오며 무한 반복된다.
  const YT_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com']);
  function docKey(u) {
    if (!u) return '';
    const base = String(u).split('#')[0];
    let p;
    try {
      p = new URL(base);
    } catch {
      return base.replace(/\/$/, '');
    }
    if (YT_HOSTS.has(p.hostname.toLowerCase()) && p.pathname === '/watch' && p.searchParams.get('v')) {
      const list = p.searchParams.get('list');
      return `youtube:${p.searchParams.get('v')}${list ? `:${list}` : ''}`;
    }
    return base.replace(/\/$/, '');
  }

  function sameDoc(a, b) {
    if (!a || !b) return false;
    return docKey(a) === docKey(b);
  }

  // ---------- HTTPS 우선 ----------
  // http 주소를 https 로 먼저 시도할지. 같은 네트워크 · 내 PC · 포트를 직접 쓴 주소 · 한 단어 주소(사내망)는 그대로
  const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
  function httpsUpgrade(u) {
    let p;
    try {
      p = new URL(u);
    } catch {
      return null;
    }
    if (p.protocol !== 'http:' || p.port || p.username || p.password) return null;
    const h = p.hostname.toLowerCase();
    if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.internal')) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) && PRIVATE_V4.test(h)) return null;
    if (h.startsWith('[')) return null; // IPv6 주소
    p.protocol = 'https:';
    return p.toString();
  }

  // ---------- 비슷한 가짜 주소 ----------
  // 저장한 로그인 사이트와 철자가 비슷하거나(navver.com, naver.co, n4ver.com), 헷갈리는 글자(키릴 а · 숫자 0/1)를 쓰거나,
  // 진짜 이름을 하위 도메인으로 붙인(naver.com.login-check.io) 주소인지. host 는 유니코드로 풀어서(punycode → 글자) 넘겨요
  const CONFUSE = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'l', 'ӏ': 'l', 'ј': 'j', 'ԁ': 'd', 'ɡ': 'g', 'ν': 'v', 'ο': 'o', 'α': 'a', '0': 'o', '1': 'l', 'i': 'l', '3': 'e', '5': 's', '4': 'a', '@': 'a' };
  const skeleton = (s) =>
    [...String(s).toLowerCase()].map((c) => CONFUSE[c] || c).join('').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[-_]/g, '');
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // 글자 바뀜
      }
    }
    return d[a.length][b.length];
  }
  const labelOf = (site) => String(site).split('.')[0];
  /** host(유니코드)가 saved(사이트 목록) 중 하나와 비슷하면 그 사이트, 아니면 null (같은 사이트면 null) */
  function lookalikeOf(host, savedSites) {
    host = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    // 유니코드 글자가 있으면 URL 이 punycode 로 바꿔 버리므로 그대로 잘라서 씀
    const site = /^[\x00-\x7f]*$/.test(host) ? siteOf(`https://${host}/`) || host : host.split('.').slice(-2).join('.');
    for (const saved of savedSites || []) {
      const s = String(saved || '').toLowerCase();
      if (!s || s === site) continue;
      const a = labelOf(site);
      const b = labelOf(s);
      if (b.length < 3) continue;
      // ① 진짜 사이트 이름을 하위 도메인으로 붙임: naver.com.evil.io, login.naver.com-secure.net
      const parts = host.split('.');
      if (host.includes(`${s}.`) || host.includes(`${s}-`) || parts.slice(0, -2).includes(b)) return saved;
      // ② 헷갈리는 글자로 바꾼 같은 이름 (nаver · n4ver), 다른 끝(.co, .net)의 같은 이름
      if (skeleton(a) === skeleton(b)) return saved;
      // ③ 한두 글자 다름 (navver, naevr) — 짧은 이름은 한 글자만
      const dist = editDistance(skeleton(a), skeleton(b));
      if (b.length >= 5 && dist <= 1) return saved;
      if (b.length >= 9 && dist <= 2) return saved;
    }
    return null;
  }

  const api = { siteOf, sameSite, isSensitiveUrl, docKey, sameDoc, httpsUpgrade, lookalikeOf, skeleton };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JamSite = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
