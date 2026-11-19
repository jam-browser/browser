// E2E: 사이트 보호 — 추적기 차단 · 🛡 패널 · 서드파티 쿠키 · 사이트 권한 묻기 · 사이트별 설정 목록
// 실행: test/e2e-jam/run.ps1 -Tests siteguard (차단 목록은 fixtures/blocklist.txt: /trk.js · /trk.gif)
//   페이지 http://127.0.0.1:8766/track 이 http://localhost:8766 (다른 사이트)의 trk.js · trk.gif · ok.gif · showck(iframe) 를 부름
const P = require('./ports');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8766'; // 지금 보는 사이트
const OTHER = 'http://localhost:8766'; // 다른 사이트 (쿠키는 SameSite=None; Secure — localhost 는 http 여도 Secure 쿠키 허용)

async function target(port, pick = (x) => x.type === 'page') {
  for (let i = 0; i < 60; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(pick);
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => ws.once('open', r));
        let id = 0;
        const p = new Map();
        ws.on('message', (raw) => {
          const m = JSON.parse(raw);
          if (p.has(m.id)) p.get(m.id)(m), p.delete(m.id);
        });
        const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
        const ev = async (e) => {
          const m = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true });
          if (m.result?.exceptionDetails) throw new Error(e.slice(0, 80) + ' -> ' + m.result.exceptionDetails.exception?.description);
          return m.result?.result?.value;
        };
        return { ev, close: () => ws.close() };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('no target ' + port);
}
async function until(label, fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let v;
    try { v = await fn(); } catch {}
    if (v) return v;
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
}
const step = (s) => console.log('✓', s);
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const lastCookie = async () => (await (await fetch(`${OTHER}/lastck`)).json())?.cookie;

(async () => {
  const A = await target(P.host);
  await until('lock', () => A.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`), 20000);
  await A.ev(`${q('#ls-skip')}.click(); 1`);
  await until('booted', () => A.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
  await A.ev(`window.__toasts=[]; { const o = toast; toast = (t, a) => { window.__toasts.push(t); return o(t, a); }; } 1`);
  const go = async (url) => {
    await A.ev(`navigateTab(activeTab, ${JSON.stringify(url)}); 1`);
    await until('load ' + url, () => A.ev(`activeTab.url.startsWith(${JSON.stringify(url)}) && !activeTab.loading`), 15000).catch(async (e) => { throw new Error(e.message + ' — now ' + JSON.stringify(await A.ev('({ url: activeTab.url, loading: activeTab.loading })'))); });
    await sleep(1200);
  };
  const page = () => target(P.host, (x) => x.type === 'webview' && x.url.startsWith(`${SITE}/track`));
  const reload = async () => {
    await A.ev(`activeTab.webview.reload(); 1`);
    await sleep(300);
    await until('reloaded', () => A.ev(`!activeTab.loading`), 15000);
    await sleep(1200);
  };

  // 1. 다른 사이트(localhost)에 직접 들어가서 쿠키를 받아 둠 (그 사이트에서는 첫 번째 쿠키라 허용)
  await go(`${OTHER}/setck`);
  // 2. 127.0.0.1 페이지가 localhost 의 추적기 · 그림 · iframe 을 부름
  await go(`${SITE}/track`);
  let W = await page();
  const trk = await W.ev(`typeof window.__trk`);
  const okImg = await W.ev(`document.getElementById('ok').naturalWidth`);
  const count = await until('shield count', () => A.ev(`!${q('#shield-count')}.hidden && ${q('#shield-count')}.textContent`));
  const ck1 = await lastCookie();
  W.close();
  if (trk !== 'undefined' || okImg !== 1 || count !== '2' || ck1 !== '') throw new Error('blocking ' + JSON.stringify({ trk, okImg, count, ck1 }));
  step(`tracker blocking: trk.js · trk.gif blocked (🛡 badge "${count}"), ok.gif from the same other site still loads`);
  step('third-party cookies: the iframe from localhost got no cookie (SameSite=None, set when visiting localhost directly)');

  // 3. 🛡 패널: 막은 주소 · 이 사이트에서 끄기 · 쿠키 허용 → 새로고침
  await A.ev(`${q('#shield-btn')}.click(); 1`);
  const panel = await until('panel', () => A.ev(`${q('#shield-pop')}.classList.contains('open') && ${q('#shield-site')}.textContent && ({ site: ${q('#shield-site')}.textContent, sum: ${q('#shield-summary')}.textContent, hosts: [...document.querySelectorAll('#shield-hosts li')].map(l => l.textContent), on: ${q('#shield-on')}.checked, ck: ${q('#shield-cookies')}.checked })`));
  if (panel.site !== '127.0.0.1' || !panel.on || !panel.ck || !panel.sum.includes('2개')) throw new Error('panel ' + JSON.stringify(panel));
  await A.ev(`${q('#shield-on')}.click(); 1`);
  await sleep(300);
  await A.ev(`${q('#shield-cookies')}.click(); 1`);
  await until('reload button', () => A.ev(`!${q('#shield-reload')}.hidden`));
  await A.ev(`${q('#shield-reload')}.click(); 1`);
  await sleep(300);
  await until('reloaded', () => A.ev(`!activeTab.loading`), 15000);
  await sleep(1200);
  W = await page();
  const trk2 = await W.ev(`window.__trk`);
  W.close();
  const ck2 = await lastCookie();
  const count2 = await A.ev(`${q('#shield-count')}.hidden`);
  if (trk2 !== 1 || !String(ck2).includes('jamck=yes') || !count2) throw new Error('site exception ' + JSON.stringify({ trk2, ck2, count2 }));
  step(`🛡 panel: "${panel.sum}" (${panel.hosts.join(', ')}) → turned blocking and third-party cookie blocking off for 127.0.0.1 → reload: tracker runs, iframe gets "${ck2}"`);

  await A.ev(`jamSite.set({ site: '127.0.0.1', key: 'shieldOff', value: false }).then(() => jamSite.set({ site: '127.0.0.1', key: 'cookies3p', value: false }))`);
  await reload();
  W = await page();
  const trk3 = await W.ev(`typeof window.__trk`);
  W.close();
  if (trk3 !== 'undefined' || (await lastCookie()) !== '') throw new Error('back on');
  step('turned back on → blocked again');

  // 4. 사이트 권한: 알림 요청 → 위쪽에 묻는 줄 → 허용 → 기억 (페이지가 보는 상태도 granted)
  W = await page();
  await W.ev(`Notification.requestPermission().then(p => (window.__perm = p)); 1`);
  const ask = await until('perm banner', () => A.ev(`!${q('#perm-banner')}.hidden && ${q('#perm-text')}.textContent`));
  await A.ev(`${q('#perm-allow')}.click(); 1`);
  const granted = await until('granted', () => W.ev(`window.__perm`));
  const state = await W.ev(`Notification.permission`);
  W.close();
  if (granted !== 'granted' || state !== 'granted' || !ask.includes('알림')) throw new Error('perm ' + JSON.stringify({ ask, granted, state }));
  step(`permission prompt: "${ask}" → 허용 → page sees "${state}"`);

  // 🛡 패널에서 차단으로 바꾸면 → 새로고침 뒤 denied, 다시 요청해도 묻지 않음
  await A.ev(`${q('#shield-btn')}.click(); 1`);
  await until('perm row', () => A.ev(`!!document.querySelector('#shield-perms select')`));
  await A.ev(`(() => { const s = document.querySelector('#shield-perms select'); s.value = 'deny'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await sleep(400);
  await A.ev(`${q('#shield-pop')}.classList.remove('open'); 1`);
  await reload();
  W = await page();
  const st2 = await W.ev(`Notification.permission`);
  const again = await W.ev(`Notification.requestPermission()`);
  W.close();
  const bannerShown = await A.ev(`!${q('#perm-banner')}.hidden`);
  if (again !== 'denied' || bannerShown) throw new Error('deny ' + JSON.stringify({ st2, again, bannerShown }));
  step(`changed to 차단 in the 🛡 panel → page sees "${st2}", asking again returns "${again}" without a prompt`);

  // 5. 설정 → 보안 · 개인정보 → 사이트별 설정 목록
  await A.ev(`openSiteSettings(); 1`);
  const listed = await until('site list', () => A.ev(`(${q('#site-guard-list')}.textContent.includes('127.0.0.1') && ${q('#site-guard-list')}.textContent)`));
  const rowsN = await A.ev(`document.querySelectorAll('#set-security .pref-row').length`);
  await A.ev(`${q('#settings-dialog')}.close(); 1`);
  step(`settings → 보안 · 개인정보: ${rowsN} settings + site list "${listed.slice(0, 60)}"`);

  // 6. 설정에서 차단을 끄면 → 추적기 그대로
  await A.ev(`prefs.set('contentBlock', 'off'); 1`);
  await sleep(300);
  await reload();
  W = await page();
  const trk4 = await W.ev(`window.__trk`);
  W.close();
  await A.ev(`prefs.set('contentBlock', 'trackers'); 1`);
  if (trk4 !== 1) throw new Error('contentBlock off');
  step('settings: 추적 · 광고 차단 "끔" → tracker loads; back to 추적기 차단');

  // 7. 인터넷 사이트(example.com)가 내 PC(127.0.0.1) · 공유기(192.168.0.1)를 부르면 막힘 → 🛡 에서 허용하면 됨
  await A.ev(`navigateTab(activeTab, 'https://example.com/'); 1`);
  await until('example.com', () => A.ev(`activeTab.url.startsWith('https://example.com') && !activeTab.loading`), 20000);
  await sleep(800);
  const probe = `(async () => { const r = {}; try { await fetch('${OTHER}/lastck', { mode: 'no-cors' }); r.pc = 'reached'; } catch { r.pc = 'blocked'; } try { const ws = new WebSocket('ws://127.0.0.1:${P.host}/'); r.ws = await new Promise((res) => { ws.onopen = () => res('open'); ws.onerror = () => res('blocked'); }); } catch { r.ws = 'blocked'; } return r; })()`;
  W = await target(P.host, (x) => x.type === 'webview' && x.url.startsWith('https://example.com'));
  const lna1 = await W.ev(probe);
  W.close();
  const lnaToast = await until('local toast', () => A.ev(`window.__toasts.find(t => t.includes('🏠'))`), 5000);
  await A.ev(`${q('#shield-btn')}.click(); 1`);
  const note = await until('local note', () => A.ev(`!${q('#shield-local-note')}.hidden && ${q('#shield-local-note')}.textContent`));
  await A.ev(`${q('#shield-local')}.click(); 1`);
  await sleep(300);
  await A.ev(`${q('#shield-pop')}.classList.remove('open'); 1`);
  W = await target(P.host, (x) => x.type === 'webview' && x.url.startsWith('https://example.com'));
  const lna2 = await W.ev(probe);
  W.close();
  await A.ev(`jamSite.set({ site: 'example.com', key: 'localNet', value: false })`);
  if (lna1.pc !== 'blocked' || lna1.ws !== 'blocked' || lna2.pc !== 'reached') throw new Error('local network ' + JSON.stringify({ lna1, lna2 }));
  step(`internet page → my PC: fetch 127.0.0.1 ${lna1.pc}, WebSocket to 127.0.0.1 (debug port) ${lna1.ws} · toast "${lnaToast.slice(0, 50)}…" · 🛡 "${note.slice(0, 50)}…" → allowed for example.com → fetch ${lna2.pc}`);

  console.log('\nE2E siteguard OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
