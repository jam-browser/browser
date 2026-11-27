'use strict';
// 🗳️ 클릭 투표 테스트: node test/vote-test.js
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const V = require('../shared/vote');
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
    async next(type, ms = 3000, pred = () => true) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const i = inbox.findIndex((m) => m.type === type && pred(m));
        if (i >= 0) return inbox.splice(i, 1)[0];
        await sleep(15);
      }
      throw new Error(`timeout ${type}`);
    },
    clear: () => inbox.splice(0),
  };
}

let n = 0;
const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');

// ---------- shared/vote.js ----------
{
  assert.equal(V.cleanOpts([{ x: 0, y: 0, w: 0.5, h: 0.5 }]), null); // 1개는 안 됨
  assert.equal(V.cleanOpts(Array.from({ length: 7 }, () => ({ x: 0, y: 0, w: 0.2, h: 0.2 }))), null);
  assert.equal(V.cleanOpts([{ x: 0, y: 0, w: 0.01, h: 0.5 }, { x: 0.5, y: 0, w: 0.4, h: 0.4 }]), null); // 너무 작음
  assert.equal(V.cleanOpts([{ x: 'a', y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.4, h: 0.4 }]), null);
  const o = V.cleanOpts([{ x: -1, y: 0.2, w: 0.7, h: 2, label: '  아주   긴 이름이 들어가는 왼쪽 칸입니다 정말로  ' }, { x: 0.9, y: 0.1, w: 0.5, h: 0.5 }]);
  assert.deepEqual(o.map((x) => [x.k, x.x, x.y, x.w, x.h]), [['A', 0, 0.2, 0.7, 0.8], ['B', 0.9, 0.1, 0.1, 0.5]]); // 화면 밖은 잘라냄
  assert.equal(o[0].label.length, 20);
  const s = V.cleanSetup({ opts: V.PRESETS.halves, sec: 17, title: 'x'.repeat(100), auto: false });
  assert.deepEqual([s.sec, s.title.length, s.live, s.auto, s.endAll, s.series], [15, 60, true, false, true, false]);
  assert.equal(V.cleanSetup({ opts: V.PRESETS.halves, sec: 0 }).sec, 0);
  ok('칸 정리: 2~6개 · 화면 밖은 잘라냄 · 너무 작거나 숫자가 아니면 거절 · 이름 20자 · 시간은 정해진 값만');

  const opts = V.cleanOpts(V.PRESETS.quad);
  assert.deepEqual(V.tally(new Map([['1', 'A'], ['2', 'B'], ['3', 'A'], ['4', 'Z']]), opts), { A: 2, B: 1, C: 0, D: 0 });
  assert.deepEqual(V.pickWinner({ A: 2, B: 1 }, 'B'), { winner: 'A', tie: false, how: 'votes', top: 2 });
  assert.deepEqual(V.pickWinner({ A: 1, B: 1, C: 0 }, 'B'), { winner: 'B', tie: true, how: 'host', top: 1 });
  assert.equal(V.pickWinner({ A: 1, B: 1, C: 1 }, 'X', () => 0.99).winner, 'C');
  assert.equal(V.pickWinner({ A: 1, B: 1 }, null, () => 0).how, 'random');
  assert.deepEqual(V.pickWinner({ A: 0, B: 0 }, 'A'), { winner: null, tie: false, how: 'none', top: 0 });
  ok('표 세기 · 1등이 하나면 그것, 동점이면 호스트가 고른 쪽 → 아니면 무작위, 아무도 안 하면 없음');

  const h = V.cleanOpts([{ x: 0, y: 0, w: 1, h: 1 }, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }]);
  assert.equal(V.hit(h, 0.5, 0.5), 'B'); // 겹치면 작은 칸
  assert.equal(V.hit(h, 0.1, 0.1), 'A');
  assert.equal(V.hit(V.cleanOpts(V.PRESETS.halves), 0.5, 0.5), null); // 사이 틈
  assert.deepEqual(V.center(V.cleanOpts(V.PRESETS.halves)[1]), { x: 0.75, y: 0.5 });
  ok('누른 자리 → 칸 (겹치면 작은 칸, 틈은 없음) · 칸 가운데');
}

(async () => {
  const server = await createJamServer({ port: 0, localCreateOnly: true });
  const secret = newSecret();
  const host = client(server.port);
  await host.opened;
  await host.create('호스트', secret);
  const code = (await host.next('welcome')).room.code;
  const g = client(server.port);
  await g.opened;
  await g.join('게스트', code, secret);
  await g.next('welcome');
  const g2 = client(server.port);
  await g2.opened;
  await g2.join('구경꾼', code, secret);
  await g2.next('welcome');
  await sleep(100);
  for (const c of [host, g, g2]) c.clear();

  // 참여자는 투표를 열 수 없음
  g.send({ type: 'vote-open', opts: V.PRESETS.halves });
  await sleep(150);
  assert.equal(host.inbox.filter((m) => m.type === 'vote').length, 0);
  // 칸이 이상하면 호스트에게 오류
  host.send({ type: 'vote-open', opts: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] });
  assert.equal((await host.next('error')).code, 'bad-vote');
  ok('참여자는 투표를 못 엶 · 칸이 1개뿐이면 호스트에게 오류');

  // 1. 투표 열기 → 모두에게 · 표 수만 (누가 뭘 골랐는지는 안 감) · 모두 투표하면 바로 끝 · 동점이면 호스트 쪽
  host.send({ type: 'vote-open', title: '이상형 월드컵', opts: V.PRESETS.halves, sec: 30, live: true, auto: true, series: true });
  const opened = (await g.next('vote')).vote;
  assert.deepEqual([opened.state, opened.round, opened.title, opened.opts.length, opened.voted, opened.total, opened.series], ['open', 1, '이상형 월드컵', 2, 0, 3, true]);
  assert.ok(opened.left > 28000 && opened.left <= 30000);
  host.send({ type: 'vote-cast', id: opened.id, k: 'A' });
  const t1 = await g2.next('vote-tally');
  assert.deepEqual([t1.counts, t1.voted, t1.total], [{ A: 1, B: 0 }, 1, 3]);
  assert.ok(!JSON.stringify(t1).includes('"1"'), 'no voter ids');
  g.send({ type: 'vote-cast', id: opened.id, k: 'B' });
  await g2.next('vote-tally');
  g.send({ type: 'vote-cast', id: 'other-id', k: 'A' }); // 다른 투표 id → 무시
  g.send({ type: 'vote-cast', id: opened.id, k: 'Z' }); // 없는 칸 → 무시
  g.send({ type: 'vote-cast', id: opened.id, k: 'A' }); // 바꿈
  const tc = await g2.next('vote-tally');
  assert.deepEqual([tc.counts, tc.voted], [{ A: 2, B: 0 }, 2]);
  g.send({ type: 'vote-cast', id: opened.id, k: null }); // 취소
  const tn = await g2.next('vote-tally');
  assert.deepEqual([tn.counts, tn.voted], [{ A: 1, B: 0 }, 1]);
  g.send({ type: 'vote-cast', id: opened.id, k: 'B' });
  await g2.next('vote-tally');
  g2.send({ type: 'vote-cast', id: opened.id, k: 'A' }); // 3명 모두 → 바로 끝 (A 2 : B 1)
  const closed = (await g.next('vote', 3000, (m) => m.vote && m.vote.state === 'closed')).vote;
  assert.deepEqual(closed.result, { winner: 'A', tie: false, how: 'votes', top: 2 });
  assert.deepEqual(closed.counts, { A: 2, B: 1 });
  const sys = await g.next('system', 3000, (m) => m.text.includes('🗳️'));
  assert.match(sys.text, /A "왼쪽" 2표로 결정/);
  ok(`호스트가 열면 모두에게 (3명) · 한 사람 한 표, 바꾸기 · 취소 · 다른 투표 · 없는 칸은 무시 · 칸마다 수만 보냄 · 모두 투표하면 바로 끝 → "${sys.text}"`);

  // 2. 다음 라운드(월드컵): 라운드 +1 · 실시간 끄면 끝날 때까지 수 안 보임 · 시간이 되면 끝 · 동점 → 호스트 쪽
  host.send({ type: 'vote-open', next: true, title: '이상형 월드컵', opts: V.PRESETS.halves, sec: 5, live: false, endAll: false, series: true });
  const r2 = (await g.next('vote')).vote;
  assert.deepEqual([r2.round, r2.counts, r2.endAll], [2, null, false]);
  host.send({ type: 'vote-cast', id: r2.id, k: 'B' });
  g.send({ type: 'vote-cast', id: r2.id, k: 'A' });
  const t2 = await g2.next('vote-tally', 3000, (m) => m.id === r2.id);
  assert.equal(t2.counts, null);
  const started = Date.now();
  const c2 = (await g2.next('vote', 7000, (m) => m.vote && m.vote.id === r2.id && m.vote.state === 'closed')).vote;
  assert.ok(Date.now() - started > 3500, 'closed by timer');
  assert.deepEqual(c2.result, { winner: 'B', tie: true, how: 'host', top: 1 });
  ok('다음 라운드: 2라운드 · 실시간 결과를 끄면 투표 중에는 수를 안 보냄 · 5초가 되면 끝 · 1:1 동점 → 호스트가 고른 B');

  // 3. 투표 중 들어온 사람: 처음 받는 방 정보에 투표가 있음 · 인원 갱신 · 나가면 표도 빠짐 · 호스트가 닫기
  host.send({ type: 'vote-open', opts: V.PRESETS.quad, sec: 0, endAll: true });
  const r3 = (await g.next('vote', 3000, (m) => m.vote && m.vote.state === 'open')).vote;
  assert.equal(r3.round, 1);
  g2.send({ type: 'vote-cast', id: r3.id, k: 'D' });
  await g.next('vote-tally', 3000, (m) => m.id === r3.id && m.voted === 1);
  const late = client(server.port);
  await late.opened;
  await late.join('늦게 온 사람', code, secret);
  const w = await late.next('welcome');
  assert.deepEqual([w.room.vote.id, w.room.vote.state, w.room.vote.voted], [r3.id, 'open', 1]);
  assert.equal((await g.next('vote-tally', 3000, (m) => m.id === r3.id && m.total === 4)).voted, 1);
  g2.ws.close();
  const t3 = await g.next('vote-tally', 3000, (m) => m.id === r3.id && m.total === 3);
  assert.deepEqual([t3.voted, t3.counts.D], [0, 0]);
  host.send({ type: 'vote-cancel' });
  const cancelled = await g.next('vote', 3000, (m) => m.vote === null);
  assert.equal(cancelled.vote, null);
  ok('투표 중에 들어온 사람도 바로 봄 · 인원 4명으로 · 나간 사람 표는 빠짐 · 호스트가 닫으면 모두에게서 사라짐');

  // 4. 호스트가 나가면 투표 취소
  host.send({ type: 'vote-open', opts: V.PRESETS.halves, sec: 30 });
  await g.next('vote', 3000, (m) => m.vote && m.vote.state === 'open');
  host.ws.close();
  assert.equal((await g.next('vote', 3000, (m) => m.vote === null)).vote, null);
  ok('투표를 연 호스트가 나가면 투표도 취소');

  for (const c of [g, late]) c.ws.close();
  await server.close();
  console.log(`\n클릭 투표 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
