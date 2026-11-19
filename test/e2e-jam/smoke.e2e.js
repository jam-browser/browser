// 설치본 스모크: 버전 표시 · 확장 프로그램 줄(생성 파일) · 기본 탭 열기
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let t;
  for (let i = 0; i < 60 && !t; i++) {
    try {
      t = (await (await fetch(`http://127.0.0.1:${P.host}/json/list`)).json()).find((x) => x.type === 'page');
    } catch {}
    if (!t) await sleep(500);
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const p = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (p.has(m.id)) p.get(m.id)(m), p.delete(m.id);
  });
  const ev = (e) => new Promise((r) => { const i = ++id; p.set(i, (m) => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); });
  for (let i = 0; i < 40; i++) {
    if (await ev(`typeof account==='object' && !document.querySelector('#ls-welcome').hidden`)) break;
    await sleep(500);
  }
  await ev(`document.querySelector('#ls-skip').click(); 1`);
  await sleep(2500);
  const r = await ev(`({
    version: document.getElementById('app-version')?.textContent || '',
    extBar: !!document.querySelector('#ext-bar'),
    extActionsDefined: !!customElements.get('browser-action-list'),
    tabs: tabs.length,
    prefsPages: [...document.querySelectorAll('#settings-dialog .pref-page')].length,
    prefsWant: JamPrefs.PAGES.length,
    pingBtn: !!document.getElementById('ov-ping'),
  })`);
  console.log(JSON.stringify(r));
  // Google 로그인 대책: 웹페이지 탭이 보내는 UA · Sec-CH-UA 와 navigator.userAgentData 에 "Google Chrome" (Electron 표시 없음)
  await ev(`navigateTab(activeTab, 'http://localhost:8766/echo-ua'); 1`);
  await sleep(2000);
  await ev(`activeTab.webview.reload(); 1`); // 두 번째 요청부터 Accept-CH 로 요청한 전체 버전 헤더도 옴
  await sleep(2000);
  let wt;
  for (let i = 0; i < 20 && !wt; i++) {
    wt = (await (await fetch(`http://127.0.0.1:${P.host}/json/list`)).json()).find((x) => x.type === 'webview' && x.url.includes('/echo-ua'));
    if (!wt) await sleep(500);
  }
  const ww = new WebSocket(wt.webSocketDebuggerUrl);
  await new Promise((res) => ww.once('open', res));
  let wid = 0;
  const wp = new Map();
  const hdrs = [];
  ww.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && wp.has(m.id)) wp.get(m.id)(m), wp.delete(m.id);
    if (m.method === 'Network.requestWillBeSentExtraInfo') hdrs.push(m.params.headers);
  });
  const wcmd = (method, params = {}) => new Promise((res) => { const i = ++wid; wp.set(i, res); ww.send(JSON.stringify({ id: i, method, params })); });
  const wv = async (e) => (await wcmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const ua = await wv(`(async () => ({ js: navigator.userAgentData.brands.map(b => b.brand), full: (await navigator.userAgentData.getHighEntropyValues(['fullVersionList'])).fullVersionList.map(b => b.brand + '/' + b.version), nav: navigator.userAgent }))()`);
  // 헤더(Sec-CH-UA)는 https 에서만 보내요 → example.com 으로 확인
  await wcmd('Network.enable');
  await wcmd('Page.navigate', { url: 'https://example.com/' });
  for (let i = 0; i < 30 && !hdrs.some((h) => h['sec-ch-ua']); i++) await sleep(300);
  const h = hdrs.find((x) => x['sec-ch-ua']) || {};
  ua.hdr = { ua: h['user-agent'] || '', chua: h['sec-ch-ua'] || '', platform: h['sec-ch-ua-platform'] || '' };
  ww.close();
  console.log(JSON.stringify(ua));
  const uaOk = ua && /Google Chrome/.test(ua.hdr.chua) && ua.js.includes('Google Chrome') && ua.full.some((x) => x.startsWith('Google Chrome/')) && !/Electron|jam-browser/i.test(ua.hdr.ua + ua.nav + ua.hdr.chua);
  console.log(uaOk ? '✓ web tabs look like Google Chrome (UA · Sec-CH-UA header · userAgentData)' : '✗ brand info still missing Google Chrome');
  r.uaOk = uaOk;
  const want = require('../../package.json').version; // 지금 버전이 화면에 보이는지
  const ok = r.version.includes(want) && r.extBar && r.extActionsDefined && r.tabs > 0 && r.prefsPages === r.prefsWant && r.pingBtn && r.uaOk;
  console.log(ok ? '\nE2E smoke OK' : '\nE2E smoke FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
