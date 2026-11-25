// 친구 상태: Ed25519 → X25519 변환 · 둘만 아는 키 · 방향 · 시간대 ID · 암호문 · 바꿔 보여 줄 사이트 고르기
const assert = require('assert');
const crypto = require('crypto');
const ID = require('../shared/identity');
const FS = require('../shared/friend-status');
const Decoy = require('../shared/decoy');

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log('  ✓', name);
};

const a = ID.newIdentity();
const b = ID.newIdentity();
const c = ID.newIdentity();

t('Ed25519 → X25519: 바꾼 개인 키의 공개 키 = 바꾼 공개 키 (100쌍)', () => {
  for (let i = 0; i < 100; i++) {
    const k = ID.newIdentity();
    const xpriv = FS.edPrivToX(k.priv);
    const fromPriv = crypto.createPublicKey(xpriv).export({ type: 'spki', format: 'der' }).subarray(FS.X_SPKI.length);
    assert.deepStrictEqual(fromPriv, FS.edPubToX(k.pub));
  }
});

t('둘만 아는 비밀: A·B 양쪽이 같은 값, C 와는 다른 값, 이상한 공개 키는 null', () => {
  const ab = FS.pairSecret(a.priv, b.pub);
  const ba = FS.pairSecret(b.priv, a.pub);
  assert.ok(ab && ab.length === 32);
  assert.deepStrictEqual(ab, ba);
  assert.notDeepStrictEqual(ab, FS.pairSecret(a.priv, c.pub));
  assert.strictEqual(FS.pairSecret(a.priv, 'xx'), null);
  assert.strictEqual(FS.pairSecret(a.priv, Buffer.alloc(32, 0).toString('base64url')), null); // y=0 → 작은 위수
});

t('A→B 로 올린 것은 B 의 받는 곳과 맞고, 반대 방향 · 제3자 키로는 못 풂 · ID 는 1시간마다 바뀜', () => {
  const now = Date.UTC(2026, 10, 25, 10, 30);
  const ss = FS.pairSecret(a.priv, b.pub);
  const out = FS.outbox(ss, a.pub, b.pub, now);
  assert.match(out.id, FS.ID_RE);
  const inB = FS.inbox(FS.pairSecret(b.priv, a.pub), b.pub, a.pub, now);
  assert.ok(inB.ids.includes(out.id));
  // 시계가 40분 늦은 B 도 찾음 (앞뒤 시간대)
  assert.ok(FS.inbox(ss, b.pub, a.pub, now - 40 * 60e3).ids.includes(out.id));
  const blob = FS.seal(out.key, { st: 'online', site: 'YouTube.com', at: now });
  assert.deepStrictEqual(FS.open(inB.key, blob), { v: 1, at: now, st: 'online', site: 'youtube.com' });
  // B→A 방향 키 · C 키로는 안 풀림
  assert.strictEqual(FS.open(FS.outbox(ss, b.pub, a.pub, now).key, blob), null);
  const ac = FS.pairSecret(a.priv, c.pub);
  assert.strictEqual(FS.open(FS.inbox(ac, c.pub, a.pub, now).key, blob), null);
  assert.notStrictEqual(FS.outbox(ss, a.pub, b.pub, now + FS.EPOCH_MS).id, out.id);
});

t('올리는 내용은 정해진 모양만: 이상한 사이트 값 · 다른 필드는 빠짐', () => {
  const key = crypto.randomBytes(32);
  const o = FS.open(key, FS.seal(key, { st: 'weird', site: 'https://x.com/a?b', jam: 1, secret: 'pw', at: 5 }));
  assert.deepStrictEqual(o, { v: 1, at: 5, st: 'online' });
  assert.strictEqual(FS.open(key, 'garbage'), null);
  assert.strictEqual(FS.endpoint('wss://relay.example:443', 'put'), 'https://relay.example:443/friends/put');
  assert.strictEqual(FS.endpoint('ws://1.2.3.4:3031', 'get'), 'http://1.2.3.4:3031/friends/get');
  assert.strictEqual(FS.endpoint('http://x', 'get'), null);
});

// ---------- 바꿔 보여 줄 사이트 ----------
t('이상한 사이트 감지: 성인 · 도박 · 토렌트 키워드와 목록, 평범한 사이트는 통과', () => {
  for (const h of ['pornhub.com', 'www.xvideos.com', 'm.xhamster.com', 'onlyfans.com', 'some-casino.net', 'bet365.com', 'sportstoto.co.kr', 'hitomi.la', 'torrentqq123.com', 'adult-cams.tv', 'nhentai.net', 'chaturbate.com'])
    assert.ok(Decoy.isEmbarrassing(h), h);
  for (const h of ['youtube.com', 'naver.com', 'namu.wiki', 'github.com', 'essex.ac.uk', 'middlesex.gov.uk', 'sussex.ac.uk', 'betterment.com', 'alphabet.com', 'slotkin.house.gov'])
    assert.ok(!Decoy.isEmbarrassing(h), h);
});

t('자주 가는 사이트: 30일 안 · 2번 이상 · 이상한/숨긴/로그인 사이트 빼고 횟수 순', () => {
  const now = Date.UTC(2026, 10, 25);
  const H = (url, d = 0) => ({ url, at: now - d * 86400e3 });
  const hist = [
    H('https://www.youtube.com/watch?v=1'), H('https://m.youtube.com/'), H('https://youtube.com/x'),
    H('https://namu.wiki/w/a'), H('https://namu.wiki/w/b'),
    H('https://pornhub.com/1'), H('https://pornhub.com/2'), H('https://pornhub.com/3'), H('https://pornhub.com/4'),
    H('https://secret.example/a'), H('https://secret.example/b'),
    H('https://old.example/a', 40), H('https://old.example/b', 41),
    H('https://once.example/'),
    H('http://192.168.0.1/a'), H('http://192.168.0.1/b'),
  ];
  const top = Decoy.frequentSites(hist, { now, hidden: new Set(['secret.example']) });
  assert.deepStrictEqual(top.map((x) => x.site), ['youtube.com', 'namu.wiki']);
});

t('보여 줄 사이트: 평범하면 그대로 · 이상하면 방금 보던 사이트 → 시간이 지나면 다른 자주 가는 사이트 · 안 바뀌고 유지', () => {
  let now = Date.UTC(2026, 10, 25, 12);
  const rand = (() => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const st = Decoy.createState();
  const opts = (o = {}) => ({ now, rand, frequent: [{ site: 'youtube.com', n: 9 }, { site: 'namu.wiki', n: 5 }, { site: 'naver.com', n: 3 }], hidden: new Set(['diary.example']), ...o });
  assert.deepStrictEqual(Decoy.shownSite(st, 'https://www.naver.com/news', opts()), { site: 'naver.com', decoy: false });
  now += 60e3;
  const d1 = Decoy.shownSite(st, 'https://www.pornhub.com/view', opts());
  assert.deepStrictEqual(d1, { site: 'naver.com', decoy: true }); // 방금 보던 사이트를 계속 보는 것처럼
  now += 5 * 60e3;
  assert.strictEqual(Decoy.shownSite(st, 'https://diary.example/me', opts()).site, 'naver.com'); // 숨긴 사이트도 같은 대신 사이트 유지
  now += 40 * 60e3; // 오래 지나면 다른 자주 가는 사이트로 (같은 사이트에 몇 시간씩 있으면 어색하니까)
  const d2 = Decoy.shownSite(st, 'https://www.pornhub.com/2', opts());
  assert.ok(d2.decoy && d2.site !== 'naver.com' && ['youtube.com', 'namu.wiki'].includes(d2.site), JSON.stringify(d2));
  now += 60e3;
  assert.deepStrictEqual(Decoy.shownSite(st, 'https://github.com/x', opts()), { site: 'github.com', decoy: false });
  // 로그인 페이지 · 내 PC · 같은 네트워크 · 시작 페이지
  assert.strictEqual(Decoy.shownSite(st, 'https://accounts.google.com/signin', opts()).site, 'github.com');
  assert.strictEqual(Decoy.shownSite(st, 'http://192.168.0.1/admin', opts()).site, 'github.com');
  assert.deepStrictEqual(Decoy.shownSite(Decoy.createState(), 'about:blank', opts()), { site: null, decoy: false });
  // 바꿔 보여 주기를 끄면 이상한 사이트는 사이트 없이 (온라인만)
  assert.deepStrictEqual(Decoy.shownSite(Decoy.createState(), 'https://pornhub.com/', opts({ mode: 'hide' })), { site: null, decoy: true });
  // 보던 사이트를 그 자리에서 숨기면: 그 사이트가 아니라 다른 자주 가는 사이트
  const s2 = Decoy.createState();
  Decoy.shownSite(s2, 'https://diary.example/', opts({ hidden: new Set() }));
  const d4 = Decoy.shownSite(s2, 'https://diary.example/', opts());
  assert.ok(d4.decoy && d4.site !== 'diary.example', JSON.stringify(d4));
  // 처음부터 이상한 사이트 · 기록 없음 → 기본 목록에서
  const d3 = Decoy.shownSite(Decoy.createState(), 'https://pornhub.com/', opts({ frequent: [] }));
  assert.ok(d3.decoy && Decoy.FALLBACK.includes(d3.site), JSON.stringify(d3));
});

// ---------- 메인 프로세스 모듈 (src/friend-status.js) + 중계 서버 흉내 ----------
const http = require('http');
const { setupFriendStatus } = require('../src/friend-status');

function fakeBoard({ old = false } = {}) {
  const board = new Map();
  const seen = []; // 서버가 받은 요청 본문 (평문이 없는지 확인용)
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push(raw);
      if (old) return res.end('Jam relay\n');
      const body = JSON.parse(raw || '{}');
      const json = (o) => res.end(JSON.stringify(o));
      if (req.url === '/friends/put') {
        for (const id of body.drop || []) board.delete(id);
        for (const x of body.items || []) board.set(x.id, x.blob);
        return json({ ok: true });
      }
      if (req.url === '/friends/get') {
        const found = {};
        for (const id of body.ids) if (board.has(id)) found[id] = board.get(id);
        return json({ found });
      }
      res.statusCode = 404;
      json({ error: 'not-found' });
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `ws://127.0.0.1:${server.address().port}`, board, seen, close: () => server.close() })));
}

function fakeApp(identity, friendsOf, prefs = {}) {
  const handlers = new Map();
  const sender = {};
  const events = [];
  const doc = { friends: [] };
  const P = { friendStatus: 'site', friendShowJam: true, friendAwayMin: 10, ...prefs };
  let idle = 0;
  const vaultApi = {
    friendPairs: () =>
      identity && !app.locked
        ? { me: identity.pub, pairs: doc.friends.map((f) => ({ fp: f.fp, name: f.name, pub: f.pub, hide: !!f.hide, ss: FS.pairSecret(identity.priv, f.pub) })) }
        : null,
  };
  const api = setupFriendStatus({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    vaultApi,
    getPrefs: () => P,
    powerMonitor: { getSystemIdleTime: () => idle },
    fromApp: (e) => e.sender === sender,
    send: (ch, d) => events.push([ch, d]),
    fetch: globalThis.fetch,
  });
  const app = {
    locked: false,
    prefs: P,
    api,
    events,
    setIdle: (s) => (idle = s),
    add: (other, name) => doc.friends.push({ fp: ID.fingerprint(other.pub), pub: other.pub, name }),
    hide: (other, h) => (doc.friends.find((f) => f.pub === other.pub).hide = h),
    call: (ch, arg) => handlers.get(ch)({ sender }, arg),
    callAsWebpage: (ch, arg) => handlers.get(ch)({ sender: {} }, arg),
    friend: async (other) => {
      await api._tick();
      return api._snapshot().friends.find((f) => f.fp === ID.fingerprint(other.pub));
    },
  };
  return app;
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const at = async (name, fn) => {
  await fn();
  n++;
  console.log('  ✓', name);
};

(async () => {
  const relay = await fakeBoard();
  const A = fakeApp(a);
  const B = fakeApp(b);
  const C = fakeApp(c);
  A.add(b, '비');
  B.add(a, '에이');
  B.add(c, '씨'); // C 는 B 를 추가하지 않음 (한쪽만)
  C.add(a, '에이');
  for (const X of [A, B, C]) await X.call('fstatus:config', { relayUrls: [relay.url] });

  await at('서로 친구: A 가 보는 사이트 · Jam 중 → B 에게 온라인 + youtube.com + Jam, 중계 서버엔 평문 없음', async () => {
    await A.call('fstatus:set', { site: 'youtube.com', jam: true });
    await A.api._tick();
    const f = await B.friend(a);
    assert.deepStrictEqual({ online: f.online, st: f.st, site: f.site, jam: f.jam, name: f.name }, { online: true, st: 'online', site: 'youtube.com', jam: true, name: '에이' });
    assert.ok(f.lastSeen > 0);
    const all = relay.seen.join('\n');
    for (const plain of ['youtube', a.pub, b.pub, '에이', 'online']) assert.ok(!all.includes(plain), plain);
  });

  await at('한쪽만 추가: C 는 A 를 추가했지만 A 는 C 를 몰라서 C 에게는 오프라인 · B 는 C 를 추가했지만 C 는 안 올림', async () => {
    assert.strictEqual((await C.friend(a)).online, false);
    await C.call('fstatus:set', { site: 'naver.com' });
    await C.api._tick();
    assert.strictEqual((await B.friend(c)).online, false);
  });

  await at('자리 비움 · 온라인만 · Jam 숨김 설정이 그대로 반영', async () => {
    A.setIdle(11 * 60);
    A.prefs.friendStatus = 'online';
    await A.api._tick();
    let f = await B.friend(a);
    assert.deepStrictEqual([f.st, f.site, f.jam], ['away', null, false]);
    A.setIdle(0);
    A.prefs.friendStatus = 'site';
    A.prefs.friendShowJam = false;
    await A.api._tick();
    f = await B.friend(a);
    assert.deepStrictEqual([f.st, f.site, f.jam], ['online', 'youtube.com', false]);
  });

  await at('이 친구에게만 숨기기 → B 에게 바로 오프라인 (올려 둔 것을 지움) · 다시 보이기', async () => {
    const before = relay.board.size;
    A.hide(b, true);
    await A.api._tick();
    assert.ok(relay.board.size < before);
    assert.strictEqual((await B.friend(a)).online, false);
    A.hide(b, false);
    await A.api._tick();
    assert.strictEqual((await B.friend(a)).online, true);
  });

  await at('전체 숨기기 · 계정 잠금 · 앱 종료 → 오프라인', async () => {
    A.prefs.friendStatus = 'hidden';
    await A.api._tick();
    assert.strictEqual((await B.friend(a)).online, false);
    A.prefs.friendStatus = 'site';
    await A.api._tick();
    assert.strictEqual((await B.friend(a)).online, true);
    A.locked = true;
    await A.api._tick();
    assert.strictEqual((await B.friend(a)).online, false);
    A.locked = false;
    await A.api._tick();
    assert.strictEqual((await B.friend(a)).online, true);
    await A.api.goodbye();
    assert.strictEqual((await B.friend(a)).online, false);
  });

  await at('잘못된 사이트 값은 안 보냄 · 웹페이지 등 다른 곳에서 부르면 거절', async () => {
    const A2 = fakeApp(a);
    A2.add(b, '비');
    await A2.call('fstatus:config', { relayUrls: [relay.url, 'http://not-ws', 'ws://bad host'] });
    await A2.call('fstatus:set', { site: 'https://evil.example/path?q=secret' });
    await A2.api._tick();
    const f = await B.friend(a);
    assert.strictEqual(f.online, true);
    assert.strictEqual(f.site, null);
    assert.throws(() => A2.callAsWebpage('fstatus:set', { site: 'x.com' }), /forbidden/);
    A2.api.goodbye();
  });

  await at('예전 중계 서버(친구 상태 모름) → relays 에 old', async () => {
    const oldRelay = await fakeBoard({ old: true });
    const D = fakeApp(a);
    D.add(b, '비');
    await D.call('fstatus:config', { relayUrls: [oldRelay.url] });
    await D.api._tick();
    const s = await D.call('fstatus:get', {});
    assert.deepStrictEqual(s.relays, { [oldRelay.url]: 'old' });
    D.api.goodbye();
    oldRelay.close();
  });

  for (const X of [A, B, C]) X.api.goodbye();
  relay.close();
  console.log(`\n친구 상태 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
