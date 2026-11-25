// E2E: 로그인은 반드시 중계 서버로 (v0.6.0)
//  A: 가입(자동 로그인 기본) → 잠그고 화면 새로 시작 → 비밀번호 없이 자동 로그인
//     → 인터넷 주소가 죽으면(앞에 둔 중계 프록시를 끔) 같은 네트워크(LAN) 주소로 자동 로그인 · 둘 다 안 되면 "다시 시도"
//  B: 예전 이 PC 계정 → 화면 새로 시작 → "서버 계정으로 옮기기" 를 마쳐야 시작 → 데이터 그대로 서버에
//   run.ps1 이 가입 열린 중계 서버(1.3.0+)를 43131 에 띄움
const P = require('./ports');
const WebSocket = require('ws');
const net = require('net');
const os = require('os');
const { signup } = require('./signup');
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
        ws.on('close', () => { for (const r of p.values()) r({ result: { result: { value: null } } }); p.clear(); });
        const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
        const ev = async (e) => {
          const m = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
          if (m.result?.exceptionDetails) throw new Error(e.slice(0, 80) + ' -> ' + m.result.exceptionDetails.exception?.description);
          return m.result?.result?.value;
        };
        return { ev, cmd, close: () => ws.close() };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('no target ' + port);
}
async function until(label, fn, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); } catch (e) { last = e.message; }
    if (last) return last;
    await sleep(400);
  }
  throw new Error('timeout: ' + label + ' (' + JSON.stringify(last) + ')');
}
const step = (s) => console.log('✓', s);
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
// 화면(앱 창)만 새로 시작 — 메인 프로세스는 그대로라 계정을 잠가 두면 "앱을 다시 켠 것" 과 같은 시작 과정
async function restartUi(port, X) {
  await X.ev(`window.onbeforeunload = null; window.__beforeReload = 1; 1`).catch(() => {});
  await X.cmd('Page.reload', { ignoreCache: true });
  X.close();
  await sleep(3000);
  const Y = await target(port);
  await until('ui back (reloaded)', () => Y.ev(`typeof account === 'object' && !window.__beforeReload`));
  return Y;
}
// "인터넷 주소" 흉내: 중계 서버 앞의 TCP 프록시 (끄면 인터넷 주소만 죽고 LAN 주소는 살아 있음)
function proxy(to) {
  const socks = new Set();
  const srv = net.createServer((c) => {
    const u = net.connect(to, '127.0.0.1');
    socks.add(c).add(u);
    c.pipe(u).pipe(c);
    const end = () => { c.destroy(); u.destroy(); };
    c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ port: srv.address().port, close: () => { for (const s of socks) s.destroy(); srv.close(); } })));
}

(async () => {
  if (!RELAY) {
    console.log('건너뜀: 중계 서버가 필요해요 (-Relay)');
    process.exit(0);
  }
  const hello = await fetch(`http://127.0.0.1:${RELAY}/account/hello?nonce=${'n'.repeat(24)}`);
  if (hello.status !== 200) {
    console.log(`건너뜀: 이 중계 서버는 서버 키(hello)를 몰라요 (1.3.0+)`);
    process.exit(0);
  }
  const front = await proxy(Number(RELAY));
  const PW = 'Auto-Login-Pass-2026';
  let A = await target(P.host);
  const shown = await until('welcome', () => A.ev(`!${q('#ls-welcome')}.hidden && [...document.querySelectorAll('#ls-welcome button')].filter(b => !b.hidden).map(b => b.textContent.trim())`));
  await signup(A, { relayPort: front.port, id: 'auto.user', name: '오토', pw: PW });
  const st0 = await A.ev(`jamVault.status()`);
  if (!st0.autoLogin) throw new Error('auto login not stored by default');
  await A.ev(`jamVault.saveLogin({ origin: 'https://auto.example', username: 'a', password: 'Auto-Site-1!' })`);
  await sleep(2500);
  step(`first screen ${JSON.stringify(shown)} → signed up through 127.0.0.1:${front.port} with "자동 로그인" checked by default (stored: ${st0.autoLogin})`);

  // 1. 잠그고 다시 시작 → 비밀번호 없이 로그인
  await A.ev(`jamVault.lock()`);
  A = await restartUi(P.host, A);
  await until('auto logged in', () => A.ev(`${q('#lock-screen')}.hidden && account.isUnlocked() && tabs.length > 0`)).catch(async (e) => {
    throw new Error(e.message + ' ' + JSON.stringify(await A.ev(`(async () => ({ steps: [...document.querySelectorAll('.ls-step')].filter(s => !s.hidden).map(s => s.id), lock: !${q('#lock-screen')}.hidden, auto: ${q('#ls-auto-msg')}.textContent, unlock: ${q('#ls-unlock-msg')}.textContent, reason: ${q('#ls-unlock-reason')}.textContent, st: await jamVault.status(), tabs: tabs.length }))()`)));
  });
  const st1 = await A.ev(`jamVault.status()`);
  step(`restart → logged in without a password (via ${st1.via}, sync ${st1.sync.state})`);

  // 2. 인터넷 주소가 죽으면 → 같은 네트워크 주소(서버가 알려 준, 서버 키 확인)로
  const acct = await A.ev(`jamVault.status().then(s => s.account)`);
  const lanIps = Object.values(os.networkInterfaces()).flat().filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  front.close();
  await A.ev(`jamVault.lock()`);
  if (lanIps.length) {
    A = await restartUi(P.host, A);
    await until('auto logged in via LAN', () => A.ev(`${q('#lock-screen')}.hidden && account.isUnlocked()`), 40000).catch(async (e) => {
      throw new Error(e.message + ' ' + JSON.stringify(await A.ev(`({ msg: ${q('#ls-auto-msg')}.textContent, st: [...document.querySelectorAll('.ls-step')].filter(s => !s.hidden).map(s => s.id) })`)));
    });
    const st2 = await A.ev(`jamVault.status()`);
    if (st2.via !== 'lan') throw new Error('expected LAN, got ' + st2.via);
    const logins = await A.ev(`jamVault.logins().then(l => l.map(x => x.origin))`);
    if (!logins.includes('https://auto.example')) throw new Error('data missing ' + JSON.stringify(logins));
    step(`internet address ${acct.server} down → logged in via the relay's LAN address (server key checked) · data there: ${JSON.stringify(logins)}`);
    await A.ev(`jamVault.lock()`);
  } else console.log('  (LAN step skipped: this PC has no private IPv4 address)');

  // 3. 어느 주소도 안 되면 로그인 안 됨 (이 PC 사본으로 열지 않음) → "다시 시도" · "비밀번호로"
  //    LAN 주소까지 막으려고 계정 정보의 LAN 주소를 아무도 없는 곳으로 바꿀 수는 없으니, 중계 서버를 잠깐 멈추는 대신
  //    잠금 화면에서 비밀번호로 시도: 인터넷 주소(프록시)는 꺼져 있고 LAN 이 있으면 LAN 으로 되므로, LAN 이 없을 때만 확인
  A = await restartUi(P.host, A);
  if (!lanIps.length) {
    const msg = await until('offline message', () => A.ev(`!${q('#ls-auto')}.hidden && !${q('#ls-auto-retry')}.hidden && ${q('#ls-auto-msg')}.textContent`));
    step(`no server reachable → not logged in, shows "${msg}" with 다시 시도 / 비밀번호로 로그인`);
  } else {
    await until('auto logged in again', () => A.ev(`${q('#lock-screen')}.hidden && account.isUnlocked()`), 40000);
  }

  // 4. 예전 이 PC 계정 → 반드시 서버 계정으로 옮겨야 시작
  let B = await target(P.guest);
  await until('B welcome', () => B.ev(`!${q('#ls-welcome')}.hidden`));
  await B.ev(`jamVault.create('예전', 'Old-Local-Pass-77')`); // v0.5 이전에 만든 이 PC 계정 흉내
  await B.ev(`jamVault.saveLogin({ origin: 'https://old.example', username: 'o', password: 'Old-Site-1!' })`);
  B = await restartUi(P.guest, B);
  await until('migrate screen', () => B.ev(`!${q('#ls-migrate')}.hidden`));
  const blocked = await B.ev(`tabs.length === 0 && !${q('#lock-screen')}.hidden`);
  await B.ev(`${q('#ls-mg-srv')}.value='127.0.0.1:${RELAY}'; ${q('#ls-mg-id')}.value='old.local'; ${q('#ls-mg-pw')}.value='wrong-password-1'; ${q('#ls-migrate')}.requestSubmit(); 1`);
  const wrong = await until('wrong pw', () => B.ev(`${q('#ls-mg-msg')}.textContent`));
  await B.ev(`${q('#ls-mg-pw')}.value='Old-Local-Pass-77'; ${q('#ls-migrate')}.requestSubmit(); 1`);
  await until('B booted', () => B.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`), 40000);
  const bs = await B.ev(`jamVault.status()`);
  const bl = await B.ev(`jamVault.logins().then(l => l.map(x => x.origin))`);
  if (!bs.account || bs.account.id !== 'old.local' || !bs.autoLogin || !bl.includes('https://old.example')) throw new Error('migrate ' + JSON.stringify({ bs, bl }));
  // 서버에 정말 있는지: A 를 로그아웃하고 그 아이디로 로그인
  await A.ev(`jamVault.logout()`);
  await A.ev(`${q('#ls-go-login')}.click(); ${q('#ls-srv')}.value='127.0.0.1:${RELAY}'; ${q('#ls-id')}.value='old.local'; ${q('#ls-login-pw')}.value='Old-Local-Pass-77'; ${q('#ls-login')}.requestSubmit(); 1`);
  const onA = await until('A got old.local data', () => A.ev(`account.isUnlocked() && jamVault.logins().then(l => l.map(x => x.origin).includes('https://old.example') && l.map(x => x.origin))`));
  step(`old PC-only account: browser blocked until "서버 계정으로 옮기기" (tabs blocked: ${blocked}, wrong password → "${wrong}") → moved with its data, auto-login on → another app logs in with that ID: ${JSON.stringify(onA)}`);

  console.log('\nE2E autologin OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e.message || e);
  process.exit(1);
});
