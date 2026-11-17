# 실제 앱 E2E 테스트

앱 두 개(호스트 9301, 게스트 9302 디버깅 포트)를 띄워서 CDP로 조작하는 테스트예요.

```powershell
# 로그인/다운로드/클립보드/꾸미기 테스트는 테스트 사이트(포트 8765)가 필요해요
Start-Process node -ArgumentList "test\e2e\test-site.js"

# 실행: 스크립트 이름, 앱 폴더 절대 경로
& .\test\e2e\run-e2e.ps1 jam-core.e2e.js (Resolve-Path .)
& .\test\e2e\run-e2e.ps1 resolution.e2e.js (Resolve-Path .)
& .\test\e2e\run-e2e.ps1 login-follow-safety.e2e.js (Resolve-Path .)
& .\test\e2e\run-e2e.ps1 customize.e2e.js (Resolve-Path .)
& .\test\e2e\run-e2e.ps1 extensions.e2e.js (Resolve-Path .)
```

| 파일 | 확인하는 것 |
| --- | --- |
| `jam-core.e2e.js` | 승인 후 참여, 다른 사이트 링크 잠금, 권한 부여, 화면 영역 공유, 커서 숨김, 동영상 동기화, 광고 예외, 종료 |
| `resolution.e2e.js` | 다른 해상도·확대율에서 사각형/커서/스크롤 따라가기 위치 정확도 |
| `login-follow-safety.e2e.js` | 로그인 대기 → 로그인 후 자동 합류, 패널 숨김 + 사람 따라가기, 클립보드 경고, 다운로드 격리, Jam이 데려간 다운로드 차단 |
| `customize.e2e.js` | 스피드 다이얼, 검색 엔진, 북마크, 기록, 찾기, 확대, 사이트 CSS, 탭 고정/분할/다시 열기, 탭 위치·테마·프리셋, 사용자 CSS |
| `extensions.e2e.js` | User-Agent 에 Electron 이 없는지, 확장 아이콘 줄, Chrome 웹 스토어 설치 API 주입 |

주의: `run-e2e.ps1` 은 실행 중인 Jam Browser 창을 모두 닫고 시작해요. 인터넷(위키백과, example.com, 위키미디어 영상)이 필요해요.
