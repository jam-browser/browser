'use strict';
// 세부 설정 · 보안 추가 테스트: node test/settings-test.js
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const P = require('../shared/prefs');
const SITE = require('../shared/site');
const { createJamServer, cleanLimits, DEFAULT_LIMITS } = require('../server/jam-server');
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
    async next(type, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await sleep(20);
      }
      throw new Error(`timeout ${type}`);
    },
  };
}

(async () => {
  let n = 0;
  const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');

  // ---------- 설정 목록 ----------
  const d = P.clean({});
  assert.equal(d.mirrorSessionMbps, 0, '세션 영상 한도 기본 없음');
  assert.equal(d.maxMembers, 64);
  assert.equal(d.remoteBlockSensitive, true, '보안은 기본 켬');
  assert.equal(d.pauseOnSecret, true);
  assert.equal(d.httpsFirst, true);
  const c = P.clean({ maxMembers: 9999, mirrorMaxFps: '120', httpsFirst: 'yes', fileMaxMB: -5, jamNavSensitive: false, junk: 1 });
  assert.equal(c.maxMembers, 64, '범위 밖 → 끝값');
  assert.equal(c.mirrorMaxFps, '60', '없는 선택지 → 기본값');
  assert.equal(c.httpsFirst, true, '형식이 틀리면 기본값');
  assert.equal(c.fileMaxMB, 1);
  assert.equal(c.jamNavSensitive, true, '잠긴 항목은 못 끔');
  assert.ok(!('junk' in c));
  for (const s of P.SCHEMA) {
    assert.ok(P.PAGES.some((pg) => pg.id === s.page), `page ${s.key}`);
    assert.ok(s.label, `label ${s.key}`);
  }
  ok(`설정 ${P.SCHEMA.length}개: 양 한도는 넉넉한 기본값(세션 영상 한도 없음 · 64명 · 파일 2GB), 보안은 기본 켬, 범위 · 형식 검사, 잠긴 항목`);

  const L = P.serverLimits({ maxMembers: 3, approvalSec: 30, mirrorSessionMbps: 100, fileMaxMB: 10, fileSpeed: 'max' });
  assert.deepEqual([L.maxMembers, L.approvalMs, L.mirrorRate, L.fileMax, L.filePerTick], [3, 30000, 12.5e6, 10 * 1024 * 1024, 16]);
  assert.equal(cleanLimits({ maxMembers: 1000 }).maxMembers, 64);
  assert.equal(DEFAULT_LIMITS.mirrorRate, 0);
  ok('설정 → 호스트 Jam 서버 한도 변환 (초 → ms, Mbps → 초당 바이트, MB → 바이트) · 서버도 범위를 다시 검사');

  // ---------- 서버가 설정대로 (실행 중 변경 포함) ----------
  const server = await createJamServer({ port: 0, localCreateOnly: true, limits: { maxMembers: 2 } });
  const secret = newSecret();
  const host = client(server.port);
  await host.opened;
  await host.create('호스트', secret, { access: 'open' });
  const code = (await host.next('welcome')).room.code;
  const g1 = client(server.port);
  await g1.opened;
  await g1.join('g1', code, secret);
  await g1.next('welcome');
  const g2 = client(server.port);
  await g2.opened;
  await g2.join('g2', code, secret);
  assert.equal((await g2.next('error')).code, 'full');
  server.setLimits({ maxMembers: 3 });
  assert.equal(server.limits().maxMembers, 3);
  const g3 = client(server.port);
  await g3.opened;
  await g3.join('g3', code, secret);
  await g3.next('welcome');
  ok('최대 인원 설정이 바로 적용됨 (2명이면 거절 → 실행 중 3명으로 바꾸면 들어옴)');
  for (const x of [host, g1, g2, g3]) x.ws.close();
  await server.close();

  // ---------- HTTPS 우선 ----------
  assert.equal(SITE.httpsUpgrade('http://example.com/a?b=1'), 'https://example.com/a?b=1');
  for (const u of ['http://localhost:8766/', 'http://192.168.0.22/', 'http://10.0.0.5/x', 'http://intranet/', 'http://nas.local/', 'http://x.com:8080/', 'https://a.com/', 'ftp://a.com/']) {
    assert.equal(SITE.httpsUpgrade(u), null, u);
  }
  ok('HTTPS 우선: 인터넷 http 주소만 https 로, 같은 네트워크 · localhost · 포트 지정 · 한 단어 주소는 그대로');

  // ---------- 비슷한 가짜 주소 ----------
  const saved = ['naver.com', 'google.com', 'github.com', 'shinhan.com'];
  for (const h of ['navver.com', 'naver.co', 'n4ver.com', 'nаver.com', 'gооgle.com', 'naver.com.login-check.io', 'login.naver.com-secure.net', 'g00gle.com', 'githab.com', 'shlnhan.com']) {
    assert.ok(SITE.lookalikeOf(h, saved), h);
  }
  for (const h of ['naver.com', 'www.naver.com', 'nid.naver.com', 'accounts.google.com', 'youtube.com', 'example.com', 'naverblog.com', 'gitlab.com']) {
    assert.equal(SITE.lookalikeOf(h, saved), null, h);
  }
  ok('비슷한 가짜 주소: 한 글자 차이 · 다른 끝(.co) · 숫자/키릴 글자 바꿔치기 · 진짜 이름을 앞에 붙인 주소는 경고, 진짜 사이트 · 하위 도메인 · 무관한 사이트는 통과');

  console.log(`\n세부 설정 · 보안 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
