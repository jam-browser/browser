// Drives two running Jam Browser instances (CDP 9301 host, 9302 guest).
const WebSocket = require(process.argv[2] + '/node_modules/ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && x.url.endsWith('index.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
  });
  const cmd = async (method, params) => {
    const myId = ++id;
    ws.send(JSON.stringify({ id: myId, method, params }));
    return new Promise((r) => pending.set(myId, r));
  };
  const ev = async (expr) => {
    const myId = ++id;
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const m = await new Promise((r) => pending.set(myId, r));
    if (m.result?.exceptionDetails) throw new Error(expr.slice(0, 80) + ' -> ' + JSON.stringify(m.result.exceptionDetails.exception?.description));
    return m.result?.result?.value;
  };
  // wait until app script is loaded
  for (let i = 0; i < 40 && !(await ev(`typeof jam === 'object' && !!document.querySelector('#name')`)); i++) await sleep(250);
  return { ev, cmd, close: () => ws.close() };
}
async function until(label, fn, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
}
const step = (s) => console.log('✓', s);

(async () => {
  const A = await page(9301);
  const B = await page(9302);
  const inPage = (P, code) => P.ev(`jam.tab.webview.executeJavaScript(${JSON.stringify(code)})`);

  // --- start + join on example.com
  await A.ev(`navigateTab(activeTab, 'https://example.com/'); 1`);
  await until('host on example', () => A.ev(`activeTab.url === 'https://example.com/' && !activeTab.loading`));
  await A.ev(`document.querySelector('#name').value='호스트'; document.querySelector('#start-jam').click(); 1`);
  const invite = await until('host started', () => A.ev(`jam.active && jam.invite`));
  const local = invite.replace(/jam:\/\/[^:]+/, 'jam://127.0.0.1');
  await B.ev(`document.querySelector('#name').value='게스트'; document.querySelector('#invite').value=${JSON.stringify(local)}; document.querySelector('#join-jam').click(); 1`);
  await until('host sees join request', () => A.ev(`!!document.querySelector('#join-requests .req-card')`), 10000);
  await A.ev(`document.querySelector('#join-requests .req-card .mini-btn.active').click(); 1`);
  await until('guest joined', () => B.ev(`jam.active && jam.tab.ready && jam.tab.url === 'https://example.com/' && !jam.tab.loading`));
  step('guest joined on example.com');
  await sleep(1500);

  // --- cross-site lock: example.com's only link goes to iana.org (another site)
  await B.ev(`window.__toasts=[]; new MutationObserver(()=>document.querySelectorAll('.toast span').forEach(s=>__toasts.includes(s.textContent)||__toasts.push(s.textContent))).observe(document.querySelector('#toasts'),{childList:true,subtree:true}); 1`);
  await inPage(B, `document.querySelector('a').click()`);
  await sleep(1500);
  const bUrl1 = await B.ev(`jam.tab.url`);
  if (bUrl1 !== 'https://example.com/') throw new Error('link was not blocked: ' + bUrl1);
  step('link to other site blocked for guest (stays on ' + bUrl1 + ')');
  await inPage(B, `location.href = 'https://www.iana.org/'`);
  await sleep(2000);
  const bUrl2 = await B.ev(`jam.tab.url`);
  if (bUrl2 !== 'https://example.com/') throw new Error('script navigation was not blocked: ' + bUrl2);
  step('script navigation to other site blocked in main process');
  console.log('  toasts:', await B.ev(`__toasts`));
  console.log('  lock flag visible:', await B.ev(`!document.querySelector('#lock-flag').hidden`));

  // --- host grants permission -> link works, host follows
  const guestId = await B.ev(`jam.you.id`);
  await A.ev(`jam.send({type:'perm', id:${JSON.stringify(guestId)}, canCrossSite:true}); 1`);
  await until('guest got perm', () => B.ev(`jam.canCrossSite()`));
  await sleep(500);
  await inPage(B, `document.querySelector('a').click()`);
  await until('host followed guest to iana', () => A.ev(`jam.tab.url.includes('iana.org')`));
  step('after permission, guest link to other site moves everyone');

  // --- viewports / minimap
  await until('host sees guest viewport', () => A.ev(`(()=>{const m=jam.member(${JSON.stringify(guestId)}); return m && m.view && sameDoc(m.view.url, jam.tab.url) && m.view.w>0 && (m.view.w+'x'+m.view.h)})()`));
  const res = await A.ev(`(()=>{const m=jam.member(${JSON.stringify(guestId)}); return m.view.w+'×'+m.view.h})()`);
  const boxes = await until('minimap boxes', () => A.ev(`document.querySelectorAll('#minimap .mm-box').length === 2 && 2`));
  const layerOk = await inPage(A, `!!document.querySelector('jam-presence')`);
  const status = await A.ev(`[...document.querySelectorAll('#members .status')].map(s=>s.textContent)`);
  step(`guest viewport shared (${res}), minimap boxes=${boxes}, overlay layer=${layerOk}`);
  console.log('  member status:', status);

  // --- cursor show/hide
  await A.ev(`window.__cur=[]; const __h = handleMessage; handleMessage = (m) => { if (m.type==='cursor') __cur.push(m.x); return __h(m); }; 1`);
  // real input routed by the browser: move over the webpage area, then onto the Jam side panel
  const panelX = await B.ev(`Math.round(document.querySelector('#jam-panel').getBoundingClientRect().left + 100)`);
  for (const [x, y] of [[300, 300], [320, 320], [340, 340]]) {
    await B.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(150);
  }
  await until('host got guest cursor', () => A.ev(`__cur.some(x => typeof x === 'number')`));
  await B.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panelX, y: 340 });
  await until('host got cursor hide', () => A.ev(`__cur[__cur.length-1] === null`), 5000);
  step('cursor shown while on page, hidden when the pointer leaves: ' + JSON.stringify(await A.ev(`__cur.map(x=>x===null?null:+x.toFixed(2))`)));

  // --- video sync + ad exception
  const VIDEO = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.480p.vp9.webm';
  await A.ev(`navigateTab(jam.tab, ${JSON.stringify(VIDEO)}); 1`);
  await until('both on video', async () => (await A.ev(`jam.tab.url`)) === VIDEO && (await B.ev(`jam.tab.url`)) === VIDEO, 20000);
  await until('video ready in both', async () =>
    (await inPage(A, `!!document.querySelector('video') && document.querySelector('video').readyState >= 2`)) &&
    (await inPage(B, `!!document.querySelector('video') && document.querySelector('video').readyState >= 2`)), 30000);
  await sleep(3000); // grace period for autoplay events
  await inPage(A, `(()=>{const v=document.querySelector('video'); v.currentTime=30; v.play(); return 1})()`);
  const t1 = await until('guest synced to ~30s', async () => {
    const t = await inPage(B, `document.querySelector('video').currentTime`);
    return t > 29 && t < 40 && t;
  }, 15000);
  step(`guest video followed host seek to 30s (guest at ${t1.toFixed(1)}s)`);

  // simulate a YouTube ad on the guest
  await inPage(B, `(()=>{const d=document.createElement('div'); d.id='fake-ad'; d.className='html5-video-player ad-showing'; document.body.appendChild(d); return 1})()`);
  await until('guest marked as watching ad', () => A.ev(`(jam.member(${JSON.stringify(guestId)}).presence||{}).ad === true`), 5000);
  console.log('  host sees guest status:', await A.ev(`[...document.querySelectorAll('#members .status')].map(s=>s.textContent)`));
  const before = await inPage(B, `document.querySelector('video').currentTime`);
  await inPage(A, `(()=>{const v=document.querySelector('video'); v.currentTime=120; return 1})()`);
  await sleep(2500);
  const during = await inPage(B, `document.querySelector('video').currentTime`);
  if (during > 100) throw new Error('guest jumped during ad: ' + during);
  step(`during ad guest did not jump (was ${before.toFixed(1)}s, now ${during.toFixed(1)}s, host at ~120s)`);
  await inPage(B, `document.getElementById('fake-ad').remove(); 1`);
  const after = await until('guest caught up after ad', async () => {
    const t = await inPage(B, `document.querySelector('video').currentTime`);
    return t > 119 && t;
  }, 10000);
  const hostT = await inPage(A, `document.querySelector('video').currentTime`);
  step(`after ad ended guest caught up: guest ${after.toFixed(1)}s vs host ${hostT.toFixed(1)}s`);

  await A.ev(`leaveJam({ask:false}); 1`);
  await until('guest notified', () => B.ev(`!jam.active`));
  step('host ended jam');
  console.log('E2E PASS');
  A.close();
  B.close();
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAIL', e.message);
  process.exit(1);
});
