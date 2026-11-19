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
  const want = require('../../package.json').version; // 지금 버전이 화면에 보이는지
  const ok = r.version.includes(want) && r.extBar && r.extActionsDefined && r.tabs > 0 && r.prefsPages === r.prefsWant && r.pingBtn;
  console.log(ok ? '\nE2E smoke OK' : '\nE2E smoke FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
