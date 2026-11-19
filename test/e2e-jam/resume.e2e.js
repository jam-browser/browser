// E2E: 다른 기기에서 이어 보기 (같은 브라우저 계정)
//   A: 계정 만들기 → 중계 서버로 Jam 시작 ("링크 + 승인") → 중계 서버에 암호문이 맡겨짐
//   B: 첫 화면에서 A 의 계정 백업 불러오기 + 같은 비밀번호 · 비밀 키로 잠금 해제 (계정을 다른 기기로 옮기는 방법 그대로)
//      → "💻 내 다른 기기의 Jam" 에 A 의 Jam → 이어 보기 → 승인 없이 입장 (A 의 참여자 목록에 💻)
//   A 가 Jam 을 끝내면 중계 서버에서 사라짐
// 실행: test/e2e-jam/run.ps1 -Tests resume -Relay <presence 를 아는 jam-relay.js (1.0.5+)>
const P = require('./ports');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAY = process.argv[3];
const PW = 'Resume-Test-2026!';

async function target(port, pick = (x) => x.type === 'page') {
  for (let i = 0; i < 80; i++) {
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
        return { ev, close: () => ws.close() };
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
const step = (s) => console.log('✓', s);
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const relayStatus = async () => (await (await fetch(`http://127.0.0.1:${RELAY}/status`)).json());

(async () => {
  if (!RELAY) {
    console.log('건너뜀: 중계 서버가 필요해요 (-Relay)');
    process.exit(0);
  }
  const ver = await (await fetch(`http://127.0.0.1:${RELAY}/version`)).text();
  if (!('presence' in (await relayStatus()))) {
    console.log(`건너뜀: 이 중계 서버(${ver})는 이어 보기를 몰라요 (1.0.5+ 필요)`);
    process.exit(0);
  }

  // ---- A: 계정 + Jam ----
  const A = await target(P.host);
  await until('A welcome', () => A.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`), 20000);
  await A.ev(`${q('#ls-go-create')}.click(); ${q('#ls-name')}.value='나'; ${q('#ls-pw')}.value=${JSON.stringify(PW)}; ${q('#ls-pw2')}.value=${JSON.stringify(PW)}; ${q('#ls-create')}.requestSubmit(); 1`);
  const sk = await until('A secret', () => A.ev(`!${q('#ls-secret')}.hidden && ${q('#ls-secret-text')}.textContent`), 30000);
  await A.ev(`${q('#ls-secret-ok')}.click(); ${q('#ls-secret-done')}.click(); 1`);
  await until('A booted', () => A.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`), 20000);
  await A.ev(`${q('#server-url')}.value='127.0.0.1:${RELAY}'; ${q('#access-mode')}.value='approval'; ${q('#access-mode')}.dispatchEvent(new Event('change')); ${q('#name')}.value='나 (데스크톱)'; 1`);
  await A.ev(`navigateTab(activeTab, 'http://localhost:8766/long'); 1`);
  await sleep(1500);
  await A.ev(`${q('#start-jam')}.click(); 1`);
  const invite = await until('A hosting', () => A.ev(`jam.active && jam.invite`), 20000);
  if (!invite.startsWith('jamr://')) throw new Error('not via relay: ' + invite);
  await until('presence at relay', async () => (await relayStatus()).presence === 1, 10000);
  step(`A (account "나") started a Jam via the relay; the relay holds 1 encrypted presence (it only sees a random ID + ciphertext)`);

  // ---- B: 계정 백업 파일 + 비밀 키로 옮기기 (사용자가 하는 그대로: A 백업 → B 첫 화면 "백업 불러오기") ----
  if (!process.env.JAM_TEST_DIALOG_FILE) throw new Error('JAM_TEST_DIALOG_FILE 이 필요해요 (run.ps1 이 넣어 줌)');
  fs.rmSync(process.env.JAM_TEST_DIALOG_FILE, { force: true });
  const saved = await A.ev(`jamVault.exportBackup()`);
  if (!saved || !fs.existsSync(process.env.JAM_TEST_DIALOG_FILE)) throw new Error('backup not written');
  const B = await target(P.guest);
  await until('B welcome', () => B.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`), 20000);
  // 중계 서버 주소는 잠금 해제 전에 (잠금을 풀자마자 찾음)
  await B.ev(`window.__toasts=[]; { const o = toast; toast = (t, a) => { window.__toasts.push(t); return o(t, a); }; } ${q('#server-url')}.value='127.0.0.1:${RELAY}'; ${q('#ls-go-import')}.click(); 1`);
  await until('B unlock screen', () => B.ev(`!${q('#ls-unlock')}.hidden`), 15000);
  const needSk = await B.ev(`!${q('#ls-sk-row')}.hidden`);
  await B.ev(`${q('#ls-unlock-pw')}.value=${JSON.stringify(PW)}; ${q('#ls-unlock-sk')}.value=${JSON.stringify(sk)}; ${q('#ls-unlock')}.requestSubmit(); 1`);
  await until('B unlocked', () => B.ev(`${q('#lock-screen')}.hidden && account.isUnlocked()`), 30000).catch(async (e) => {
    throw new Error(e.message + ' — ' + JSON.stringify(await B.ev(`({ msg: ${q('#ls-unlock-msg')}.textContent, steps: [...document.querySelectorAll('.ls-step')].filter(s => !s.hidden).map(s => s.id) })`)));
  });
  fs.rmSync(process.env.JAM_TEST_DIALOG_FILE, { force: true });
  step(`B: imported A's account backup on the first screen + password${needSk ? ' + secret key' : ''} → unlocked`);

  const card = await until('B resume card', () => B.ev(`!${q('#resume-box')}.hidden && ${q('#resume-list')}.textContent.includes('이어 보기') && ${q('#resume-list')}.textContent`), 15000);
  const toastT = await B.ev(`window.__toasts.find(t => t.includes('내 다른 기기')) || ''`);
  step(`B found it on unlock: "${card.slice(0, 60)}" · toast "${toastT.slice(0, 50)}…"`);

  await B.ev(`${q('#resume-list .mini-btn')}.click(); 1`);
  await until('B joined', () => B.ev(`jam.active && !jam.isHost()`), 20000);
  const reqs = await A.ev(`jam.requests.size`);
  const me = await until('A sees 💻', () => A.ev(`(jam.room.members.find(m => m.self) || null)`), 10000);
  const badge = await A.ev(`[...document.querySelectorAll('#members .badge-friend')].map(b => b.textContent).join('')`);
  if (reqs !== 0) throw new Error('approval was requested');
  step(`B joined with no approval (A has ${reqs} requests) · A's member list: "${me.name}" ${badge.includes('💻') ? '💻' : badge}`);

  // A 가 Jam 을 끝내면 중계 서버에서도 사라짐
  await A.ev(`leaveJam({ ask: false }); 1`);
  await until('presence gone', async () => (await relayStatus()).presence === 0, 10000);
  step('A ended the Jam → the relay forgot the presence');

  B.close();
  A.close();
  console.log('\nE2E resume OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
