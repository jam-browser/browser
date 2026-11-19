// test/e2e-jam 공통: CDP 포트(test/e2e 와 같은 환경 변수) · 결과 폴더 · 테스트 파일 폴더
const path = require('path');
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
module.exports = {
  host: num(process.env.JAM_E2E_HOST_PORT, 9301), // 호스트 앱
  guest: num(process.env.JAM_E2E_GUEST_PORT, 9302), // 참여자 앱
  out: path.join(__dirname, 'out'), // 화면 캡처
  fixtures: path.join(__dirname, 'fixtures'), // make-fixtures.js 가 만드는 PDF · HTML 폴더 · SWF
  hostProfile: path.join(__dirname, 'ud-host'), // 호스트 앱 프로필 (vault 검사)
};
