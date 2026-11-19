'use strict';
// 다른 기기에서 이어 보기 테스트: node test/presence-test.js
//  계정 키 → ID · 암호 키, 암호문, 중계 터널이 맡기기 · 다시 붙으면 다시 보내기 · 지우기
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const ID = require('../shared/identity');
const PRES = require('../shared/presence');
const { startRelayTunnel } = require('../server/relay-tunnel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let n = 0;
  const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');
  const me = ID.newIdentity();
  const a = PRES.derive(me.priv);
  const b = PRES.derive(me.priv);
  const other = PRES.derive(ID.newIdentity().priv);
  assert.equal(a.id, b.id);
  assert.ok(a.key.equals(b.key));
  assert.match(a.id, PRES.ID_RE);
  assert.notEqual(a.id, other.id);
  assert.notEqual(a.id, PRES.derive(me.pub)?.id); // 공개 키로는 같은 값이 안 나옴
  ok('같은 계정(같은 개인 키)이면 어느 기기에서나 같은 ID · 키, 다른 계정 · 공개 키로는 다름');

  const info = { v: 1, link: 'jamrs://relay.example:3031/abcdefghij/K7Q2M/secret_secret', title: '같이 보기', device: 'DESKTOP', at: 1 };
  const blob = PRES.seal(a.key, info);
  assert.ok(blob.length < PRES.MAX_BLOB);
  assert.ok(!blob.includes('relay.example') && !Buffer.from(blob, 'base64url').toString('latin1').includes('K7Q2M'));
  assert.deepEqual(PRES.open(b.key, blob), info);
  assert.equal(PRES.open(other.key, blob), null);
  const flipped = Buffer.from(blob, 'base64url');
  flipped[20] ^= 1;
  assert.equal(PRES.open(a.key, flipped.toString('base64url')), null);
  ok('암호문에는 링크 · 이름이 안 보이고, 같은 계정만 풀 수 있음 (바뀌면 거부)');

  assert.equal(PRES.lookupUrl('wss://relay.example:3031', a.id), `https://relay.example:3031/presence/${a.id}`);
  assert.equal(PRES.lookupUrl('ws://10.0.0.2:3031', a.id), `http://10.0.0.2:3031/presence/${a.id}`);
  assert.equal(PRES.lookupUrl('wss://relay.example/x', a.id), null);
  assert.equal(PRES.lookupUrl('ws://relay', 'bad id'), null);
  ok('찾는 주소: ws → http, wss → https (경로 붙은 주소 · 잘못된 ID 는 거절)');

  // 가짜 중계 서버: 경로를 주고, 제어 연결로 온 메시지를 기록
  const wss = new WebSocketServer({ port: 0 });
  const got = [];
  let hostWs = null;
  wss.on('connection', (ws, req) => {
    if (!req.url.startsWith('/host')) return ws.close();
    hostWs = ws;
    ws.send(JSON.stringify({ type: 'route', route: 'r1', token: 't1' }));
    ws.on('message', (raw) => got.push(JSON.parse(raw)));
  });
  const port = wss.address().port;
  const tunnel = await startRelayTunnel({ relayUrl: `ws://127.0.0.1:${port}`, localPort: 1, relayKey: 'k' });
  tunnel.setPresence({ id: a.id, blob });
  await sleep(100);
  assert.deepEqual(got.at(-1), { type: 'presence', id: a.id, blob });
  ok('호스트 터널이 제어 연결로 { ID, 암호문 } 을 맡김');

  got.length = 0;
  hostWs.close(); // 잠깐 끊김 → 터널이 다시 붙음
  for (let i = 0; i < 40 && !got.length; i++) await sleep(100);
  assert.deepEqual(got.at(-1), { type: 'presence', id: a.id, blob });
  ok('중계 서버와 잠깐 끊겼다 다시 붙으면 다시 맡김');

  tunnel.setPresence(null);
  await sleep(100);
  assert.deepEqual(got.at(-1), { type: 'presence', id: null, blob: null });
  got.length = 0;
  tunnel.setPresence(null); // 이미 없으면 보내지 않음
  await sleep(50);
  assert.equal(got.length, 0);
  ok('Jam 을 끝내면 지움');

  tunnel.close();
  wss.close();
  console.log(`\n다른 기기에서 이어 보기 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
