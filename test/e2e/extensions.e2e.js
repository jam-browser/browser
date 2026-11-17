// Chrome 호환성: User-Agent 정리, 확장 아이콘 줄, Chrome 웹 스토어 지원 (호스트 앱 하나만 사용, 포트는 ports.js)
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
  const ev = async (expr) => {
    const myId = ++id;
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const m = await new Promise((r) => pending.set(myId, r));
    if (m.result?.exceptionDetails) throw new Error(expr.slice(0, 80) + ' -> ' + JSON.stringify(m.result.exceptionDetails.exception?.description));
    return m.result?.result?.value;
  };
  for (let i = 0; i < 40 && !(await ev(`typeof activeTab === 'object' && !!activeTab`)); i++) await sleep(250);
  return { ev, close: () => ws.close() };
}
async function until(label, fn, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
}
let passed = 0;
function ok(cond, label, extra) {
  if (!cond) throw new Error('FAIL: ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
  console.log('  ✓ ' + label);
  passed++;
}

(async () => {
  const host = await page(require("./ports").host);
  const inTab = (js) => host.ev(`activeTab.webview.executeJavaScript(${JSON.stringify(js)})`);
  const openTab = async (url) => {
    await host.ev(`createTab(${JSON.stringify(url)}); true`);
    await until('tab ready ' + url, () => host.ev(`activeTab.ready && !activeTab.loading && activeTab.url.startsWith(${JSON.stringify(url)})`), 40000);
  };

  // 1. User-Agent: Electron · 앱 이름이 없고, Chrome 주 버전만
  await openTab('https://example.com/');
  const ua = await inTab('navigator.userAgent');
  ok(!/Electron|jam-browser|Jam ?Browser/i.test(ua), 'UA 에 Electron/앱 이름 없음', ua);
  ok(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(ua), 'UA 가 일반 Chrome 형식', ua);
  const brands = await inTab('(navigator.userAgentData?.brands || []).map(b => b.brand).join(",")');
  ok(/Chromium/.test(brands) && !/Electron/i.test(brands), 'UA Client Hints 에 Electron 없음', brands);

  // 2. 확장 아이콘 줄 + 웹 스토어 버튼
  ok(await host.ev(`!!customElements.get('browser-action-list')`), '<browser-action-list> 요소 등록됨');
  ok(await host.ev(`!!document.querySelector('#ext-actions') && !!document.querySelector('#ext-store')`), '툴바에 확장 영역 표시');

  // 3. 확장 프로그램이 현재 탭을 알 수 있음 (chrome.tabs 활성 탭 = 앱의 활성 탭)
  //    (확장 없이 확인할 수 있는 범위: 활성 탭 알림이 오류 없이 가는지)
  ok(await host.ev(`typeof notifyExtActiveTab === 'function' && (notifyExtActiveTab(activeTab), true)`), '활성 탭 알림');

  // 4. Chrome 웹 스토어: 설치 API 가 페이지에 주입됨
  await host.ev(`document.querySelector('#ext-store').click(); true`);
  await until('web store loaded', () => host.ev(`activeTab.ready && !activeTab.loading && activeTab.url.includes('chromewebstore.google.com')`), 40000);
  const wsp = await until('webstorePrivate', () => inTab('typeof chrome !== "undefined" && typeof chrome.webstorePrivate === "object"'), 15000);
  ok(wsp, '웹 스토어에 chrome.webstorePrivate 주입됨');
  const unsupported = await inTab('/Chrome 에서만|only available in Chrome|switch to Chrome|Chrome으로 전환/i.test(document.body.innerText)');
  ok(!unsupported, '웹 스토어가 "Chrome 전용" 안내를 띄우지 않음');

  console.log(`\n확장 · 호환성 테스트 통과 (${passed}개)`);
  host.close();
  process.exit(0);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
