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

  const api = { siteOf, sameSite, isSensitiveUrl };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JamSite = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
