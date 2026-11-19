// E2E: 같이 보는 파일 — PDF(쪽 · 스크롤 동기화) · HTML 폴더(인터넷 차단) · SWF(Ruffle) · 나가면 지움
// 실행: test/e2e-jam/run.ps1 (README.md 참고). 직접 실행할 때: node <이 파일> <앱 폴더> [중계 서버 포트]
const P = require('./ports');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = P.out;
const FIX = P.fixtures;

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
        const shot = async (name) => fs.writeFileSync(path.join(OUT, name), Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
        return { ev, shot, close: () => ws.close() };
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
    try {
      v = await fn();
    } catch {}
    if (v) return v;
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
}
const step = (s) => console.log('✓', s);
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const hookToasts = `window.__toasts=[]; if(!window.__th){ window.__th=1; const o=toast; toast=(t,a)=>{window.__toasts.push(t); return o(t,a)} } 1`;
const clickToast = (X, label) => X.ev(`(() => { const b = [...document.querySelectorAll('.toast .toast-btn')].reverse().find(b => b.textContent.includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);

(async () => {
  const A = await target(P.host);
  const B = await target(P.guest);
  for (const X of [A, B]) {
    await until('lock screen', () => X.ev(`typeof account==='object' && !${q('#ls-welcome')}.hidden`), 20000);
    await X.ev(`${q('#ls-skip')}.click(); 1`);
    await until('booted', () => X.ev(`${q('#lock-screen')}.hidden && tabs.length > 0`));
    await X.ev(hookToasts);
  }
  const RELAY = process.argv[3];
  await A.ev(`${q('#server-url')}.value=${JSON.stringify(RELAY ? `127.0.0.1:${RELAY}` : '')}; 1`);
  await A.ev(`${q('#name')}.value='호스트'; ${q('#access-mode')}.value='open'; ${q('#access-mode')}.dispatchEvent(new Event('change')); ${q('#start-jam')}.click(); 1`);
  const invite = await until('host started', () => A.ev(`jam.active && jam.invite`), 20000);
  const local = RELAY ? invite : invite.replace(/^jam:\/\/[^/]+/, 'jam://127.0.0.1:' + invite.match(/:(\d+)\//)[1]);
  console.log(`  (path: ${RELAY ? 'via relay' : 'direct LAN'})`);
  await B.ev(`${q('#name')}.value='게스트'; ${q('#invite')}.value=${JSON.stringify(local)}; ${q('#join-jam')}.click(); 1`);
  await until('B joined', () => B.ev(`jam.active`), 15000);

  // 1. PDF 공유 → 참여자 목록에 보임
  const shareFile = async (file, withFolder = false) => {
    const meta = await A.ev(`jamApp.fileFromPath(${JSON.stringify(file)}, ${withFolder})`);
    if (!meta || meta.error) throw new Error('pick failed ' + JSON.stringify(meta));
    await A.ev(`jamFiles.share(${JSON.stringify(meta)}); 1`);
    await until('host ready ' + meta.name, () => A.ev(`jamFiles.list().find(f => f.fid === '${meta.fid}' && f.ready)`), 30000);
    await until('guest sees ' + meta.name, () => B.ev(`jamFiles.list().find(f => f.fid === '${meta.fid}' && f.ready)`), 10000);
    return meta;
  };
  const pdf = await shareFile(path.join(FIX, 'test-5p.pdf'));
  const listText = await B.ev(`${q('#files-list')}.textContent`);
  step(`host shared ${pdf.name} (${pdf.size}B, sha ${pdf.sha.slice(0, 8)}…) → guest list: "${listText.trim().slice(0, 60)}"`);

  // 2. 호스트가 Jam 탭에서 열기 → 참여자는 "받아서 열기" 를 눌러야 열림
  await A.ev(`jamFiles.openInJam('${pdf.fid}'); 1`);
  await until('A on pdf', () => A.ev(`jam.tab.url === 'jamfile://${pdf.fid}/' && !jam.tab.loading`));
  await until('guest asked', () => B.ev(`window.__toasts.some(t => t.includes('열었어요'))`), 8000);
  const bBefore = await B.ev(`jam.tab.url`);
  if (bBefore.startsWith('jamfile:')) throw new Error('guest opened without consent');
  await until('click 받아서 열기', () => clickToast(B, '받아서 열기'));
  await until('B on pdf', () => B.ev(`jam.tab.url === 'jamfile://${pdf.fid}/' && !jam.tab.loading`), 15000);
  const WA = await target(P.host, (x) => x.type === 'webview' && x.url === `jamfile://${pdf.fid}/`);
  const WB = await target(P.guest, (x) => x.type === 'webview' && x.url === `jamfile://${pdf.fid}/`);
  const pa = await until('A pdf rendered', () => WA.ev(`window.__pdf && document.querySelector('#p1 canvas') && window.__pdf.pages`), 15000);
  const pb = await until('B pdf rendered', () => WB.ev(`window.__pdf && document.querySelector('#p1 canvas') && window.__pdf.pages`), 15000);
  const text = await until('text layer', () => WB.ev(`document.querySelector('#p1 .textLayer')?.textContent`), 8000);
  step(`guest asked first ("받아서 열기"), then followed into the pdf.js viewer: ${pa}/${pb} pages, text layer "${text.slice(0, 30)}…"`);

  // 3. 호스트가 휠로 스크롤 → 참여자도 같은 쪽
  for (let i = 0; i < 6; i++) {
    await A.ev(`jam.tab.webview.sendInputEvent({ type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: -600, canScroll: true }); 1`);
    await sleep(120);
  }
  const aPage = await until('A scrolled', () => WA.ev(`window.__pdf.page() >= 3 && window.__pdf.page()`), 5000);
  await sleep(1200);
  const bPage = await until('B synced', () => WB.ev(`(p => p === ${aPage} && p)(window.__pdf.page())`), 6000);
  // 참여자가 자기 화면에서 확대해도 같은 쪽을 따라감
  await WB.ev(`document.getElementById('zin').click(); 1`);
  for (let i = 0; i < 4; i++) {
    await A.ev(`jam.tab.webview.sendInputEvent({ type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: -500, canScroll: true }); 1`);
    await sleep(120);
  }
  const aPage2 = await until('A scrolled more', () => WA.ev(`window.__pdf.page() > ${aPage} && window.__pdf.page()`), 5000);
  await sleep(1200);
  const bPage2 = await until('B synced zoomed', () => WB.ev(`(p => Math.abs(p - ${aPage2}) <= 0 && p)(window.__pdf.page())`), 6000);
  const bZoom = await WB.ev(`window.__pdf.zoom()`);
  step(`page sync: host wheel → page ${aPage}, guest page ${bPage}; guest zoomed to ${Math.round(bZoom * 100)}% and still followed to page ${bPage2} (host ${aPage2})`);
  await B.shot('f1-guest-pdf.png');

  // 4. HTML 폴더 공유 (이미지 · CSS · 둘째 쪽 함께, .exe 는 빠짐) → 인터넷 차단 확인
  const site = await shareFile(path.join(FIX, 'site', 'index.html'), true);
  await A.ev(`jamFiles.openInJam('${site.fid}'); 1`);
  await until('guest asked site', () => B.ev(`window.__toasts.filter(t => t.includes('열었어요')).length >= 2`), 8000);
  await until('click 받아서 열기 2', () => clickToast(B, '받아서 열기'));
  await until('B on site', () => B.ev(`jam.tab.url === 'jamfile://${site.fid}/index.html' && !jam.tab.loading`), 15000);
  const WS = await target(P.guest, (x) => x.type === 'webview' && x.url === `jamfile://${site.fid}/index.html`);
  const res = await until('script results', () => WS.ev(`(r => r && r.fetch && r.ws && r.remoteImg && r.local !== undefined && r)(window.__res)`), 10000);
  const look = await WS.ev(`({ img: document.getElementById('dot').naturalWidth, h1: getComputedStyle(document.getElementById('h')).color })`);
  if (res.fetch !== 'blocked' || res.ws !== 'blocked' || res.remoteImg !== 'blocked' || res.local !== look.img * 0 + res.local || look.img !== 8) throw new Error('isolation ' + JSON.stringify({ res, look }));
  step(`HTML folder (${site.count} files, .exe left out): local image ${look.img}px + CSS ${look.h1} + fetch of own file ${res.local}B work; internet fetch=${res.fetch}, WebSocket=${res.ws}, remote image=${res.remoteImg}`);
  // 공유 HTML 안의 링크 → 같은 묶음의 둘째 쪽, 참여자도 따라옴
  await A.ev(`jam.tab.webview.executeJavaScript("document.getElementById('next').click()"); 1`);
  await until('A page2', () => A.ev(`jam.tab.url === 'jamfile://${site.fid}/page2.html'`), 8000);
  await until('B page2', () => B.ev(`jam.tab.url === 'jamfile://${site.fid}/page2.html'`), 8000);
  step('link inside the shared HTML → page2.html, guest followed (already downloaded, no second prompt)');

  // 5. SWF (Ruffle)
  const game = await shareFile(path.join(FIX, 'game.swf'));
  await A.ev(`jamFiles.openInJam('${game.fid}'); 1`);
  await until('guest asked swf', () => B.ev(`window.__toasts.filter(t => t.includes('열었어요')).length >= 3`), 8000);
  await until('click 받아서 열기 3', () => clickToast(B, '받아서 열기'));
  await until('B on swf', () => B.ev(`jam.tab.url === 'jamfile://${game.fid}/' && !jam.tab.loading`), 15000);
  const WG = await target(P.guest, (x) => x.type === 'webview' && x.url === `jamfile://${game.fid}/`);
  const swf = await until('ruffle loaded', () => WG.ev(`window.__swf`), 20000);
  if (!swf.ok) throw new Error('ruffle ' + JSON.stringify(swf));
  const meta = await WG.ev(`(() => { const p = document.querySelector('#player > *'); const api = p && (typeof p.ruffle === 'function' ? p.ruffle() : p); const m = api && api.metadata; return m ? { w: m.width, h: m.height, fps: m.frameRate, v: m.swfVersion } : null; })()`);
  await B.shot('f2-guest-swf.png');
  step(`SWF played by Ruffle on the guest: ${meta ? `${meta.w}×${meta.h} @ ${meta.fps}fps, SWF v${meta.v}` : 'loaded'}`);

  // 6. 웹페이지에서 jamfile:// 읽기 시도 → 실패
  await A.ev(`navigateTab(jam.tab, 'http://localhost:8766/'); 1`);
  await until('A on web', () => A.ev(`jam.tab.url.startsWith('http://localhost:8766') && !jam.tab.loading`), 10000);
  const WW = await target(P.host, (x) => x.type === 'webview' && x.url.startsWith('http://localhost:8766'));
  const cross = await WW.ev(`fetch('jamfile://${pdf.fid}/file').then(r => r.arrayBuffer()).then(b => 'read ' + b.byteLength).catch(() => 'blocked')`);
  if (cross !== 'blocked') throw new Error('web page read jamfile: ' + cross);
  const embed = await WW.ev(`Promise.all([
    new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('blocked'); i.src = 'jamfile://${site.fid}/img/dot.png'; }),
    new Promise((r) => { const i = new Image(); i.referrerPolicy = 'no-referrer'; i.onload = () => r('loaded'); i.onerror = () => r('blocked'); i.src = 'jamfile://${site.fid}/img/dot.png?nr=1'; }),
  ])`);
  if (embed.some((x) => x !== 'blocked')) throw new Error('web page embedded jamfile image ' + embed);
  step(`a normal web page cannot read or embed jamfile:// content (fetch blocked, <img> ${embed.join(' / ')} incl. no-referrer)`);

  // 6-1. 인터넷 허용으로 공유한 HTML → 외부 이미지가 열림 (허용 안 한 공유는 위에서 막힘)
  const siteNet = await (async () => {
    const meta = await A.ev(`jamApp.fileFromPath(${JSON.stringify(path.join(FIX, 'site', 'index.html'))}, true, true)`);
    await A.ev(`jamFiles.share(${JSON.stringify(meta)}); 1`);
    await until('net ready', () => B.ev(`jamFiles.list().find(f => f.fid === '${meta.fid}' && f.ready)`), 20000);
    return meta;
  })();
  await A.ev(`jamFiles.openInJam('${siteNet.fid}'); 1`);
  const netToast = await until('guest asked net', () => B.ev(`window.__toasts.find(t => t.includes('인터넷 허용됨'))`), 8000);
  await until('click 받아서 열기 net', () => clickToast(B, '받아서 열기'));
  await until('B on net site', () => B.ev(`jam.tab.url === 'jamfile://${siteNet.fid}/index.html' && !jam.tab.loading`), 15000);
  const WN = await target(P.guest, (x) => x.type === 'webview' && x.url === `jamfile://${siteNet.fid}/index.html`);
  const resNet = await until('net results', () => WN.ev(`(r => r && r.remoteImg && r)(window.__res)`), 15000);
  if (resNet.remoteImg !== 'loaded') throw new Error('net share still blocked ' + JSON.stringify(resNet));
  step(`"internet allowed" HTML: guest prompt said "${netToast.slice(0, 50)}…", external https image ${resNet.remoteImg}`);

  // 6-2. 웹의 PDF 를 Jam 파일로 (호스트 세션으로 받아서)
  const web = await A.ev(`jamApp.fileFromWeb('http://127.0.0.1:8766/doc.pdf')`);
  if (!web || web.error || web.kind !== 'pdf' || web.name !== 'doc.pdf') throw new Error('web pdf ' + JSON.stringify(web));
  const notPdf = await A.ev(`jamApp.fileFromWeb('http://127.0.0.1:8766/panel')`);
  if (!notPdf.error) throw new Error('html accepted as pdf');
  step(`web PDF → Jam file: ${web.name} ${web.size}B; a non-PDF page is refused ("${notPdf.error}")`);

  // 7. 참여자가 나가면 받은 파일을 메모리에서 지움
  const hadBefore = await B.ev(`jamApp.fileHas('${pdf.fid}')`);
  await B.ev(`leaveJam({ ask: false }); 1`);
  await until('B left', () => B.ev(`!jam.active`));
  await sleep(300);
  const hadAfter = await B.ev(`Promise.all(['${pdf.fid}','${site.fid}','${game.fid}'].map(f => jamApp.fileHas(f)))`);
  if (!hadBefore || hadAfter.some(Boolean)) throw new Error('guest kept files ' + JSON.stringify(hadAfter));
  step('guest left the Jam → received files dropped from memory (fileHas: true → false)');

  console.log('\nE2E files OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
