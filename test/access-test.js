'use strict';
// Jam 입장 방식 · 친구 신원 테스트: node test/access-test.js
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createJamServer } = require('../server/jam-server');
const { newSecret, deriveKeys, makeProof, seal, open, C2S, S2C } = require('../shared/jam-crypto');
const ID = require('../shared/identity');

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = [];
  let keys = null;
  let nonce = null;
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
      if (msg.type === 'hello') return gotNonce((nonce = msg.nonce));
      return deliver(msg);
    }
    deliver(open(keys, raw, S2C));
  });
  const opened = new Promise((r) => ws.once('open', r));
  return {
    ws,
    open: () => opened,
    async create(name, secret, extra) {
      await nonceP;
      keys = deriveKeys(secret);
      ws.send(JSON.stringify({ type: 'create', name, secret, ...extra }));
    },
    // identity: { priv, pub } 또는 null. forge 로 서명을 바꿔치기할 수 있다
    async join(name, code, secret, identity, forge) {
      await nonceP;
      keys = deriveKeys(secret);
      const inner = { name, resume: null };
      if (identity) inner.id = { pub: identity.pub, sig: forge ? forge(nonce) : ID.signJoin(identity.priv, nonce, code) };
      ws.send(JSON.stringify({ type: 'join', code, proof: makeProof(keys, nonce, code), p: seal(keys, inner, C2S).toString('base64') }));
    },
    send: (m) => ws.send(seal(keys, m, C2S)),
    next(type, pred = () => true) {
      const match = (m) => m.type === type && pred(m);
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 2000);
        waiters.push({ pred: match, resolve: (m) => (clearTimeout(t), resolve(m)) });
      });
    },
    clear: () => inbox.splice(0),
    nothing(type, ms = 250) {
      return new Promise((resolve, reject) =>
        setTimeout(() => (inbox.some((m) => m.type === type) ? reject(new Error(`unexpected ${type}`)) : resolve()), ms)
      );
    },
  };
}

(async () => {
  let n = 0;
  const ok = (s) => {
    n++;
    console.log(`  ✓ ${s}`);
  };
  const server = await createJamServer({ port: 0, localCreateOnly: true });
  const { port } = server;
  const secret = newSecret();
  const alice = ID.newIdentity(); // 호스트의 친구
  const bob = ID.newIdentity(); // 친구 아님
  const aliceFp = ID.fingerprint(alice.pub);

  const host = client(port);
  await host.open();
  await host.create('호스트', secret, { access: 'friends', allow: [aliceFp] });
  const hw = await host.next('welcome');
  const code = hw.room.code;
  assert.equal(hw.room.settings.access, 'friends');
  assert.equal(hw.room.settings.allow, undefined);
  ok('"친구만" Jam 생성 (친구 목록은 설정에 실려 나가지 않음)');

  const a = client(port);
  await a.open();
  await a.join('앨리스', code, secret, alice);
  const aw = await a.next('welcome');
  assert.equal(aw.you.friend, true);
  assert.equal(aw.you.verified, true);
  assert.equal(aw.room.settings.allow, undefined);
  await host.nothing('join-request');
  ok('친구는 링크 + 서명으로 승인 없이 바로 입장');

  const b = client(port);
  await b.open();
  await b.join('밥', code, secret, bob);
  assert.equal((await b.next('error')).code, 'not-friend');
  ok('친구가 아니면 링크가 있어도 거절');

  const anon = client(port);
  await anon.open();
  await anon.join('익명', code, secret, null);
  assert.equal((await anon.next('error')).code, 'not-friend');
  ok('브라우저 계정 없이(신원 없이)는 "친구만" Jam 에 못 들어감');

  // 사칭: 앨리스의 공개 키를 대면서 자기 키로 서명
  const mallory = ID.newIdentity();
  const fake = client(port);
  await fake.open();
  await fake.join('앨리스', code, secret, { pub: alice.pub }, (nonce) => ID.signJoin(mallory.priv, nonce, code));
  assert.equal((await fake.next('error')).code, 'bad-identity');
  ok('친구 공개 키를 훔쳐 써도 서명이 안 맞아 거절 (이름 사칭 불가)');

  // 재사용: 앨리스가 예전에 만든 서명(다른 nonce)을 다시 보냄
  const oldSig = ID.signJoin(alice.priv, 'old-nonce-aaaaaaaaaaa', code);
  const replay = client(port);
  await replay.open();
  await replay.join('앨리스', code, secret, { pub: alice.pub }, () => oldSig);
  assert.equal((await replay.next('error')).code, 'bad-identity');
  ok('예전 서명을 다시 써도 이 연결의 nonce 와 달라 거절 (재사용 공격 방지)');

  // 호스트가 "승인" 방식으로 바꾸면: 누구나 요청, 친구 여부가 요청 카드에 표시
  host.send({ type: 'settings', access: 'approval' });
  await host.next('settings', (m) => m.settings.access === 'approval');
  const b2 = client(port);
  await b2.open();
  await b2.join('밥', code, secret, bob);
  await b2.next('pending');
  const req = await host.next('join-request');
  assert.equal(req.friend, false);
  assert.equal(req.fp, ID.fingerprint(bob.pub));
  host.send({ type: 'approve', id: req.id, ok: true });
  const bw = await b2.next('welcome');
  assert.equal(bw.you.verified, true);
  assert.equal(bw.you.friend, false);
  ok('"링크 + 승인": 친구가 아니어도 요청 가능, 호스트 카드에 신원 지문 · 친구 여부 표시');

  // 친구 목록을 바꾸면 참여자 표시도 갱신
  host.send({ type: 'settings', allow: [aliceFp, ID.fingerprint(bob.pub)] });
  const mem = await host.next('members', (m) => m.members.some((x) => x.name === '밥' && x.friend));
  assert.ok(mem);
  ok('호스트가 친구를 추가하면 참여자 목록의 친구 표시도 바로 갱신');

  // 자유 입장
  host.send({ type: 'settings', access: 'open' });
  await host.next('settings', (m) => m.settings.access === 'open');
  const free = client(port);
  await free.open();
  await free.join('지나가던사람', code, secret, null);
  const fw = await free.next('welcome');
  assert.equal(fw.you.verified, false);
  await host.nothing('join-request');
  ok('"자유 입장": 링크만 있으면 승인 없이 바로 (신원 없이도)');

  // 자유 입장이어도 링크(비밀키)는 필요
  const nolink = client(port);
  await nolink.open();
  await nolink.join('x', code, newSecret(), null);
  assert.equal((await nolink.next('error')).code, 'bad-invite');
  ok('어떤 방식이든 링크(비밀키) 없이는 못 들어옴');

  // 참여자는 설정을 못 바꿈
  await new Promise((r) => setTimeout(r, 200));
  host.clear();
  a.send({ type: 'settings', access: 'approval', allow: [] });
  await host.nothing('settings');
  await host.nothing('members');
  ok('참여자는 입장 방식 · 친구 목록을 바꿀 수 없음');

  // 다른 기기에서 이어 보기: 호스트와 같은 브라우저 계정(같은 신원 키)이면 입장 방식과 상관없이 승인 없이
  const mine = ID.newIdentity();
  const s2 = newSecret();
  const h2 = client(port);
  await h2.open();
  await h2.create('나', s2, { access: 'approval', allow: [], self: ID.fingerprint(mine.pub) });
  const code2 = (await h2.next('welcome')).room.code;
  const laptop = client(port);
  await laptop.open();
  await laptop.join('나 (노트북)', code2, s2, mine);
  const lw = await laptop.next('welcome');
  assert.equal(lw.you.self, true);
  await h2.nothing('join-request');
  const stranger = client(port);
  await stranger.open();
  await stranger.join('남', code2, s2, bob);
  await h2.next('join-request', (m) => m.name === '남');
  ok('같은 계정의 다른 기기는 "링크 + 승인" 이어도 바로 입장, 다른 사람은 그대로 승인 요청');
  const fakeMe = client(port);
  await fakeMe.open();
  await fakeMe.join('가짜 나', code2, s2, { pub: mine.pub, priv: bob.priv });
  assert.equal((await fakeMe.next('error')).code, 'bad-identity');
  const noId = client(port);
  await noId.open();
  await noId.join('나 (서명 없음)', code2, s2, null);
  await h2.next('join-request', (m) => m.name === '나 (서명 없음)');
  ok('내 공개 키만 가져와서는 못 들어옴 (서명 확인), 서명 없으면 보통 승인 요청');
  h2.send({ type: 'settings', access: 'friends', allow: [] });
  await new Promise((r) => setTimeout(r, 100));
  const phone = client(port);
  await phone.open();
  await phone.join('나 (휴대폰)', code2, s2, mine);
  assert.equal((await phone.next('welcome')).you.self, true);
  ok('"친구만" 으로 바꿔도 내 다른 기기는 들어옴 (친구 목록이 비어 있어도)');

  for (const c of [host, a, b2, free, h2, laptop, stranger, fakeMe, noId, phone]) c.ws.close();
  await server.close();
  console.log(`\n입장 방식 · 친구 신원 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
