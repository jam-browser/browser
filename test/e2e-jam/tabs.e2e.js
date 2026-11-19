// E2E: 탭이 저절로 왔다갔다 하지 않는지 (확장 프로그램 시스템과 주고받는 "지금 탭" 알림이 되돌아와 생기던 고리)
//   탭 3개를 만들고 빠르게 A→B→C→A→B 로 바꾼 뒤, 3초 동안 저절로 바뀌는 횟수를 셈 → 0 이어야 함
//   + 탭 닫기 · 새 탭 · Ctrl+Tab 연타 뒤에도 마지막 탭에 머무는지
const P = require('./ports');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        const ev = (e) => new Promise((r) => { const i = ++id; p.set(i, (m) => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); });
        return { ev };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('no target');
}
const step = (s) => console.log('✓', s);

(async () => {
  const A = await target(P.host);
  for (let i = 0; i < 40; i++) {
    if (await A.ev(`typeof account==='object' && !document.querySelector('#ls-welcome').hidden`)) break;
    await sleep(500);
  }
  await A.ev(`document.querySelector('#ls-skip').click(); 1`);
  await sleep(2000);
  // 탭 3개 (웹페이지가 붙어야 확장 프로그램 시스템에 등록됨)
  await A.ev(`(() => { navigateTab(activeTab, 'http://localhost:8766/?a'); createTab('http://localhost:8766/?b'); createTab('http://localhost:8766/?c'); return 1; })()`);
  await sleep(3000);
  // 활성 탭이 바뀔 때마다 기록
  await A.ev(`(() => { window.__flips = []; const orig = activateTab; activateTab = function (t) { window.__flips.push([Date.now(), tabs.indexOf(t)]); return orig.apply(this, arguments); }; return 1; })()`);
  const check = async (label, burst) => {
    const after = await A.ev(burst); // 연타가 끝나는 시각 (페이지 시계)
    await sleep(3000);
    const r = await A.ev(`({ flips: window.__flips.filter(f => f[0] > ${after} + 200).map(f => f[1]), active: tabs.indexOf(activeTab) })`);
    return { label, ...r };
  };
  const results = [];
  results.push(await check('fast switching A→B→C→A→B', `(() => { const s = [0,1,2,0,1]; s.forEach((i, k) => setTimeout(() => activateTab(tabs[i]), k * 15)); return Date.now() + 4 * 15; })()`));
  results.push(await check('back and forth B→C→B→C', `(() => { [2,1,2].forEach((i, k) => setTimeout(() => activateTab(tabs[i]), k * 5)); return Date.now() + 2 * 5; })()`));
  results.push(await check('new tab then close it', `(() => { const t = createTab('http://localhost:8766/?d'); setTimeout(() => closeTab(t), 30); return Date.now() + 30; })()`));
  results.push(await check('Ctrl+Tab held down (20×)', `(() => { for (let k = 0; k < 20; k++) setTimeout(() => activateTab(tabs[(tabs.indexOf(activeTab) + 1) % tabs.length]), k * 8); return Date.now() + 19 * 8; })()`));
  let bad = 0;
  for (const r of results) {
    console.log(`  ${r.flips.length ? '✗' : '✓'} ${r.label}: switched by itself ${r.flips.length}× afterwards ${r.flips.length ? JSON.stringify(r.flips.slice(0, 12)) : ''} · stayed on tab ${r.active}`);
    if (r.flips.length) bad++;
  }
  if (bad) throw new Error(`${bad} case(s) kept flipping tabs`);
  step('tabs stay put after fast switching, new/close and Ctrl+Tab bursts');
  console.log('\nE2E tabs OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e.message || e);
  process.exit(1);
});
