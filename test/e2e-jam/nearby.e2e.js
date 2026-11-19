// E2E: relay address list + nearby discovery + invite fallback + pairing (two app instances on CDP 9301 / 9302, off-screen)
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RP = Number(process.argv[3]); // local relay port
const OUT = P.out;

async function target(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page');
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
        const shot = async (name) => fs.writeFileSync(path.join(OUT, name), Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
        return { ev, shot };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('no target ' + port);
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
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const hookToasts = `window.__toasts=[]; if(!window.__th){ window.__th=1; const o=toast; toast=(t,a)=>{window.__toasts.push(t); return o(t,a)} } 1`;

(async () => {
  const A = await target(P.host);
  const B = await target(P.guest);
  for (const X of [A, B]) {
    await until('lock screen', () => X.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`), 20000);
    await X.ev(`${q('#ls-skip')}.click(); 1`);
    await until('booted', () => X.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
    await X.ev(hookToasts);
  }

  // 1. 중계 서버 목록: 첫 주소는 안 되고 둘째는 됨
  await A.ev(`${q('#name')}.value='호스트'; ${q('#relay-details')}.open=true; ${q('#server-url')}.value='127.0.0.1:1\\n127.0.0.1:${RP}'; probeRelayList(); 1`);
  const status = await until('probe', () => A.ev(`[...document.querySelectorAll('#relay-status li')].map(l=>l.className+'|'+l.textContent).filter(t=>!t.includes('확인 중')).join('\\n') || null`), 8000);
  if (!/^bad\|○ 127\.0\.0\.1:1 /m.test(status) || !/^ok\|● 127\.0\.0\.1:\d+ · v\d/m.test(status)) throw new Error('relay status ' + status);
  step(`relay list status:\n    ${status.replace(/\n/g, '\n    ')}`);
  await A.ev(`${q('#start-jam')}.click(); 1`);
  const invite = await until('host started', () => A.ev(`jam.active && jam.invite`), 20000);
  if (!invite.startsWith(`jamr://127.0.0.1:${RP}/`)) throw new Error('invite ' + invite);
  const skippedToast = await until('skip toast', () => A.ev(`window.__toasts.find(t=>t.includes('연결하지 못해서'))`));
  const code = await A.ev(`jam.room.code`);
  step(`start Jam: first relay skipped ("${skippedToast.slice(0, 60)}…"), invite uses 127.0.0.1:${RP}`);

  // 2. 근처 목록에 호스트가 보임
  const seen = await until('nearby', () => B.ev(`(nearby.find(x=>x.code==='${code}')||null)`), 15000);
  await sleep(2500); // 브로드캐스트 · 이 PC 두 길로 다 들릴 시간
  const listText = await B.ev(`${q('#nearby-list')}.textContent`);
  const entries = await B.ev(`nearby.filter(x=>x.code==='${code}').map(x=>x.ip)`);
  if (entries.length !== 1) throw new Error('duplicate nearby entries: ' + entries);
  step(`guest sees nearby Jam: ${JSON.stringify({ name: seen.name, ip: seen.ip, port: seen.port, access: seen.access, n: seen.n })} → "${listText.slice(0, 40)}"`);
  await B.shot('n1-nearby-list.png');

  // 3. 초대 링크의 중계 서버가 죽었을 때 → 근처에서 같은 방 코드로 바로 연결
  const deadInvite = invite.replace(`127.0.0.1:${RP}`, '127.0.0.1:1');
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(deadInvite)}; ${q('#join-jam')}.click(); 1`);
  await until('A request', () => A.ev(`jam.requests.size > 0`), 15000);
  await A.ev(`${q('#join-requests .req-card .mini-btn.active')}.click(); 1`);
  await until('B joined', () => B.ev(`jam.active`), 15000);
  const via = await B.ev(`jam.serverUrl`);
  const fbToast = await B.ev(`window.__toasts.find(t=>t.includes('바로 연결'))`);
  if (!via.startsWith('ws://') || via.includes(':1/')) throw new Error('fallback server ' + via);
  step(`dead relay in invite → fell back to nearby host ${via} ("${fbToast}")`);
  await B.ev(`leaveJam(); 1`);
  await until('B left', () => B.ev(`!jam.active`));
  await sleep(500);

  // 4. 링크 없이 근처 목록에서 페어링 (6자리 확인 코드)
  await until('nearby again', () => B.ev(`!!document.querySelector('#nearby-list .mini-btn.active:not([disabled])')`), 10000);
  await B.ev(`${q('#nearby-list .mini-btn.active')}.click(); 1`);
  const gSas = await until('guest sas', () => B.ev(`/^\\d{3} \\d{3}$/.test(${q('#pair-sas')}.textContent) && ${q('#pair-sas')}.textContent`), 10000);
  const hSas = await until('host sas', () => A.ev(`${q('#join-requests .req-sas b')}?.textContent`), 10000);
  await A.shot('n2-host-pair-card.png');
  await B.shot('n3-guest-pair-dialog.png');
  if (gSas !== hSas) throw new Error(`SAS mismatch ${gSas} vs ${hSas}`);
  await A.ev(`${q('#join-requests .req-card .mini-btn.active')}.click(); 1`);
  await until('B joined via pairing', () => B.ev(`jam.active`), 15000);
  await sleep(500);
  const after = await A.ev(`JSON.stringify({ requests: jam.requests.size, members: jam.room.members.length })`);
  const dlgOpen = await B.ev(`${q('#pair-dialog')}.open`);
  step(`pairing: both screens show ${gSas}; host accepted once → guest joined without a second approval ${after}, dialog closed: ${!dlgOpen}`);

  // 5. 근처에 보이기 끄기 → 목록에서 사라짐
  await B.ev(`leaveJam(); 1`);
  await until('B left 2', () => B.ev(`!jam.active`));
  await A.ev(`${q('#nearby-visible')}.checked=false; ${q('#nearby-visible')}.dispatchEvent(new Event('change')); 1`);
  await until('gone', () => B.ev(`!nearby.some(x=>x.code==='${code}')`), 15000);
  step('host turned off "show nearby" → guest list no longer shows it');

  console.log('\nE2E nearby OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
