// E2E: 핑 휠 — Alt 누른 채 드래그 방향(위 ⚠️ · 아래 ❓ · 오른쪽 👀 · 왼쪽 🏃 · 그대로 📍), Jam 탭 밖은 그대로, 미러 화면 휠
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = P.out;
const SITE = 'http://localhost:8766';

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
          const m = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
          if (m.result?.exceptionDetails) throw new Error(e.slice(0, 80) + ' -> ' + m.result.exceptionDetails.exception?.description);
          return m.result?.result?.value;
        };
        const shot = async (name) => fs.writeFileSync(path.join(OUT, name), Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
        return { ev, shot, close: () => ws.close() };
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

(async () => {
  const A = await target(P.host);
  const B = await target(P.guest);
  for (const X of [A, B]) {
    await until('lock', () => X.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`), 20000);
    await X.ev(`${q('#ls-skip')}.click(); 1`);
    await until('booted', () => X.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
    await X.ev(`window.__pingsShown = []; 1`);
  }
  await A.ev(`navigateTab(activeTab, '${SITE}/long'); 1`);
  await until('long', () => A.ev(`activeTab.url === '${SITE}/long' && !activeTab.loading`));
  await A.ev(`${q('#name')}.value='호스트'; ${q('#access-mode')}.value='open'; ${q('#access-mode')}.dispatchEvent(new Event('change')); ${q('#start-jam')}.click(); 1`);
  const invite = await until('host', () => A.ev(`jam.active && jam.invite`), 20000);
  const local = invite.replace(/^jam:\/\/[^/]+/, 'jam://127.0.0.1:' + invite.match(/:(\d+)\//)[1]);
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(local)}; ${q('#join-jam')}.click(); 1`);
  await until('joined', () => B.ev(`jam.active && jam.tab && jam.tab.url === '${SITE}/long' && !jam.tab.loading`), 20000);
  await sleep(1200);
  const WB = await target(P.guest, (x) => x.type === 'webview' && x.url === `${SITE}/long`);
  const [x0, y0] = await WB.ev(`(() => { const r = document.getElementById('t1').getBoundingClientRect(); return [Math.round(r.left + 60), Math.round(r.top + r.height / 2)]; })()`);
  const input = (X, ev) => X.ev(`jam.tab.webview.sendInputEvent(${JSON.stringify(ev)}); 1`);
  const lastKind = () => A.ev(`(window.__pingsShown.at(-1) || {}).k`);

  // 1. 방향마다 핑 종류
  const dirs = [['아래', 0, 75, 'what'], ['위', 0, -75, 'warn'], ['오른쪽', 75, 0, 'look'], ['왼쪽', -75, 0, 'omw'], ['그대로', 4, 3, 'here']];
  const seen = [];
  for (const [name, dx, dy, want] of dirs) {
    await sleep(600); // 도배 방지 한도 안에서
    const before = await A.ev(`window.__pingsShown.length`);
    await input(B, { type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1, modifiers: ['alt'] });
    for (let i = 1; i <= 4; i++) await input(B, { type: 'mouseMove', x: Math.round(x0 + (dx * i) / 4), y: Math.round(y0 + (dy * i) / 4), button: 'left', modifiers: ['alt', 'leftButtonDown'] });
    if (want === 'what') {
      await sleep(250);
      await B.shot('w1-wheel-open.png'); // 휠이 열린 화면 (아래 = 노란 물음표 선택)
    }
    await input(B, { type: 'mouseUp', x: Math.round(x0 + dx), y: Math.round(y0 + dy), button: 'left', clickCount: 1, modifiers: ['alt'] });
    await until(`ping ${name}`, () => A.ev(`window.__pingsShown.length > ${before}`), 8000);
    const k = await lastKind();
    seen.push(`${name}→${k}`);
    if (k !== want) throw new Error(`${name}: got ${k}, want ${want}`);
  }
  const bLog = await WB.ev(`JSON.stringify(window.__log)`);
  if (bLog !== '[]') throw new Error('page got clicks ' + bLog);
  await sleep(300);
  await A.shot('w2-host-pings.png');
  step(`hold Alt + drag: ${seen.join(', ')} (page got no clicks)`);

  // 2. Jam 탭이 아닌 탭: Alt+클릭은 그대로 페이지로 (휠 안 뜸)
  await B.ev(`activateTab(createTab('${SITE}/long?free=1')); 1`);
  await until('free tab', () => B.ev(`activeTab !== jam.tab && activeTab.url.includes('free=1') && !activeTab.loading`), 15000);
  await sleep(1200);
  const WF = await target(P.guest, (x) => x.type === 'webview' && x.url.includes('free=1'));
  const [fx, fy] = await WF.ev(`(() => { const r = document.getElementById('t1').getBoundingClientRect(); return [Math.round(r.left + 60), Math.round(r.top + r.height / 2)]; })()`);
  const nBefore = await A.ev(`window.__pingsShown.length`);
  for (const type of ['mouseDown', 'mouseUp']) await B.ev(`activeTab.webview.sendInputEvent({ type: '${type}', x: ${fx}, y: ${fy}, button: 'left', clickCount: 1, modifiers: ['alt'] }); 1`);
  await sleep(800);
  const freeLog = await WF.ev(`JSON.stringify(window.__log)`);
  const nAfter = await A.ev(`window.__pingsShown.length`);
  if (!freeLog.includes('c:t1') || nAfter !== nBefore) throw new Error(`free tab: ${freeLog} pings ${nBefore}->${nAfter}`);
  step(`outside the Jam tab Alt+click stays a normal click (${freeLog}), no ping`);
  await B.ev(`activateTab(jam.tab); 1`);

  // 3. 화면 미러링 위 휠: 오른쪽으로 끌면 👀
  await A.ev(`window.__mirrorNoConfirm = true; mirror.start(jam.tab); 1`);
  await until('guest view', () => B.ev(`(s => s.view && s.view.frames > 2)(mirror.stats())`), 20000);
  await sleep(800);
  await A.ev(`window.__pingsShown = []; 1`);
  await B.ev(`(() => { const c = ${q('#mirror-canvas')}; const r = c.getBoundingClientRect(); window.__wx = r.left + r.width * 0.4; window.__wy = r.top + r.height * 0.3; c.dispatchEvent(new MouseEvent('mousedown', { clientX: __wx, clientY: __wy, button: 0, altKey: true, bubbles: true })); return 1; })()`);
  for (let i = 1; i <= 4; i++) await B.ev(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: __wx + ${i * 20}, clientY: __wy, bubbles: true })); 1`);
  const wheelShown = await B.ev(`!!document.querySelector('.ping-wheel .pw-slice.on')`);
  await sleep(200);
  await B.shot('w3-mirror-wheel.png');
  await B.ev(`window.dispatchEvent(new MouseEvent('mouseup', { clientX: __wx + 80, clientY: __wy, button: 0, bubbles: true })); 1`);
  const mp = await until('mirror wheel ping', () => A.ev(`window.__pingsShown.at(-1)`), 8000);
  if (!wheelShown || mp.k !== 'look') throw new Error(`mirror wheel ${wheelShown} ${JSON.stringify(mp)}`);
  step('mirror screen: Alt + drag right on the video → 👀 ping drawn on the host tab');

  console.log('\nE2E wheel OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
