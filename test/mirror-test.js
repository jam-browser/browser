'use strict';
// 화면 미러링 · 조작 권한 테스트: node test/mirror-test.js
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createJamServer } = require('../server/jam-server');
const { newSecret, deriveKeys, makeProof, seal, open, C2S, S2C } = require('../shared/jam-crypto');
const MIR = require('../shared/mirror');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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
    inbox,
    opened: new Promise((r) => ws.once('open', r)),
    async create(name, secret, extra) {
      await nonceP;
      keys = deriveKeys(secret);
      ws.send(JSON.stringify({ type: 'create', name, secret, ...extra }));
    },
    async join(name, code, secret) {
      const nonce = await nonceP;
      keys = deriveKeys(secret);
      ws.send(JSON.stringify({ type: 'join', code, proof: makeProof(keys, nonce, code), p: seal(keys, { name }, C2S).toString('base64') }));
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
    async none(type, ms = 300) {
      await sleep(ms);
      const hit = inbox.filter((m) => m.type === type);
      if (hit.length) throw new Error(`unexpected ${type}: ${JSON.stringify(hit[0]).slice(0, 120)}`);
    },
    clear: () => inbox.splice(0),
  };
}

(async () => {
  let n = 0;
  const ok = (s) => {
    n++;
    console.log(`  ✓ ${s}`);
  };

  // ---------- 조작 규칙 ----------
  assert.ok(MIR.allowKey('game', 'ArrowUp'));
  assert.ok(MIR.allowKey('game', 'KeyW'));
  assert.ok(!MIR.allowKey('game', 'KeyT'), 'game: 글자 키 막힘');
  assert.ok(!MIR.allowKey('game', 'ArrowUp', { ctrl: true }), 'Ctrl 조합 막힘');
  assert.ok(!MIR.allowKey('mouse', 'ArrowUp'));
  assert.ok(!MIR.allowKey('view', 'ArrowUp'));
  assert.ok(MIR.allowKey('full', 'KeyT'));
  for (const k of ['F5', 'F12', 'MetaLeft', 'ContextMenu', 'AltLeft', 'ControlLeft', 'PrintScreen']) assert.ok(!MIR.allowKey('full', k), k);
  assert.ok(!MIR.allowKey('full', 'KeyT', { alt: true }));
  assert.ok(!MIR.allowKey('full', 'a<script>'));
  assert.equal(MIR.mapKey('game2', 'KeyW'), 'ArrowUp');
  assert.equal(MIR.mapKey('game2', 'KeyD'), 'ArrowRight');
  assert.equal(MIR.mapKey('game', 'KeyW'), 'KeyW');
  assert.equal(MIR.electronKey('ArrowLeft'), 'Left');
  assert.equal(MIR.electronKey('KeyQ'), 'q');
  assert.equal(MIR.electronKey('Digit3'), '3');
  assert.equal(MIR.electronKey('Space'), 'Space');
  assert.equal(MIR.cleanMouse({ t: 'dn', x: 0.5, y: 0.25, b: 'right' }).b, 'left');
  assert.equal(MIR.cleanMouse({ t: 'mv', x: 1.5, y: 0 }), null);
  assert.equal(MIR.cleanMouse({ t: 'zz', x: 0, y: 0 }), null);
  assert.equal(MIR.cleanMouse({ t: 'wh', x: 0, y: 0, dy: 99999 }).dy, 2000);
  ok('조작 규칙: 게임 키만 · Ctrl/Alt/Win · F 키 · 메뉴 키 막힘 · WASD→방향키(2P) · 우클릭 없음 · 좌표 0~1');

  // ---------- 서버 ----------
  const server = await createJamServer({ port: 0, localCreateOnly: true });
  const secret = newSecret();
  const host = client(server.port);
  await host.opened;
  await host.create('호스트', secret, { access: 'open' });
  const code = (await host.next('welcome')).room.code;
  const g = client(server.port);
  await g.opened;
  await g.join('게스트', code, secret);
  const gw = await g.next('welcome');
  const gid = gw.you.id;
  assert.equal(gw.you.control, 'view');

  // 참여자는 미러링을 시작할 수 없음
  g.send({ type: 'mirror-start', sid: 'guestsid01', w: 640, h: 360 });
  await host.none('mirror');
  host.send({ type: 'mirror-start', sid: 'hostsid001', w: 1280, h: 720, title: '게임' });
  const gm = await g.next('mirror');
  assert.equal(gm.mirror.sid, 'hostsid001');
  assert.equal(gm.mirror.by, (await host.next('mirror')).mirror.by);
  ok('호스트만 화면 미러링을 시작 · 참여자에게 알림');

  // 영상 조각: 키프레임부터 받음
  const piece = (f, k, i = 0, nn = 1) => ({ type: 'mv', sid: 'hostsid001', f, k, i, n: nn, ts: f * 1000, d: Buffer.alloc(100, f).toString('base64'), w: 1280, h: 720 });
  host.send(piece(0, false));
  await g.none('mv');
  await host.next('mkey');
  host.send(piece(1, true, 0, 2));
  host.send(piece(1, true, 1, 2));
  host.send(piece(2, false));
  const got = [await g.next('mv'), await g.next('mv'), await g.next('mv')];
  assert.deepEqual(got.map((m) => [m.f, m.k, m.i]), [[1, true, 0], [1, true, 1], [2, false, 0]]);
  assert.equal(got[0].w, 1280);
  ok('영상 조각은 키프레임부터 전달 (중간부터 온 참여자는 키프레임 요청)');

  // 참여자가 보낸 영상 조각은 무시 · 잘못된 조각 무시
  g.send(piece(3, true));
  await host.none('mv');
  host.send({ ...piece(3, false), n: 999 });
  host.send({ ...piece(3, false), d: 'x'.repeat(50000) });
  await g.none('mv');
  ok('미러링하는 사람이 아니면 영상을 보낼 수 없음 · 형식이 틀린 조각 버림');

  // 큰 메시지는 바이트 한도 (초당 4MB, 순간 8MB) 안에서 그대로 통과
  g.clear();
  const big = Buffer.alloc(30000, 7).toString('base64');
  for (let f = 10; f < 70; f++) host.send({ type: 'mv', sid: 'hostsid001', f, k: f === 10, i: 0, n: 1, ts: f, d: big, w: 1280, h: 720 });
  for (let i = 0; i < 60; i++) await g.next('mv', () => true, 5000);
  ok('영상 60조각(약 2.4MB)을 몰아 보내도 바이트 한도 안이라 모두 전달');

  // 조작: 권한 없으면 무시
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'ArrowUp', mods: {} });
  g.send({ type: 'mi', k: 'm', t: 'dn', x: 0.5, y: 0.5, b: 'left', c: 1 });
  await host.none('mi');
  // 참여자는 권한을 바꿀 수 없음
  g.send({ type: 'control', id: gid, level: 'full' });
  await g.none('control');
  ok('조작 권한이 없으면 입력이 호스트로 가지 않음 · 참여자는 권한을 바꿀 수 없음');

  // 게임 키 권한
  host.send({ type: 'control', id: gid, level: 'game' });
  assert.equal((await g.next('control')).level, 'game');
  const mem = await host.next('members', (m) => m.members.some((x) => x.id === gid && x.control === 'game'));
  assert.ok(mem);
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'ArrowUp', key: 'ArrowUp', mods: {} });
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'KeyT', key: 't', mods: {} });
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'ArrowUp', mods: { ctrl: true } });
  g.send({ type: 'mi', k: 'm', t: 'dn', x: 0.25, y: 0.75, b: 'right', c: 1 });
  g.send({ type: 'mi', k: 'm', t: 'mv', x: 2, y: 0.5 });
  const k1 = await host.next('mi');
  const m1 = await host.next('mi');
  await host.none('mi');
  assert.deepEqual([k1.k, k1.code, k1.by, k1.key], ['k', 'ArrowUp', gid, undefined]);
  assert.deepEqual([m1.k, m1.t, m1.x, m1.y, m1.b], ['m', 'dn', 0.25, 0.75, 'left']);
  ok('게임 키 권한: 방향키 · 마우스만 호스트로 (글자 키 · Ctrl 조합 · 범위 밖 좌표 버림, 우클릭→왼쪽)');

  // 2P: WASD → 방향키
  host.send({ type: 'control', id: gid, level: 'game2' });
  await g.next('control');
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'KeyA', mods: {} });
  assert.equal((await host.next('mi')).code, 'ArrowLeft');
  // 키보드 전체: 글자도, F 키는 여전히 막힘
  host.send({ type: 'control', id: gid, level: 'full' });
  await g.next('control');
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'KeyT', key: 't', mods: { shift: false } });
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'F5', key: 'F5', mods: {} });
  const t1 = await host.next('mi');
  await host.none('mi');
  assert.deepEqual([t1.code, t1.key], ['KeyT', 't']);
  ok('2P 권한은 WASD 를 방향키로 바꿔 전달 · 키보드 전체는 글자까지 (F 키는 막힘)');

  // 미러링 끝 → 권한 초기화
  host.send({ type: 'mirror-stop' });
  assert.equal((await g.next('mirror')).mirror, null);
  await host.next('members', (m) => m.members.every((x) => x.control === 'view'));
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'KeyT', key: 't', mods: {} });
  await host.none('mi');
  ok('미러링을 멈추면 모든 조작 권한이 "보기만" 으로 돌아가고 입력도 막힘');

  // 새로 들어온 사람: 미러링 중이면 환영 정보에 포함 + 호스트에게 키프레임 요청
  host.send({ type: 'mirror-start', sid: 'hostsid002', w: 640, h: 360 });
  await g.next('mirror');
  host.clear();
  const late = client(server.port);
  await late.opened;
  await late.join('늦게옴', code, secret);
  const lw = await late.next('welcome');
  assert.equal(lw.room.mirror.sid, 'hostsid002');
  await host.next('mkey');
  ok('미러링 중에 들어온 사람은 환영 정보로 알고, 호스트가 바로 키프레임을 보냄');

  // 호스트가 나가면 미러링 끝
  host.ws.close();
  assert.equal((await g.next('mirror')).mirror, null);
  ok('미러링하던 사람이 나가면 미러링이 끝남');

  for (const c of [g, late]) c.ws.close();
  await server.close();
  console.log(`\n화면 미러링 · 조작 권한 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
