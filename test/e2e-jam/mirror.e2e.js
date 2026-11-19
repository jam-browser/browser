// E2E: screen mirroring + control permissions (two app instances on CDP 9301 / 9302, off-screen)
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = 'http://localhost:8766';
const OUT = P.out;

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
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error('timeout: ' + label);
}
const step = (s) => console.log('✓', s);
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const hookToasts = `window.__toasts=[]; if(!window.__th){ window.__th=1; const o=toast; toast=(t,a)=>{window.__toasts.push(t); return o(t,a)} } 1`;

(async () => {
  const A = await target(P.host);
  const B = await target(P.guest);
  for (const X of [A, B]) {
    await until('lock screen', () => X.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`), 20000);
    await X.ev(`${q('#ls-skip')}.click(); 1`);
    await until('booted', () => X.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
    await X.ev(hookToasts);
  }
  // Jam: 자유 입장, 호스트는 테스트 게임 페이지
  await A.ev(`navigateTab(activeTab, '${SITE}/game'); 1`);
  await until('game page', () => A.ev(`activeTab.url.startsWith('${SITE}/game') && !activeTab.loading`));
  const RELAY = process.argv[3]; // 중계 서버 포트를 주면 그 서버를 거쳐서 참여
  await A.ev(`${q('#server-url')}.value=${JSON.stringify(RELAY ? `127.0.0.1:${RELAY}` : '')}; 1`);
  await A.ev(`${q('#name')}.value='호스트'; ${q('#access-mode')}.value='open'; ${q('#access-mode')}.dispatchEvent(new Event('change')); ${q('#start-jam')}.click(); 1`);
  const invite = await until('host started', () => A.ev(`jam.active && jam.invite`), 20000);
  const local = RELAY ? invite : invite.replace(/^jam:\/\/[^/]+/, 'jam://127.0.0.1:' + invite.match(/:(\d+)\//)[1]);
  if (RELAY && !invite.startsWith('jamr://')) throw new Error('not a relay invite ' + invite);
  console.log(`  (path: ${RELAY ? 'via relay ' + invite.split('/')[2] : 'direct LAN'})`);
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(local)}; ${q('#join-jam')}.click(); 1`);
  await until('B joined', () => B.ev(`jam.active`), 15000);
  const gid = await B.ev(`jam.you.id`);

  // 1. 미러링 시작 → 참여자 화면에 영상
  await A.ev(`window.__mirrorNoConfirm = true; mirror.start(jam.tab); 1`);
  const hs = await until('host frames', () => A.ev(`(s => s.host && s.host.sent > 10 && s.host)(mirror.stats())`), 20000);
  const vs = await until('guest frames', () => B.ev(`(s => s.view && s.view.frames > 5 && s.view)(mirror.stats())`), 20000);
  const shown = await B.ev(`!${q('#mirror-view')}.hidden`);
  const px = await B.ev(`(() => { const c = ${q('#mirror-canvas')}; const d = c.getContext('2d').getImageData(c.width/4, c.height/2, 1, 1).data; return [c.width, c.height, d[0], d[1], d[2]]; })()`);
  if (!shown || px[2] + px[3] + px[4] === 0) throw new Error('mirror view blank ' + JSON.stringify(px));
  await sleep(1500);
  const vs2 = await B.ev(`mirror.stats().view.frames`);
  step(`mirroring: host encoded ${hs.w}×${hs.h}, sent ${hs.sent} frames; guest decoded ${vs.frames}→${vs2} frames, canvas ${px[0]}×${px[1]} pixel rgb(${px.slice(2).join(',')})`);
  await B.shot('m1-guest-mirror.png');
  await A.shot('m2-host.png');

  // 2. 권한 없이 입력 → 호스트 페이지에 아무것도 안 감
  const W = await target(P.host, (x) => x.type === 'webview' && x.url.startsWith(`${SITE}/game`));
  const pageLog = () => W.ev(`JSON.stringify(window.__log)`);
  const press = (code, key, extra = '') => B.ev(`(() => { const c = ${q('#mirror-canvas')}; c.focus(); for (const t of ['keydown','keyup']) c.dispatchEvent(new KeyboardEvent(t, { code: '${code}', key: '${key}', bubbles: true, cancelable: true ${extra} })); return 1; })()`);
  const click = (fx, fy) => B.ev(`(() => { const c = ${q('#mirror-canvas')}; const r = c.getBoundingClientRect(); const s = Math.min(r.width / c.width, r.height / c.height); const x = r.left + (r.width - c.width * s) / 2 + c.width * s * ${fx}; const y = r.top + (r.height - c.height * s) / 2 + c.height * s * ${fy}; for (const t of ['mousedown','mouseup']) c.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, button: 0, detail: 1, bubbles: true })); return 1; })()`);
  await press('ArrowUp', 'ArrowUp');
  await click(0.5, 0.5);
  await sleep(800);
  if ((await pageLog()) !== '[]') throw new Error('input leaked without permission ' + (await pageLog()));
  step('no permission → guest keys/clicks never reach the host page');

  // 3. 게임 키 권한 (호스트가 참여자 목록에서 고름)
  await A.ev(`(() => { const b = document.querySelector('#members input.mirror-mouse'); b.checked = true; const s = document.querySelector('#members select.mirror-keys'); s.value = 'game'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await until('B game level', () => B.ev(`jam.me().control.k === 'game'`));
  await press('ArrowUp', 'ArrowUp');
  await press('KeyT', 't');
  await press('ArrowLeft', 'ArrowLeft', ', ctrlKey: true');
  await click(0.25, 0.5);
  const log1 = await until('host page got input', async () => {
    const l = JSON.parse(await pageLog());
    return l.some((x) => x.startsWith('d:ArrowUp')) && l.some((x) => x.startsWith('m:')) ? l : null;
  }, 8000);
  await sleep(500);
  const log1b = JSON.parse(await pageLog());
  if (log1b.some((x) => x.includes('KeyT') || x.includes('ArrowLeft'))) throw new Error('blocked key leaked ' + log1b);
  const m = log1b.find((x) => x.startsWith('m:'));
  step(`"game" permission: host page got ${JSON.stringify(log1b)} (KeyT and Ctrl+← blocked; click at ${m})`);
  const ctrlLabel = await A.ev(`${q('#mirror-ctrl')}.textContent`);

  // 4. 2P: WASD → 방향키
  await A.ev(`(() => { const b = document.querySelector('#members input.mirror-mouse'); b.checked = true; const s = document.querySelector('#members select.mirror-keys'); s.value = 'game2'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await until('B game2', () => B.ev(`jam.me().control.k === 'game2'`));
  await W.ev(`window.__log.length = 0; 1`);
  await press('KeyD', 'd');
  const log2 = await until('remap', async () => {
    const l = JSON.parse(await pageLog());
    return l.length ? l : null;
  }, 8000);
  if (!log2[0].startsWith('d:ArrowRight')) throw new Error('remap failed ' + log2);
  step(`"game2" (2P) permission: guest's KeyD arrived as ${log2[0]} · host saw label "${ctrlLabel}"`);

  // 5. 모두 회수 (Esc 길게) → 다시 막힘
  await A.ev(`mirror.revokeAll('test'); 1`);
  await until('revoked', () => B.ev(`(c => !c.m && c.k === 'none')(jam.me().control)`));
  await W.ev(`window.__log.length = 0; 1`);
  await press('ArrowUp', 'ArrowUp');
  await sleep(800);
  if ((await pageLog()) !== '[]') throw new Error('input after revoke ' + (await pageLog()));
  step('revoke all → guest back to view-only, input blocked again');

  // 6. 미러링 탭이 다른 사이트로 가면 자동 회수
  await A.ev(`(() => { const b = document.querySelector('#members input.mirror-mouse'); b.checked = true; const s = document.querySelector('#members select.mirror-keys'); s.value = 'game'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await until('B game again', () => B.ev(`jam.me().control.k === 'game'`));
  await A.ev(`navigateTab(jam.tab, 'https://example.com/'); 1`);
  await until('auto revoke', () => B.ev(`(c => !c.m && c.k === 'none')(jam.me().control)`), 15000);
  const autoToast = await A.ev(`window.__toasts.find(t => t.includes('회수'))`);
  step(`mirrored tab moved to another site → permissions auto-revoked ("${autoToast}")`);

  // 7. 멈추기
  await A.ev(`mirror.stop(); 1`);
  await until('guest view closed', () => B.ev(`${q('#mirror-view')}.hidden && !mirror.stats().view`), 10000);
  step('stop → guest mirror view closes');

  console.log('\nE2E mirror OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
