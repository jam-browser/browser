// E2E: 중계 서버를 거쳐 참여 (호스트 9301, 게스트 9302). 중계 서버는 127.0.0.1:3031 에 미리 띄워 둘 것
//   node relay/jam-relay.js
const WebSocket = require(process.argv[2] + '/node_modules/ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(port) {
  let t;
  for (let i = 0; i < 40 && !t; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    t = list.find((x) => x.type === 'page' && x.url.endsWith('index.html'));
    if (!t) await sleep(250);
  }
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
  for (let i = 0; i < 40 && !(await ev(`typeof jam === 'object' && typeof ui === 'object' && tabs.length > 0`)); i++) await sleep(250);
  return { ev };
}
async function until(label, fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
}
const step = (s) => console.log('✓', s);

(async () => {
  const A = await page(9301);
  const B = await page(9302);

  await A.ev(`navigateTab(activeTab, 'https://example.com/'); 1`);
  await until('host page', () => A.ev(`activeTab.url === 'https://example.com/' && !activeTab.loading`));
  await A.ev(`document.querySelector('#name').value='호스트'; document.querySelector('#server-url').value='127.0.0.1:3031'; document.querySelector('#start-jam').click(); 1`);
  const invite = await until('host started with relay', () => A.ev(`jam.active && jam.invite`), 15000);
  if (!/^jamr:\/\/127\.0\.0\.1:3031\/[a-z0-9]{10}\/[A-Z0-9]{5}\/[A-Za-z0-9_-]{43}$/.test(invite)) throw new Error('bad relay invite: ' + invite);
  const alt = await A.ev(`document.querySelector('#invite-alt').textContent`);
  step(`host started Jam through the relay → invite ${invite.replace(/\/[A-Za-z0-9_-]{43}$/, '/<비밀키>')}`);
  console.log('  ' + alt.replace(/\/[A-Za-z0-9_-]{43}/g, '/<비밀키>'));

  await B.ev(`document.querySelector('#name').value='멀리있는친구'; document.querySelector('#invite').value=${JSON.stringify(invite)}; document.querySelector('#join-jam').click(); 1`);
  const card = await until('join request card', () => A.ev(`document.querySelector('#join-requests .req-card')?.textContent`), 15000);
  await A.ev(`document.querySelector('#join-requests .req-card .mini-btn.active').click(); 1`);
  await until('guest joined', () => B.ev(`jam.active && jam.tab && jam.tab.url === 'https://example.com/' && !jam.tab.loading`), 20000);
  step(`guest joined through the relay after approval (card: "${card.replace(/\s+/g, ' ').trim()}")`);

  await A.ev(`navigateTab(jam.tab, 'https://www.iana.org/help/example-domains'); 1`);
  await until('guest followed', () => B.ev(`jam.tab.url.includes('iana.org')`), 20000);
  await B.ev(`document.querySelector('#chat-input').value='중계로 안녕!'; document.querySelector('#chat-form').requestSubmit(); 1`);
  await until('chat', () => A.ev(`document.querySelector('#chat').textContent.includes('중계로 안녕!')`));
  await until('viewport shared', () => A.ev(`!!jam.room.members.find(m => m.id !== jam.you.id)?.view`), 10000);
  step('navigation, chat and viewport boxes work through the relay');

  await A.ev(`leaveJam({ask:false}); 1`);
  await until('guest notified', () => B.ev(`!jam.active`), 10000);
  step('host ended Jam; guest notified through the relay');
  console.log('RELAY E2E PASS');
  process.exit(0);
})().catch((e) => {
  console.error('RELAY E2E FAIL', e.message);
  process.exit(1);
});
