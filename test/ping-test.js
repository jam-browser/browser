'use strict';
// 핑 테스트: node test/ping-test.js
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createJamServer } = require('../server/jam-server');
const { newSecret, deriveKeys, makeProof, seal, open, C2S, S2C } = require('../shared/jam-crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  let keys = null;
  let gotNonce;
  const nonceP = new Promise((r) => (gotNonce = r));
  ws.on('message', (raw, isBinary) => {
    if (!isBinary) {
      const m = JSON.parse(raw);
      if (m.type === 'hello') return gotNonce(m.nonce);
      return inbox.push(m);
    }
    inbox.push(open(keys, raw, S2C));
  });
  return {
    ws,
    inbox,
    opened: new Promise((r) => ws.once('open', r)),
    async create(name, secret) {
      await nonceP;
      keys = deriveKeys(secret);
      ws.send(JSON.stringify({ type: 'create', name, secret, access: 'open' }));
    },
    async join(name, code, secret) {
      const nonce = await nonceP;
      keys = deriveKeys(secret);
      ws.send(JSON.stringify({ type: 'join', code, proof: makeProof(keys, nonce, code), p: seal(keys, { name }, C2S).toString('base64') }));
    },
    send: (m) => ws.send(seal(keys, m, C2S)),
    async next(type, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await sleep(20);
      }
      throw new Error(`timeout ${type}`);
    },
    count: (type) => inbox.filter((m) => m.type === type).length,
    clear: () => inbox.splice(0),
  };
}

(async () => {
  let n = 0;
  const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');
  const server = await createJamServer({ port: 0, localCreateOnly: true });
  const secret = newSecret();
  const host = client(server.port);
  await host.opened;
  await host.create('호스트', secret);
  const code = (await host.next('welcome')).room.code;
  const g = client(server.port);
  await g.opened;
  await g.join('게스트', code, secret);
  const gid = (await g.next('welcome')).you.id;
  const g2 = client(server.port);
  await g2.opened;
  await g2.join('구경꾼', code, secret);
  await g2.next('welcome');

  // 1. 핑은 다른 모두에게 (보낸 사람 제외), 종류 · 좌표 정리
  g.send({ type: 'ping', url: 'https://example.com/a', x: 0.25, y: 0.5, a: null, k: 'warn' });
  const p1 = await host.next('ping');
  const p2 = await g2.next('ping');
  assert.deepEqual([p1.by, p1.url, p1.x, p1.y, p1.k], [gid, 'https://example.com/a', 0.25, 0.5, 'warn']);
  assert.equal(p2.by, gid);
  await sleep(150);
  assert.equal(g.count('ping'), 0);
  g.send({ type: 'ping', url: 'https://example.com/a', x: 7, y: -1, k: 'evil' });
  const p3 = await host.next('ping');
  assert.deepEqual([p3.x, p3.y, p3.k], [1, 0, 'here']);
  for (const k of ['what', 'look', 'warn', 'omw', 'here']) {
    await sleep(550); // 도배 방지 한도 안에서
    g.send({ type: 'ping', url: 'https://example.com/a', x: 0.5, y: 0.5, k });
    assert.equal((await host.next('ping')).k, k);
  }
  ok('핑은 보낸 사람을 뺀 모두에게 · 좌표는 0~1 로, 휠의 5가지(📍 ❓ 👀 ⚠️ 🏃) 그대로, 모르는 종류는 📍(here) 로');

  // 2. 로그인 · 결제 주소, 이상한 주소의 핑은 안 보냄
  host.clear();
  g.send({ type: 'ping', url: 'https://accounts.example.com/login', x: 0.1, y: 0.1 });
  g.send({ type: 'ping', url: 'javascript:alert(1)', x: 0.1, y: 0.1 });
  await sleep(300);
  assert.equal(host.count('ping'), 0);
  ok('로그인 · 결제 주소나 웹 주소가 아닌 곳의 핑은 보내지 않음 (주소에 인증 정보가 있을 수 있어서)');

  // 3. 도배 방지: 순간 6개까지
  await sleep(3200); // 토큰 다시 채우기
  host.clear();
  for (let i = 0; i < 15; i++) g.send({ type: 'ping', url: 'https://example.com/a', x: 0.5, y: 0.5 });
  await sleep(500);
  const got = host.count('ping');
  assert.ok(got >= 6 && got <= 8, `got ${got}`);
  ok(`도배 방지: 15개를 몰아 보내면 ${got}개만 (순간 6개 · 초당 2개)`);

  // 4. 화면 미러링 핑: 미러링하는 사람에게만, 미러링 중일 때만
  await sleep(3200);
  host.clear();
  g.send({ type: 'mping', x: 0.5, y: 0.5 });
  await sleep(300);
  assert.equal(host.count('mping'), 0, '미러링이 없으면 무시');
  host.send({ type: 'mirror-start', sid: 'pingsid0001', w: 640, h: 360 });
  await g.next('mirror');
  g.send({ type: 'mping', x: 0.3, y: 0.6, k: 'look' });
  const mp = await host.next('mping');
  assert.deepEqual([mp.by, mp.x, mp.y, mp.k], [gid, 0.3, 0.6, 'look']);
  await sleep(150);
  assert.equal(g2.count('mping'), 0, '다른 참여자에게는 안 감 (영상으로 보임)');
  g.send({ type: 'mping', x: 2, y: 0.5 });
  await sleep(200);
  assert.equal(host.count('mping'), 0, '범위 밖 좌표 버림');
  ok('화면 미러링 핑은 미러링하는 사람에게만 (그 탭 위에 그려져 영상으로 모두에게), 조작 권한 없어도 됨');

  for (const c of [host, g, g2]) c.ws.close();
  await server.close();
  console.log(`\n핑 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
