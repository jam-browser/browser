// E2E: 👥 친구 상태 — 실제 앱 두 개 (서버 계정 + 서로 친구), 계정 API · 친구 상태가 있는 중계 서버(1.2.0+)
//   run.ps1 이 *.test 를 127.0.0.1 로 (--host-resolver-rules), 가입 열린 중계 서버를 띄워 줌
//   A 가 보는 사이트가 B 에게 보이는지 · 보여 주기 곤란한 사이트는 다른 사이트로 · 숨긴 사이트 · 친구마다 숨기기 · 전체 숨기기
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
        const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
        const ev = async (e) => {
          const m = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
          if (m.result?.exceptionDetails) throw new Error(e.slice(0, 80) + ' -> ' + m.result.exceptionDetails.exception?.description);
          return m.result?.result?.value;
        };
        // 화면 캡처 (out\ 에, git 에 안 들어감)
        const shot = async (file) => {
          const m = await cmd('Page.captureScreenshot', { format: 'png' });
          if (m.result?.data) require('fs').writeFileSync(require('path').join(__dirname, 'out', file), Buffer.from(m.result.data, 'base64'));
        };
        return { ev, shot, close: () => ws.close() };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('no target ' + port);
}
async function until(label, fn, ms = 25000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); } catch (e) { last = e.message; }
    if (last && !(typeof last === 'string' && last.startsWith('!'))) return last;
    await sleep(500);
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
  if (!('accounts' in st) || !('friendStatus' in st)) {
    console.log(`건너뜀: 이 중계 서버(${st.version})는 친구 상태를 몰라요 (1.2.0+)`);
    process.exit(0);
  }
  const SRV = `127.0.0.1:${RELAY}`;
  const PW = 'E2E-Friends-Pass-2026';
  const A = await target(P.host);
  const B = await target(P.guest);

  // 둘 다 첫 화면에서 서버 계정 가입
  for (const [X, id, name] of [[A, 'fr.alice', '앨리스'], [B, 'fr.bob', '밥']]) {
    await until('welcome', () => X.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`));
    await X.ev(`${q('#ls-go-signup')}.click(); 1`);
    await until('signup form', () => X.ev(`!${q('#ls-signup')}.hidden`));
    await X.ev(`${set('#ls-su-srv', SRV)} ${set('#ls-su-id', id)} ${set('#ls-su-name', name)} ${set('#ls-su-pw', PW)} ${set('#ls-su-pw2', PW)} ${q('#ls-signup')}.requestSubmit(); 1`);
    await until(`${id} booted`, () => X.ev(`${q('#lock-screen')}.hidden && account.isUnlocked() && tabs.length > 0`), 40000);
  }
  // 서로 친구 코드 주고받기
  const codeA = (await A.ev(`jamVault.identity()`)).friendCode;
  const codeB = (await B.ev(`jamVault.identity()`)).friendCode;
  await A.ev(`jamVault.addFriend(${JSON.stringify(codeB)}, '밥')`);
  await B.ev(`jamVault.addFriend(${JSON.stringify(codeA)}, '앨리스')`);
  step('A, B signed up on the relay and added each other as friends');

  // B 에서 본 앨리스
  const alice = () => B.ev(`(async () => { const s = await jamFriends.refresh(); const f = s.friends.find(x => x.name === '앨리스'); return f ? { st: f.st, site: f.site, jam: f.jam, relays: s.relays } : null; })()`);
  const want = (label, ok) => until(label, async () => { const f = await alice(); return ok(f) ? f : '!' + JSON.stringify(f); });

  // ① 평범한 사이트 → 그대로
  await A.ev(`createTab('http://news.test:8766/'); 1`);
  const f1 = await want('B sees news.test', (f) => f && f.st !== 'offline' && f.site === 'news.test');
  step(`A opens news.test → B sees 🟢 online · ${f1.site} (relay ${JSON.stringify(f1.relays)})`);

  // 👥 창 (B): 배지 · 줄
  await B.ev(`${q('#friends-btn')}.click(); 1`);
  const row = await until('B panel row', () => B.ev(`(() => { const r = ${q('#fr-list .fr-row')}; return r && r.textContent.includes('news.test') && { text: r.textContent, badge: ${q('#friends-badge')}.textContent, hidden: ${q('#friends-badge')}.hidden }; })()`));
  if (row.hidden || row.badge !== '1') throw new Error('badge ' + JSON.stringify(row));
  await B.shot('friends-panel-b.png');
  await B.ev(`document.body.click(); 1`);
  step(`B's 👥 panel: badge ${row.badge}, row "${row.text.replace(/\s+/g, ' ').trim()}"`);

  // ② 보여 주기 곤란한 사이트 → 방금 보던 사이트로
  await A.ev(`createTab('http://best-casino.test:8766/'); 1`);
  await until('A on casino', () => A.ev(`activeTab && activeTab.url.includes('best-casino.test')`));
  await sleep(4500);
  const f2 = await want('B still sees news.test', (f) => f && f.st !== 'offline' && f.site === 'news.test');
  const meLine = await A.ev(`jamFriendStatus.shown()`);
  if (!meLine.decoy || meLine.site !== 'news.test') throw new Error('A shown ' + JSON.stringify(meLine));
  await A.ev(`${q('#friends-btn')}.click(); 1`);
  const aLine = await until('A me line', () => A.ev(`${q('#fr-me-line')}.textContent.includes('대신') && ${q('#fr-me-line')}.textContent`));
  await A.shot('friends-panel-a-decoy.png');
  await A.ev(`document.body.click(); 1`);
  step(`A opens best-casino.test → B still sees ${f2.site} (A's panel: "${aLine}")`);

  // ③ 🛡 친구에게 숨기기 한 사이트 → 마찬가지
  await A.ev(`createTab('http://blog.test:8766/'); 1`);
  await want('B sees blog.test', (f) => f && f.site === 'blog.test');
  await A.ev(`jamSite.set({ site: 'blog.test', key: 'friendHide', value: true }).then(() => jamFriendStatus.reloadHidden())`);
  const f3 = await want('blog.test hidden', (f) => f && f.st !== 'offline' && f.site && f.site !== 'blog.test');
  const listed = await A.ev(`jamSite.list().then(r => r.sites['blog.test'])`);
  step(`A hides blog.test from friends (🛡) → B sees ${f3.site} instead · site setting ${JSON.stringify(listed)}`);
  await A.ev(`jamSite.set({ site: 'blog.test', key: 'friendHide', value: false }).then(() => jamFriendStatus.reloadHidden())`);
  await want('blog.test again', (f) => f && f.site === 'blog.test');

  // ④ 친구마다 숨기기 (A 의 👥 창 버튼) → B 에게 오프라인
  await A.ev(`${q('#friends-btn')}.click(); 1`);
  await until('A row', () => A.ev(`!!${q('#fr-list .fr-row .fr-hide')}`));
  await A.ev(`${q('#fr-list .fr-row .fr-hide')}.click(); 1`);
  await until('A hide on', () => A.ev(`(async () => (await jamVault.friends()).some(f => f.hideStatus))()`));
  await want('B sees A offline (per-friend hide)', (f) => f && f.st === 'offline');
  await until('A row shows 숨김', () => A.ev(`${q('#fr-list .fr-row .fr-hide')}.textContent.includes('숨김')`));
  await A.ev(`${q('#fr-list .fr-row .fr-hide')}.click(); 1`);
  await want('B sees A online again', (f) => f && f.st !== 'offline');
  step('A hides from 밥 in the 👥 panel → B sees ⚫ offline; un-hide → 🟢 again');

  // ⑤ 전체: 온라인만 → 숨기기
  await A.ev(`${set('#fr-mode', 'online')} ${q('#fr-mode')}.dispatchEvent(new Event('change')); 1`);
  await want('online only', (f) => f && f.st !== 'offline' && !f.site);
  await A.ev(`${set('#fr-mode', 'hidden')} ${q('#fr-mode')}.dispatchEvent(new Event('change')); 1`);
  await want('hidden → offline', (f) => f && f.st === 'offline');
  const seenText = await until('B offline row', async () => {
    await B.ev(`${q('#friends-btn')}.click(); 1`);
    const t = await B.ev(`${q('#fr-list .fr-row')}.textContent`);
    await B.ev(`document.body.click(); 1`);
    return /오프라인 · .*접속/.test(t) && t;
  });
  await A.ev(`${set('#fr-mode', 'site')} ${q('#fr-mode')}.dispatchEvent(new Event('change')); 1`);
  await want('visible again', (f) => f && f.st !== 'offline' && f.site === 'blog.test');
  step(`A: "온라인만" → B sees online without a site; "숨기기" → offline ("${seenText.replace(/\s+/g, ' ').trim()}"); back to sites`);

  // ⑥ 잠그면 오프라인
  await A.ev(`jamVault.lock()`);
  await want('locked → offline', (f) => f && f.st === 'offline');
  step('A locks the account → B sees offline right away');

  console.log('\nE2E friends OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e.message || e);
  process.exit(1);
});
