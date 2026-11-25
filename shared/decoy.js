/**
 * 친구에게 보여 줄 사이트 고르기 (앱 화면 · 테스트가 함께 씀)
 *
 *  - 평범한 사이트: 그대로 (사이트 이름만, 페이지 주소 · 제목은 안 보냄)
 *  - 이상한 사이트(성인 · 도박 · 토렌트 등), 내가 숨긴 사이트, 로그인 · 결제 페이지, 내 PC · 같은 네트워크 주소:
 *    → 방금 보던 평범한 사이트를 계속 보는 것처럼, 시간이 지나면 내가 자주 가는 다른 사이트로 (아무도 이상하게 보지 않게)
 *    → 한 번 고른 대신 사이트는 10~30분 유지 (자꾸 바뀌면 오히려 티가 남)
 *  - "바꿔 보여 주기" 를 끄면(mode 'hide') 사이트 없이 온라인만
 */
(function (root) {
  'use strict';
  const Site = typeof module === 'object' && module.exports ? require('./site') : root.JamSite;

  // 사이트 이름(siteOf) 그대로 맞추는 목록
  const SITES = new Set([
    'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'spankbang.com', 'eporner.com', 'tnaflix.com', 'motherless.com',
    'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com', 'bongacams.com', 'camsoda.com', 'livejasmin.com', 'myfreecams.com',
    'hitomi.la', 'nhentai.net', 'e-hentai.org', 'exhentai.org', 'rule34.xxx', 'missav.com', 'missav.ws', 'jable.tv', 'javlibrary.com', 'avsee.in',
    'bet365.com', '1xbet.com', 'stake.com', 'betway.com', 'betman.co.kr', 'pinnacle.com', 'ggbet.com',
    'tinder.com', 'bumble.com', 'ashleymadison.com', 'grindr.com',
  ]);
  const TLDS = new Set(['xxx', 'adult', 'porn', 'sex', 'casino', 'bet', 'poker']);
  // 주소 어디에 들어 있어도
  const STRONG = ['porn', 'xxx', 'hentai', 'nsfw', 'xvideo', 'xnxx', 'xhamster', 'onlyfans', 'camgirl', 'yadong', 'casino', 'baccarat', 'torrent', 'sportstoto', '1xbet', 'bet365'];
  // 한 낱말일 때만 (essex · betterment · slotkin 같은 평범한 이름은 통과)
  const WEAK = new Set(['sex', 'sexy', 'adult', 'nude', 'nudes', 'milf', 'cams', 'escort', 'escorts', 'toto', 'bet', 'bets', 'slot', 'slots', 'poker', 'gamble']);

  function isEmbarrassing(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!h) return false;
    const site = Site.siteOf(`https://${h}/`) || h;
    if (SITES.has(site) || TLDS.has(h.split('.').pop())) return true;
    const body = h.split('.').slice(0, -1).join('.');
    if (STRONG.some((k) => body.includes(k))) return true;
    return body.split(/[.\-0-9]+/).some((w) => WEAK.has(w));
  }

  const FALLBACK = ['youtube.com', 'naver.com', 'google.com', 'namu.wiki', 'wikipedia.org'];
  const KEEP_REAL_MS = 15 * 60e3; // 이만큼 안에 보던 평범한 사이트가 있으면 그걸 계속 보는 것처럼

  function parse(url) {
    try {
      const u = new URL(String(url || ''));
      return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
    } catch {
      return null;
    }
  }
  const isIp = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h.startsWith('[');

  /** 친구에게 그대로 보이면 안 되는 주소인지 */
  function isPrivate(url, hidden) {
    const u = parse(url);
    if (!u) return true;
    const site = Site.siteOf(u.href) || u.hostname;
    return isEmbarrassing(u.hostname) || (hidden && hidden.has(site)) || Site.isSensitiveUrl(u.href) || !!Site.localKind(u.hostname) || isIp(u.hostname);
  }

  /** 방문 기록에서 자주 가는 평범한 사이트 [{ site, n }] */
  function frequentSites(history, { now = Date.now(), hidden = new Set(), days = 30, min = 2, limit = 8 } = {}) {
    const since = now - days * 86400e3;
    const count = new Map();
    for (const h of Array.isArray(history) ? history : []) {
      if (!h || !(h.at >= since) || isPrivate(h.url, hidden)) continue;
      const site = Site.siteOf(h.url);
      if (!site) continue;
      const c = count.get(site) || { site, n: 0, last: 0 };
      c.n++;
      c.last = Math.max(c.last, h.at);
      count.set(site, c);
    }
    return [...count.values()].filter((c) => c.n >= min).sort((a, b) => b.n - a.n || b.last - a.last).slice(0, limit).map(({ site, n }) => ({ site, n }));
  }

  const createState = () => ({ real: null, decoy: null, until: 0 });

  function pick(state, { now, rand, frequent, hidden }) {
    // 방금 보던 사이트를 이어서 (그 사이트를 지금 막 숨겼으면 빼고)
    if (!state.decoy && state.real && now - state.real.at < KEEP_REAL_MS && !(hidden && hidden.has(state.real.site))) return state.real.site;
    const pool = (frequent || []).filter((f) => f.site !== state.decoy);
    if (pool.length) {
      let r = rand() * pool.reduce((s, f) => s + f.n, 0);
      for (const f of pool) if ((r -= f.n) <= 0) return f.site;
      return pool[pool.length - 1].site;
    }
    const fb = FALLBACK.filter((s) => s !== state.decoy);
    return fb[Math.floor(rand() * fb.length) % fb.length];
  }

  /** 지금 보는 주소 → 친구에게 보여 줄 { site, decoy } (state 는 탭을 바꿔도 이어서 씀) */
  function shownSite(state, url, { now = Date.now(), rand = Math.random, frequent = [], hidden = new Set(), mode = 'often' } = {}) {
    const u = parse(url);
    if (!u) return { site: null, decoy: false }; // 시작 페이지 · 설정 등
    if (!isPrivate(url, hidden)) {
      const site = Site.siteOf(u.href) || u.hostname;
      state.real = { site, at: now };
      state.decoy = null;
      state.until = 0;
      return { site, decoy: false };
    }
    if (mode === 'hide') return { site: null, decoy: true };
    if (!state.decoy || now >= state.until) {
      state.decoy = pick(state, { now, rand, frequent: (frequent || []).filter((f) => !hidden.has(f.site)), hidden });
      state.until = now + (10 + rand() * 20) * 60e3;
    }
    return { site: state.decoy, decoy: true };
  }

  const api = { isEmbarrassing, isPrivate, frequentSites, createState, shownSite, FALLBACK };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JamDecoy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
