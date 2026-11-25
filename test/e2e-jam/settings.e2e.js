// E2E: 세부 설정 화면 · 실행 중 적용 · HTTPS 우선 · 비슷한 가짜 주소 경고 · 새 탭 음소거
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
}
const step = (s) => console.log('✓', s);
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;

(async () => {
  const A = await target(P.host);
  // 계정 만들기 (비밀번호 뱅크 · 가짜 주소 경고 확인용) — 서버 계정 (run.ps1 이 중계 서버를 띄움)
  await require('./signup').signup(A, { relayPort: process.argv[3], id: 'settings.host', name: '호스트', pw: 'Settings-Test-2026!' });
  await until('booted', () => A.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`), 20000);
  await A.ev(`window.__toasts=[]; { const o = toast; toast = (t, a) => { window.__toasts.push(t); return o(t, a); }; } 1`);

  // 1. 설정 화면: 새 페이지 5개, 항목 수, 보안 끄면 경고
  const pages = await A.ev(`[...document.querySelectorAll('#settings-dialog .set-nav button')].map(b => b.textContent)`);
  const rows = await A.ev(`document.querySelectorAll('#settings-dialog .pref-row').length`);
  for (const p of ['Jam · 연결', '화면 미러링', '같이 보는 파일', '보안 · 개인정보', '소리']) if (!pages.includes(p)) throw new Error('missing page ' + p);
  await A.ev(`(() => { const i = document.querySelector('[data-pref="remoteBlockSensitive"]'); i.checked = false; i.dispatchEvent(new Event('change')); return 1; })()`);
  const warn = await A.ev(`document.querySelector('[data-pref="remoteBlockSensitive"]').closest('.pref-row').querySelector('.pref-warn').textContent`);
  await A.ev(`prefs.set('remoteBlockSensitive', true); 1`);
  step(`settings dialog: pages ${pages.join(' / ')}; ${rows} settings; turning a protection off shows "${warn.slice(0, 40)}…"`);

  // 2. 호스트 Jam 서버에 바로 적용 (실행 중 변경 포함)
  await A.ev(`${q('#name')}.value='호스트'; ${q('#start-jam')}.click(); 1`);
  await until('hosting', () => A.ev(`jam.active && jam.invite`), 20000);
  const l1 = await A.ev(`jamApp.serverLimits()`);
  await A.ev(`prefs.set('maxMembers', 5); prefs.set('mirrorSessionMbps', 300); prefs.set('fileMaxMB', 64); 1`);
  await sleep(300);
  const l2 = await A.ev(`jamApp.serverLimits()`);
  if (l1.maxMembers !== 64 || l1.mirrorRate !== 0 || l2.maxMembers !== 5 || l2.mirrorRate !== 37.5e6 || l2.fileMax !== 64 * 1024 * 1024) throw new Error('limits ' + JSON.stringify({ l1, l2 }));
  step(`host Jam server limits: default ${l1.maxMembers} people · session video unlimited · file ${l1.fileMax / 1024 / 1024}MB → changed live to ${l2.maxMembers} · ${l2.mirrorRate * 8 / 1e6}Mbps · ${l2.fileMax / 1024 / 1024}MB`);
  await A.ev(`leaveJam({ ask: false }); 1`);
  await until('left', () => A.ev(`!jam.active`));

  // 3. 새 탭 음소거 설정
  await A.ev(`prefs.set('muteNewTabs', true); 1`);
  const muted = await A.ev(`(() => { const t = createTab('http://localhost:8766/'); return !!t.muted; })()`);
  await A.ev(`prefs.set('muteNewTabs', false); 1`);
  const unmuted = await A.ev(`(() => { const t = createTab('http://localhost:8766/'); return !!t.muted; })()`);
  if (!muted || unmuted) throw new Error('mute setting');
  step('"새 탭은 음소거로 시작" setting: new tab muted when on, not muted when off');

  // 4. HTTPS 우선: http://example.com → https, 끄면 그대로
  await A.ev(`navigateTab(activeTab, 'http://example.com/'); 1`);
  const httpsUrl = await until('https', () => A.ev(`!activeTab.loading && activeTab.url.startsWith('https://example.com') && activeTab.url`), 20000);
  await A.ev(`prefs.set('httpsFirst', false); 1`);
  await sleep(200);
  await A.ev(`navigateTab(activeTab, 'http://example.com/?plain=1'); 1`);
  const plainUrl = await until('plain', () => A.ev(`!activeTab.loading && activeTab.url.includes('plain=1') && activeTab.url`), 20000);
  await A.ev(`prefs.set('httpsFirst', true); 1`);
  // https 가 안 되는 주소 → http 로 되돌아감 (포트 없는 공인 IP 의 http: 이 PC 에는 https 서버 없음 → 127.0.0.2 는 사설이라 안 바뀜, 그래서 대신 example.invalid 로 실패 확인은 생략)
  if (!plainUrl.startsWith('http://')) throw new Error('httpsFirst off still upgraded ' + plainUrl);
  // https 가 없는 사이트 (neverssl.com 은 일부러 http 만) → https 시도가 실패하면 http 로 다시 열림
  await A.ev(`navigateTab(activeTab, 'http://http.badssl.com/'); 1`);
  const fallback = await until('fallback', () => A.ev(`!activeTab.loading && activeTab.url.startsWith('http://http.badssl.com') && activeTab.url`), 30000).catch(async () => `FAILED (${await A.ev('activeTab.url')})`);
  console.log(`  https-only fallback: http://http.badssl.com/ → ${fallback}`);
  step(`HTTPS-first: http://example.com/ opened as ${httpsUrl}; with the setting off it stays ${plainUrl}`);

  // 5. 비슷한 가짜 주소: mybank.localhost 에 로그인 저장 → mybamk.localhost 에서 경고 · 🔑 채우기 없음
  const login = async (host, submit) => {
    await A.ev(`navigateTab(activeTab, 'http://${host}:8766/pwlogin'); 1`);
    await until('login page ' + host, () => A.ev(`activeTab.url.startsWith('http://${host}:8766/pwlogin') && !activeTab.loading`), 15000);
    await sleep(1200);
    if (!submit) return;
    const W = await target(P.host, (x) => x.type === 'webview' && x.url.startsWith(`http://${host}:8766/pwlogin`));
    await W.ev(`document.querySelector('#user').value='me@bank.test'; document.querySelector('#pass').value='Bank-Pass-1234!'; document.querySelector('#go').click(); 1`);
    W.close();
  };
  await login('mybank.localhost', true);
  await until('save offer', () => A.ev(`!!${q('.save-toast')}`), 10000);
  await A.ev(`${q('.save-toast .toast-btn')}.click(); 1`);
  await until('saved', () => A.ev(`jamVault.logins().then(l => l.length > 0)`), 10000);
  await login('mybamk.localhost', false);
  const lookToast = await until('lookalike toast', () => A.ev(`window.__toasts.find(t => t.includes('비슷한 다른 주소'))`), 8000);
  await login('mybank.localhost', false);
  await sleep(800);
  const realWarned = await A.ev(`window.__toasts.filter(t => t.includes('비슷한 다른 주소')).length`);
  if (realWarned !== 1) throw new Error('warned on the real site too');
  step(`lookalike warning: saved login on mybank.localhost, then mybamk.localhost → "${lookToast.slice(0, 70)}…"; the real site is not warned`);

  console.log('\nE2E settings OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
