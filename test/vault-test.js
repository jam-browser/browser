'use strict';
// 비밀번호 뱅크 암호화 · 신원 테스트: node test/vault-test.js
const assert = require('node:assert/strict');
const crypto = require('crypto');
const V = require('../src/vault-crypto');
const ID = require('../shared/identity');

const FAST = { alg: 'scrypt', N: 1 << 14, r: 8, p: 1 }; // 테스트 속도용 (실제 기본값은 2^17)

(async () => {
  let n = 0;
  const ok = (s) => {
    n++;
    console.log(`  ✓ ${s}`);
  };

  // 기본 설정(N=2^17) 그대로 한 번 만들고 여는 시간
  let t = Date.now();
  const real = await V.createVault({ password: 'correct horse battery', doc: { hello: 'world' } });
  const createMs = Date.now() - t;
  t = Date.now();
  const realOpen = await V.unlockVault(real.file, 'correct horse battery', real.secretKey);
  assert.equal(realOpen.doc.hello, 'world');
  ok(`기본 설정(scrypt N=2^17) 생성 ${createMs}ms · 열기 ${Date.now() - t}ms`);
  assert.equal(real.file.kdf.N, 1 << 17);
  assert.equal(Buffer.from(real.file.kdf.salt, 'base64').length, 32);

  const { file, secretKey, session } = await V.createVault({ password: 'master password 1', doc: { logins: [] }, kdf: FAST });
  const fileText = JSON.stringify(file);
  assert.ok(!fileText.includes('logins'), '파일에 평문 구조가 보이면 안 됨');
  ok('파일에는 평문이 없음 (salt · 설정 · 암호문만)');

  await assert.rejects(V.unlockVault(file, 'master password 2', secretKey), (e) => e.code === 'auth');
  await assert.rejects(V.unlockVault(file, 'master password 1', crypto.randomBytes(20)), (e) => e.code === 'auth');
  await assert.rejects(V.createVault({ password: 'short', doc: {} }), (e) => e.code === 'weak');
  ok('비밀번호가 틀리거나 비밀 키가 틀리면 못 엶 · 10자 미만 비밀번호 거절');

  // 같은 비밀번호라도 계정마다 salt · 비밀 키가 달라 결과가 완전히 다름
  const other = await V.createVault({ password: 'master password 1', doc: { logins: [] }, kdf: FAST });
  assert.notEqual(other.file.kdf.salt, file.kdf.salt);
  assert.notEqual(other.file.dek, file.dek);
  ok('같은 비밀번호라도 계정마다 개인 salt · 비밀 키가 달라 암호문이 다름');

  // 항목별 비밀번호 이중 암호화
  const pw = 'S3cret-site-pw!';
  const sealed = V.sealField(session, 'login-1', pw);
  assert.ok(!sealed.includes(pw));
  assert.equal(V.openField(session, 'login-1', sealed), pw);
  assert.throws(() => V.openField(session, 'login-2', sealed)); // 다른 항목 자리로 옮겨도 못 엶
  session.doc.logins.push({ id: 'login-1', origin: 'https://example.com', username: 'me', pw: sealed });
  const saved = V.saveVault(session, file);
  const reopened = await V.unlockVault(saved, 'master password 1', secretKey);
  assert.equal(V.openField(reopened, 'login-1', reopened.doc.logins[0].pw), pw);
  ok('사이트 비밀번호는 항목마다 따로 이중 암호화 · 다른 항목 자리로 옮기면 못 엶');

  // 이중 암호화: 한 겹 키만으로는 못 엶, 한 바이트만 바꿔도 못 엶
  const { seal2, open2 } = V._internal;
  const k = { aes: crypto.randomBytes(32), chacha: crypto.randomBytes(32) };
  const c = seal2(k, Buffer.from('data'), 'x');
  assert.equal(open2(k, c, 'x').toString(), 'data');
  assert.throws(() => open2({ aes: k.aes, chacha: crypto.randomBytes(32) }, c, 'x'));
  assert.throws(() => open2({ aes: crypto.randomBytes(32), chacha: k.chacha }, c, 'x'));
  const b = Buffer.from(c, 'base64');
  b[b.length - 1] ^= 1;
  assert.throws(() => open2(k, b.toString('base64'), 'x'));
  assert.throws(() => open2(k, c, 'y'));
  ok('AES-256-GCM 안쪽 + ChaCha20/HMAC-SHA256 바깥: 한쪽 키만으로는 못 엶 · 한 바이트 변조 · 용도 바꾸기 모두 거절');

  // ChaCha20 직접 구현이 표준과 같은지: RFC 8439 2.4.2 시험 벡터 + OpenSSL chacha20 과 무작위 비교
  const { chacha20 } = V._internal;
  const rfcKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const rfcNonce = Buffer.from('000000000000004a00000000', 'hex');
  const sunscreen = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const rfcCt = chacha20(rfcKey, rfcNonce, sunscreen, 1);
  assert.equal(rfcCt.subarray(0, 16).toString('hex'), '6e2e359a2568f98041ba0728dd0d6981');
  assert.equal(rfcCt.subarray(-2).toString('hex'), '874d');
  assert.equal(chacha20(rfcKey, rfcNonce, rfcCt, 1).toString(), sunscreen.toString());
  let compared = 0;
  if (crypto.getCiphers().includes('chacha20')) {
    for (const len of [0, 1, 63, 64, 65, 200, 1000, 4097]) {
      const key = crypto.randomBytes(32);
      const nonce = crypto.randomBytes(12);
      const data = crypto.randomBytes(len);
      const ctr = Buffer.alloc(4);
      ctr.writeUInt32LE(1);
      const c = crypto.createCipheriv('chacha20', key, Buffer.concat([ctr, nonce]));
      const ref = Buffer.concat([c.update(data), c.final()]);
      assert.equal(chacha20(key, nonce, data, 1).toString('hex'), ref.toString('hex'));
      compared++;
    }
  }
  ok(`ChaCha20 직접 구현 = RFC 8439 시험 벡터 일치${compared ? ` · OpenSSL chacha20 과 ${compared}가지 길이에서 똑같음` : ''}`);

  // 파일 변조
  const tampered = { ...saved, data: saved.data.slice(0, -4) + (saved.data.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA') };
  await assert.rejects(V.unlockVault(tampered, 'master password 1', secretKey));
  ok('저장 파일이 바뀌면 열리지 않음');

  // 비밀번호 변경
  const changed = await V.changePassword(reopened, saved, 'new master password', secretKey);
  assert.notEqual(changed.kdf.salt, saved.kdf.salt);
  await assert.rejects(V.unlockVault(changed, 'master password 1', secretKey), (e) => e.code === 'auth');
  const afterChange = await V.unlockVault(changed, 'new master password', secretKey);
  assert.equal(V.openField(afterChange, 'login-1', afterChange.doc.logins[0].pw), pw);
  ok('마스터 비밀번호 변경: 새 salt 로 다시 감싸고, 옛 비밀번호로는 못 엶');

  // 비밀 키 표기
  const sk = V.formatSecretKey(secretKey);
  assert.match(sk, /^JK1(-[A-Z0-9]{4}){8}$/);
  assert.ok(V.parseSecretKey(sk).equals(secretKey));
  assert.ok(V.parseSecretKey(sk.toLowerCase().replace(/-/g, ' ')).equals(secretKey));
  assert.equal(V.parseSecretKey('JK1-XXXX'), null);
  ok(`비밀 키 표기 ${sk.slice(0, 13)}… (소문자·띄어쓰기도 인식)`);

  V.wipeSession(afterChange);
  assert.equal(afterChange.doc, null);
  assert.ok(afterChange.dek.every((x) => x === 0));
  ok('잠그면 메모리의 키를 0 으로 지움');

  const g = V.generatePassword(20);
  assert.equal(g.length, 20);
  assert.ok(/[A-Z]/.test(g) && /[a-z]/.test(g) && /\d/.test(g) && /[^A-Za-z0-9]/.test(g));
  ok(`비밀번호 생성기: ${g.length}자, 대·소문자·숫자·기호 포함`);

  // 신원
  const alice = ID.newIdentity();
  const mallory = ID.newIdentity();
  const sig = ID.signJoin(alice.priv, 'nonce-1', 'ABCDE');
  assert.ok(ID.verifyJoin(alice.pub, sig, 'nonce-1', 'abcde'));
  assert.ok(!ID.verifyJoin(alice.pub, sig, 'nonce-2', 'ABCDE')); // 다른 nonce (재사용 공격)
  assert.ok(!ID.verifyJoin(alice.pub, ID.signJoin(mallory.priv, 'nonce-1', 'ABCDE'), 'nonce-1', 'ABCDE')); // 사칭
  const code = ID.friendCode(alice.pub, '앨리스');
  const parsed = ID.parseFriendCode(code);
  assert.equal(parsed.pub, alice.pub);
  assert.equal(parsed.name, '앨리스');
  assert.equal(parsed.fp, ID.fingerprint(alice.pub));
  assert.equal(ID.parseFriendCode('jamfriend:abc'), null);
  ok('친구 신원: 서명 확인 · 다른 nonce 재사용 거절 · 다른 키로 사칭 거절 · 친구 코드');

  console.log(`\n비밀번호 뱅크 · 신원 테스트 통과 (${n}개)`);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
