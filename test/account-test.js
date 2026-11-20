'use strict';
// 서버 계정(아이디 · 비밀번호) + 동기화 테스트: node test/account-test.js
//  - 기기 두 대(src/vault.js 를 그대로, Electron 은 흉내)와 계약대로 동작하는 작은 가짜 중계 서버
//  - 서버로 가는 값에 비밀번호 · 사이트 비밀번호 · 이름이 평문으로 없는지
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const V = require('../src/vault-crypto');
const { mergeDocs } = require('../shared/vault-merge');
const { setupVault } = require('../src/vault');
const API = require('../src/account-api');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 가짜 중계 서버 (jam-browser/backend 의 /account/* 계약) ----------
function fakeRelay({ signup = 'invite', invites = ['JINV-TEST-0001'] } = {}) {
  const accounts = new Map(); // id → { verifier, vault, rev }
  const tokens = new Map(); // token → id
  const seen = []; // 서버가 받은 원문 (평문 유출 검사)
  const inv = new Set(invites);
  const hash = (auth, salt) => crypto.scryptSync(Buffer.from(auth, 'base64'), salt, 32, { N: 16384, r: 8, p: 1 });
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(body);
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      const j = body ? JSON.parse(body) : {};
      const u = new URL(req.url, 'http://x');
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      const me = tokens.get(tok);
      const verify = (a, auth) => a && crypto.timingSafeEqual(hash(auth, Buffer.from(a.verifier.salt, 'base64')), Buffer.from(a.verifier.hash, 'base64'));
      const newToken = (id) => {
        const t = crypto.randomBytes(32).toString('base64url');
        tokens.set(t, id);
        return t;
      };
      const mkVerifier = (auth) => {
        const salt = crypto.randomBytes(16);
        return { salt: salt.toString('base64'), hash: hash(auth, salt).toString('base64') };
      };
      switch (`${req.method} ${u.pathname}`) {
        case 'POST /account/prelogin': {
          const a = accounts.get(j.id);
          return send(200, { kdf: a ? a.vault.kdf : { alg: 'scrypt', N: 131072, r: 8, p: 1, salt: crypto.createHash('sha256').update('fake' + j.id).digest('base64') } });
        }
        case 'POST /account/register': {
          if (signup === 'closed') return send(403, { error: 'signup-closed' });
          if (signup === 'invite' && !inv.delete(j.invite)) return send(403, { error: 'bad-invite' });
          if (accounts.has(j.id)) return send(409, { error: 'id-taken' });
          accounts.set(j.id, { verifier: mkVerifier(j.auth), vault: j.vault, rev: 1 });
          return send(201, { token: newToken(j.id), rev: 1 });
        }
        case 'POST /account/login': {
          const a = accounts.get(j.id);
          if (!verify(a, j.auth)) return send(401, { error: 'bad-login' });
          return send(200, { token: newToken(j.id), rev: a.rev, vault: a.vault });
        }
        case 'GET /account/vault': {
          if (!me) return send(401, { error: 'bad-token' });
          const a = accounts.get(me);
          if (u.searchParams.get('rev') === String(a.rev)) return send(304);
          return send(200, { rev: a.rev, vault: a.vault });
        }
        case 'PUT /account/vault': {
          if (!me) return send(401, { error: 'bad-token' });
          const a = accounts.get(me);
          if (j.baseRev !== a.rev) return send(409, { error: 'conflict', rev: a.rev, vault: a.vault });
          a.vault = j.vault;
          a.rev++;
          return send(200, { rev: a.rev });
        }
        case 'POST /account/password': {
          if (!me) return send(401, { error: 'bad-token' });
          const a = accounts.get(me);
          if (!verify(a, j.auth)) return send(401, { error: 'bad-login' });
          if (j.baseRev !== a.rev) return send(409, { error: 'conflict', rev: a.rev, vault: a.vault });
          a.verifier = mkVerifier(j.newAuth);
          a.vault = j.vault;
          a.rev++;
          for (const [t, id] of tokens) if (id === me && t !== tok) tokens.delete(t);
          return send(200, { rev: a.rev });
        }
        case 'POST /account/logout':
          tokens.delete(tok);
          return send(200, {});
        case 'POST /account/delete': {
          if (!me) return send(401, { error: 'bad-token' });
          if (!verify(accounts.get(me), j.auth)) return send(401, { error: 'bad-login' });
          accounts.delete(me);
          return send(200, {});
        }
        default:
          return send(404, { error: 'nope' });
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, accounts, tokens, seen, addr: `127.0.0.1:${srv.address().port}` })));
}

// ---------- 기기 (src/vault.js 그대로, Electron 흉내) ----------
function device(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jam-acct-${name}-`));
  const handlers = new Map();
  const events = [];
  const win = { isDestroyed: () => false, isFocused: () => false, webContents: { send: (ch, d) => events.push([ch, d]) } };
  setupVault({
    app: { getPath: () => dir },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} },
    // Windows 계정 암호화(DPAPI) 흉내 — 실제 앱처럼 이 PC 계정의 비밀 키를 저장할 수 있게
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() },
    clipboard: { writeText() {}, readText: () => '', clear() {} },
    dialog: { showMessageBox: async () => ({ response: 0, checkboxChecked: true }) },
    powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    getWindow: () => win,
  });
  const call = async (ch, arg) => handlers.get(ch)({ sender: win.webContents }, arg);
  return { dir, call, events, name };
}

(async () => {
  let n = 0;
  const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');
  const PW = 'Correct-Horse-Battery-77';

  // ---- 금고 암호화: 서버 계정 방식 ----
  const doc = { profile: { name: 'x' }, logins: [], friends: [], settings: {} };
  const c = await V.createAccountVault({ id: 'Alice', password: PW, doc });
  const u = await V.unlockAccountVault(c.file, PW, 'alice');
  assert.deepEqual(u.session.doc, doc);
  assert.ok(u.auth.equals(c.auth));
  assert.ok(u.auth.equals(await V.accountAuth(PW, c.file.kdf, 'alice')));
  await assert.rejects(V.unlockAccountVault(c.file, PW + 'x', 'alice'), /맞지 않아요/);
  await assert.rejects(V.unlockAccountVault(c.file, PW, 'bob'), /맞지 않아요/);
  assert.ok(!c.auth.equals(Buffer.from(V._internal.accountSecret('alice'))));
  ok('아이디 + 비밀번호로만 열림 (아이디 · 비밀번호가 다르면 못 엶), 로그인 확인 값(auth)은 같은 계산으로 다시 나옴');

  // ---- 합치기 ----
  const a0 = { profile: { name: 'A', updatedAt: 1 }, logins: [{ id: '1', updatedAt: 5, title: 'a' }, { id: '2', updatedAt: 5 }], friends: [], tomb: {}, sync: { bookmarks: { v: [1], at: 10 } } };
  const b0 = { profile: { name: 'B', updatedAt: 2 }, logins: [{ id: '1', updatedAt: 9, title: 'b' }], friends: [{ fp: 'F', addedAt: 3 }], tomb: { 'l:2': 7 }, sync: { bookmarks: { v: [2], at: 5 } } };
  const m = mergeDocs(a0, b0, 100);
  assert.equal(m.doc.profile.name, 'B');
  assert.deepEqual(m.doc.logins.map((l) => [l.id, l.title]), [['1', 'b']]);
  assert.deepEqual(m.doc.friends.map((f) => f.fp), ['F']);
  assert.deepEqual(m.doc.sync.bookmarks.v, [1]);
  assert.ok(m.localChanged && m.remoteBehind);
  assert.deepEqual(mergeDocs(m.doc, m.doc, 100), { doc: m.doc, localChanged: false, remoteBehind: false });
  ok('합치기: 항목마다 나중에 바뀐 쪽, 지운 기록(tomb)이 더 나중이면 지움, 동기화 묶음은 시각 기준');

  // ---- 주소 ----
  assert.equal(API.serverBase('relay.example.com'), 'http://relay.example.com:3031');
  assert.equal(API.serverBase('wss://relay.example.com'), 'https://relay.example.com');
  assert.equal(API.serverBase('ws://10.0.0.2:3031/'), 'http://10.0.0.2:3031');
  assert.equal(API.serverBase('bad host/x'), null);
  assert.equal(API.insecureInternet('http://192.168.0.5:3031'), false);
  assert.equal(API.insecureInternet('http://relay.example.com:3031'), true);
  assert.equal(API.insecureInternet('https://relay.example.com'), false);
  ok('중계 서버 주소 → 계정 API 주소 (ws → http, wss → https), 인터넷 주소를 http 로 쓰면 경고');

  // ---- 기기 두 대 + 가짜 중계 서버 ----
  const relay = await fakeRelay();
  const A = device('a');
  const B = device('b');
  await assert.rejects(A.call('vault:server-create', { server: relay.addr, id: 'alice', name: '앨리스', password: PW, invite: 'WRONG' }), /초대 코드/);
  const ca = await A.call('vault:server-create', { server: relay.addr, id: 'Alice', name: '앨리스', password: PW, invite: 'JINV-TEST-0001' });
  assert.equal(ca.ok, true);
  assert.equal((await A.call('vault:status')).account.id, 'alice');
  assert.equal(relay.accounts.get('alice').rev, 1);
  ok('새 서버 계정: 초대 코드가 틀리면 거절, 맞으면 서버에 암호화된 금고 · 이 기기는 바로 열림');

  await A.call('vault:login-save', { origin: 'https://site.example', username: 'alice@x', password: 'Site-Secret-123!' });
  const IDN = require('../shared/identity');
  await A.call('friends:add', { code: IDN.friendCode(IDN.newIdentity().pub, '밥') });
  await sleep(2500);
  assert.equal(relay.accounts.get('alice').rev, 2);
  ok('로그인 저장 · 친구 추가 → 잠시 뒤 서버로 올라감');

  await assert.rejects(B.call('vault:server-login', { server: relay.addr, id: 'alice', password: 'Wrong-Password-1' }), /아이디나 비밀번호/);
  const lb = await B.call('vault:server-login', { server: relay.addr, id: 'ALICE', password: PW });
  assert.equal(lb.ok, true);
  assert.equal(lb.name, '앨리스');
  const bl = await B.call('vault:logins');
  assert.deepEqual(bl.map((l) => l.username), ['alice@x']);
  assert.equal((await B.call('friends:list')).length, 1);
  ok('다른 기기: 틀린 비밀번호는 거절, 맞으면 아이디 · 비밀번호만으로 로그인 → 비밀번호 뱅크 · 친구가 그대로');

  // 두 기기에서 동시에 바꿈 → 충돌 → 합침
  const loginB = bl[0].id;
  await B.call('vault:login-delete', { id: loginB });
  await A.call('vault:login-save', { origin: 'https://other.example', username: 'a2', password: 'Other-Secret-456!' });
  await sleep(2500);
  await A.call('vault:sync-now');
  await B.call('vault:sync-now');
  await A.call('vault:sync-now');
  const la = (await A.call('vault:logins')).map((l) => l.origin).sort();
  const lb2 = (await B.call('vault:logins')).map((l) => l.origin).sort();
  assert.deepEqual(la, ['https://other.example']);
  assert.deepEqual(lb2, ['https://other.example']);
  ok('두 기기에서 동시에 바꿔도(한쪽은 지우고 한쪽은 추가) 서버에서 합쳐져 두 기기가 같아짐 (지운 것은 되살아나지 않음)');

  // 북마크 같은 앱 데이터도 계정 문서로
  await A.call('vault:sync-put', { key: 'bookmarks', value: [{ url: 'https://news.example', title: '뉴스' }] });
  await sleep(2500);
  await B.call('vault:sync-now');
  assert.deepEqual((await B.call('vault:sync-get')).bookmarks.v, [{ url: 'https://news.example', title: '뉴스' }]);
  assert.ok(B.events.some(([ch]) => ch === 'vault:changed'));
  ok('북마크 · 설정 같은 앱 데이터도 계정 문서(암호화)로 다른 기기에 전달, 앱 화면에 알림');

  // 서버가 받은 것에 평문이 없는지
  const all = relay.seen.join('\n');
  for (const secret of [PW, 'Site-Secret-123!', 'Other-Secret-456!', '앨리스', 'alice@x', 'news.example']) assert.ok(!all.includes(secret), `server saw ${secret}`);
  ok('서버가 받은 모든 요청에 계정 비밀번호 · 사이트 비밀번호 · 이름 · 아이디(사이트) · 북마크가 평문으로 없음');

  // 비밀번호 바꾸기 (A) → B 는 옛 비밀번호로 못 열고 새 비밀번호로 열림
  assert.equal((await A.call('vault:change-password', { oldPassword: PW, newPassword: 'New-Password-2026!' })).ok, true);
  await B.call('vault:lock');
  const bad = await B.call('vault:unlock', { password: PW });
  assert.equal(bad.ok, true); // 이 PC 의 옛 사본은 옛 비밀번호로 열림 (오프라인)
  await sleep(500);
  await B.call('vault:sync-now').catch(() => null);
  assert.equal((await B.call('vault:status')).sync.state, 'relogin');
  await B.call('vault:lock');
  const good = await B.call('vault:unlock', { password: 'New-Password-2026!' });
  assert.equal(good.ok, true);
  await sleep(500);
  await B.call('vault:sync-now');
  assert.equal((await B.call('vault:status')).sync.state, 'ok');
  await B.call('vault:lock');
  assert.equal((await B.call('vault:unlock', { password: 'New-Password-2026!' })).ok, true); // 이제 이 PC 사본도 새 비밀번호
  ok('한 기기에서 비밀번호를 바꾸면 다른 기기는 "다시 로그인 필요" → 새 비밀번호로 열면 서버에서 새 금고를 받아 이어짐');

  // 이 PC 계정 → 서버 계정으로 올리기
  const C = device('c');
  await C.call('vault:create', { name: '캐럴', password: 'Local-Only-Pass-9' });
  await C.call('vault:login-save', { origin: 'https://bank.example', username: 'carol', password: 'Bank-Pass-000!' });
  assert.equal((await C.call('vault:server-upload', { server: relay.addr, id: 'carol', password: 'nope', invite: '' })).ok, false);
  relay.srv.close();
  const relay2 = await fakeRelay({ signup: 'open' });
  const up = await C.call('vault:server-upload', { server: relay2.addr, id: 'carol', password: 'Local-Only-Pass-9', invite: '' });
  assert.equal(up.ok, true);
  const D = device('d');
  await D.call('vault:server-login', { server: relay2.addr, id: 'carol', password: 'Local-Only-Pass-9' });
  assert.deepEqual((await D.call('vault:logins')).map((l) => l.username), ['carol']);
  await C.call('vault:lock');
  assert.equal((await C.call('vault:unlock', { password: 'Local-Only-Pass-9' })).ok, true); // 비밀 키 없이
  ok('이 PC 계정을 서버 계정으로 올리기 (계정 비밀번호 확인) → 다른 기기에서 로그인 · 이 PC 는 비밀 키 없이 열림');

  // 계정 지우기 (서버에서도)
  assert.equal(await D.call('vault:delete-account'), true);
  assert.equal(relay2.accounts.has('carol'), false);
  await assert.rejects(device('e').call('vault:server-login', { server: relay2.addr, id: 'carol', password: 'Local-Only-Pass-9' }), /아이디나 비밀번호/);
  ok('계정 삭제에서 "서버에서도 지우기" → 서버 계정도 사라짐');

  // 서버를 모르는 옛 중계 서버
  const old = http.createServer((q, r) => r.end('Jam relay\n'));
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  await assert.rejects(device('f').call('vault:server-login', { server: `127.0.0.1:${old.address().port}`, id: 'olduser', password: PW }), /1\.1\.0/);
  old.close();
  ok('브라우저 계정을 모르는 옛 중계 서버면 "1.1.0 부터" 안내');

  for (const d of [A, B, C, D]) await d.call('vault:lock');
  relay2.srv.close();
  console.log(`\n서버 계정 · 동기화 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
