// E2E 준비: 새 프로필로 켜면 "브라우저 계정" 첫 화면이 떠서 탭이 열리지 않는다.
// 두 앱 모두 "건너뛰기"를 눌러 바로 탭이 열리게 한다 (이미 탭이 있으면 아무것도 안 함)
const WebSocket = require('ws');
const PORTS = require('./ports');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function skip(port) {
  let t;
  for (let i = 0; i < 40 && !t; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      t = list.find((x) => x.type === 'page' && x.url.endsWith('index.html'));
    } catch {}
    if (!t) await sleep(250);
  }
  if (!t) return;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const ev = (expression) =>
    new Promise((r) => {
      const my = ++id;
      const on = (raw) => {
        const m = JSON.parse(raw);
        if (m.id !== my) return;
        ws.off('message', on);
        r(m.result?.result?.value);
      };
      ws.on('message', on);
      ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  for (let i = 0; i < 60; i++) {
    const done = await ev(`typeof tabs !== 'undefined' && tabs.length > 0`);
    if (done) break;
    await ev(`(() => { const b = document.querySelector('#ls-skip'); if (b && b.offsetParent) b.click(); return 1; })()`);
    await sleep(250);
  }
  ws.close();
}

const ports = process.argv.slice(2).map(Number).filter(Boolean);
Promise.all((ports.length ? ports : [PORTS.host, PORTS.guest]).map(skip)).then(() => process.exit(0), () => process.exit(0));
