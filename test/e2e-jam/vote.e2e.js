// E2E: 🗳️ 클릭 투표 (이상형 월드컵) — 실제 앱 두 개
//  호스트가 /worldcup 에서 "왼쪽 / 오른쪽" 칸으로 연속 투표 시작 → 둘이 투표 → 이긴 쪽을 호스트 화면에서 진짜 클릭
//  → 같은 칸으로 2라운드 자동 → 시간 끝 → 동점이면 호스트 쪽 → 연속 멈추기 · 닫기
const P = require('./ports');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = 'http://localhost:8766';

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
        const shot = async (file) => {
          const m = await cmd('Page.captureScreenshot', { format: 'png' });
          if (m.result?.data) fs.writeFileSync(path.join(__dirname, 'out', file), Buffer.from(m.result.data, 'base64'));
        };
        return { ev, shot, close: () => ws.close() };
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
    await sleep(250);
  }
  throw new Error('timeout: ' + label + ' (' + JSON.stringify(last) + ')');
}
const step = (s) => console.log('✓', s);
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;

(async () => {
  const A = await target(P.host);
  const B = await target(P.guest);
  for (const X of [A, B]) {
    await until('welcome', () => X.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`));
    await X.ev(`${q('#ls-skip')}.click(); 1`);
    await until('booted', () => X.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
  }
  await A.ev(`navigateTab(activeTab, '${SITE}/worldcup'); 1`);
  await until('worldcup', () => A.ev(`activeTab.url === '${SITE}/worldcup' && !activeTab.loading`));
  await A.ev(`${q('#name')}.value='호스트'; ${q('#access-mode')}.value='open'; ${q('#access-mode')}.dispatchEvent(new Event('change')); ${q('#start-jam')}.click(); 1`);
  const invite = await until('host', () => A.ev(`jam.active && jam.invite`));
  const local = invite.replace(/^jam:\/\/[^/]+/, 'jam://127.0.0.1:' + invite.match(/:(\d+)\//)[1]);
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(local)}; ${q('#join-jam')}.click(); 1`);
  await until('joined', () => B.ev(`jam.active && jam.tab && jam.tab.url === '${SITE}/worldcup' && !jam.tab.loading`));
  await sleep(800);
  const WA = await target(P.host, (x) => x.type === 'webview' && x.url === `${SITE}/worldcup`);

  // 0. 🗳️ 버튼은 호스트에게만
  const btn = { a: await A.ev(`!${q('#ov-vote')}.hidden`), b: await B.ev(`!${q('#ov-vote')}.hidden`) };
  if (!btn.a || btn.b) throw new Error('vote button ' + JSON.stringify(btn));

  // 1. 호스트: 🗳️ → 편집기 → "왼쪽 / 오른쪽" · 이름 · 15초 · 연속 투표 → 시작
  await A.ev(`${q('#ov-vote')}.click(); 1`);
  await until('editor', () => A.ev(`!${q('#vote-editor')}.hidden && document.querySelectorAll('#vote-layer .vote-box').length === 2`));
  // 끌어서 칸 하나 더 그려 보기 (편집 화면에서 마우스로) → 3칸 → 다시 왼쪽/오른쪽
  const drew = await A.ev(`(() => { const L = ${q('#vote-layer')}; const r = L.getBoundingClientRect();
    const ev = (t, fx, fy) => (t === 'mousedown' ? L : window).dispatchEvent(new MouseEvent(t, { bubbles: true, button: 0, clientX: r.left + fx * r.width, clientY: r.top + fy * r.height }));
    ev('mousedown', 0.4, 0.02); ev('mousemove', 0.6, 0.1); ev('mouseup', 0.6, 0.1);
    return document.querySelectorAll('#vote-layer .vote-box').length; })()`);
  if (drew !== 3) throw new Error('drag-to-draw ' + drew);
  await A.ev(`[...document.querySelectorAll('#vote-editor .mini-btn')].find(b => b.textContent.includes('왼쪽')).click(); 1`);
  await A.ev(`(() => { const ins = document.querySelectorAll('#vote-editor .vote-opt input'); ins[0].value = '왼쪽 후보'; ins[0].dispatchEvent(new Event('input')); ins[1].value = '오른쪽 후보'; ins[1].dispatchEvent(new Event('input'));
    ${q('#vote-title')}.value = '이상형 월드컵'; ${q('#vote-sec')}.value = '15'; ${q('#vote-series')}.checked = true; return 1; })()`);
  await A.shot('vote1-editor.png');
  await A.ev(`${q('#vote-start')}.click(); 1`);
  const bVote = await until('B sees vote', () => B.ev(`(() => { const s = jamVote.state(); return s.vote && s.vote.state === 'open' && s.stage && s.boxes.length === 2 && s; })()`));
  step(`host 🗳️ (guest has no button) → editor: drag drew a 3rd box, "왼쪽 / 오른쪽" preset, names, 15s, 연속 투표 → started; guest sees "${bVote.vote.title}" with ${bVote.boxes.map((b) => b.text).join(' | ')} over its Jam tab`);

  // 2. 투표: 게스트는 오른쪽, 호스트는 왼쪽 → 1:1 → 모두 투표해서 바로 끝 → 동점 → 호스트가 고른 왼쪽 → 호스트 화면에서 진짜 클릭
  await B.ev(`document.querySelector('#vote-layer .vote-box[data-k="B"]').click(); 1`);
  const tally = await until('host sees 1 vote', () => A.ev(`(() => { const v = jamVote.state().vote; return v && v.voted === 1 && v.counts && v.counts.B === 1 && v; })()`));
  await B.shot('vote2-guest-voted.png');
  await A.ev(`document.querySelector('#vote-layer .vote-box[data-k="A"]').click(); 1`);
  const closed = await until('closed', () => B.ev(`(() => { const v = jamVote.state().vote; return v && v.state === 'closed' && v; })()`), 8000);
  if (closed.result.winner !== 'A' || closed.result.how !== 'host') throw new Error('result ' + JSON.stringify(closed.result));
  await A.shot('vote3-result.png');
  const barA = await A.ev(`${q('#vote-bar')}.textContent`);
  if (/null|undefined/.test(barA)) throw new Error('bar text ' + barA);
  const pick1 = await until('host page clicked', () => WA.ev(`window.__picks.length >= 1 && window.__picks[0]`), 8000);
  if (pick1.side !== 'left' || !pick1.trusted) throw new Error('click ' + JSON.stringify(pick1));
  const sys = await A.ev(`[...document.querySelectorAll('#chat .system')].map(x => x.textContent).filter(t => t.includes('🗳️')).pop() || ''`);
  step(`guest voted B (host saw live count ${JSON.stringify(tally.counts)}), host voted A → everyone voted → 1:1 tie → host's pick A → host page got a real click on the left (${JSON.stringify(pick1)}) · chat: "${sys}"`);

  // 3. 연속 투표: 같은 칸으로 2라운드가 저절로 → 게스트만 오른쪽 → 시간(15초) 대신 호스트가 "지금 끝내기" → 오른쪽 클릭
  const r2 = await until('round 2', () => B.ev(`(() => { const v = jamVote.state().vote; return v && v.state === 'open' && v.round === 2 && v; })()`), 10000);
  await B.ev(`document.querySelector('#vote-layer .vote-box[data-k="B"]').click(); 1`);
  await until('host sees round2 vote', () => A.ev(`(() => { const v = jamVote.state().vote; return v && v.round === 2 && v.voted === 1; })()`));
  await A.ev(`[...document.querySelectorAll('#vote-bar .mini-btn')].find(b => b.textContent.includes('지금 끝내기')).click(); 1`);
  const pick2 = await until('round2 click', () => WA.ev(`window.__picks.length >= 2 && window.__picks[1]`), 8000);
  if (pick2.side !== 'right') throw new Error('round2 click ' + JSON.stringify(pick2));
  step(`연속 투표: round ${r2.round} opened by itself with the same boxes → guest voted B → host "지금 끝내기" → right side clicked (${JSON.stringify(pick2)})`);

  // 4. 3라운드가 열리면 연속 멈추기 → 닫기 → 모두에게서 사라짐
  await until('round 3', () => A.ev(`(() => { const v = jamVote.state().vote; return v && v.round === 3 && v.state === 'open'; })()`), 10000);
  await A.ev(`[...document.querySelectorAll('#vote-bar .mini-btn')].find(b => b.textContent.includes('연속 멈추기')).click(); 1`);
  await A.ev(`[...document.querySelectorAll('#vote-bar .mini-btn')].find(b => b.textContent.includes('닫기')).click(); 1`);
  await until('gone for guest', () => B.ev(`!jamVote.state().vote && ${q('#vote-layer')}.hidden`));
  await sleep(3500);
  const picks = await WA.ev(`window.__picks.length`);
  if (picks !== 2) throw new Error('extra clicks after stop: ' + picks);
  step('round 3 → 연속 멈추기 + 닫기 → vote gone for everyone, no more clicks');

  // 5. 화면 미러링과 함께: 게스트는 호스트 화면 영상 위에 칸이 보이고, 영상 위에서 투표 → 호스트 탭에서 클릭
  await A.ev(`window.__mirrorNoConfirm = true; mirror.start(jam.tab); 1`);
  await until('guest viewing mirror', () => B.ev(`mirror.viewing() && ${q('#mirror-canvas')}.width > 100`), 20000);
  await A.ev(`${q('#ov-vote')}.click(); 1`);
  await until('editor 2', () => A.ev(`!${q('#vote-editor')}.hidden`));
  await A.ev(`${q('#vote-series')}.checked = false; ${q('#vote-start')}.click(); 1`);
  const mv = await until('guest vote over mirror', () => B.ev(`(() => { const s = jamVote.state(); if (!s.vote || s.vote.state !== 'open' || !s.stage) return null;
    const c = ${q('#mirror-canvas')}.getBoundingClientRect(); return { stage: s.stage, canvas: { left: c.left, top: c.top, width: c.width, height: c.height } }; })()`));
  const inside = mv.stage.left >= mv.canvas.left - 1 && mv.stage.top >= mv.canvas.top - 1 && mv.stage.left + mv.stage.width <= mv.canvas.left + mv.canvas.width + 1;
  if (!inside) throw new Error('vote stage not on the mirror video ' + JSON.stringify(mv));
  const barText = await B.ev(`${q('#vote-bar')}.textContent`);
  if (/null|undefined/.test(barText)) throw new Error('bar text ' + barText);
  await B.ev(`document.querySelector('#vote-layer .vote-box[data-k="B"]').click(); 1`);
  await A.ev(`document.querySelector('#vote-layer .vote-box[data-k="B"]').click(); 1`);
  const pick3 = await until('mirror vote click', () => WA.ev(`window.__picks.length >= 3 && window.__picks[2]`), 8000);
  await B.shot('vote4-over-mirror.png');
  if (pick3.side !== 'right') throw new Error('mirror click ' + JSON.stringify(pick3));
  step(`with screen mirroring: guest sees the boxes on the host video (stage ${Math.round(mv.stage.width)}×${Math.round(mv.stage.height)} inside the canvas), bar "${barText.slice(0, 40)}…", both voted B → host tab clicked right (${JSON.stringify(pick3)})`);

  console.log('\nE2E vote OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e.message || e);
  process.exit(1);
});
