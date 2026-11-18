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
  assert.ok(!MIR.allowKey('none', 'ArrowUp'));
  assert.ok(!MIR.allowKey(undefined, 'ArrowUp'));
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
  assert.ok(MIR.ELECTRON_KEYS.has('Up') && MIR.ELECTRON_KEYS.has('q') && !MIR.ELECTRON_KEYS.has('F5'));
  assert.equal(MIR.cleanMouse({ t: 'dn', x: 0.5, y: 0.25, b: 'right' }).b, 'left');
  assert.equal(MIR.cleanMouse({ t: 'mv', x: 1.5, y: 0 }), null);
  assert.equal(MIR.cleanMouse({ t: 'zz', x: 0, y: 0 }), null);
  assert.equal(MIR.cleanMouse({ t: 'wh', x: 0, y: 0, dy: 99999 }).dy, 2000);
  ok('조작 규칙: 게임 키만 · Ctrl/Alt/Win · F 키 · 메뉴 키 막힘 · WASD→방향키(2P) · 우클릭 없음 · 좌표 0~1');

  // 권한 = { 마우스 여부, 키 묶음 }
  assert.deepEqual(MIR.normControl(null), { m: false, k: 'none' });
  assert.deepEqual(MIR.normControl({ m: 'yes', k: 'root' }), { m: false, k: 'none' });
  assert.deepEqual(MIR.normControl({ m: true, k: 'game2' }), { m: true, k: 'game2' });
  assert.ok(!MIR.canControl({ m: false, k: 'none' }));
  assert.ok(MIR.canControl({ m: false, k: 'game' }) && !MIR.canMouse({ m: false, k: 'game' }));
  assert.ok(MIR.canMouse({ m: true, k: 'none' }));
  assert.equal(MIR.controlLabel({ m: true, k: 'game' }), '🖱 마우스 + 🎮 게임 키');
  assert.equal(MIR.controlLabel({}), '보기만');
  ok('권한은 "마우스 허용"과 "보낼 수 있는 키 묶음"을 따로 정함 (이상한 값은 보기만)');

  // 개인정보 버튼 · 비밀 칸 판별
  const V = (d, kind = 'mouseDown', code = '') => MIR.remoteVerdict(d, kind, code);
  assert.equal(V(null).reason, 'unknown');
  assert.equal(V({ pwLayer: true }).reason, 'pw');
  assert.equal(V({ tag: 'iframe', frame: 'https://js.stripe.com/v3/elements' }).reason, 'frame');
  assert.ok(V({ tag: 'iframe', frame: 'https://games.example/embed/123' }).ok);
  assert.equal(V({ tag: 'button', act: true, text: '결제하기' }).reason, 'button');
  assert.equal(V({ tag: 'a', act: true, text: '내 정보', href: 'https://x.example/me' }).reason, 'button');
  assert.equal(V({ tag: 'a', act: true, text: 'Go', href: 'https://x.example/account/settings' }).reason, 'button');
  assert.equal(V({ tag: 'button', act: true, aria: 'Sign in with Google' }).reason, 'button');
  assert.equal(V({ tag: 'button', act: true, text: '확인', formPw: true }).reason, 'login');
  assert.ok(V({ tag: 'button', act: true, text: '다음 판' }).ok);
  assert.ok(V({ tag: 'canvas', act: false, text: '' }).ok);
  assert.ok(V({ tag: 'div', act: false, text: '설정 안내 문서입니다' }).ok, '누를 수 없는 글자는 그냥 통과');
  assert.equal(V({ tag: 'input', type: 'password', editable: true }).reason, 'secret');
  assert.equal(V({ tag: 'input', type: 'password', editable: true }, 'keyDown', 'KeyA').reason, 'secret');
  assert.equal(V({ tag: 'input', type: 'text', editable: true, ac: 'one-time-code' }, 'char').reason, 'secret');
  assert.equal(V({ tag: 'input', type: 'text', editable: true, name: 'card_no' }, 'keyDown', 'Digit1').reason, 'secret');
  assert.equal(V({ tag: 'input', type: 'text', editable: true, formPw: true }, 'keyDown', 'KeyA').reason, 'secret', '로그인 폼의 아이디 칸');
  assert.ok(V({ tag: 'input', type: 'text', editable: true, name: 'q' }, 'keyDown', 'KeyA').ok, '검색창 같은 일반 칸은 됨');
  assert.equal(V({ tag: 'button', act: true, text: 'Sign in' }, 'keyDown', 'Enter').reason, 'button', '로그인 버튼에 Enter');
  assert.ok(V({ tag: 'button', act: true, text: 'Sign in' }, 'keyDown', 'ArrowUp').ok, '방향키는 버튼을 누르지 않음');
  assert.ok(V({ tag: 'button', act: true, text: 'Jump' }, 'keyDown', 'Space').ok);
  assert.ok(MIR.isSecretField({ pwMenu: true }));
  assert.ok(!MIR.isSecretField({ tag: 'textarea', editable: true, name: 'comment' }));
  // 글자 없는 아이콘 버튼
  const B = (d) => V({ tag: 'button', act: true, text: '', ...d }).reason;
  assert.equal(B({ cls: 'btn Login' }), 'button', '클래스 이름');
  assert.equal(B({ icon: 'icons settings' }), 'button', '그림 파일 이름');
  assert.equal(B({ cls: 'fa fa cog' }), 'button', '톱니바퀴 아이콘');
  assert.equal(B({ icon: 'My Account' }), 'button', 'SVG 제목');
  assert.equal(B({ icon: 'avatar 32' }), 'button', '아바타');
  assert.equal(B({ lab: '결제하기' }), 'button', 'aria-labelledby');
  assert.equal(B({ data: 'logout btn' }), 'button', 'data-*');
  assert.equal(B({ tag: 'a', href: 'https://shop.example/checkout?step=1' }), 'button', '민감한 링크 주소');
  for (const d of [{ cls: 'player controls', icon: 'play' }, { cls: 'next level', icon: 'arrow right' }, { cls: 'level locked', icon: 'lock' }, { href: 'https://games.example/play/1' }]) {
    assert.ok(V({ tag: 'button', act: true, ...d }).ok, JSON.stringify(d));
  }
  ok('글자 없는 아이콘 버튼도 클래스 이름 · 그림 파일 이름 · SVG 제목 · aria-labelledby · data-* · 링크 주소로 걸러냄 (게임 버튼은 통과)');
  ok('개인정보 · 결제 · 계정 버튼, 로그인 양식, 결제 iframe, 비밀번호 뱅크, 비밀 입력 칸은 원격 클릭 · 키를 막고 게임 버튼 · 일반 칸은 허용');

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
  assert.deepEqual(gw.you.control, { m: false, k: 'none' });

  // 참여자는 미러링을 시작할 수 없음
  g.send({ type: 'mirror-start', sid: 'guestsid01', w: 640, h: 360 });
  await host.none('mirror');
  host.send({ type: 'mirror-start', sid: 'hostsid001', w: 1280, h: 720, title: '게임' });
  const gm = await g.next('mirror');
  assert.equal(gm.mirror.sid, 'hostsid001');
  assert.equal(gm.mirror.by, (await host.next('mirror')).mirror.by);
  ok('호스트만 화면 미러링을 시작 · 참여자에게 알림');

  // 영상 조각: 키프레임부터 받음 · 영상 형식(c) 전달
  const piece = (f, k, i = 0, nn = 1, c) => ({ type: 'mv', sid: 'hostsid001', f, k, i, n: nn, ts: f * 1000, d: Buffer.alloc(100, f).toString('base64'), w: 1280, h: 720, c });
  host.send(piece(0, false));
  await g.none('mv');
  await host.next('mkey');
  host.send(piece(1, true, 0, 2, 'avc1.640028'));
  host.send(piece(1, true, 1, 2));
  host.send(piece(2, false));
  const got = [await g.next('mv'), await g.next('mv'), await g.next('mv')];
  assert.deepEqual(got.map((m) => [m.f, m.k, m.i]), [[1, true, 0], [1, true, 1], [2, false, 0]]);
  assert.equal(got[0].w, 1280);
  assert.equal(got[0].c, 'avc1.640028');
  host.send({ ...piece(3, true, 0, 1, 'evil"codec'), f: 3 });
  assert.equal((await g.next('mv')).c, 'vp8');
  ok('영상 조각은 키프레임부터 전달 (중간부터 온 참여자는 키프레임 요청) · 영상 형식은 H.264/VP8 만');

  // 참여자가 보낸 영상 조각은 무시 · 잘못된 조각 무시
  g.send(piece(4, true));
  await host.none('mv');
  host.send({ ...piece(4, false), n: 999 });
  host.send({ ...piece(4, false), d: 'x'.repeat(50000) });
  await g.none('mv');
  ok('미러링하는 사람이 아니면 영상을 보낼 수 없음 · 형식이 틀린 조각 버림');

  // 큰 메시지: 바이트 한도 안이면 그대로 통과 (받는 쪽에 3MB 이상 쌓이면 그때부터 건너뜀)
  g.clear();
  const big = Buffer.alloc(30000, 7).toString('base64');
  for (let f = 10; f < 70; f++) host.send({ type: 'mv', sid: 'hostsid001', f, k: f === 10, i: 0, n: 1, ts: f, d: big, w: 1280, h: 720 });
  for (let i = 0; i < 60; i++) await g.next('mv', () => true, 5000);
  ok('영상 60조각(약 2.4MB)을 몰아 보내도 바이트 한도 안이라 모두 전달');

  // 1초마다 전송 상태(mstat) → 앱이 프레임 · 화질 조절
  await sleep(1100);
  g.send({ type: 'mfb', late: 250 });
  await sleep(50);
  host.clear();
  host.send({ type: 'mv', sid: 'hostsid001', f: 200, k: true, i: 0, n: 1, ts: 1, d: big, w: 1280, h: 720 });
  const st = await host.next('mstat');
  assert.equal(st.viewers, 1);
  assert.equal(st.late, 250);
  assert.equal(st.cap, 0); // 기본: 세션 한도 없음 (설정으로 정함)
  assert.ok(st.out > 0);
  ok('서버가 1초마다 참여자 수 · 지연 · 버림 · 실제 전송량 · 세션 한도(기본 없음)를 알려 줌');

  // 조작: 권한 없으면 무시
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'ArrowUp', mods: {} });
  g.send({ type: 'mi', k: 'm', t: 'dn', x: 0.5, y: 0.5, b: 'left', c: 1 });
  await host.none('mi');
  // 참여자는 권한을 바꿀 수 없음
  g.send({ type: 'control', id: gid, control: { m: true, k: 'full' } });
  await g.none('control');
  ok('조작 권한이 없으면 입력이 호스트로 가지 않음 · 참여자는 권한을 바꿀 수 없음');

  // 조작 요청 → 호스트에게만, 15초에 한 번
  g.send({ type: 'control-req' });
  const req = await host.next('control-req');
  assert.equal(req.id, gid);
  g.send({ type: 'control-req' });
  await host.none('control-req');
  ok('참여자의 조작 요청은 호스트에게만 가고, 15초에 한 번만');

  // 게임 키만 (마우스 없음)
  host.send({ type: 'control', id: gid, control: { m: false, k: 'game' } });
  assert.deepEqual((await g.next('control')).control, { m: false, k: 'game' });
  await host.next('members', (m) => m.members.some((x) => x.id === gid && x.control.k === 'game'));
  g.send({ type: 'mi', k: 'm', t: 'dn', x: 0.5, y: 0.5, b: 'left', c: 1 });
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'ArrowUp', key: 'ArrowUp', mods: {} });
  assert.equal((await host.next('mi')).code, 'ArrowUp');
  await host.none('mi');
  ok('키만 허락하면 마우스는 막힘');

  // 마우스 + 게임 키
  host.send({ type: 'control', id: gid, control: { m: true, k: 'game' } });
  await g.next('control');
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
  ok('마우스 + 게임 키: 방향키 · 마우스만 호스트로 (글자 키 · Ctrl 조합 · 범위 밖 좌표 버림, 우클릭→왼쪽)');

  // 호스트가 비밀 칸에 있으면(mstate secret) 키는 서버에서도 버림, 참여자에게 알림
  host.send({ type: 'mstate', paused: 'secret', secret: true });
  const ms = await g.next('mstate');
  assert.deepEqual([ms.paused, ms.secret], ['secret', true]);
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'ArrowUp', key: 'ArrowUp', mods: {} });
  g.send({ type: 'mi', k: 'm', t: 'mv', x: 0.1, y: 0.1 });
  assert.equal((await host.next('mi')).k, 'm');
  await host.none('mi');
  g.send({ type: 'mstate', paused: null, secret: false }); // 참여자는 바꿀 수 없음
  await host.none('mstate');
  host.send({ type: 'mstate', paused: null, secret: false });
  await g.next('mstate');
  ok('호스트가 비밀 입력 칸에 있는 동안 참여자의 키는 서버에서도 버림 (영상 멈춤 상태는 호스트만 바꿈)');

  // 막힘 알림은 그 참여자에게만
  const g2 = client(server.port);
  await g2.opened;
  await g2.join('구경꾼', code, secret);
  await g2.next('welcome');
  host.send({ type: 'mblock', id: gid, reason: 'button' });
  assert.equal((await g.next('mblock')).reason, 'button');
  await g2.none('mblock');
  g2.send({ type: 'mblock', id: gid, reason: 'pw' });
  await g.none('mblock');
  ok('조작이 막혔다는 알림은 그 참여자에게만 (미러링하는 사람만 보낼 수 있음)');

  // 2P: WASD → 방향키
  host.send({ type: 'control', id: gid, control: { m: false, k: 'game2' } });
  await g.next('control');
  g.send({ type: 'mi', k: 'k', t: 'd', code: 'KeyA', mods: {} });
  assert.equal((await host.next('mi')).code, 'ArrowLeft');
  // 키보드 전체: 글자도, F 키는 여전히 막힘
  host.send({ type: 'control', id: gid, control: { m: true, k: 'full' } });
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
  await host.next('members', (m) => m.members.every((x) => !x.control.m && x.control.k === 'none'));
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
  for (const c of [g, g2, late]) c.ws.close();
  await server.close();

  // ---------- 세션 한도 (테스트용으로 작게: 초당 200KB) ----------
  const small = await createJamServer({ port: 0, localCreateOnly: true, mirrorRate: 200 * 1024 });
  const h2 = client(small.port);
  await h2.opened;
  await h2.create('호스트', secret, { access: 'open' });
  const code2 = (await h2.next('welcome')).room.code;
  const viewers = [];
  for (let i = 0; i < 3; i++) {
    const v = client(small.port);
    await v.opened;
    await v.join(`v${i}`, code2, secret);
    await v.next('welcome');
    viewers.push(v);
  }
  h2.send({ type: 'mirror-start', sid: 'capsid0001', w: 640, h: 360 });
  for (const v of viewers) await v.next('mirror');
  const d40 = Buffer.alloc(30000, 1).toString('base64'); // 약 40KB
  for (let f = 0; f < 4; f++) h2.send({ type: 'mv', sid: 'capsid0001', f, k: true, i: 0, n: 1, ts: f, d: d40, w: 640, h: 360 });
  await sleep(400);
  const recv = viewers.map((v) => v.inbox.filter((m) => m.type === 'mv').length);
  const total = recv.reduce((a, b) => a + b, 0);
  assert.ok(total < 12 && total >= 4, `세션 한도로 일부만 전달: ${recv}`);
  await sleep(700);
  h2.send({ type: 'mv', sid: 'capsid0001', f: 9, k: true, i: 0, n: 1, ts: 9, d: d40, w: 640, h: 360 });
  const st2 = await h2.next('mstat');
  assert.ok(st2.drops > 0 && st2.viewers === 3 && st2.cap === 200 * 1024);
  ok(`세션(방) 전체 영상 한도를 넘으면 그 참여자는 건너뛰고 다음 키프레임부터 (받은 조각 ${recv.join('/')}, mstat 버림 ${st2.drops})`);
  for (const c of [h2, ...viewers]) c.ws.close();
  await small.close();

  console.log(`\n화면 미러링 · 조작 권한 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
