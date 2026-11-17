// Resolution / view-size test: host and guest look at the same Wikipedia article with
// different window sizes and zoom levels. Checks that the guest's viewport box and cursor
// are drawn on the host's page at the same *content* the guest is looking at.
const PORTS = require('./ports');
const WebSocket = require(process.argv[2] + '/node_modules/ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = 'https://en.wikipedia.org/wiki/Jam_session';

async function target(port, pick) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find(pick);
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
    if (m.result?.exceptionDetails) throw new Error(expr.slice(0, 80) + ' -> ' + JSON.stringify(m.result.exceptionDetails.exception?.description));
    return m.result?.result?.value;
  };
  return { cmd, ev, close: () => ws.close() };
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

(async () => {
  const A = await target(PORTS.host, (x) => x.type === 'page');
  const B = await target(PORTS.guest, (x) => x.type === 'page');
  for (const P of [A, B]) for (let i = 0; i < 40 && !(await P.ev(`typeof jam==='object'`)); i++) await sleep(250);

  await A.ev(`navigateTab(activeTab, '${PAGE}'); 1`);
  await until('host page', () => A.ev(`activeTab.url === '${PAGE}' && !activeTab.loading`), 20000);
  await A.ev(`document.querySelector('#name').value='호스트'; document.querySelector('#start-jam').click(); 1`);
  const invite = await until('started', () => A.ev(`jam.active && jam.invite`));
  await B.ev(`document.querySelector('#name').value='게스트'; document.querySelector('#invite').value=${JSON.stringify(invite.replace(/jam:\/\/[^:]+/, 'jam://127.0.0.1'))}; document.querySelector('#join-jam').click(); 1`);
  await until('host sees join request', () => A.ev(`!!document.querySelector('#join-requests .req-card')`), 10000);
  await A.ev(`document.querySelector('#join-requests .req-card .mini-btn.active').click(); 1`);
  await until('joined', () => B.ev(`jam.active && jam.tab.ready && jam.tab.url === '${PAGE}' && !jam.tab.loading`), 20000);
  await sleep(2000);
  const guestId = await B.ev(`jam.you.id`);

  const HW = await target(PORTS.host, (x) => x.type === 'webview' && x.url.includes('Jam_session')); // host page
  const GW = await target(PORTS.guest, (x) => x.type === 'webview' && x.url.includes('Jam_session')); // guest page

  const hostDebug = async () => {
    await A.ev(`window.__jamDebug = null; jam.tab.webview.send('jam:debug-req'); 1`);
    return until('debug', () => A.ev(`window.__jamDebug`), 3000);
  };
  const headingInfo = (P, k) =>
    P.ev(`(() => { const h = document.querySelectorAll('#bodyContent h2, #bodyContent h3')[${k}]; const r = h.getBoundingClientRect();
      return { text: h.textContent.trim().slice(0, 30), top: r.top + scrollY, cx: r.left + r.width / 2 + scrollX, cy: r.top + r.height / 2 + scrollY,
               vx: r.left + r.width / 2, vy: r.top + r.height / 2, docH: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight }; })()`);

  const conditions = [
    { name: '같은 크기', setup: async () => {} },
    { name: '게스트 확대 150%', setup: async () => { await B.ev(`jam.tab.webview.setZoomFactor(1.5); 1`); } },
    { name: '게스트 작은 화면 480×640', setup: async () => {
      await B.ev(`jam.tab.webview.setZoomFactor(1); 1`);
      await GW.cmd('Emulation.setDeviceMetricsOverride', { width: 480, height: 640, deviceScaleFactor: 1, mobile: false });
    } },
    { name: '게스트 작은 화면 + 호스트 축소 80%', setup: async () => { await A.ev(`jam.tab.webview.setZoomFactor(0.8); 1`); } },
    { name: '게스트 넓은 화면 1600×900', setup: async () => {
      await A.ev(`jam.tab.webview.setZoomFactor(1); 1`);
      await GW.cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    } },
  ];

  let failures = 0;
  const k = 3; // 4th heading in the article
  for (const c of conditions) {
    await c.setup();
    await sleep(1500);
    // guest scrolls so heading k is near the top of their view
    await GW.ev(`(() => { const h = document.querySelectorAll('#bodyContent h2, #bodyContent h3')[${k}]; window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 120); return 1; })()`);
    await sleep(1500);
    // guest moves the mouse onto the center of the next heading
    const g = await headingInfo(GW, k + 1);
    await GW.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(g.vx), y: Math.round(g.vy) });
    await sleep(300);
    await GW.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(g.vx) + 1, y: Math.round(g.vy) });
    await sleep(1200);

    const gHead = await headingInfo(GW, k);
    const guestTopOffset = gHead.top - (await GW.ev('scrollY')); // where heading k sits in the guest's view (px from top)
    const hHead = await headingInfo(A === null ? null : HW, k);
    const hNext = await headingInfo(HW, k + 1);
    const dbg = await hostDebug();
    const box = dbg.views.find((v) => v.id === guestId);
    const cur = dbg.cursors.find((v) => v.id === guestId);
    const view = await A.ev(`jam.member(${JSON.stringify(guestId)}).view`);

    // where the box top *should* be on the host: heading k top minus how far below the guest's view top it was,
    // scaled by the size ratio between the two layouts for that heading region is unknowable, so we check
    // that heading k lies inside the drawn box at a similar relative position.
    const inBox = box && hHead.top >= box.top - 5 && hHead.top <= box.top + box.height;
    const ratioTop = view.vy * hHead.docH; // what the old ratio-only method would draw
    const cursorErr = cur ? Math.hypot(cur.x - hNext.cx, cur.y - hNext.cy) : Infinity;
    const label = await A.ev(`[...document.querySelectorAll('#members .status')].map(s => s.textContent)[1]`);

    const ok = inBox && cursorErr < 40;
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${c.name}`);
    console.log(`    guest view ${view.w}×${view.h} zoom ${view.z}; "${gHead.text}" is ${Math.round(guestTopOffset)}px below the guest's top`);
    console.log(`    host draws box top=${box && Math.round(box.top)} h=${box && Math.round(box.height)}; host heading at ${Math.round(hHead.top)} → ${Math.round(hHead.top - (box?.top ?? 0))}px below box top (ratio-only method: ${Math.round(hHead.top - ratioTop)}px)`);
    console.log(`    cursor on "${hNext.text}": drawn (${cur && Math.round(cur.x)}, ${cur && Math.round(cur.y)}) vs heading center (${Math.round(hNext.cx)}, ${Math.round(hNext.cy)}) → error ${Math.round(cursorErr)}px`);
    console.log(`    member status on host: ${label}`);
  }

  // scroll following across different sizes (guest still at 1600×900)
  await A.ev(`jam.followScroll = true; document.querySelector('#follow-scroll').checked = true; 1`);
  // 실제 휠 입력으로 스크롤한다 (앱은 사람이 직접 한 스크롤만 다른 사람에게 보낸다. 스크립트 scrollTo 는 무시됨)
  const delta = await GW.ev(`Math.round(document.querySelectorAll('#bodyContent h2, #bodyContent h3')[6].getBoundingClientRect().top - 80)`);
  await GW.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: delta });
  await sleep(2500);
  const gOff = await GW.ev(`document.querySelectorAll('#bodyContent h2, #bodyContent h3')[6].getBoundingClientRect().top`);
  const hOff = await HW.ev(`document.querySelectorAll('#bodyContent h2, #bodyContent h3')[6].getBoundingClientRect().top`);
  const scrollOk = Math.abs(gOff - hOff) < 60;
  if (!scrollOk) failures++;
  console.log(`${scrollOk ? '✓' : '✗'} 스크롤 따라가기 (다른 크기): heading 7 is ${Math.round(gOff)}px from top for guest, ${Math.round(hOff)}px for host`);

  await GW.cmd('Emulation.clearDeviceMetricsOverride');
  await A.ev(`leaveJam({ask:false}); 1`);
  console.log(failures ? `FAILURES: ${failures}` : 'RESOLUTION TEST PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
