# Jam 중계 서버 (Windows)

멀리 있는 친구와 Jam을 하려면, 호스트 PC와 친구가 둘 다 접속할 수 있는 **중계 서버**가 하나 있으면 돼요.

- 중계 서버는 **길만 이어 줘요.** 호스트 PC가 계속 진짜 서버 역할을 해요.
- 대화는 호스트와 참여자 사이에서 초대 코드의 비밀키로 **암호화**되어 있어서, 중계 서버는 내용을 볼 수 없어요.
- 아무것도 저장하지 않아요. 접속·종료 로그(시간, IP 앞부분)만 남겨요.
- 데이터 양이 작아서(커서·스크롤·채팅) **가장 싼 사양(1 vCPU, 1GB RAM)** 으로도 충분해요.

```
참여자 ──인터넷──▶ 중계 서버 ──▶ 호스트 PC (Jam Browser 안의 Jam 서버)
              (암호화된 데이터를 그대로 전달)
```

## 1. 준비 (Windows 10/11 또는 Windows Server)

1. Node.js LTS 설치: `winget install OpenJS.NodeJS.LTS`
2. 이 `relay` 폴더를 서버 PC에 복사

## 2. 실행해 보기

`start-relay.bat` 을 더블클릭하면 포트 **3031** 로 실행돼요(처음에는 필요한 패키지를 설치해요).

## 3. 밖에서 접속되게 하기

- **방화벽**: 관리자 PowerShell 에서 `powershell -ExecutionPolicy Bypass -File open-firewall.ps1`
- **클라우드 서버(VPS)**: 업체 관리 화면의 보안 그룹/방화벽에서 TCP 3031 을 열어 주세요.
- **집 PC 를 서버로 쓸 때**: 공유기에서 TCP 3031 포트 포워딩이 필요해요.

## 4. Windows 시작할 때 자동 실행

관리자 PowerShell 에서:

```powershell
powershell -ExecutionPolicy Bypass -File install-autostart.ps1
```

- 작업 스케줄러에 `Jam Relay` 작업을 등록해요 (권한이 가장 낮은 LOCAL SERVICE 계정, 꺼지면 1분 뒤 다시 시작).
- 로그: `relay\relay.log`
- 제거: `uninstall-autostart.ps1`

## 5. Jam Browser 에서 쓰기

호스트가 Jam 시작 화면의 **인터넷으로 함께하기 (중계 서버)** 칸에 `서버주소:3031` 을 넣고 Jam 을 시작하면,
`jamr://서버주소:3031/경로/방코드/비밀키` 형태의 초대 코드가 나와요. 친구는 그 코드를 그대로 붙여 넣으면 돼요.

## 6. (선택) wss:// 암호화 연결

내용은 이미 끝에서 끝까지 암호화되어 있어서 꼭 필요하진 않지만, 연결 자체도 TLS 로 감싸고 싶다면
도메인과 인증서(PFX, 예: win-acme 로 발급)를 준비한 뒤:

```powershell
powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Port 443 -Pfx C:\certs\relay.pfx -PfxPass 비밀번호
```

앱에는 `https://도메인` 또는 `wss://도메인` 으로 입력하면 돼요 (초대 코드가 `jamrs://` 로 나와요).

## 보안 · 운영 메모

- 웹페이지(http/https 출처)는 중계 서버에 접속할 수 없어요. Jam Browser 앱만 접속돼요.
- 경로 번호는 무작위이고, 호스트만 아는 토큰이 있어야 손님을 받을 수 있어요.
- 한 Jam 최대 16명, IP 당 동시 연결 30개, 메시지 크기·속도 제한이 있어요.
- 잘못된 초대 코드를 계속 넣는 사람은 **호스트 PC 쪽**에서 손님 IP 별로 차단돼요.
- 친구끼리 무료로 쓰는 용도라면 보통 문제없지만, 불특정 다수에게 서비스로 제공하거나 돈을 받는다면
  전기통신사업법상 부가통신사업 신고 대상인지 확인하세요.
