// E2E: 화면 미러링 비율 — 시작할 때 · 호스트 탭 크기가 바뀐 뒤(패널 열고 닫기) 영상 비율이 탭 비율과 같은지
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = 'http://localhost:8766';
async function target(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page');
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => ws.once('open', r));
        let id = 0;
        const p = new Map();
        ws.on('message', (raw) => {
          const m = JSON.parse(raw);
          if (p.has(m.id)) p.get(m.id)(m), p.delete(m.id);
        });
        const ev = (e) => new Promise((r) => { const i = ++id; p.set(i, (m) => { if (m.result?.exceptionDetails) console.log('ERR', e.slice(0, 60), m.result.exceptionDetails.exception?.description); r(m.result?.result?.value); }); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); });
        return { ev };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('no target');
}
async function until(label, fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  throw new Error('timeout ' + label);
}
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
(async () => {
  const A = await target(P.host);
  const B = await target(P.guest);
  for (const X of [A, B]) {
    await until('lock', () => X.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`));
    await X.ev(`${q('#ls-skip')}.click(); 1`);
    await until('booted', () => X.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
  }
  await A.ev(`navigateTab(activeTab, '${SITE}/game'); 1`);
  await until('game', () => A.ev(`activeTab.url.includes('/game') && !activeTab.loading`));
  await A.ev(`${q('#name')}.value='호스트'; ${q('#access-mode')}.value='open'; ${q('#access-mode')}.dispatchEvent(new Event('change')); ${q('#start-jam')}.click(); 1`);
  const invite = await until('host', () => A.ev(`jam.active && jam.invite`));
  const local = invite.replace(/^jam:\/\/[^/]+/, 'jam://127.0.0.1:' + invite.match(/:(\d+)\//)[1]);
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(local)}; ${q('#join-jam')}.click(); 1`);
  await until('joined', () => B.ev(`jam.active`));
  await A.ev(`window.__mirrorNoConfirm = true; mirror.start(jam.tab); 1`);
  await until('frames', () => B.ev(`(s => s.view && s.view.frames > 3)(mirror.stats())`));
  const measure = async (label) => {
    await sleep(2500);
    const tab = await A.ev(`(() => { const w = jam.tab.webview; return [w.clientWidth, w.clientHeight]; })()`);
    const vid = await B.ev(`(s => [s.view.w, s.view.h])(mirror.stats())`);
    const ta = tab[0] / tab[1];
    const va = vid[0] / vid[1];
    const off = Math.abs(va / ta - 1);
    console.log(`${label}: host tab ${tab[0]}×${tab[1]} (${ta.toFixed(3)}) · video ${vid[0]}×${vid[1]} (${va.toFixed(3)}) · aspect error ${(off * 100).toFixed(1)}%`);
    return off;
  };
  const e1 = await measure('at start');
  // 호스트가 Jam 패널을 닫았다 열기 → 탭 폭이 바뀜
  const panelBtn = await A.ev(`!!${q('#ov-panel')}`);
  await A.ev(`${q('#ov-panel')}.click(); 1`);
  const e2 = await measure('after panel toggled');
  await A.ev(`${q('#ov-panel')}.click(); 1`);
  const e3 = await measure('after panel back');
  const wide = await B.ev(`mirror.stats().view.w`);
  const bad = [e1, e2, e3].some((x) => x > 0.03);
  console.log(bad ? '\nASPECT MISMATCH (stretched)' : '\nE2E aspect OK');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
