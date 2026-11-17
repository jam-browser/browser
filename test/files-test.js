'use strict';
// 같이 보는 파일 테스트: node test/files-test.js
const assert = require('node:assert/strict');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createJamServer, isJamFileUrl } = require('../server/jam-server');
const { newSecret, deriveKeys, makeProof, seal, open, C2S, S2C } = require('../shared/jam-crypto');
const { pack, unpack } = require('../src/jamfiles');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PIECE = 32 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

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
    next(type, pred = () => true, ms = 4000) {
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

  // ---------- 묶음 ----------
  const html = Buffer.from('<h1>hi</h1><img src="img/a.png">');
  const png = crypto.randomBytes(5000);
  const p1 = pack([{ p: 'index.html', bytes: html }, { p: 'img/a.png', bytes: png }], 'index.html');
  const u1 = unpack(p1);
  assert.equal(u1.entry, 'index.html');
  assert.deepEqual(u1.entries.get('img/a.png'), png);
  assert.deepEqual(u1.entries.get('index.html'), html);
  for (const bad of ['../x', '/abs', 'a\\b', 'a/../b', 'a//b', '']) {
    assert.throws(() => unpack(pack([{ p: bad, bytes: html }], bad)), `path ${JSON.stringify(bad)}`);
  }
  assert.throws(() => unpack(Buffer.from('NOPE....')));
  assert.throws(() => unpack(pack([{ p: 'a.html', bytes: html }], 'b.html')), '없는 시작 파일');
  const tampered = Buffer.from(p1);
  tampered.writeUInt32BE(9e6, 4);
  assert.throws(() => unpack(tampered));
  ok('파일 묶음: 폴더 구조 그대로 풀림 · ".." · 절대 경로 · 역슬래시 · 빈 경로 · 깨진 머리 · 없는 시작 파일은 거부');

  assert.ok(isJamFileUrl('jamfile://abcdefghijklmnop/'));
  assert.ok(isJamFileUrl('jamfile://abcdefghijklmnop/sub/page.html'));
  assert.ok(!isJamFileUrl('jamfile://ABCDEFGHIJKLMNOP/'));
  assert.ok(!isJamFileUrl('jamfile://short/'));
  assert.ok(!isJamFileUrl('file:///C:/x.pdf'));
  ok('jamfile:// 주소 형식 (파일 ID 16자, 소문자 · 숫자)');

  // ---------- 서버 ----------
  const server = await createJamServer({ port: 0, localCreateOnly: true });
  const secret = newSecret();
  const host = client(server.port);
  await host.opened;
  await host.create('호스트', secret, { access: 'open', url: 'https://example.com/' });
  const code = (await host.next('welcome')).room.code;
  const g = client(server.port);
  await g.opened;
  await g.join('게스트', code, secret);
  await g.next('welcome');

  const data = crypto.randomBytes(PIECE * 3 + 1234); // 4조각
  const fid = 'abcdefghij012345';
  const offer = { type: 'file-offer', fid, name: '자료.pdf', kind: 'pdf', size: data.length, sha: sha(data), entry: 'file', count: 1 };

  // 참여자는 공유할 수 없음
  g.send({ ...offer, fid: 'zzzzzzzzzzzzzzzz' });
  await host.none('file');
  // 형식 검사
  host.send({ ...offer, kind: 'exe' });
  host.send({ ...offer, size: 60 * 1024 * 1024 });
  host.send({ ...offer, fid: 'BAD' });
  await g.none('file');
  ok('파일 공유는 호스트만 · 허용 형식(PDF · HTML · 이미지 · 텍스트 · SWF)만 · 50MB 까지');

  host.send(offer);
  const f1 = await g.next('file');
  assert.deepEqual([f1.file.fid, f1.file.name, f1.file.ready, f1.file.size], [fid, '자료.pdf', false, data.length]);
  // 다 올리기 전에는 Jam 이 그 주소로 갈 수 없음
  host.send({ type: 'navigate', url: `jamfile://${fid}/`, title: '자료.pdf' });
  await g.none('navigate');
  // 조각 올리기 (하나는 빼고) → 다 보냈다고 하면 빠진 번호를 알려 줌
  const chunk = (i) => data.subarray(i * PIECE, (i + 1) * PIECE).toString('base64');
  for (const i of [0, 1, 3]) host.send({ type: 'file-up', fid, i, d: chunk(i) });
  host.send({ type: 'file-up', fid, i: 2, d: Buffer.alloc(10).toString('base64') }); // 크기가 틀린 조각은 버림
  host.send({ type: 'file-up-end', fid });
  const miss = await host.next('file-missing');
  assert.deepEqual(miss.list, [2]);
  host.send({ type: 'file-up', fid, i: 2, d: chunk(2) });
  const ready = await g.next('file', (m) => m.file.ready);
  assert.equal(ready.file.sha, sha(data));
  ok('조각을 다 받으면 SHA-256 을 확인하고 "준비됨" 알림 · 빠진 조각은 번호를 알려 줘서 다시 받음 · 크기가 틀린 조각은 버림');

  // 참여자가 받기 → 전체가 그대로
  g.send({ type: 'file-get', fid });
  const parts = [];
  for (let i = 0; i < 4; i++) parts.push(await g.next('file-down'));
  assert.deepEqual(parts.map((m) => m.i), [0, 1, 2, 3]);
  assert.deepEqual(Buffer.concat(parts.map((m) => Buffer.from(m.d, 'base64'))), data);
  await host.none('file-down');
  ok('참여자가 "받기" 를 누르면 그 사람에게만 조각을 순서대로 보내고, 합치면 원본과 같음');

  // 이제 Jam 이 파일 주소로 이동 가능
  host.send({ type: 'navigate', url: `jamfile://${fid}/`, title: '자료.pdf' });
  assert.equal((await g.next('navigate')).url, `jamfile://${fid}/`);
  ok('공유가 끝난 파일은 Jam 탭이 jamfile:// 주소로 이동 · 참여자가 따라감');

  // 해시가 틀리면 취소
  const bad = crypto.randomBytes(1000);
  host.send({ ...offer, fid: 'badbadbadbad0000', size: bad.length, sha: sha(Buffer.from('other')) });
  await g.next('file', (m) => m.file.fid === 'badbadbadbad0000');
  host.send({ type: 'file-up', fid: 'badbadbadbad0000', i: 0, d: bad.toString('base64') });
  const err = await host.next('error', (m) => m.code === 'file-bad');
  assert.ok(err.message.includes('해시'));
  assert.equal((await g.next('file-removed')).fid, 'badbadbadbad0000');
  ok('올린 내용의 SHA-256 이 안 맞으면 공유를 취소하고 모두의 목록에서 지움');

  // 새로 들어온 사람은 환영 정보로 파일 목록을 받음
  const late = client(server.port);
  await late.opened;
  await late.join('늦게옴', code, secret);
  const lw = await late.next('welcome');
  assert.deepEqual(lw.room.files.map((f) => [f.fid, f.ready]), [[fid, true]]);
  ok('나중에 들어온 사람도 공유 파일 목록을 받음');

  // 지우기 → 목록에서 빠지고 받기 불가
  host.clear();
  g.send({ type: 'file-remove', fid });
  await host.none('file-removed');
  host.send({ type: 'file-remove', fid });
  assert.equal((await g.next('file-removed')).fid, fid);
  g.send({ type: 'file-get', fid });
  await g.none('file-down');
  ok('호스트만 공유를 지울 수 있고, 지운 파일은 더 받을 수 없음');

  // 개수 한도
  const small = Buffer.from('hello world');
  for (let i = 0; i < 10; i++) host.send({ ...offer, fid: `limit${String(i).padStart(11, '0')}`, size: small.length, sha: sha(small), kind: 'text' });
  for (let i = 0; i < 10; i++) await g.next('file');
  host.send({ ...offer, fid: 'limitoverflow000', size: small.length, sha: sha(small), kind: 'text' });
  const lim = await host.next('error', (m) => m.code === 'file-limit');
  assert.ok(lim.message.includes('10개'));
  ok('한 Jam 에 공유 파일은 10개 · 합계 200MB 까지');

  for (const c of [host, g, late]) c.ws.close();
  await server.close();
  console.log(`\n같이 보는 파일 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
