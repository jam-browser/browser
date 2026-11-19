'use strict';
/**
 * 릴리스할 설치 파일에 서명 (배포하는 PC 에서만)
 *
 *   node tools/sign-update.js --key <배포 비밀키.pem> dist/JamBrowser-Setup-0.3.1.exe
 *
 *  - 같은 폴더에 JamBrowser-Setup-0.3.1.exe.sig 를 만들고, 저장소의 공개키(src/update-key.pub.pem)로 바로 확인해요
 *  - 버전은 파일 이름에서 (없으면 package.json)
 *  - 비밀키는 저장소에 절대 넣지 마세요. 잃어버리면 이미 설치된 앱에 업데이트를 보낼 수 없어요
 */
const fs = require('fs');
const path = require('path');
const { signFile, verifyFile } = require('../shared/update-sign');

(async () => {
  const argv = process.argv.slice(2);
  const ki = argv.indexOf('--key');
  const keyPath = ki >= 0 ? argv[ki + 1] : process.env.JAM_BROWSER_RELEASE_KEY;
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--key');
  if (!keyPath || !file) {
    console.error('사용법: node tools/sign-update.js --key <비밀키.pem> <설치 파일>');
    process.exit(1);
  }
  const m = /-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.exe$/.exec(path.basename(file));
  const version = m ? m[1] : require('../package.json').version;
  const sig = await signFile(fs.readFileSync(keyPath, 'utf8'), version, file);
  const out = `${file}.sig`;
  fs.writeFileSync(out, JSON.stringify(sig) + '\n');
  const pub = fs.readFileSync(path.join(__dirname, '..', 'src', 'update-key.pub.pem'), 'utf8');
  const v = await verifyFile(pub, version, file, fs.readFileSync(out, 'utf8'));
  if (!v.ok) {
    console.error(`서명 확인 실패: ${v.reason} — 비밀키와 src/update-key.pub.pem 이 짝이 아니에요`);
    process.exit(1);
  }
  console.log(`signed ${path.basename(file)} (v${version}) → ${path.basename(out)}, verified with src/update-key.pub.pem`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
