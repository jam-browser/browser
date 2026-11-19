'use strict';
// 사이트 보호 · 비밀번호 점검 테스트: node test/siteguard-test.js
//  (Electron 없이: app · ipcMain · webContents · 세션을 흉내 내서 src/siteguard.js 를 그대로 돌림)
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupSiteGuard, permKinds } = require('../src/siteguard');
const HEALTH = require('../shared/password-health');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let n = 0;
  const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-siteguard-'));
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, '||tracker.test^\n||pixel.example^$image\n');
  process.env.JAM_TEST_BLOCKLIST = list;

  // ---- 가짜 Electron ----
  const sent = [];
  const appWc = { send: (ch, d) => sent.push([ch, d]) };
  const win = { isDestroyed: () => false, webContents: appWc };
  const handlers = new Map();
  const ons = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => ons.set(ch, fn) };
  const call = (ch, arg) => handlers.get(ch)({ sender: appWc }, arg);
  const tabs = new Map();
  const mkTab = (id, url, type = 'webview') => {
    const t = { id, url, isDestroyed: () => false, getType: () => type, getURL: () => t.url, once() {} };
    tabs.set(id, t);
    return t;
  };
  const webContents = { fromId: (id) => tabs.get(id) || null };
  const prefs = { contentBlock: 'trackers', blockListHours: 24, thirdPartyCookies: 'block', permPrompt: 'ask' };
  const g = setupSiteGuard({ app: { getPath: () => dir }, ipcMain, net: {}, webContents, getWindow: () => win, getPrefs: () => prefs, testMode: true });
  const L = {};
  g.attach({ webRequest: { onBeforeSendHeaders: (_f, fn) => (L.send = fn), onHeadersReceived: (_f, fn) => (L.recv = fn) } });
  await g.applyPrefs();
  assert.equal(g._state().ready, true);

  // ---- 추적기 차단 ----
  mkTab(7, 'https://news.example.com/article');
  const req = (url, resourceType = 'script', id = 7) => ({ url, resourceType, webContentsId: id, method: 'GET' });
  assert.deepEqual(g.onRequest(req('https://cdn.tracker.test/t.js')), { cancel: true });
  assert.deepEqual(g.onRequest(req('https://pixel.example/p.gif', 'image')), { cancel: true });
  assert.equal(g.onRequest(req('https://pixel.example/app.js', 'script')), null); // $image 만
  assert.equal(g.onRequest(req('https://news.example.com/app.js')), null);
  ok('목록에 있는 추적 주소는 막고, 나머지 요청은 그대로');
  await sleep(500);
  assert.ok(sent.some(([ch, d]) => ch === 'shield:count' && d.wcId === 7 && d.n === 2));
  const info = await call('site:info', { wcId: 7 });
  assert.equal(info.blocked, 2);
  assert.equal(info.site, 'example.com');
  assert.deepEqual(info.hosts.map((h) => h[0]).sort(), ['cdn.tracker.test', 'pixel.example']);
  ok('탭마다 막은 수 · 주소를 🛡 패널에 알림');

  assert.equal(g.onRequest(req('https://tracker.test/', 'mainFrame')), null);
  ok('페이지 이동(주소창 · 링크) 자체는 막지 않음');
  mkTab(8, 'file:///C:/app/index.html', 'window');
  assert.equal(g.onRequest(req('https://tracker.test/x.js', 'script', 8)), null);
  ok('앱 화면 · 확장 프로그램 요청에는 손대지 않음 (웹페이지 탭만)');

  await call('site:set', { site: 'example.com', key: 'shieldOff', value: true });
  assert.equal(g.onRequest(req('https://cdn.tracker.test/t.js')), null);
  await call('site:set', { site: 'example.com', key: 'shieldOff', value: false });
  assert.deepEqual(g.onRequest(req('https://cdn.tracker.test/t.js')), { cancel: true });
  ok('🛡 에서 사이트마다 차단 끄기 · 다시 켜기');

  prefs.contentBlock = 'off';
  await g.applyPrefs();
  assert.equal(g.onRequest(req('https://cdn.tracker.test/t.js')), null);
  prefs.contentBlock = 'trackers';
  await g.applyPrefs();
  ok('설정에서 끄면 차단 안 함');

  // ---- 인터넷 사이트 → 내 PC · 같은 네트워크 ----
  const { localKind } = require('../shared/site');
  const H = (u) => new URL(u).hostname;
  for (const u of ['http://127.0.0.1:3030/', 'http://localhost/', 'http://a.localhost/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0:3030/']) assert.equal(localKind(H(u)), 'loopback', u);
  for (const u of ['http://192.168.0.1/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://172.31.255.1/', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://[fd12::1]/', 'http://[fe80::1]/', 'http://[::ffff:192.168.0.1]/']) assert.equal(localKind(H(u)), 'private', u);
  for (const u of ['https://example.com/', 'http://8.8.8.8/', 'http://172.32.0.1/', 'http://[2001:4860::8888]/', 'http://localhost.example.com/']) assert.equal(localKind(H(u)), null, u);
  ok('내 PC · 같은 네트워크 주소 판별 (10진수 · 16진수 · IPv6 · IPv4-mapped 표기 포함)');
  sent.length = 0;
  for (const [url, type] of [['http://127.0.0.1:3030/', 'xhr'], ['ws://localhost:3030/', 'webSocket'], ['http://192.168.0.1/cgi-bin/reboot', 'image'], ['http://[::1]:8080/', 'subFrame']]) {
    assert.deepEqual(g.onRequest(req(url, type)), { cancel: true }, url);
  }
  assert.ok(sent.some(([ch, d]) => ch === 'shield:local' && d.kind === 'loopback'));
  assert.deepEqual((await call('site:info', { wcId: 7 })).localBlocked.map((x) => x[0]).sort(), ['127.0.0.1:3030', '192.168.0.1', '[::1]:8080', 'localhost:3030']);
  mkTab(9, 'http://192.168.0.1/admin'); // 공유기 관리 화면 자체 → 같은 네트워크 요청은 그대로
  assert.equal(g.onRequest(req('http://192.168.0.1/status.json', 'xhr', 9)), null);
  mkTab(10, 'http://localhost:8080/'); // 내 PC 의 개발 서버
  assert.equal(g.onRequest(req('http://127.0.0.1:3030/', 'xhr', 10)), null);
  ok('인터넷 사이트가 내 PC · 공유기 주소를 부르면 막음 (fetch · WebSocket · 그림 · iframe), 내 PC · 같은 네트워크 페이지는 그대로');
  await call('site:set', { site: 'example.com', key: 'shieldOff', value: true });
  assert.deepEqual(g.onRequest(req('http://127.0.0.1:3030/')), { cancel: true }); // 추적기 차단을 꺼도 이건 따로
  await call('site:set', { site: 'example.com', key: 'shieldOff', value: false });
  await call('site:set', { site: 'example.com', key: 'localNet', value: true });
  assert.equal(g.onRequest(req('http://127.0.0.1:3030/')), null);
  await call('site:set', { site: 'example.com', key: 'localNet', value: false });
  prefs.blockLocalNet = false;
  assert.equal(g.onRequest(req('http://127.0.0.1:3030/')), null);
  prefs.blockLocalNet = true;
  ok('🛡 에서 사이트마다 허용 · 설정에서 끄기 (추적기 차단 끄기와는 따로)');

  // ---- 서드파티 쿠키 ----
  const sendH = (url, top = 7) => new Promise((r) => L.send({ ...req(url, 'xhr', top), requestHeaders: { Cookie: 'a=1', Accept: '*/*' } }, r));
  const recvH = (url) => new Promise((r) => L.recv({ ...req(url, 'image'), responseHeaders: { 'Set-Cookie': ['b=2'], 'content-type': ['image/gif'] } }, r));
  assert.equal((await sendH('https://ads.other.net/x')).requestHeaders.Cookie, undefined);
  assert.equal((await sendH('https://ads.other.net/x')).requestHeaders.Accept, '*/*');
  assert.deepEqual(await sendH('https://img.example.com/x'), {}); // 같은 사이트 (서브도메인)
  assert.equal((await recvH('https://ads.other.net/p.gif')).responseHeaders['Set-Cookie'], undefined);
  ok('다른 사이트로 가는 요청의 쿠키를 빼고, 받은 쿠키도 버림 (같은 사이트는 그대로)');
  await call('site:set', { site: 'example.com', key: 'cookies3p', value: true });
  assert.deepEqual(await sendH('https://ads.other.net/x'), {});
  await call('site:set', { site: 'example.com', key: 'cookies3p', value: false });
  prefs.thirdPartyCookies = 'allow';
  assert.deepEqual(await sendH('https://ads.other.net/x'), {});
  prefs.thirdPartyCookies = 'block';
  ok('사이트별 허용 · 설정에서 허용하면 그대로 보냄');

  // ---- 권한 ----
  assert.deepEqual(permKinds('media', { mediaTypes: ['video', 'audio'] }), ['camera', 'microphone']);
  assert.deepEqual(permKinds('openExternal'), []);
  const tab = tabs.get(7);
  const ask = (permission, details = {}) => new Promise((r) => g.requestPermission(tab, permission, { requestingUrl: tab.url, ...details }, r));
  sent.length = 0;
  const p1 = ask('geolocation');
  const p1b = ask('geolocation'); // 같은 요청이 또 와도 묻는 줄은 하나
  await sleep(10);
  const asks = sent.filter(([ch]) => ch === 'perm:ask');
  assert.equal(asks.length, 1);
  assert.equal(asks[0][1].origin, 'https://news.example.com');
  assert.deepEqual(asks[0][1].labels, ['위치']);
  ons.get('perm:answer')({ sender: { send() {} } }, { id: asks[0][1].id, decision: 'allow' }); // 웹페이지가 보낸 답은 무시
  ons.get('perm:answer')({ sender: appWc }, { id: asks[0][1].id, decision: 'allow' });
  assert.equal(await p1, true);
  assert.equal(await p1b, true);
  assert.equal(await ask('geolocation'), true); // 기억
  assert.equal(g.checkPermission(tab, 'geolocation', 'https://news.example.com'), true);
  assert.equal(g.checkPermission(tab, 'geolocation', 'https://evil.example.org'), false);
  ok('권한 요청 → 앱이 묻고 · 앱 화면의 답만 받고 · 출처마다 기억 (같은 요청은 하나로)');

  sent.length = 0;
  const p2 = ask('media', { mediaTypes: ['video'] });
  await sleep(10);
  const a2 = sent.find(([ch]) => ch === 'perm:ask')[1];
  ons.get('perm:answer')({ sender: appWc }, { id: a2.id, decision: 'once' });
  assert.equal(await p2, true);
  sent.length = 0;
  const p3 = ask('media', { mediaTypes: ['video'] });
  await sleep(10);
  const a3 = sent.find(([ch]) => ch === 'perm:ask')[1];
  ons.get('perm:answer')({ sender: appWc }, { id: a3.id, decision: 'deny' });
  assert.equal(await p3, false);
  assert.equal(await ask('media', { mediaTypes: ['video'] }), false); // 차단 기억
  ok('"이번만" 은 기억하지 않고, "차단" 은 기억');

  prefs.permPrompt = 'deny';
  assert.equal(await ask('notifications'), false);
  prefs.permPrompt = 'ask';
  assert.equal(await new Promise((r) => g.requestPermission(tabs.get(8), 'geolocation', { requestingUrl: 'file:///x' }, r)), false);
  assert.equal(await ask('openExternal'), false);
  ok('"모두 거절" 설정 · 앱 화면 · 모르는 권한은 묻지 않고 거절');

  const listed = await call('site:list');
  assert.deepEqual(listed.perms['https://news.example.com'], { geolocation: 'allow', camera: 'deny' });
  await call('site:set', { origin: 'https://news.example.com', key: 'perm', value: { kind: 'camera', v: null } });
  await sleep(300);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'site-settings.json'), 'utf8'));
  assert.deepEqual(saved.perms['https://news.example.com'], { geolocation: 'allow' });
  ok('사이트별 설정 목록 · 지우기 · 파일에 저장');

  // ---- 비밀번호 점검 ----
  const r = HEALTH.review([
    { id: 'a', origin: 'https://naver.com', username: 'kim', pw: 'qwer1234!' },
    { id: 'b', origin: 'https://daum.net', username: 'kim', pw: 'Jx8r-Pq3t-Lm5w-Zc2v' },
    { id: 'c', origin: 'https://bank.example', username: 'kim', pw: 'Jx8r-Pq3t-Lm5w-Zc2v' },
    { id: 'd', origin: 'https://shop.example', username: 'kim', pw: 'Summer2024' },
  ]);
  assert.equal(r.a.weak, true);
  assert.equal(r.d.weak, true);
  assert.equal(r.b.weak, false);
  assert.deepEqual(r.b.reusedWith, ['c']);
  assert.deepEqual(r.a.reusedWith, []);
  ok('약한 비밀번호 (흔함 · 연속 · 단어+연도) · 재사용 찾기');
  const { prefix, suffix } = HEALTH.hibpPrefix('password');
  assert.equal(prefix, '5BAA6');
  assert.equal(HEALTH.hibpCount(`0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${suffix}:9545824\r\nFFFF:0`, suffix), 9545824);
  assert.equal(HEALTH.hibpCount('AAAA:3', suffix), 0);
  ok('유출 확인은 SHA-1 앞 5자리만 보내고 이 PC 에서 맞춰 봄');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n사이트 보호 · 비밀번호 점검 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
