// E2E: login wait, follow-person overlay, panel hide, clipboard warning, download quarantine, remote-download block.
const WebSocket = require(process.argv[2] + '/node_modules/ws');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = 'http://localhost:8765';

async function target(port, pick) {
  let t;
  for (let i = 0; i < 40 && !t; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    t = list.find(pick);
    if (!t) await sleep(250);
  }
  if (!t) throw new Error('no target on ' + port);
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
  return { cmd, ev };
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

(async () => {
  const A = await target(9301, (x) => x.type === 'page');
  const B = await target(9302, (x) => x.type === 'page');
  for (const P of [A, B]) await until('app ready', () => P.ev(`typeof jam==='object' && typeof downloadList==='object'`));
  const inPage = (P, code, gesture = false) => P.ev(`jam.tab.webview.executeJavaScript(${JSON.stringify(code)}, ${gesture})`);

  // --- host logs in on the test site, opens the members-only video
  await A.ev(`navigateTab(activeTab, '${SITE}/login'); 1`);
  await until('host login page', () => A.ev(`activeTab.url.includes('/login') && !activeTab.loading`));
  await A.ev(`activeTab.webview.executeJavaScript("document.querySelector('form').submit()"); 1`);
  await until('host logged in', () => A.ev(`activeTab.url === '${SITE}/' && !activeTab.loading`));
  await A.ev(`navigateTab(activeTab, '${SITE}/video'); 1`);
  await until('host on video', () => A.ev(`activeTab.url === '${SITE}/video' && !activeTab.loading`));

  await A.ev(`document.querySelector('#name').value='호스트'; document.querySelector('#start-jam').click(); 1`);
  const invite = await until('started', () => A.ev(`jam.active && jam.invite`));
  step('host started Jam on a members-only video page');

  // --- panel can be hidden; overlay stays
  await A.ev(`document.querySelector('#jam-panel .panel-close').click(); 1`);
  const hidden = await A.ev(`document.querySelector('#jam-panel').classList.contains('collapsed') && !document.querySelector('#jam-overlay').hidden`);
  if (!hidden) throw new Error('panel did not hide / overlay missing');
  step('side panel hidden, Jam overlay still shown');

  // --- guest joins (host approves from the request card even with the panel hidden)
  await B.ev(`document.querySelector('#name').value='게스트'; document.querySelector('#invite').value=${JSON.stringify(invite.replace(/jam:\/\/[^:]+/, 'jam://127.0.0.1'))}; document.querySelector('#join-jam').click(); 1`);
  await until('join request card', () => A.ev(`!!document.querySelector('#join-requests .req-card')`), 10000);
  await A.ev(`document.querySelector('#join-requests .req-card .mini-btn.active').click(); 1`);
  await until('guest joined', () => B.ev(`jam.active && !!jam.tab`), 10000);
  step('guest joined after host approval (request card shown over the page)');

  // --- guest is not logged in → their own login page, sync paused
  await until('guest on own login page', () => B.ev(`!!jam.loginWait && jam.tab.url.includes('/login') && !document.querySelector('#login-banner').hidden`), 15000);
  const hostSeesLogin = await until('host sees guest logging in', () =>
    A.ev(`(jam.room.members.find(m => m.id !== jam.you.id)?.presence || {}).private === true`), 10000);
  const loginText = await B.ev(`document.querySelector('#login-banner').textContent.replace(/\\s+/g,' ').trim()`);
  step(`guest sees their own login page; Jam waits (banner: "${loginText.slice(0, 70)}…")`);
  console.log('  host overlay status for guest:', await A.ev(`document.querySelector('#ov-people .ov-person')?.title.split('\\n')[0]`));

  // host moves the video while the guest is still logging in
  await until('host video ready', () => inPage(A, `(()=>{const v=document.querySelector('video'); return !!v && v.readyState >= 2})()`), 30000);
  await sleep(2500);
  await inPage(A, `(()=>{const v=document.querySelector('video'); v.currentTime=60; v.play(); return 1})()`);
  await sleep(1500);
  const guestStillLogin = await B.ev(`jam.tab.url.includes('/login')`);
  if (!guestStillLogin) throw new Error('guest left login page before logging in');
  step('host seeked to 60s; guest stays on login (not dragged away)');

  // guest logs in → site sends them to its home page → Jam brings them to the video at the right time
  await inPage(B, `document.querySelector('form').submit()`);
  await until('guest auto-moved to Jam video after login', () => B.ev(`jam.tab.url === '${SITE}/video' && !jam.loginWait`), 20000);
  const gt = await until('guest video synced', async () => {
    const t = await inPage(B, `(()=>{const v=document.querySelector('video'); return v && v.readyState >= 2 ? v.currentTime : 0})()`);
    return t > 59 && t;
  }, 30000);
  const ht = await inPage(A, `document.querySelector('video').currentTime`);
  step(`after login guest auto-moved to the video and caught up: guest ${gt.toFixed(1)}s, host ${ht.toFixed(1)}s`);

  // --- follow a person from the overlay
  await A.ev(`navigateTab(jam.tab, '${SITE}/long'); 1`);
  await until('guest on long page', () => B.ev(`jam.tab.url === '${SITE}/long' && !jam.tab.loading`), 15000);
  await sleep(1500);
  await B.ev(`document.querySelector('#ov-people .ov-person').click(); 1`);
  const following = await B.ev(`!!jam.followingId && !document.querySelector('#follow-frame').hidden`);
  if (!following) throw new Error('follow did not start');
  await inPage(A, `(()=>{ const h=document.getElementById('s30'); window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 50); return 1 })()`);
  await sleep(2000);
  const gOff = await inPage(B, `document.getElementById('s30').getBoundingClientRect().top`);
  const hOff = await inPage(A, `document.getElementById('s30').getBoundingClientRect().top`);
  if (Math.abs(gOff - hOff) > 60) throw new Error(`follow off: guest ${gOff} host ${hOff}`);
  await inPage(A, `(()=>{ const h=document.getElementById('s45'); window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 10); return 1 })()`);
  await sleep(2000);
  const gOff2 = await inPage(B, `document.getElementById('s45').getBoundingClientRect().top`);
  step(`clicking the host in the overlay follows their view (section 30: guest ${Math.round(gOff)}px vs host ${Math.round(hOff)}px; then section 45 at ${Math.round(gOff2)}px)`);
  const scrollBefore = await inPage(B, `[scrollY, document.documentElement.scrollHeight - innerHeight]`);
  // 내가 직접 스크롤: 진짜 마우스 휠 입력 (앱 창 기준 좌표, 웹페이지 영역 위)
  for (let i = 0; i < 4; i++) {
    await B.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: -200 });
    await sleep(120);
  }
  await sleep(600);
  console.log('  guest scroll before/after:', scrollBefore, await inPage(B, `scrollY`), 'following:', await B.ev(`jam.followingId`), 'myView.user:', await B.ev(`jam.myView && jam.myView.user`));
  await until('follow stopped by own scroll', () => B.ev(`jam.followingId === null && document.querySelector('#follow-frame').hidden`), 5000);
  step('scrolling yourself stops following');

  // --- clipboard warning (private tab)
  await B.ev(`createTab('${SITE}/clip'); 1`);
  await until('clip page', () => B.ev(`activeTab.url === '${SITE}/clip' && !activeTab.loading`));
  await sleep(1200);
  const siteBanner = await B.ev(`!document.querySelector('#clip-site-banner').hidden`);
  await B.ev(`activeTab.webview.focus(); activeTab.webview.executeJavaScript("document.getElementById('b').click()", true); 1`);
  await until('clipboard modal', () => B.ev(`document.querySelector('#clip-modal').open`), 5000);
  const danger = await B.ev(`!document.querySelector('#clip-danger').hidden`);
  const shown = await B.ev(`document.querySelector('#clip-text').textContent.slice(0, 40)`);
  if (!danger) throw new Error('command not flagged');
  step(`site with copy code → banner on visit: ${siteBanner}; copying a command → warning modal with "절대 실행하지 마세요" (shows "${shown}…")`);
  await B.ev(`document.querySelector('#clip-clear').click(); 1`);
  const cleared = await until('clipboard cleared', () => B.ev(`jamApp.readClipboard().then(t => t === '')`), 3000);
  step('"클립보드 비우기" empties the clipboard: ' + cleared);

  // --- installer download is quarantined
  await B.ev(`navigateTab(activeTab, '${SITE}/tool.exe'); 1`);
  const rec = await until('quarantined download', () =>
    B.ev(`[...downloadList.values()].find(r => r.name === 'tool.exe' && r.state === 'completed') || null`), 10000);
  const onDisk = fs.existsSync(rec.savePath);
  if (!rec.quarantined || !rec.savePath.endsWith('.다운로드확인전') || !onDisk) throw new Error('not quarantined: ' + JSON.stringify(rec));
  let motw = '';
  try { motw = fs.readFileSync(rec.savePath + ':Zone.Identifier', 'utf8').split(/\r?\n/)[1]; } catch {}
  step(`tool.exe held in Downloads as "${rec.savePath.split(/[\\/]/).pop()}" (not runnable), Mark-of-the-Web: ${motw || 'n/a'}`);

  // --- Jam sends everyone to a page that auto-downloads → followers do not download
  const before = await B.ev(`downloadList.size`);
  await B.ev(`window.__blocked = []; jamApp.onDownloadBlocked(i => __blocked.push(i.name)); 1`);
  await A.ev(`navigateTab(jam.tab, '${SITE}/autodl'); 1`);
  await until('guest blocked remote download', () => B.ev(`__blocked.length > 0`), 15000);
  await sleep(1000);
  const afterCount = await B.ev(`downloadList.size`);
  const hostGot = await until('host own download quarantined', () =>
    A.ev(`[...downloadList.values()].filter(r => r.name.startsWith('tool') && r.quarantined).length`), 10000);
  if (afterCount !== before) throw new Error('guest downloaded anyway');
  step(`download triggered by the Jam's navigation was blocked for the guest (host's own download quarantined: ${hostGot})`);

  await A.ev(`leaveJam({ask:false}); 1`);
  await until('guest notified', () => B.ev(`!jam.active`));
  step('host ended Jam');
  console.log('E2E4 PASS');
  process.exit(0);
})().catch((e) => {
  console.error('E2E4 FAIL', e.message);
  process.exit(1);
});
