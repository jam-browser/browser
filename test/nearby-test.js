'use strict';
// 근처 찾기 · 근처 페어링 테스트: node test/nearby-test.js
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createJamServer, isPrivateIp } = require('../server/jam-server');
const { startBeacon, startScanner, parseBeacon } = require('../server/nearby');
const { pairWithHost } = require('../server/pair-client');
const { newSecret, deriveKeys, makeProof, seal, open, C2S, S2C } = require('../shared/jam-crypto');
const ID = require('../shared/identity');
const PAIR = require('../shared/pairing');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 암호화된 Jam 클라이언트 (호스트 · 링크 참여용)
function client(port, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
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
    deliver(open(keys, raw, S2C));
  });
  return {
    ws,
    opened: new Promise((r) => ws.once('open', r)),
    nonceP,
    async create(name, secret, extra) {
      await nonceP;
      keys = deriveKeys(secret);
      ws.send(JSON.stringify({ type: 'create', name, secret, ...extra }));
    },
    async join(name, code, secret, ticket) {
      const nonce = await nonceP;
      keys = deriveKeys(secret);
      const inner = { name, resume: null, ...(ticket ? { ticket } : {}) };
      ws.send(JSON.stringify({ type: 'join', code, proof: makeProof(keys, nonce, code), p: seal(keys, inner, C2S).toString('base64') }));
    },
    send: (m) => ws.send(seal(keys, m, C2S)),
    next(type, pred = () => true, ms = 3000) {
      const match = (m) => m.type === type && pred(m);
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
        waiters.push({ pred: match, resolve: (m) => (clearTimeout(t), resolve(m)) });
      });
    },
  };
}

(async () => {
  let n = 0;
  const ok = (s) => {
    n++;
    console.log(`  ✓ ${s}`);
  };

  // ---------- 주소 판별 · 알림 형식 ----------
  for (const ip of ['192.168.0.5', '10.1.2.3', '172.20.0.1', '127.0.0.1', '::ffff:192.168.1.9', '::1', 'fe80::1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '59.1.2.3', 'relay:192.168.0.5', '']) assert.ok(!isPrivateIp(ip), ip);
  ok('같은 네트워크 주소 판별 (사설 · 링크 로컬 · 이 PC 만, 중계 경유는 제외)');

  const good = { t: 'jam-nearby', v: 1, app: '0.3.0', id: 'abcdefgh1234', name: '현석', port: 3030, code: 'K7Q2M', access: 'approval', n: 2 };
  assert.deepEqual(parseBeacon(Buffer.from(JSON.stringify(good))).code, 'K7Q2M');
  for (const bad of [
    { ...good, v: 2 },
    { ...good, port: 70000 },
    { ...good, code: 'k7q2m' },
    { ...good, access: 'admin' },
    { ...good, id: 'x' },
    { ...good, secret: 'x'.repeat(600) },
  ]) {
    assert.equal(parseBeacon(Buffer.from(JSON.stringify(bad))), null);
  }
  assert.equal(parseBeacon(Buffer.from('not json')), null);
  assert.equal(parseBeacon(Buffer.from(JSON.stringify({ ...good, name: 'a\u0000b'.repeat(20) }))).name.length <= 24, true);
  ok('근처 알림 형식 검사: 버전 · 포트 · 방 코드 · 입장 방식 · 크기가 틀리면 버림, 이름은 24자 · 제어문자 제거');

  // ---------- 알림 → 스캐너 ----------
  const UDP = 43000 + Math.floor(Math.random() * 1000);
  const seen = [];
  const scanner = startScanner({ udpPort: UDP, onChange: (l) => seen.push(l) });
  await sleep(200);
  const beacon = startBeacon({ id: 'test-host-0001', port: 3030, udpPort: UDP, intervalMs: 300, getRooms: () => [{ code: 'ABCDE', name: '호스트', access: 'friends', n: 3 }] });
  for (let i = 0; i < 30 && !seen.some((l) => l.some((x) => x.code === 'ABCDE')); i++) await sleep(100);
  const hit = seen.flat().find((x) => x.code === 'ABCDE');
  assert.ok(hit, 'scanner should hear the beacon');
  assert.equal(hit.access, 'friends');
  assert.equal(hit.n, 3);
  assert.ok(isPrivateIp(hit.ip));
  assert.equal(JSON.stringify(hit).includes('secret'), false);
  beacon.close();
  ok(`호스트 알림이 같은 네트워크 스캐너에 들림 (${hit.ip}, 비밀키 없음)`);

  // ---------- 페어링 ----------
  const server = await createJamServer({ port: 0, localCreateOnly: true, relayKey: 'relay-key-for-test-123' });
  const url = `ws://127.0.0.1:${server.port}`;
  const secret = newSecret();
  const friend = ID.newIdentity();
  const stranger = ID.newIdentity();
  const host = client(server.port);
  await host.opened;
  await host.create('호스트', secret, { access: 'approval', allow: [ID.fingerprint(friend.pub)] });
  const code = (await host.next('welcome')).room.code;

  // 1) 승인 방식: 양쪽 확인 코드가 같고, 호스트가 수락하면 비밀키 + 입장권
  let guestSas = null;
  let pendingSeen = false;
  const p1 = pairWithHost({ url, code, name: '근처사람', onSas: (s) => (guestSas = s), onPending: () => (pendingSeen = true) });
  const req = await host.next('join-request', (m) => m.pair);
  assert.equal(req.name, '근처사람');
  assert.match(req.sas, /^\d{6}$/);
  await sleep(50);
  assert.equal(req.sas, guestSas);
  assert.ok(pendingSeen);
  assert.equal(req.friend, false);
  host.send({ type: 'approve', id: req.id, ok: true });
  const got = await p1.promise;
  assert.equal(got.secret, secret);
  ok(`링크 없이 페어링: 양쪽 확인 코드 같음(${PAIR.formatSas(guestSas)}), 호스트 수락 → 초대 비밀키를 페어링 키로 암호화해서 받음`);

  // 2) 입장권으로 승인 없이 바로 입장, 입장권은 한 번만
  const g1 = client(server.port);
  await g1.opened;
  await g1.join('근처사람', code, got.secret, got.ticket);
  const w1 = await g1.next('welcome');
  assert.equal(w1.you.name, '근처사람');
  const g2 = client(server.port);
  await g2.opened;
  await g2.join('재사용', code, got.secret, got.ticket);
  await g2.next('pending');
  const req2 = await host.next('join-request', (m) => m.name === '재사용');
  assert.equal(req2.pair, false);
  host.send({ type: 'approve', id: req2.id, ok: false });
  ok('받은 일회용 입장권으로 바로 입장 · 같은 입장권을 다시 쓰면 평소처럼 승인 대기');

  // 3) 거절
  const p3 = pairWithHost({ url, code, name: '거절될사람' });
  const req3 = await host.next('join-request', (m) => m.name === '거절될사람');
  host.send({ type: 'approve', id: req3.id, ok: false });
  await assert.rejects(p3.promise, (e) => e.code === 'rejected');
  ok('호스트가 거절하면 비밀키를 받지 못함');

  // 4) 계정 서명: 친구는 카드에 ⭐, 서명이 다른 기록에 대한 것이면 거절
  const p4 = pairWithHost({ url, code, name: '친구', signer: async (th) => ({ pub: friend.pub, sig: ID.signPair(friend.priv, th) }) });
  const req4 = await host.next('join-request', (m) => m.name === '친구');
  assert.equal(req4.friend, true);
  assert.equal(req4.fp, ID.fingerprint(friend.pub));
  host.send({ type: 'approve', id: req4.id, ok: false });
  await p4.promise.catch(() => {});
  const p5 = pairWithHost({ url, code, name: '사칭', signer: async () => ({ pub: friend.pub, sig: ID.signPair(stranger.priv, 'ab'.repeat(32)) }) });
  await assert.rejects(p5.promise, (e) => e.code === 'bad-identity');
  ok('브라우저 계정 서명: 친구면 요청 카드에 친구 표시, 남의 공개 키 + 다른 서명은 거절');

  // 5) "친구만": 친구는 서명 확인 후 바로, 친구가 아니면 / 계정 없으면 거절
  host.send({ type: 'settings', access: 'friends' });
  await host.next('settings', (m) => m.settings.access === 'friends');
  const r6 = await pairWithHost({ url, code, name: '친구', signer: async (th) => ({ pub: friend.pub, sig: ID.signPair(friend.priv, th) }) }).promise;
  assert.equal(r6.secret, secret);
  await assert.rejects(pairWithHost({ url, code, name: '모르는사람', signer: async (th) => ({ pub: stranger.pub, sig: ID.signPair(stranger.priv, th) }) }).promise, (e) => e.code === 'not-friend');
  await assert.rejects(pairWithHost({ url, code, name: '익명' }).promise, (e) => e.code === 'not-friend');
  host.send({ type: 'settings', access: 'approval' });
  await host.next('settings', (m) => m.settings.access === 'approval');
  ok('"친구만": 친구는 승인 없이 페어링, 친구가 아니거나 계정 없으면 거절');

  // 6) 틀린 방 코드 · 중계 서버를 거친 페어링은 거절
  await assert.rejects(pairWithHost({ url, code: 'ZZZZZ', name: 'x' }).promise, (e) => e.code === 'bad-invite');
  const viaRelay = client(server.port, { 'x-jam-relay-ip': '192.168.0.50', 'x-jam-relay-key': 'relay-key-for-test-123' });
  await viaRelay.opened;
  await viaRelay.nonceP;
  viaRelay.ws.send(JSON.stringify({ type: 'pair', code, epk: PAIR.newEphemeral().pub }));
  const err = await viaRelay.next('error');
  assert.equal(err.code, 'forbidden');
  ok('틀린 방 코드 거절 · 중계 서버를 거쳐 온 페어링은 거절 (같은 네트워크 직접 연결만)');

  // 7) 중간자: 다른 키로 교환하면 확인 코드가 달라짐
  const a = PAIR.newEphemeral();
  const b = PAIR.newEphemeral();
  const m = PAIR.newEphemeral();
  const th1 = PAIR.transcript(a.pub, m.pub, 'nonce-1234567890', code);
  const th2 = PAIR.transcript(m.pub, b.pub, 'nonce-1234567890', code);
  const sasGuest = PAIR.derive(a.priv, m.pub, th1).sas;
  const sasHost = PAIR.derive(b.priv, m.pub, th2).sas;
  assert.notEqual(sasGuest, sasHost);
  const honest = PAIR.transcript(a.pub, b.pub, 'nonce-1234567890', code);
  assert.equal(PAIR.derive(a.priv, b.pub, honest).sas, PAIR.derive(b.priv, a.pub, honest).sas);
  assert.equal(PAIR.derive(a.priv, 'A'.repeat(43), honest), null);
  ok('중간에서 가로채 따로 키 교환하면 양쪽 확인 코드가 달라짐 · 잘못된 공개 키 거절');

  for (const c of [host, g1, g2, viaRelay]) c.ws.close();
  scanner.close();
  await server.close();
  console.log(`\n근처 찾기 · 페어링 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
