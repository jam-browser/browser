'use strict';
/**
 * 브라우저 업데이트 서명 (Ed25519)
 *
 * 릴리스할 때 배포 비밀키(저장소 밖)로 설치 파일에 서명해 JamBrowser-Setup-<버전>.exe.sig 를 같이 올리고,
 * 앱은 받은 설치 파일을 앱 안의 공개키(src/update-key.pub.pem)로 확인한 뒤에만 설치해요.
 * → GitHub 계정이나 릴리스가 바뀌어도, 비밀키 없이 만든 가짜 설치 파일은 설치되지 않아요.
 *
 * 서명 파일(JSON): { v: 1, version, sha512 (설치 파일 SHA-512, base64), sig (Ed25519, base64) }
 * 서명하는 내용: "jam-browser-update|<버전>|<sha512>"
 */
const crypto = require('crypto');
const fs = require('fs');

const message = (version, sha512) => Buffer.from(`jam-browser-update|${version}|${sha512}`);
const sha512File = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('base64')));
  });

/** 서명 만들기 (배포하는 PC 에서만) */
async function signFile(privatePem, version, file) {
  const sha512 = await sha512File(file);
  const sig = crypto.sign(null, message(version, sha512), privatePem).toString('base64');
  return { v: 1, version, sha512, sig };
}

/** 받은 설치 파일 확인 → { ok, reason } */
async function verifyFile(publicPem, version, file, sigText) {
  let s;
  try {
    s = typeof sigText === 'string' ? JSON.parse(sigText) : sigText;
  } catch {
    return { ok: false, reason: '서명 파일 형식이 이상해요' };
  }
  if (!s || s.v !== 1 || typeof s.sig !== 'string' || typeof s.sha512 !== 'string') return { ok: false, reason: '서명 파일 형식이 이상해요' };
  if (s.version !== version) return { ok: false, reason: `서명 버전(${s.version})이 업데이트 버전(${version})과 달라요` };
  const sha512 = await sha512File(file);
  if (sha512 !== s.sha512) return { ok: false, reason: '설치 파일이 서명한 파일과 달라요' };
  let good = false;
  try {
    good = crypto.verify(null, message(version, sha512), publicPem, Buffer.from(s.sig, 'base64'));
  } catch {
    good = false;
  }
  return good ? { ok: true } : { ok: false, reason: '서명이 맞지 않아요 (배포 키로 서명한 파일이 아니에요)' };
}

module.exports = { signFile, verifyFile, sha512File, message };
