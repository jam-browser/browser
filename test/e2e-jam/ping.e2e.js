// E2E: 핑 — Alt+클릭 · 📍 버튼 · 화면 밖 화살표 · 화면 미러링 위 핑 · 페이지 클릭으로 안 넘어감
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
    await X.ev(`window.__toasts=[]; { const o = toast; toast = (t, a) => { window.__toasts.push(t); return o(t, a); }; } window.__pingsShown = []; 1`);
  }
  await A.ev(`navigateTab(activeTab, '${SITE}/long'); 1`);
  await until('long', () => A.ev(`activeTab.url === '${SITE}/long' && !activeTab.loading`));
  await A.ev(`${q('#name')}.value='호스트'; ${q('#access-mode')}.value='open'; ${q('#access-mode')}.dispatchEvent(new Event('change')); ${q('#start-jam')}.click(); 1`);
  const invite = await until('host', () => A.ev(`jam.active && jam.invite`), 20000);
  const local = invite.replace(/^jam:\/\/[^/]+/, 'jam://127.0.0.1:' + invite.match(/:(\d+)\//)[1]);
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(local)}; ${q('#join-jam')}.click(); 1`);
  await until('joined', () => B.ev(`jam.active && jam.tab && jam.tab.url === '${SITE}/long' && !jam.tab.loading`), 20000);
  await sleep(1000);
  const WB = await target(P.guest, (x) => x.type === 'webview' && x.url === `${SITE}/long`);
  const WA = await target(P.host, (x) => x.type === 'webview' && x.url === `${SITE}/long`);
  const center = (W, id) => W.ev(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [Math.round(r.left + 40), Math.round(r.top + r.height / 2)]; })()`);
  const altClick = async (X, W, id, mods = ['alt']) => {
    const [x, y] = await center(W, id);
    for (const type of ['mouseDown', 'mouseUp']) await X.ev(`jam.tab.webview.sendInputEvent({ type: '${type}', x: ${x}, y: ${y}, button: 'left', clickCount: 1, modifiers: ${JSON.stringify(mods)} }); 1`);
  };

  // 1. 참여자가 Alt+클릭 → 호스트 화면 그 자리에 📍, 참여자 페이지에는 클릭이 안 감
  await altClick(B, WB, 't1');
  const p1 = await until('host got ping', () => A.ev(`window.__pingsShown.length > 0 && window.__pingsShown[0]`), 8000);
  const bShown = await until('guest own ping', () => B.ev(`window.__pingsShown.length > 0`), 5000);
  const bLog = await WB.ev(`JSON.stringify(window.__log)`);
  if (!p1.onscreen || bLog !== '[]') throw new Error(`ping1 ${JSON.stringify(p1)} log ${bLog}`);
  await sleep(300);
  await A.shot('p1-host-ping.png');
  step(`guest Alt+click → host sees 📍 on the same spot (on screen), guest sees own ping too (${bShown}), the page itself got no click (${bLog})`);

  // 2. 호스트가 아래로 내려가 있으면 화면 밖 → 가장자리 화살표
  await WA.ev(`window.scrollTo(0, document.body.scrollHeight); 1`);
  await sleep(400);
  await A.ev(`window.__pingsShown = []; 1`);
  await altClick(B, WB, 't1', ['alt', 'shift']);
  const p2 = await until('host got off-screen ping', () => A.ev(`window.__pingsShown.length > 0 && window.__pingsShown[0]`), 8000);
  if (p2.onscreen) throw new Error('expected off-screen');
  await sleep(300);
  await A.shot('p2-host-edge.png');
  step('host scrolled away → the ⚠️ ping (Alt+Shift+click) shows as an edge arrow (off screen)');

  // 3. 📍 버튼: 누르고 다음 클릭 자리에 (Alt 없이)
  await WA.ev(`window.scrollTo(0, 0); 1`);
  await sleep(300);
  await B.ev(`window.__pingsShown = []; 1`);
  await A.ev(`${q('#ov-ping')}.click(); 1`);
  const modeOn = await A.ev(`${q('#ov-ping')}.classList.contains('on')`);
  await sleep(200);
  await altClick(A, WA, 'top', []);
  await until('guest got button ping', () => B.ev(`window.__pingsShown.length > 0`), 8000);
  const modeOff = await A.ev(`!${q('#ov-ping')}.classList.contains('on')`);
  const aLog = await WA.ev(`JSON.stringify(window.__log)`);
  if (!modeOn || !modeOff || aLog !== '[]') throw new Error(`button mode ${modeOn} ${modeOff} ${aLog}`);
  step(`📍 button: mode on → next plain click became a ping for the guest, mode turned off, page got no click (${aLog})`);

  // 4. 화면 미러링: 보기만 권한인 참여자가 Alt+클릭 → 호스트 탭 위에 핑 (영상으로 모두에게)
  await A.ev(`window.__mirrorNoConfirm = true; mirror.start(jam.tab); window.__pingsShown = []; 1`);
  await until('guest view', () => B.ev(`(s => s.view && s.view.frames > 2)(mirror.stats())`), 20000);
  const canSee = await B.ev(`JSON.stringify(jam.me().control)`);
  await B.ev(`(() => { const c = ${q('#mirror-canvas')}; const r = c.getBoundingClientRect(); const s = Math.min(r.width / c.width, r.height / c.height); const x = r.left + (r.width - c.width * s) / 2 + c.width * s * 0.3; const y = r.top + (r.height - c.height * s) / 2 + c.height * s * 0.2; for (const t of ['mousedown','mouseup']) c.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, button: 0, altKey: true, bubbles: true })); return 1; })()`);
  const p4 = await until('mirror ping drawn on host tab', () => A.ev(`window.__pingsShown.length > 0 && window.__pingsShown[0]`), 8000);
  await sleep(1200);
  await B.shot('p3-guest-mirror-ping.png');
  step(`mirror view: view-only guest (${canSee}) Alt+clicked the video → ping drawn on the host's tab (onscreen ${p4.onscreen}), so it appears in the video for everyone`);

  console.log('\nE2E ping OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
