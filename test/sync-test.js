'use strict';
// Jam 서버 테스트: node test/sync-test.js
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createJamServer } = require('../server/jam-server');
const { sameSite, sameDoc, isSensitiveUrl } = require('../shared/site');
const { newSecret, deriveKeys, makeProof, seal, open, C2S, S2C } = require('../shared/jam-crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(port, { origin } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
  const inbox = [];
  const waiters = [];
  const rawFrames = [];
  let keys = null;
  let gotNonce;
  const nonceP = new Promise((r) => (gotNonce = r));
  const deliver = (msg) => {
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  };
  ws.on('message', (raw, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(raw);
      if (msg.type === 'hello') return gotNonce(msg.nonce);
      return deliver(msg);
    }
    rawFrames.push(Buffer.from(raw));
    try {
      deliver(open(keys, raw, S2C));
    } catch {
      deliver({ type: '__undecryptable' });
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return {
    ws,
    rawFrames,
    open: () => opened,
    closed: () => new Promise((r) => (ws.readyState === 3 ? r() : ws.once('close', r))),
    async create(name, secret, extra = {}) {
      await nonceP;
      keys = deriveKeys(secret);
      ws.send(JSON.stringify({ type: 'create', name, secret, ...extra }));
    },
    async join(name, code, secret, extra = {}) {
      const nonce = await nonceP;
      keys = deriveKeys(secret);
      ws.send(JSON.stringify({ type: 'join', name, code, proof: makeProof(keys, nonce, code.toUpperCase()), ...extra }));
    },
    send: (m) => ws.send(seal(keys, m, C2S)),
    sendPlain: (m) => ws.send(JSON.stringify(m)),
    next(type, pred = () => true) {
      const match = (m) => m.type === type && pred(m);
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 2000);
        waiters.push({ pred: match, resolve: (m) => (clearTimeout(t), resolve(m)) });
      });
    },
    nothing(type, ms = 200) {
      return new Promise((resolve, reject) => {
        setTimeout(() => (inbox.some((m) => m.type === type) ? reject(new Error(`unexpected ${type}`)) : resolve()), ms);
      });
    },
  };
}

async function main() {
  let passed = 0;
  const ok = (name) => {
    passed++;
    console.log(`  ✓ ${name}`);
  };

  // ---------- 규칙 함수 ----------
  assert.ok(sameSite('https://www.youtube.com/watch?v=1', 'https://m.youtube.com/'));
  assert.ok(sameSite('https://news.naver.com/a', 'https://www.naver.com/'));
  assert.ok(sameSite('https://a.example.co.kr/', 'https://b.example.co.kr/'));
  assert.ok(!sameSite('https://example.co.kr/', 'https://other.co.kr/'));
  assert.ok(!sameSite('https://www.youtube.com/', 'https://www.google.com/'));
  ok('같은 사이트 판단 (서브도메인, co.kr)');

  assert.ok(isSensitiveUrl('https://accounts.google.com/signin'));
  assert.ok(isSensitiveUrl('https://nid.naver.com/nidlogin.login'));
  assert.ok(isSensitiveUrl('https://example.com/login'));
  assert.ok(isSensitiveUrl('https://example.com/cb?code=abc&state=1'));
  assert.ok(isSensitiveUrl('https://example.com/#access_token=xyz'));
  assert.ok(!isSensitiveUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
  assert.ok(!isSensitiveUrl('https://www.google.com/search?q=login+tips'));
  ok('로그인·인증 주소 판별');

  const yt = 'https://www.youtube.com/watch?v=AAA&list=PL1';
  assert.ok(sameDoc(yt + '&index=2', yt + '&index=3&pp=xyz'), '재생목록 index · pp 만 다르면 같은 문서');
  assert.ok(sameDoc('https://www.youtube.com/watch?v=AAA&t=30s', 'https://m.youtube.com/watch?v=AAA'), '시작 시간 · 모바일 주소');
  assert.ok(!sameDoc(yt + '&index=2', 'https://www.youtube.com/watch?v=BBB&list=PL1&index=3'), '재생목록 다음 영상은 다른 문서');
  assert.ok(!sameDoc(yt, 'https://www.youtube.com/watch?v=AAA&list=PL2'), '다른 재생목록');
  assert.ok(sameDoc('https://example.com/a/#x', 'https://example.com/a'), '해시 · 끝 / 무시');
  assert.ok(!sameDoc('https://example.com/a?page=1', 'https://example.com/a?page=2'), '일반 사이트는 쿼리가 다르면 다른 문서');
  ok('같은 문서 판단 (유튜브 재생목록의 index · pp 무시)');

  // ---------- 서버 (내 PC 호스트 모드와 같은 설정) ----------
  const server = await createJamServer({ port: 0, localCreateOnly: true });
  const { port } = server;
  const secret = newSecret();

  const host = client(port);
  await host.open();
  await host.create('호스트', secret, { url: 'https://www.youtube.com/', title: 'YouTube' });
  const hw = await host.next('welcome');
  assert.equal(hw.room.hostId, hw.you.id);
  assert.match(hw.room.code, /^[A-Z0-9]{5}$/);
  assert.equal(hw.room.settings.requireApproval, true);
  assert.equal(JSON.stringify(hw).includes(secret), false);
  ok('방 만들기 (같은 PC에서만) + 기본값: 참여 승인 필요');

  // --- 보안: 웹페이지 출처는 접속 불가
  const evil = client(port, { origin: 'https://evil.example' });
  await assert.rejects(evil.open(), /403/);
  ok('웹페이지(https 출처)에서 서버 접속 차단');

  // --- 보안: 비밀키가 틀리면 거절 (코드가 맞아도)
  const wrong = client(port);
  await wrong.open();
  await wrong.join('침입자', hw.room.code, newSecret());
  assert.equal((await wrong.next('error')).code, 'bad-invite');
  await wrong.closed();
  ok('방 코드가 맞아도 비밀키가 틀리면 거절');

  // --- 참여 요청 → 호스트 승인
  const guest = client(port);
  await guest.open();
  await guest.join('게스트', hw.room.code.toLowerCase(), secret);
  await guest.next('pending');
  const req = await host.next('join-request');
  assert.equal(req.name, '게스트');
  guest.send({ type: 'chat', text: '승인 전 메시지' });
  await host.nothing('chat');
  host.send({ type: 'approve', id: req.id, ok: true });
  const gw = await guest.next('welcome');
  assert.equal(gw.room.members.length, 2);
  assert.equal(gw.room.current.url, 'https://www.youtube.com/');
  assert.equal(gw.you.canCrossSite, false);
  await host.next('members', (m) => m.members.length === 2);
  ok('참여 요청 → 호스트 수락 후 입장 (승인 전에는 아무것도 못 함)');

  // --- 거절
  const rej = client(port);
  await rej.open();
  await rej.join('모르는사람', hw.room.code, secret);
  await rej.next('pending');
  const req2 = await host.next('join-request');
  host.send({ type: 'approve', id: req2.id, ok: false });
  assert.equal((await rej.next('error')).code, 'rejected');
  ok('호스트가 거절하면 들어올 수 없음');

  // --- 암호화 확인: 실제로 오간 프레임에 주소가 평문으로 없음
  host.send({ type: 'navigate', url: 'https://www.youtube.com/watch?v=secretvideo', title: 'v' });
  await guest.next('navigate');
  assert.ok(guest.rawFrames.length > 0);
  assert.ok(guest.rawFrames.every((b) => !b.toString('latin1').includes('secretvideo')));
  ok('주고받는 내용은 암호화되어 있음 (주소가 평문으로 보이지 않음)');

  // --- 인증 뒤 평문/위조 메시지는 무시
  guest.sendPlain({ type: 'chat', text: '평문' });
  const forged = seal(deriveKeys(newSecret()), { type: 'chat', text: '위조' }, C2S);
  guest.ws.send(forged);
  await host.nothing('chat', 300);
  ok('암호화 안 된 메시지 / 다른 키로 만든 메시지는 무시');

  guest.send({ type: 'navigate', url: 'https://www.youtube.com/watch?v=abc', title: 'video' });
  assert.equal((await host.next('navigate')).url, 'https://www.youtube.com/watch?v=abc');
  await guest.nothing('navigate');
  ok('게스트도 같은 사이트 안에서는 자유롭게 이동');

  guest.send({ type: 'navigate', url: 'https://www.google.com/' });
  assert.equal((await guest.next('error')).code, 'no-cross-site');
  await host.nothing('navigate');
  ok('권한 없는 게스트의 다른 사이트 이동 차단');

  host.send({ type: 'perm', id: gw.you.id, canCrossSite: true });
  await guest.next('members', (m) => m.members.find((x) => x.id === gw.you.id).canCrossSite);
  guest.send({ type: 'navigate', url: 'https://www.google.com/' });
  assert.equal((await host.next('navigate')).url, 'https://www.google.com/');
  ok('호스트가 개별 권한을 주면 다른 사이트로 이동 가능');

  guest.send({ type: 'perm', id: hw.you.id, canCrossSite: false });
  host.send({ type: 'perm', id: gw.you.id, canCrossSite: false });
  await guest.next('members', (m) => !m.members.find((x) => x.id === gw.you.id).canCrossSite);
  host.send({ type: 'settings', allowAllCrossSite: true });
  await guest.next('settings', (m) => m.settings.allowAllCrossSite);
  await host.next('settings');
  guest.send({ type: 'navigate', url: 'https://en.wikipedia.org/' });
  assert.equal((await host.next('navigate')).url, 'https://en.wikipedia.org/');
  host.send({ type: 'settings', allowAllCrossSite: false });
  await guest.next('settings', (m) => !m.settings.allowAllCrossSite);
  await host.next('settings');
  ok('"모두 허용" 설정 (호스트만 변경 가능)');

  guest.send({ type: 'navigate', url: 'https://en.wikipedia.org/login?returnto=x' });
  guest.send({ type: 'navigate', url: 'https://en.wikipedia.org/cb?code=secret' });
  guest.send({ type: 'cursor', url: 'https://en.wikipedia.org/cb?code=secret', x: 0.1, y: 0.1 });
  await host.nothing('navigate');
  await host.nothing('cursor');
  guest.send({ type: 'presence', url: 'https://en.wikipedia.org/cb?code=secret', title: 'x' });
  const pr = await host.next('presence');
  assert.equal(pr.presence.url, null);
  assert.equal(pr.presence.private, true);
  ok('로그인·인증 주소는 이동/커서/상태 어디에도 공유되지 않음');

  guest.send({ type: 'navigate', url: 'javascript:alert(1)' });
  await host.nothing('navigate');
  ok('http(s)가 아닌 주소는 무시');

  const top = { p: '#content>h2:nth-of-type(3)', fx: 0.5, fy: 0.2, off: 4 };
  guest.send({ type: 'viewport', url: 'https://en.wikipedia.org/', vx: 0, vy: 0.4, vw: 1, vh: 0.1, top, bot: null, w: 1280, h: 720, z: 1.5 });
  const vp = await host.next('viewport');
  assert.deepEqual([vp.by, vp.vy, vp.w, vp.h, vp.z], [gw.you.id, 0.4, 1280, 720, 1.5]);
  assert.deepEqual(vp.top, top);
  guest.send({ type: 'viewport', url: 'https://en.wikipedia.org/', top: { p: 'x'.repeat(700) }, w: 1, h: 1 });
  assert.equal((await host.next('viewport')).top, null);
  ok('보고 있는 영역 + 해상도 + 확대율 + 위치 앵커 공유 (너무 긴 앵커는 버림)');

  // 글자 앵커 + 예비 앵커 (창 크기가 달라도 같은 내용을 찾기 위한 정보)
  const textTop = {
    p: '#title>h1', fx: 0.4, fy: 0.5, off: 76, t: 0, o: 12, ch: 'B', cx: 0.3, cy: 0.6,
    alt: [{ p: '#owner>a', fx: 0.1, fy: 0.5, off: 100 }, { p: '#d', fx: 0, fy: 0, off: 124 }, { p: '#e', fx: 0, fy: 0, off: 1 }, { p: '#f', fx: 0, fy: 0, off: 1 }],
  };
  guest.send({ type: 'viewport', url: 'https://en.wikipedia.org/', top: textTop, bot: null, w: 900, h: 650 });
  const tv = (await host.next('viewport')).top;
  assert.deepEqual([tv.t, tv.o, tv.ch, tv.cx, tv.cy], [0, 12, 'B', 0.3, 0.6]);
  assert.equal(tv.alt.length, 3);
  assert.equal(tv.alt[0].p, '#owner>a');
  guest.send({ type: 'cursor', url: 'https://en.wikipedia.org/', x: 0.1, y: 0.1, a: { p: '#x', fx: 2, fy: -1, t: -1, o: 3, alt: [{ p: '#y', alt: [{ p: '#z' }] }] } });
  const ca = (await host.next('cursor')).a;
  assert.deepEqual([ca.fx, ca.fy, ca.t, ca.o], [1, 0, undefined, undefined]);
  assert.equal(ca.alt[0].alt, undefined);
  ok('글자 앵커·예비 앵커 전달 (예비는 3개까지, 한 단계만, 잘못된 값은 버림)');

  guest.send({ type: 'viewport', url: null });
  assert.equal((await host.next('viewport')).url, null);
  guest.send({ type: 'cursor', x: null });
  assert.equal((await host.next('cursor')).x, null);
  ok('영역/커서 숨기기 전달');

  guest.send({ type: 'scroll', url: 'https://en.wikipedia.org/', x: 0, y: 0.5, top });
  const sc = await host.next('scroll');
  assert.equal(sc.y, 0.5);
  assert.deepEqual(sc.top, top);
  ok('스크롤 동기화 (앵커 포함)');

  host.send({ type: 'media', url: 'https://www.youtube.com/watch?v=abc', playing: true, time: 42.5, rate: 1 });
  const md = await guest.next('media');
  assert.equal(md.time, 42.5);
  assert.ok(md.age >= 0);
  ok('동영상 재생 상태 공유');

  // --- 재접속: 끊겼다가 재접속 토큰으로 돌아오면 승인 없이 바로 입장
  const resumeToken = gw.resume;
  assert.ok(resumeToken && resumeToken.length > 20);
  guest.ws.close();
  await host.next('members', (m) => m.members.length === 1);
  const back = client(port);
  await back.open();
  await back.join('게스트', hw.room.code, secret, { resume: resumeToken });
  const bw = await back.next('welcome');
  assert.equal(bw.room.media.time, 42.5);
  await host.nothing('join-request');
  ok('잠깐 끊긴 사람은 재접속 토큰으로 승인 없이 복귀 (재생 위치도 받음)');

  host.send({ type: 'settings', requireApproval: false });
  await host.next('settings', (m) => m.settings.requireApproval === false);
  const late = client(port);
  await late.open();
  await late.join('늦게옴', hw.room.code, secret);
  const lw = await late.next('welcome');
  ok('호스트가 승인을 끄면 바로 입장');

  back.send({ type: 'queue:add', url: 'https://www.google.com/', title: 'Google' });
  const q = await host.next('queue');
  assert.equal(q.queue[0].addedByName, '게스트');
  back.send({ type: 'queue:next' });
  assert.equal((await back.next('error')).code, 'no-cross-site');
  host.send({ type: 'queue:next' });
  assert.equal((await back.next('navigate')).url, 'https://www.google.com/');
  ok('대기열: 누구나 추가, 다른 사이트 재생은 권한 필요');

  back.send({ type: 'chat', text: '  안녕   하세요  ' });
  assert.equal((await host.next('chat')).text, '안녕 하세요');
  host.send({ type: 'reaction', emoji: '🔥' });
  host.send({ type: 'reaction', emoji: '<img>' });
  assert.equal((await back.next('reaction')).emoji, '🔥');
  await back.nothing('reaction');
  ok('채팅 · 리액션');

  host.send({ type: 'kick', id: lw.you.id });
  await late.next('kicked');
  ok('호스트가 내보내기');

  host.ws.close();
  const newHost = await back.next('members', (m) => m.members.length === 1);
  assert.equal(newHost.hostId, bw.you.id);
  ok('호스트가 나가면 남은 사람이 호스트 승계');

  back.send({ type: 'end' });
  await back.nothing('ended', 100).catch(() => {});
  back.ws.close();
  await server.close();

  // --- 무차별 대입 차단: 틀린 비밀키 8번이면 그 주소는 10분 차단
  const s2 = await createJamServer({ port: 0, localCreateOnly: true });
  const h2 = client(s2.port);
  await h2.open();
  const sec2 = newSecret();
  await h2.create('h', sec2);
  const w2 = await h2.next('welcome');
  for (let i = 0; i < 8; i++) {
    const c = client(s2.port);
    await c.open();
    await c.join('x', w2.room.code, newSecret());
    await c.next('error');
    await c.closed();
  }
  const after = client(s2.port);
  await assert.rejects(after.open(), /429/);
  ok('틀린 초대 코드를 계속 넣으면 그 주소를 차단 (무차별 대입 방지)');
  h2.ws.close();
  await s2.close();

  console.log(`\n모든 테스트 통과 (${passed}개)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('테스트 실패:', err);
    process.exit(1);
  });
