// E2E: browser account (lock screen) + password bank + friends-only Jam (two app instances on CDP 9301 / 9302)
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = 'http://localhost:8766';
const OUT = P.out;
const PW_A = 'Correct-Horse-Battery-77';
const PW_B = 'Guest-Account-Pass-2026';

async function connectTarget(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
  });
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const m = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(expr.slice(0, 90) + ' -> ' + JSON.stringify(m.result.exceptionDetails.exception?.description));
    return m.result?.result?.value;
  };
  return { cmd, ev, close: () => ws.close() };
}
async function target(port, pick) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = list.find(pick);
    if (t) return connectTarget(t);
    await sleep(250);
  }
  throw new Error('no target on ' + port);
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
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;

async function createAccount(X, name, pw) {
  await until('welcome', () => X.ev(`!${q('#lock-screen')}.hidden && !${q('#ls-welcome')}.hidden`));
  const tabsBefore = await X.ev('tabs.length');
  await X.ev(`${q('#ls-go-create')}.click(); ${q('#ls-name')}.value=${JSON.stringify(name)}; ${q('#ls-pw')}.value=${JSON.stringify(pw)}; ${q('#ls-pw2')}.value=${JSON.stringify(pw)}; ${q('#ls-create')}.requestSubmit(); 1`);
  const sk = await until('secret key', () => X.ev(`!${q('#ls-secret')}.hidden && ${q('#ls-secret-text')}.textContent`), 20000);
  await X.ev(`${q('#ls-secret-ok')}.click(); ${q('#ls-secret-done')}.click(); 1`);
  await until('booted', () => X.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
  return { sk, tabsBefore };
}

(async () => {
  const A = await target(P.host, (x) => x.type === 'page');
  const B = await target(P.guest, (x) => x.type === 'page');
  const shot = async (X, name) => {
    const s = await X.cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64'));
  };
  await until('A ui', () => A.ev(`typeof account === 'object'`));
  await until('B ui', () => B.ev(`typeof account === 'object'`));

  // 1. 계정 만들기 (처음 화면 → 만들기 → 비밀 키)
  await sleep(500);
  await shot(A, 'v1-welcome.png');
  const a = await createAccount(A, '호스트', PW_A);
  if (a.tabsBefore !== 0) throw new Error('tabs opened behind the lock screen: ' + a.tabsBefore);
  if (!/^JK1(-[A-HJ-NP-Z2-9]{4}){8}$/.test(a.sk)) throw new Error('secret key format ' + a.sk);
  step(`account created: welcome screen first (no tabs behind it), secret key shown ${a.sk.slice(0, 9)}…, browser started after`);
  const bAcc = await createAccount(B, '게스트', PW_B);
  step('second instance account created');

  // 2. 잠금 / 틀린 비밀번호 / 해제
  await A.ev(`account.lockNow()`);
  await until('locked', () => A.ev(`!${q('#lock-screen')}.hidden && !${q('#ls-unlock')}.hidden`));
  const lockedStatus = await A.ev(`jamVault.status()`);
  if (lockedStatus.unlocked) throw new Error('still unlocked');
  const loginsWhileLocked = await A.ev(`jamVault.logins().then(() => 'LEAK', (e) => 'denied')`);
  if (loginsWhileLocked !== 'denied') throw new Error('logins readable while locked');
  await A.ev(`${q('#ls-unlock-pw')}.value='wrong-password-123'; ${q('#ls-unlock')}.requestSubmit(); 1`);
  const wrongMsg = await until('wrong msg', () => A.ev(`${q('#ls-unlock-msg')}.textContent`));
  await A.ev(`${q('#ls-unlock-pw')}.value=${JSON.stringify(PW_A)}; ${q('#ls-unlock')}.requestSubmit(); 1`);
  await until('unlocked', () => A.ev(`${q('#lock-screen')}.hidden`), 20000);
  step(`lock (Ctrl+Shift+L) → logins API denied while locked; wrong password → "${wrongMsg}"; right password unlocks`);

  // 3. 사이트 로그인 → 저장 제안 → 저장
  await A.ev(`navigateTab(activeTab, '${SITE}/pwlogin'); 1`);
  await until('pw page', () => A.ev(`activeTab.url === '${SITE}/pwlogin' && !activeTab.loading`));
  let W = await target(P.host, (x) => x.type === 'webview' && x.url.startsWith(`${SITE}/pwlogin`));
  await sleep(1200); // form scan + pw:available
  await W.ev(`document.querySelector('#user').value='alice@example.com'; document.querySelector('#pass').value='S1te-Secret-Pass!'; document.querySelector('#go').click(); 1`);
  W.close();
  await until('save offer', () => A.ev(`!!${q('.save-toast')}`));
  await shot(A, 'v2-save-offer.png');
  await A.ev(`${q('.save-toast .toast-btn')}.click(); 1`);
  const logins = await until('saved', () => A.ev(`jamVault.logins().then(l => l.length ? l : null)`));
  if (logins[0].username !== 'alice@example.com' || logins[0].origin !== SITE) throw new Error('bad login ' + JSON.stringify(logins));
  step(`login captured on submit → save offer → stored: ${logins[0].origin} / ${logins[0].username} (list has no password field: ${!('pw' in logins[0]) && !('password' in logins[0])})`);

  // 저장 파일에 평문이 없는지
  const vaultFile = path.join(P.hostProfile, 'vault', 'profile.jvault');
  const raw = fs.readFileSync(vaultFile, 'utf8');
  if (raw.includes('alice') || raw.includes('S1te-Secret') || raw.includes('호스트')) throw new Error('plaintext in vault file');
  step(`vault file on disk has no plaintext (starts with ${JSON.stringify(raw.slice(0, 6))}, ${raw.length} bytes)`);

  // 4. 다시 로그인 페이지 → 🔑 를 진짜 클릭 → 채워짐
  await A.ev(`navigateTab(activeTab, '${SITE}/pwlogin?again=1'); 1`);
  await until('pw page 2', () => A.ev(`activeTab.url.includes('again=1') && !activeTab.loading`));
  W = await target(P.host, (x) => x.type === 'webview' && x.url.includes('again=1'));
  await sleep(1500);
  const r = await W.ev(`(() => { const r = document.querySelector('#pass').getBoundingClientRect(); return { right: r.right, top: r.top, h: r.height, left: r.left, bottom: r.bottom }; })()`);
  const empty = await W.ev(`document.querySelector('#pass').value`);
  // 화면 밖 창의 webview 에는 CDP 마우스 입력이 안 가서, Electron sendInputEvent 로 진짜(isTrusted) 클릭을 보낸다
  const click = async (x, y) => {
    x = Math.round(x); y = Math.round(y);
    await A.ev(`(async () => { const w = activeTab.webview; w.sendInputEvent({ type: 'mouseMove', x: ${x}, y: ${y} }); w.sendInputEvent({ type: 'mouseDown', x: ${x}, y: ${y}, button: 'left', clickCount: 1 }); w.sendInputEvent({ type: 'mouseUp', x: ${x}, y: ${y}, button: 'left', clickCount: 1 }); return 1; })()`);
    await sleep(150);
  };
  await click(r.right - 18, r.top + r.h / 2);
  await sleep(400);
  await shot(A, 'v3-fill-menu.png');
  await click(r.left + 30, r.bottom + 48);
  const filled = await until('filled', () => W.ev(`document.querySelector('#pass').value ? [document.querySelector('#user').value, document.querySelector('#pass').value] : null`), 5000);
  if (empty !== '' || filled[1] !== 'S1te-Secret-Pass!') throw new Error('fill failed ' + JSON.stringify(filled));
  step(`🔑 bubble → real click → account menu → fields filled (${filled[0]} / ${'*'.repeat(filled[1].length)})`);
  // 페이지 스크립트가 직접 채우기를 요청해도 (가짜 클릭) 안 채워짐: 비우고 합성 클릭
  await W.ev(`document.querySelector('#pass').value=''; document.querySelector('#user').value=''; 1`);
  W.close();

  // 5. 친구 코드 교환 (A 가 B 를 친구로)
  const bId = await B.ev(`jamVault.identity()`);
  await A.ev(`account.open('vault-friends')`);
  await A.ev(`${q('#friend-code')}.value=${JSON.stringify(bId.friendCode)}; ${q('#friend-form')}.requestSubmit(); 1`);
  await until('friend added', () => A.ev(`jamVault.friends().then(f => f.length === 1 && f[0].fp === ${JSON.stringify(bId.fp)})`));
  await shot(A, 'v4-friends.png');
  await A.ev(`${q('#vault-dialog')}.close(); 1`);
  step(`friend code exchanged: A added B (${bId.fp.slice(0, 8)}…)`);

  // 6. 친구만 Jam
  await A.ev(`${q('#access-mode')}.value='friends'; ${q('#access-mode')}.dispatchEvent(new Event('change')); 1`);
  await A.ev(`${q('#name')}.value='호스트'; ${q('#start-jam')}.click(); 1`);
  const invite = await until('host started', () => A.ev(`jam.active && jam.invite`));
  const access = await A.ev(`jam.room.settings.access`);
  const local = invite.replace(/^jam:\/\/[^/]+/, 'jam://127.0.0.1:' + invite.match(/:(\d+)\//)[1]);
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(local)}; ${q('#join-jam')}.click(); 1`);
  await until('B joined', () => B.ev(`jam.active`));
  const noReq = await A.ev(`jam.requests.size`);
  const badge = await until('friend badge', () => A.ev(`[...document.querySelectorAll('#members .member')].map(li => li.textContent).find(t => t.includes('게스트') && t.includes('⭐'))`));
  step(`friends-only Jam (settings.access=${access}): friend joined with no approval (requests=${noReq}), member list shows "${badge.slice(0, 20)}…"`);
  await shot(A, 'v5-friend-jam.png');

  // 7. 계정이 잠긴(신원 없는) 사람은 거절
  await B.ev(`leaveJam(); 1`);
  await until('B left', () => B.ev(`!jam.active`));
  await B.ev(`account.lockNow()`);
  await until('B locked', () => B.ev(`!${q('#lock-screen')}.hidden`));
  await B.ev(`window.__toasts=[]; const o=toast; toast=(t,a)=>{window.__toasts.push(t); return o(t,a)}; ${q('#invite')}.value=${JSON.stringify(local)}; joinJam(); 1`);
  const rejected = await until('rejected', () => B.ev(`window.__toasts.find(t => t.includes('친구'))`), 10000);
  if (await B.ev(`jam.active`)) throw new Error('non-friend got in');
  step(`without a signed identity → rejected: "${rejected.slice(0, 40)}…"`);

  // 8. 승인 방식으로 바꾸면 요청 카드에 친구 표시
  await B.ev(`${q('#ls-unlock-pw')}.value=${JSON.stringify(PW_B)}; ${q('#ls-unlock')}.requestSubmit(); 1`);
  await until('B unlocked', () => B.ev(`${q('#lock-screen')}.hidden`), 20000);
  await A.ev(`${q('#access-live')}.value='approval'; ${q('#access-live')}.dispatchEvent(new Event('change')); 1`);
  await until('approval mode', () => A.ev(`jam.room.settings.access === 'approval'`));
  await B.ev(`joinJam(); 1`);
  const card = await until('request card', () => A.ev(`${q('#join-requests .req-card')}?.textContent`));
  await shot(A, 'v6-request-card.png');
  await A.ev(`${q('#join-requests .req-card .mini-btn.active')}.click(); 1`);
  await until('B joined 2', () => B.ev(`jam.active`));
  step(`approval mode: request card says "${card.match(/⭐[^)]*\)/)?.[0] || card.slice(0, 60)}" → accepted`);

  // 9. 자유 입장 (B 를 친구에서 빼고 계정 잠금 → 신원 없이도 입장)
  await A.ev(`${q('#access-live')}.value='open'; ${q('#access-live')}.dispatchEvent(new Event('change')); 1`);
  await until('open mode', () => A.ev(`jam.room.settings.access === 'open'`));
  await B.ev(`leaveJam(); 1`);
  await until('B left 2', () => B.ev(`!jam.active`));
  await B.ev(`account.lockNow()`);
  await until('B locked 2', () => B.ev(`!${q('#lock-screen')}.hidden`));
  await B.ev(`joinJam(); 1`);
  await until('B joined open', () => B.ev(`jam.active`));
  const reqs = await A.ev(`jam.requests.size`);
  step(`open mode: joined anonymously without approval (requests=${reqs})`);

  // 10. 참여자에게 친구 목록이 가지 않음
  const guestSettings = await B.ev(`JSON.stringify(jam.room.settings)`);
  if (guestSettings.includes(bId.fp) || guestSettings.includes('allow"')) throw new Error('allow list leaked ' + guestSettings);
  step(`guest-visible settings have no friend list: ${guestSettings}`);

  console.log('\nE2E vault/access OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
