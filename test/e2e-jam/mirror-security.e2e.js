// E2E: 화면 미러링 보강 — 화질 조절 · 조작 요청 · 개인정보 버튼 차단 · 비밀 칸 · 호스트 입력 숨김 · 원격 입력 뒤 비밀번호 저장 안 함
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
// 두 앱 (CDP 9301 호스트 / 9302 참여자), 화면 밖 창
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
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
}
const step = (s) => console.log('✓', s);
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const hookToasts = `window.__toasts=[]; if(!window.__th){ window.__th=1; const o=toast; toast=(t,a)=>{window.__toasts.push(t); return o(t,a)} } 1`;

// 계정(비밀번호 저장 막기 확인용)은 서버 계정 — run.ps1 이 중계 서버를 띄워 줌. Jam 자체는 예전처럼 직접 연결
async function createAccount(X, name, pw) {
  await require('./signup').signup(X, { relayPort: process.argv[3], id: 'mirror.host', name, pw });
  await until('booted', () => X.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`), 20000);
}

(async () => {
  const A = await target(P.host);
  const B = await target(P.guest);
  await createAccount(A, '호스트', 'Host-Pass-2026!x');
  await until('B lock screen', () => B.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`), 20000);
  await B.ev(`${q('#ls-skip')}.click(); 1`);
  await until('B booted', () => B.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
  for (const X of [A, B]) await X.ev(hookToasts);
  await A.ev(`prefs.set('mirrorMaxFps', '24'); 1`); // 설정으로 최대 24fps (기본은 60)

  await A.ev(`navigateTab(activeTab, '${SITE}/game'); 1`);
  await until('game page', () => A.ev(`activeTab.url.startsWith('${SITE}/game') && !activeTab.loading`));
  const RELAY = process.env.JAM_E2E_MIRROR_VIA_RELAY ? process.argv[3] : ''; // 기본: 직접 연결 (계정용 중계 서버와 별개)
  await A.ev(`${q('#server-url')}.value=${JSON.stringify(RELAY ? `127.0.0.1:${RELAY}` : '')}; 1`);
  await A.ev(`${q('#name')}.value='호스트'; ${q('#access-mode')}.value='open'; ${q('#access-mode')}.dispatchEvent(new Event('change')); ${q('#start-jam')}.click(); 1`);
  const invite = await until('host started', () => A.ev(`jam.active && jam.invite`), 20000);
  const local = RELAY ? invite : invite.replace(/^jam:\/\/[^/]+/, 'jam://127.0.0.1:' + invite.match(/:(\d+)\//)[1]);
  console.log(`  (path: ${RELAY ? 'via relay ' + invite.split('/')[2] : 'direct LAN'})`);
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(local)}; ${q('#join-jam')}.click(); 1`);
  await until('B joined', () => B.ev(`jam.active`), 15000);

  // 1. 미러링 시작 → 영상 형식 · 크기 · 초당 장수
  await A.ev(`window.__mirrorNoConfirm = true; mirror.start(jam.tab); 1`);
  const hs = await until('host frames', () => A.ev(`(s => s.host && s.host.sent > 10 && s.host)(mirror.stats())`), 20000);
  const vs = await until('guest frames', () => B.ev(`(s => s.view && s.view.frames > 5 && s.view)(mirror.stats())`), 20000);
  step(`mirroring: ${hs.codec} ${hs.w}×${hs.h} @ ${hs.fps}fps, start ${(hs.rate / 1e6).toFixed(1)}Mbps; guest decoded ${vs.frames} frames (${vs.codec})`);

  // 2. 좋은 상태가 이어지면 비트레이트부터 올라감 (서버 mstat 실측)
  await sleep(7500);
  const up = await A.ev(`mirror.stats().host`);
  if (!(up.rate > hs.rate)) throw new Error('rate did not rise ' + JSON.stringify(up));
  step(`healthy link → bitrate rose ${(hs.rate / 1e6).toFixed(1)} → ${(up.rate / 1e6).toFixed(1)}Mbps (cap ${(up.cap / 1e6).toFixed(0)}Mbps for ${up.stat?.viewers} viewer, measured ${((up.stat?.out || 0) * 8 / 1e6).toFixed(2)}Mbps)`);

  // 3. 밀림을 흉내 → 초당 장수 먼저, 그다음 비트레이트, 해상도는 마지막
  const trace = [];
  for (let i = 0; i < 4; i++) {
    await A.ev(`mirror.handle({ type: 'mstat', viewers: 1, backlog: 4e6, late: 900, drops: 5, out: 0, cap: 25e6 }); 1`);
    const s = await A.ev(`mirror.stats().host`);
    trace.push(`${s.fps}fps/${(s.rate / 1e6).toFixed(1)}M/${Math.round(s.scale * 100)}%`);
    await sleep(1600);
  }
  const deg = await A.ev(`mirror.stats().host`);
  if (!trace[0].startsWith('15fps') || !trace[1].startsWith('10fps') || deg.scale !== 1) throw new Error('degrade order ' + trace);
  await sleep(1500);
  const codecAfter = await A.ev(`mirror.stats().host.codec`);
  if (codecAfter !== hs.codec) throw new Error(`codec fell back ${hs.codec} → ${codecAfter}`);
  step(`congestion → frame rate first, then bitrate, resolution kept: ${trace.join(' → ')}`);

  // 4. 조작 요청 → 호스트가 토스트에서 허락 (마우스 + 게임 키)
  await B.ev(`${q('#mirror-req')}.click(); 1`);
  await until('host got request', () => A.ev(`window.__toasts.some(t => t.includes('조작을 요청'))`));
  await A.ev(`[...document.querySelectorAll('.toast .toast-btn')].find(b => b.textContent.includes('게임 키')).click(); 1`);
  await until('B game', () => B.ev(`jam.me().control.m === true && jam.me().control.k === 'game'`));
  step('guest pressed ✋ → host toast → granted 🖱+🎮 from the toast');

  // 5. 개인정보 버튼 차단
  await A.ev(`navigateTab(jam.tab, '${SITE}/panel'); 1`);
  await until('panel', () => A.ev(`jam.tab.url === '${SITE}/panel' && !jam.tab.loading`));
  await sleep(800);
  const W = await target(P.host, (x) => x.type === 'webview' && x.url === `${SITE}/panel`);
  const pageLog = async () => JSON.parse(await W.ev(`JSON.stringify(window.__log)`));
  const center = (id) => W.ev(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [(r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight]; })()`);
  const click = async (id) => {
    const [fx, fy] = await center(id);
    await B.ev(`(() => { const c = ${q('#mirror-canvas')}; c.focus(); const r = c.getBoundingClientRect(); const s = Math.min(r.width / c.width, r.height / c.height); const x = r.left + (r.width - c.width * s) / 2 + c.width * s * ${fx}; const y = r.top + (r.height - c.height * s) / 2 + c.height * s * ${fy}; for (const t of ['mousedown','mouseup']) c.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, button: 0, detail: 1, bubbles: true })); return 1; })()`);
    await sleep(600);
  };
  const press = (code, key) => B.ev(`(() => { const c = ${q('#mirror-canvas')}; c.focus(); for (const t of ['keydown','keyup']) c.dispatchEvent(new KeyboardEvent(t, { code: '${code}', key: '${key}', bubbles: true, cancelable: true })); return 1; })()`);
  await until('guest sees panel', () => B.ev(`mirror.stats().view.frames > 0`));
  await sleep(1500);
  await click('next');
  await click('pay');
  await click('me');
  await click('txt');
  await click('gear'); // 글자 없는 톱니바퀴 그림 버튼 (settings.svg)
  const l1 = await pageLog();
  if (!l1.includes('c:next') || !l1.includes('c:txt') || l1.includes('c:pay') || l1.includes('c:me') || l1.includes('c:gear')) throw new Error('button guard ' + JSON.stringify(l1));
  step('icon-only button (<img src="settings.svg">, no text) blocked too');
  const bBlock = await until('guest told', () => B.ev(`window.__toasts.find(t => t.includes('막혔'))`));
  const aBlock = await A.ev(`window.__toasts.find(t => t.includes('막았어요'))`);
  step(`remote clicks: "다음 판" ✓ · plain text ✓ · "결제하기" ✗ · "내 정보" link ✗ (page log ${JSON.stringify(l1)}); guest: "${bBlock}"; host: "${aBlock}"`);

  // 6. 키보드 전체: 일반 칸은 입력 됨, 비밀번호 칸은 클릭도 키도 막힘
  await A.ev(`(() => { const s = document.querySelector('#members select.mirror-keys'); s.value = 'full'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await until('B full', () => B.ev(`jam.me().control.k === 'full'`));
  await click('q');
  await press('KeyA', 'a');
  await press('KeyB', 'b');
  await sleep(600);
  await click('pw');
  await press('KeyC', 'c');
  await sleep(600);
  const l2 = await pageLog();
  if (!l2.includes('i:q:2') || l2.some((x) => x.includes(':pw'))) throw new Error('field guard ' + JSON.stringify(l2));
  step(`full keyboard: typed "ab" into the search box (i:q:2) · password box click/keys blocked (${JSON.stringify(l2.filter((x) => x.includes('q') || x.includes('pw')))})`);

  // 7. 호스트가 비밀번호 칸에 있으면 영상 멈춤 + 참여자 키는 아예 안 보냄
  await W.ev(`document.getElementById('pw').focus(); 1`);
  await until('host paused secret', () => A.ev(`mirror.stats().host.paused === 'secret'`), 5000);
  await until('guest sees secret pause', () => B.ev(`(v => v.paused === 'secret' && v.secret)(mirror.stats().view)`), 5000);
  const pauseText = await B.ev(`${q('#mirror-pause')}.textContent`);
  const framesBefore = await B.ev(`mirror.stats().view.frames`);
  await press('KeyD', 'd');
  await sleep(1200);
  const secretToast = await B.ev(`window.__toasts.find(t => t.includes('키를 보내지 않았어요'))`);
  const framesDuring = await B.ev(`mirror.stats().view.frames`);
  if (!secretToast || (await pageLog()).some((x) => x.startsWith('i:pw'))) throw new Error('secret key leak');
  await W.ev(`document.getElementById('pw').blur(); 1`);
  await until('resumed', () => B.ev(`!mirror.stats().view.paused`), 5000);
  step(`host focused the password box → video paused ("${pauseText}", frames ${framesBefore}→${framesDuring}), guest's key not sent ("${secretToast}"), resumes on blur`);

  // 8. 호스트가 일반 칸에 입력하는 동안 영상 멈춤 (호스트 입력은 참여자가 못 봄)
  await W.ev(`document.getElementById('q').focus(); 1`);
  await sleep(300);
  await A.ev(`jam.tab.webview.sendInputEvent({ type: 'keyDown', keyCode: 'x' }); jam.tab.webview.sendInputEvent({ type: 'char', keyCode: 'x' }); jam.tab.webview.sendInputEvent({ type: 'keyUp', keyCode: 'x' }); 1`);
  await until('host typing pause', () => A.ev(`mirror.stats().host.paused === 'typing'`), 3000);
  await until('guest typing pause', () => B.ev(`mirror.stats().view.paused === 'typing'`), 3000);
  await until('typing resume', () => B.ev(`!mirror.stats().view.paused`), 4000);
  await W.ev(`document.getElementById('q').blur(); 1`);
  step('host typed in a text box → guests saw "⌨ 호스트가 입력 중" pause, video resumed ~1s after the last key');
  await B.shot('m3-guest-panel.png');

  // 9. 다른 컴퓨터의 입력이 들어온 사이트(localhost)에서는 비밀번호 저장 제안 없음, 다른 사이트(127.0.0.1)에서는 있음
  const login = async (base) => {
    await A.ev(`navigateTab(jam.tab, '${base}/pwlogin'); 1`);
    await until('login page', () => A.ev(`jam.tab.url === '${base}/pwlogin' && !jam.tab.loading`));
    await sleep(1200);
    const L = await target(P.host, (x) => x.type === 'webview' && x.url === `${base}/pwlogin`);
    await L.ev(`document.querySelector('#user').value='alice@example.com'; document.querySelector('#pass').value='S1te-Secret-Pass!'; document.querySelector('#go').click(); 1`);
    L.close();
  };
  await login(SITE);
  await sleep(3000);
  const offered1 = await A.ev(`!!${q('.save-toast')}`);
  const guestPage = await B.ev(`mirror.stats().view.paused`);
  await login('http://127.0.0.1:8766');
  const offered2 = await until('save offer on clean site', () => A.ev(`!!${q('.save-toast')}`), 6000).catch(() => false);
  if (offered1 || !offered2) throw new Error(`save offer: tainted=${offered1} clean=${offered2}`);
  step(`password save offer: none on the site that got remote input (localhost), shown on an untouched site (127.0.0.1); guest saw login page as "${guestPage}" pause`);

  // 10. 멈추기
  await A.ev(`mirror.stop(); 1`);
  await until('guest view closed', () => B.ev(`${q('#mirror-view')}.hidden && !mirror.stats().view`), 10000);
  step('stop → guest mirror view closes');

  console.log('\nE2E mirror (security) OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
