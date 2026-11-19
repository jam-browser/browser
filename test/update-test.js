'use strict';
// 업데이트 서명 테스트: node test/update-test.js
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { signFile, verifyFile } = require('../shared/update-sign');

(async () => {
  let n = 0;
  const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-update-'));
  const file = path.join(dir, 'JamBrowser-Setup-9.9.9.exe');
  fs.writeFileSync(file, crypto.randomBytes(300 * 1024));
  const key = crypto.generateKeyPairSync('ed25519');
  const priv = key.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = key.publicKey.export({ type: 'spki', format: 'pem' });

  const sig = await signFile(priv, '9.9.9', file);
  assert.deepEqual(await verifyFile(pub, '9.9.9', file, JSON.stringify(sig)), { ok: true });
  ok('배포 키로 서명한 설치 파일은 통과');

  const other = path.join(dir, 'other.exe');
  fs.writeFileSync(other, Buffer.concat([fs.readFileSync(file), Buffer.from([1])]));
  assert.equal((await verifyFile(pub, '9.9.9', other, JSON.stringify(sig))).ok, false);
  ok('설치 파일이 1바이트라도 바뀌면 거부');

  assert.match((await verifyFile(pub, '10.0.0', file, JSON.stringify(sig))).reason, /버전/);
  ok('다른 버전의 서명을 붙여 오면 거부 (옛 버전으로 되돌리기 방지)');

  const evil = crypto.generateKeyPairSync('ed25519');
  const fake = await signFile(evil.privateKey.export({ type: 'pkcs8', format: 'pem' }), '9.9.9', file);
  assert.match((await verifyFile(pub, '9.9.9', file, JSON.stringify(fake))).reason, /서명이 맞지 않아요/);
  ok('다른 키로 서명한 파일은 거부 (GitHub 릴리스를 바꿔도 비밀키 없이는 못 만듦)');

  for (const bad of ['not json', '{}', JSON.stringify({ ...sig, v: 2 }), JSON.stringify({ ...sig, sig: 'AAAA' })]) {
    assert.equal((await verifyFile(pub, '9.9.9', file, bad)).ok, false, bad.slice(0, 20));
  }
  ok('서명 파일이 깨졌거나 형식이 다르면 거부');

  // 저장소의 공개키가 Ed25519 형식으로 읽히는지
  const repoPub = fs.readFileSync(path.join(__dirname, '..', 'src', 'update-key.pub.pem'), 'utf8');
  assert.equal(crypto.createPublicKey(repoPub).asymmetricKeyType, 'ed25519');
  ok('앱에 들어가는 공개키(src/update-key.pub.pem)는 Ed25519');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n업데이트 서명 테스트 통과 (${n}개)`);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
