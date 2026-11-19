// E2E: 패스키 끄기 (설정 → 보안 · 개인정보 → 패스키, 기본 끔)
//   끔: 페이지에 "이 기기에서 패스키를 쓸 수 없음" + 패스키 요청은 창 없이 바로 거절 (Windows Hello 창이 뜨지 않음)
//   켬: 원래 기능 그대로 (실제 패스키 창은 내 화면에 시스템 창이 뜨므로 부르지 않고, 원래 함수인지만 확인)
const P = require('./ports');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL0 = 'http://localhost:8766/long';

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
        const ev = (e) => new Promise((r) => { const i = ++id; p.set(i, (m) => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true, userGesture: true } })); });
        return { ev, close: () => ws.close() };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('no target ' + port);
}
const step = (s) => console.log('✓', s);
const probe = `(async () => {
  const r = { has: typeof PublicKeyCredential };
  r.uvpa = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  r.cond = PublicKeyCredential.isConditionalMediationAvailable ? await PublicKeyCredential.isConditionalMediationAvailable() : null;
  r.native = /\\[native code\\]/.test(String(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable)) && /\\[native code\\]/.test(String(navigator.credentials.get));
  return r;
})()`;
const getCall = `(async () => { const t = Date.now(); try { await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), timeout: 2000, userVerification: 'preferred' } }); return { ok: 'resolved', ms: Date.now() - t }; } catch (e) { return { ok: e.name, ms: Date.now() - t }; } })()`;

(async () => {
  const A = await target(P.host);
  for (let i = 0; i < 40; i++) {
    if (await A.ev(`typeof account==='object' && !document.querySelector('#ls-welcome').hidden`)) break;
    await sleep(500);
  }
  await A.ev(`document.querySelector('#ls-skip').click(); 1`);
  await sleep(1500);
  const def = await A.ev(`prefs.get('passkeys')`);
  await A.ev(`navigateTab(activeTab, '${URL0}'); 1`);
  await sleep(2500);
  let W = await target(P.host, (x) => x.type === 'webview' && x.url.startsWith(URL0));
  const off = await W.ev(probe);
  // 막힌 게 확인될 때만 패스키 요청을 불러 봄 (안 막혔으면 내 화면에 Windows 보안 창이 뜸)
  if (off.native || off.uvpa !== false) {
    W.close();
    throw new Error('passkey shim not applied ' + JSON.stringify(off));
  }
  const offGet = await W.ev(getCall);
  W.close();
  if (def !== 'off' || off.uvpa !== false || off.cond !== false || offGet.ok !== 'NotAllowedError' || offGet.ms > 1000) throw new Error('off ' + JSON.stringify({ def, off, offGet }));
  step(`default "${def}": page sees no platform passkey (uvpa=${off.uvpa}, conditional=${off.cond}); a passkey request is refused in ${offGet.ms}ms with ${offGet.ok} — no Windows Hello window`);

  await A.ev(`prefs.set('passkeys', 'on'); 1`);
  await sleep(500);
  await A.ev(`activeTab.webview.reload(); 1`);
  await sleep(2500);
  W = await target(P.host, (x) => x.type === 'webview' && x.url.startsWith(URL0));
  const on = await W.ev(probe);
  W.close();
  if (!on.native) throw new Error('on ' + JSON.stringify(on));
  step(`"on" + reload: original browser functions again (native=${on.native}, this PC uvpa=${on.uvpa})`);

  await A.ev(`prefs.set('passkeys', 'off'); 1`);
  await sleep(500);
  await A.ev(`activeTab.webview.reload(); 1`);
  await sleep(2500);
  W = await target(P.host, (x) => x.type === 'webview' && x.url.startsWith(URL0));
  const off2 = await W.ev(probe);
  W.close();
  if (off2.uvpa !== false || off2.native) throw new Error('off again ' + JSON.stringify(off2));
  step('back to "off" + reload: blocked again');
  console.log('\nE2E passkey OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e.message || e);
  process.exit(1);
});
