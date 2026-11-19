# Jam E2E (실제 앱 두 개)

`test/e2e` 와 별도로, 근처 찾기 · 화면 미러링 · 같이 보는 파일 · 세부 설정 · 핑을 실제 앱 두 개(호스트 · 참여자)로 확인해요.

- 앱 창은 **화면 밖**에 떠서 작업 중인 화면을 가리지 않아요 (`JAM_TEST_OFFSCREEN=1`)
- 이 모드에서는 메인 프로세스 오류가 오류 창 대신 로그(`[JAM-MAIN-ERROR]`)로 남고, 테스트가 끝날 때마다 `errscan.ps1` 이 로그를 검사해서 **메인 오류가 있으면 실패**로 처리해요
- 계정을 만드는 테스트가 있어서 `test/e2e/skip-account.js` 를 쓰지 않아요 (각 테스트가 첫 화면을 직접 처리)

## 실행

```powershell
powershell -ExecutionPolicy Bypass -File test\e2e-jam\run.ps1                       # 전부
powershell -ExecutionPolicy Bypass -File test\e2e-jam\run.ps1 -Tests ping,files     # 일부
powershell -ExecutionPolicy Bypass -File test\e2e-jam\run.ps1 -Packaged             # 설치본과 같은 패키지 (먼저 npx electron-builder --win --dir)
```

- 중계 서버가 필요한 테스트(nearby · mirror · files · relay-cap)는 `-Relay <jam-relay.js 경로>` 또는 `JAM_E2E_RELAY` 환경 변수. 없으면 이 저장소 옆 `..\jam-backend-build\jam-relay.js` 를 찾고, 그래도 없으면 건너뛰어요
- 테스트 모드에서는 추적기 차단 목록 대신 `fixtures\blocklist.txt`(JAM_TEST_BLOCKLIST), 계정 백업 · 불러오기 파일 창 대신 `out\account-backup.jvault`(JAM_TEST_DIALOG_FILE) 를 써요 (둘 다 JAM_TEST_OFFSCREEN=1 일 때만)
- 포트: CDP 9301 / 9302 (`JAM_E2E_HOST_PORT` · `JAM_E2E_GUEST_PORT`), 테스트 사이트 8766, 중계 서버 43131
- 결과 화면 캡처는 `out\` 에, 테스트 파일(PDF · HTML 폴더 · SWF)은 실행할 때 `fixtures\` 에 만들어져요 (둘 다 git 에 안 들어감)
- `settings` 의 HTTPS 우선 확인은 인터넷이 필요해요 (example.com · http.badssl.com)

## 테스트

| 파일 | 확인하는 것 |
| --- | --- |
| nearby | 중계 서버 주소 목록 · 같은 네트워크 근처 찾기 · 서버가 안 될 때 근처 호스트로 · 6자리 확인 코드 페어링 · 숨기기 |
| vault | 브라우저 계정 · 잠금 · 비밀번호 뱅크 저장/채우기 · 비밀번호 점검(약함 · 재사용 · 유출 확인) · 친구 · 입장 방식 |
| mirror | 화면 미러링 · 조작 권한(게임 키 · 2P) · 회수 · 자동 회수 |
| mirror-security | 화질 자동 조절 · 조작 요청 · 개인정보 버튼(아이콘 포함) 차단 · 비밀 칸 · 호스트 입력 숨김 · 원격 입력 뒤 비밀번호 저장 안 함 |
| mirror-aspect | 호스트 탭 크기가 바뀌어도 영상 비율 그대로 |
| files | PDF 쪽 동기화 · HTML 폴더(인터넷 차단) · SWF · 웹페이지가 jamfile 못 읽음 · 인터넷 허용 HTML · 웹 PDF · 나가면 삭제 |
| settings | 설정 화면 · 호스트 서버에 바로 적용 · 새 탭 음소거 · HTTPS 우선(+실패 시 http) · 비슷한 가짜 주소 경고 |
| ping | Alt+클릭 핑 · 화면 밖 화살표 · 📍 버튼 · 미러 화면 위 핑 |
| ping-wheel | 핑 휠 5방향 · Jam 탭 밖 Alt+클릭은 그대로 · 미러 화면 휠 |
| relay-cap | 손님당 0.5Mbps 로 제한한 중계 서버: 버리지 않고 늦춤 · 호스트가 스스로 화질을 낮춤 · 파일 끝까지 |
| siteguard | 추적기 차단(테스트 목록) · 🛡 패널(막은 수 · 사이트별 끄기) · 서드파티 쿠키 차단/허용 · 알림 권한 묻기 → 허용 → 🛡 에서 차단 · 사이트별 설정 목록 · 설정에서 끄기 |
| resume | 다른 기기에서 이어 보기: A 가 중계 서버로 Jam → B 가 계정 백업 불러오기 + 잠금 해제 → 자동으로 찾아서 이어 보기 → 승인 없이 입장 (💻) → Jam 끝나면 중계 서버에서 사라짐. presence 를 아는 중계 서버(1.0.5+)가 필요 |
| tabs | 탭이 저절로 왔다갔다 하지 않는지: 빠르게 바꾸기 · 새 탭 열고 닫기 · Ctrl+Tab 연타 뒤 3초 동안 저절로 바뀐 횟수 0 |
| passkey | 패스키 끄기(기본): 페이지에 "패스키 없음", 패스키 요청은 창 없이 바로 거절 · 켜면 원래대로 (실제 패스키 창은 부르지 않음) |
| smoke | 버전 표시 · 확장 프로그램 줄 · 설정 페이지 · 📍 버튼 · 웹페이지 탭이 Google Chrome 으로 보이는지(UA · Sec-CH-UA · userAgentData) (릴리스 전 패키지 확인용) |
| update | 자동 업데이트 서명 확인 (패키지 앱 + 로컬 업데이트 서버): 배포 키 서명은 준비됨 · 다른 키 서명은 거부하고 삭제. 패키지 빌드(`dist\win-unpacked`)와 환경 변수 JAM_BROWSER_RELEASE_KEY 가 필요하고, 없으면 SKIPPED. 이 테스트는 앱을 스스로 띄워서 run.ps1 이 앱 두 개를 미리 띄우지 않아요 |
