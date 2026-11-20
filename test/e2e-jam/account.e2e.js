// E2E: 서버 계정 (중계 서버 1.1.0+ 의 /account): 첫 화면에서 가입 → 다른 앱에서 로그인 → 비밀번호 · 북마크 · 설정 동기화
//   run.ps1 이 계정 API 가 있는 중계 서버를 가입 열림(JAM_RELAY_SIGNUP=open) · 빈 데이터 폴더로 띄워 줌
const P = require('./ports');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAY = process.argv[3];

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
        const ev = async (e) => {
          const m = await new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); });
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
async function until(label, fn, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); } catch (e) { last = e.message; }
    if (last) return last;
    await sleep(300);
  }
  throw new Error('timeout: ' + label + ' (' + JSON.stringify(last) + ')');
}
const step = (s) => console.log('✓', s);
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const set = (sel, v) => `${q(sel)}.value = ${JSON.stringify(v)};`;

(async () => {
  if (!RELAY) {
    console.log('건너뜀: 중계 서버가 필요해요 (-Relay)');
    process.exit(0);
  }
  const st = await (await fetch(`http://127.0.0.1:${RELAY}/status`)).json();
  if (!('accounts' in st)) {
    console.log(`건너뜀: 이 중계 서버(${st.version})는 브라우저 계정을 몰라요 (1.1.0+)`);
    process.exit(0);
  }
  const SRV = `127.0.0.1:${RELAY}`;
  const PW = 'E2E-Account-Pass-2026';
  const A = await target(P.host);
  const B = await target(P.guest);
  for (const X of [A, B]) {
    await until('welcome', () => X.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`));
    await X.ev(`window.__toasts=[]; { const o = toast; toast = (t, a) => { window.__toasts.push(t); return o(t, a); }; } 1`);
  }

  // A: 첫 화면 → 새 계정 만들기 (서버 주소 · 아이디 · 이름 · 비밀번호)
  const buttons = await A.ev(`[...document.querySelectorAll('#ls-welcome button')].map(b => b.textContent.trim())`);
  await A.ev(`${q('#ls-go-signup')}.click(); 1`);
  await until('signup form', () => A.ev(`!${q('#ls-signup')}.hidden`));
  await A.ev(`${set('#ls-su-srv', SRV)} ${set('#ls-su-id', 'E2E.User')} ${set('#ls-su-name', '이투이')} ${set('#ls-su-pw', PW)} ${set('#ls-su-pw2', PW)} ${q('#ls-signup')}.requestSubmit(); 1`);
  await until('A booted', () => A.ev(`${q('#lock-screen')}.hidden && account.isUnlocked() && tabs.length > 0`), 40000);
  const aStatus = await A.ev(`jamVault.status()`);
  if (!aStatus.account || aStatus.account.id !== 'e2e.user') throw new Error('A account ' + JSON.stringify(aStatus.account));
  step(`first screen buttons: ${buttons.join(' / ')} → signed up "e2e.user" on ${SRV} (A unlocked, server account)`);

  // A: 사이트 비밀번호 · 북마크 · 세부 설정
  await A.ev(`jamVault.saveLogin({ origin: 'https://mail.example', username: 'e2e', password: 'Mail-Pass-1!' })`);
  await A.ev(`bookmarks.push({ url: 'https://docs.example/', title: '문서' }); saveBookmarks(); renderBookmarks(); 1`);
  await A.ev(`prefs.set('pingSeconds', 11); 1`);
  await sleep(3500);
  await A.ev(`jamVault.syncNow()`);

  // B: 첫 화면 → 로그인
  await B.ev(`${q('#ls-go-login')}.click(); 1`);
  await until('login form', () => B.ev(`!${q('#ls-login')}.hidden`));
  await B.ev(`${set('#ls-srv', SRV)} ${set('#ls-id', 'e2e.user')} ${set('#ls-login-pw', 'Wrong-Password-99')} ${q('#ls-login')}.requestSubmit(); 1`);
  const wrong = await until('wrong pw msg', () => B.ev(`${q('#ls-login-msg')}.textContent`));
  await B.ev(`${set('#ls-login-pw', PW)} ${q('#ls-login')}.requestSubmit(); 1`);
  await until('B booted', () => B.ev(`${q('#lock-screen')}.hidden && account.isUnlocked() && tabs.length > 0`), 40000);
  const diag = () => B.ev(`(async () => ({ logins: (await jamVault.logins()).map(x => x.origin), bm: bookmarks.map(b => b.url), ping: prefs.get('pingSeconds'), sync: Object.keys((await jamVault.syncGet()) || {}), st: (await jamVault.status()).sync, server: account.server() }))()`);
  const got = await until('B data', () => B.ev(`(async () => { const l = await jamVault.logins(); return l.length && bookmarks.some(b => b.url === 'https://docs.example/') && prefs.get('pingSeconds') === 11 && { logins: l.map(x => x.origin), bm: bookmarks.length, ping: prefs.get('pingSeconds') }; })()`)).catch(async (e) => { throw new Error(e.message + ' B=' + JSON.stringify(await diag()) + ' A=' + JSON.stringify(await A.ev(`(async () => ({ sync: (await jamVault.syncGet()), st: (await jamVault.status()).sync }))()`))); });
  step(`B: wrong password → "${wrong}"; right → logins ${JSON.stringify(got.logins)}, bookmark + setting (ping ${got.ping}s) arrived`);

  // B 에서 바꾸면 A 로
  await B.ev(`bookmarks.push({ url: 'https://from-b.example/', title: 'B' }); saveBookmarks(); renderBookmarks(); 1`);
  await B.ev(`jamVault.saveLogin({ origin: 'https://shop.example', username: 'b', password: 'Shop-Pass-2!' })`);
  await sleep(3500);
  await B.ev(`jamVault.syncNow()`);
  const back = await until('A gets B changes', async () => {
    await A.ev(`jamVault.syncNow()`);
    return A.ev(`(async () => { const l = (await jamVault.logins()).map(x => x.origin).sort(); return l.length === 2 && bookmarks.some(b => b.url === 'https://from-b.example/') && l; })()`);
  });
  step(`B's bookmark + login came back to A: ${JSON.stringify(back)}`);

  // 계정 화면: 서버 계정 · 동기화 상태
  await A.ev(`${q('#account-btn')}.click(); 1`);
  await A.ev(`${q('#vault-nav [data-page="vault-account"]')}.click(); 1`);
  const who = await until('account page', () => A.ev(`!${q('#acc-server-on')}.hidden && ${q('#acc-server-who')}.textContent + ' | ' + ${q('#acc-sync-state')}.textContent`));
  await A.ev(`${q('#vault-dialog')}.close(); 1`);
  step(`account page: "${who}"`);

  // 잠그고 다시 열기 (이 PC: 비밀 키 없이 비밀번호만)
  await A.ev(`jamVault.lock()`);
  await until('unlock screen', () => A.ev(`!${q('#ls-unlock')}.hidden`));
  const unlockInfo = await A.ev(`({ acct: ${q('#ls-unlock-acct')}.textContent, sk: !${q('#ls-sk-row')}.hidden })`);
  await A.ev(`${set('#ls-unlock-pw', PW)} ${q('#ls-unlock')}.requestSubmit(); 1`);
  await until('A unlocked again', () => A.ev(`${q('#lock-screen')}.hidden && account.isUnlocked()`));
  if (unlockInfo.sk) throw new Error('secret key asked for a server account');
  step(`lock → unlock screen shows "${unlockInfo.acct}", password only (no secret key)`);

  console.log('\nE2E account OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e.message || e);
  process.exit(1);
});
