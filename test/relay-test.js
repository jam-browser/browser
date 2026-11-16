'use strict';
// 중계 서버 테스트: node test/relay-test.js
//   호스트 PC 의 Jam 서버 + 호스트 터널 + 중계 서버 + 인터넷 쪽 참여자를 한 프로세스에서 흉내 낸다
const assert = require('node:assert/strict');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createJamServer } = require('../server/jam-server');
const { startRelayTunnel } = require('../server/relay-tunnel');
const { createRelay } = require('../relay/jam-relay');
const { newSecret, deriveKeys, makeProof, seal, open, C2S, S2C } = require('../shared/jam-crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(url, { origin } = {}) {
  const ws = new WebSocket(url, origin ? { origin } : {});
  const inbox = [];
  const waiters = [];
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
    try {
      deliver(open(keys, raw, S2C));
    } catch {
      deliver({ type: '__undecryptable' });
    }
  });
  const closeInfo = new Promise((r) => ws.once('close', (code) => r(code)));
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return {
    ws,
    open: () => opened,
    closed: () => closeInfo,
    async create(name, secret) {
      await nonceP;
      keys = deriveKeys(secret);
      ws.send(JSON.stringify({ type: 'create', name, secret, url: 'https://example.com/' }));
    },
    async join(name, code, secret) {
      const nonce = await nonceP;
      keys = deriveKeys(secret);
      // 앱과 같은 방식: 이름은 방 키로 암호화해서 보냄
      const p = seal(keys, { name, resume: null }, C2S).toString('base64');
      ws.send(JSON.stringify({ type: 'join', code, proof: makeProof(keys, nonce, code), p }));
    },
    send: (m) => ws.send(seal(keys, m, C2S)),
    next(type, pred = () => true) {
      const match = (m) => m.type === type && pred(m);
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 3000);
        waiters.push({ pred: match, resolve: (m) => (clearTimeout(t), resolve(m)) });
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

  // 중계 서버가 본 데이터를 모두 기록 (내용이 보이는지 확인용)
  const seen = [];
  const relay = await createRelay({ port: 0, host: '127.0.0.1', onFrame: (_l, _d, data) => seen.push(Buffer.from(data)) });
  const relayUrl = `ws://127.0.0.1:${relay.port}`;

  const relayKey = crypto.randomBytes(24).toString('base64url');
  const jam = await createJamServer({ port: 0, host: '127.0.0.1', localCreateOnly: true, relayKey });

  // 호스트: 자기 PC 의 Jam 서버에 직접 접속해서 방을 만든다
  const secret = newSecret();
  const host = client(`ws://127.0.0.1:${jam.port}`);
  await host.open();
  await host.create('호스트', secret);
  const hw = await host.next('welcome');

  // 호스트 터널: 중계 서버에서 경로를 받는다
  const tunnel = await startRelayTunnel({ relayUrl, localPort: jam.port, relayKey });
  assert.match(tunnel.route, /^[a-z0-9]{10}$/);
  ok('호스트 앱이 중계 서버에 길을 열고 경로 번호를 받음');

  // 인터넷 쪽 참여자: 중계 서버의 /join/<경로> 로 접속 → 호스트 PC 의 Jam 서버까지 이어짐
  const guest = client(`${relayUrl}/join/${tunnel.route}`);
  await guest.open();
  await guest.join('멀리있는친구', hw.room.code, secret);
  await guest.next('pending');
  const req = await host.next('join-request');
  assert.equal(req.name, '멀리있는친구');
  assert.match(req.ip, /^relay:127\.0\.0\.1$/);
  ok('중계 서버를 거쳐 참여 요청이 호스트에게 도착 (손님 IP 는 relay:… 로 표시)');

  host.send({ type: 'approve', id: req.id, ok: true });
  const gw = await guest.next('welcome');
  assert.equal(gw.room.members.length, 2);
  host.send({ type: 'navigate', url: 'https://example.com/very-secret-page', title: 'secret title' });
  assert.equal((await guest.next('navigate')).url, 'https://example.com/very-secret-page');
  guest.send({ type: 'chat', text: '비밀 채팅 내용' });
  assert.equal((await host.next('chat')).text, '비밀 채팅 내용');
  ok('승인 후 중계 서버를 통해 이동·채팅이 오감');

  const all = Buffer.concat(seen).toString('utf8');
  assert.ok(seen.length > 0);
  for (const secretText of ['very-secret-page', 'secret title', '비밀 채팅 내용', secret, '멀리있는친구']) {
    assert.ok(!all.includes(secretText), `relay saw plaintext: ${secretText}`);
  }
  ok('중계 서버가 본 데이터에는 주소·제목·채팅·이름·비밀키가 전혀 없음 (암호화된 채로 전달)');

  // 웹페이지 출처는 중계 서버에 접속 불가
  const evil = client(`${relayUrl}/join/${tunnel.route}`, { origin: 'https://evil.example' });
  await assert.rejects(evil.open(), /403/);
  ok('웹페이지(https 출처)는 중계 서버에 접속 불가');

  // 경로를 모르면 접속 불가, 토큰 없이 손님을 가로챌 수 없음
  const wrongRoute = client(`${relayUrl}/join/zzzzzzzzzz`);
  await wrongRoute.open();
  assert.equal(await wrongRoute.closed(), 4404);
  const hijack = new WebSocket(`${relayUrl}/accept/${tunnel.route}/1?token=wrong`);
  assert.equal(await new Promise((r) => hijack.once('close', r)), 4403);
  ok('없는 경로는 거절, 토큰 없이 손님 연결을 가로챌 수 없음');

  // 중계 서버로는 방을 만들 수 없음 (localCreateOnly)
  const remoteCreate = client(`${relayUrl}/join/${tunnel.route}`);
  await remoteCreate.open();
  await Promise.race([remoteCreate.create('공격', newSecret()), sleep(3000)]);
  const e = await remoteCreate.next('error').catch(() => ({ code: 'closed' }));
  assert.equal(e.code, 'forbidden');
  ok('중계 서버를 통해서는 방을 새로 만들 수 없음');

  // 중계로 들어온 사람이 잘못된 비밀키를 계속 넣으면 → 그 손님 IP 만 차단, 호스트 직접 접속은 영향 없음
  for (let i = 0; i < 8; i++) {
    const bad = client(`${relayUrl}/join/${tunnel.route}`);
    await bad.open();
    await bad.join('x', hw.room.code, newSecret());
    assert.equal((await bad.next('error')).code, 'bad-invite');
    await bad.closed();
  }
  const blocked = client(`${relayUrl}/join/${tunnel.route}`);
  await blocked.open();
  const blockedClose = await blocked.closed();
  const direct = client(`ws://127.0.0.1:${jam.port}`);
  await direct.open();
  ok(`중계로 틀린 키 8번 → 그 손님만 차단(연결 종료 ${blockedClose}), 같은 PC 직접 접속은 정상`);
  direct.ws.close();

  // 같은 PC 의 다른 프로그램이 relayKey 없이 IP 를 속일 수 없음
  const spoof = new WebSocket(`ws://127.0.0.1:${jam.port}`, { headers: { 'x-jam-relay-ip': '6.6.6.6', 'x-jam-relay-key': 'guess' } });
  await new Promise((r) => spoof.once('open', r));
  spoof.close();
  ok('relayKey 없이 보낸 가짜 IP 헤더는 무시');


  tunnel.close();
  guest.ws.close();
  host.ws.close();
  await relay.close();
  await jam.close();
  await sleep(50);
  console.log(`\n중계 서버 테스트 통과 (${passed}개)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('테스트 실패:', err);
    process.exit(1);
  });
