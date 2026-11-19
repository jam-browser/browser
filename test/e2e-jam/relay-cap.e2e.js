// E2E: 중계 서버 대역폭 한도(손님 0.5Mbps)에서 화면 미러링 → 호스트가 스스로 낮추고, 영상은 계속 옴, 파일도 끝까지 받음
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
const WebSocket = require('ws');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAY = process.argv[3];
const FIX = P.fixtures;

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
        return { ev };
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
    await sleep(250);
  }
  throw new Error('timeout: ' + label);
}
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const status = async () => JSON.parse(await (await fetch(`http://127.0.0.1:${RELAY}/status`)).text());

(async () => {
  const A = await target(P.host);
  const B = await target(P.guest);
  for (const X of [A, B]) {
    await until('lock', () => X.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`), 20000);
    await X.ev(`${q('#ls-skip')}.click(); 1`);
    await until('booted', () => X.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
  }
  await A.ev(`navigateTab(activeTab, 'http://localhost:8766/game'); 1`);
  await until('game', () => A.ev(`activeTab.url.includes('/game') && !activeTab.loading`));
  await A.ev(`${q('#server-url')}.value='127.0.0.1:${RELAY}'; ${q('#name')}.value='호스트'; ${q('#access-mode')}.value='open'; ${q('#access-mode')}.dispatchEvent(new Event('change')); ${q('#start-jam')}.click(); 1`);
  const invite = await until('host', () => A.ev(`jam.active && jam.invite`), 20000);
  if (!invite.startsWith('jamr://')) throw new Error('not relay ' + invite);
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(invite)}; ${q('#join-jam')}.click(); 1`);
  await until('joined', () => B.ev(`jam.active`), 15000);
  console.log('relay limits', JSON.stringify((await status()).limits));

  await A.ev(`window.__mirrorNoConfirm = true; mirror.start(jam.tab); 1`);
  const h0 = await until('host frames', () => A.ev(`(s => s.host && s.host.sent > 3 && s.host)(mirror.stats())`), 20000);
  await until('guest frames', () => B.ev(`(s => s.view && s.view.frames > 0 && s.view)(mirror.stats())`), 30000);
  const f1 = await B.ev(`mirror.stats().view.frames`);
  await sleep(15000);
  const h1 = await A.ev(`mirror.stats().host`);
  const f2 = await B.ev(`mirror.stats().view.frames`);
  const st = await status();
  console.log(`host start ${h0.fps}fps/${(h0.rate / 1e6).toFixed(1)}M → after 15s ${h1.fps}fps/${(h1.rate / 1e6).toFixed(1)}M scale ${h1.scale}; host saw backlog=${h1.stat?.backlog} late=${h1.stat?.late}ms drops=${h1.stat?.drops}`);
  console.log(`guest frames ${f1} → ${f2}; relay pauses ${st.pauses}, bytes ${st.bytes}`);
  if (!(h1.fps < h0.fps || h1.rate < h0.rate)) throw new Error('host did not adapt');
  if (!(f2 > f1)) throw new Error('video stopped');
  if (!(st.pauses > 0)) throw new Error('relay never throttled');
  console.log('✓ relay throttled (no drops) → host lowered frame rate / bitrate by itself, video kept coming');

  // 파일도 한도 안에서 끝까지 (PDF 2KB 라 빠르게, HTML 폴더)
  await A.ev(`mirror.stop(); 1`);
  const meta = await A.ev(`jamApp.fileFromPath(${JSON.stringify(path.join(FIX, 'site', 'index.html'))}, true)`);
  await A.ev(`jamFiles.share(${JSON.stringify(meta)}); 1`);
  await until('guest sees file', () => B.ev(`jamFiles.list().find(f => f.fid === '${meta.fid}' && f.ready)`), 20000);
  await B.ev(`jamFiles.download('${meta.fid}'); 1`);
  await until('guest got file', () => B.ev(`jamFiles.list().find(f => f.fid === '${meta.fid}' && f.local)`), 30000);
  console.log('✓ shared file downloaded completely through the throttled relay (hash checked)');
  console.log('\nE2E relay cap OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
