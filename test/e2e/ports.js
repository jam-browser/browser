// E2E 포트. 기본값이 Windows 예약 포트 범위(Hyper-V/WSL)에 걸리는 PC 에서는 환경 변수로 바꾼다.
//   확인: netsh interface ipv4 show excludedportrange protocol=tcp
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
module.exports = {
  host: num(process.env.JAM_E2E_HOST_PORT, 9301), // 호스트 앱 CDP
  guest: num(process.env.JAM_E2E_GUEST_PORT, 9302), // 게스트 앱 CDP
  site: num(process.env.JAM_E2E_SITE_PORT, 8765), // test-site.js
};
