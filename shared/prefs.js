/**
 * 세부 설정 목록 (앱 화면 · 메인 프로세스 · 호스트 Jam 서버가 함께 씀)
 *
 * 원칙
 *  - 일부러 걸어 둔 "양 제한"(대역폭 · 파일 크기 · 인원 등)은 기본값을 넉넉하게(사실상 제한 없음) 두고, 여기서 바꿀 수 있게
 *  - 보안 보호(개인정보 버튼 차단, 비밀 칸 영상 멈춤 등)는 기본으로 켜 두고, 끄면 경고를 보여 줌
 *  - 값은 이 PC 에만 저장 (localStorage → 메인 프로세스로 전달), 어디로도 보내지 않음
 *
 * 항목: { key, page, group, label, help, type: bool|select|number, def, options, min, max, step, unit, warnOff, main }
 *  - main: true 면 메인 프로세스(호스트 Jam 서버 · 근처 찾기 · 보안 처리)도 이 값을 씀
 */
(function (root) {
  'use strict';

  const PAGES = [
    { id: 'set-jam', label: 'Jam · 연결' },
    { id: 'set-mirror', label: '화면 미러링' },
    { id: 'set-files', label: '같이 보는 파일' },
    { id: 'set-security', label: '보안 · 개인정보' },
    { id: 'set-sound', label: '소리' },
    { id: 'set-update', label: '업데이트' },
  ];

  const S = [
    // ---------- Jam · 연결 ----------
    { key: 'maxMembers', page: 'set-jam', group: '인원 · 대기', label: '한 Jam 최대 인원', type: 'number', def: 64, min: 2, max: 64, unit: '명', main: true, help: '호스트 포함. 중계 서버를 거치면 서버 설정(기본 64명)도 함께 적용돼요' },
    { key: 'maxPending', page: 'set-jam', group: '인원 · 대기', label: '동시에 기다리는 참여 요청', type: 'number', def: 10, min: 1, max: 50, unit: '개', main: true },
    { key: 'approvalSec', page: 'set-jam', group: '인원 · 대기', label: '참여 요청 자동 취소', type: 'number', def: 120, min: 15, max: 1800, unit: '초', main: true },
    { key: 'resumeMin', page: 'set-jam', group: '인원 · 대기', label: '끊겼다 돌아오면 승인 없이 복귀', type: 'number', def: 5, min: 0, max: 120, unit: '분', main: true, help: '0 이면 다시 들어올 때 항상 승인' },
    { key: 'maxQueue', page: 'set-jam', group: '인원 · 대기', label: '대기열 최대 길이', type: 'number', def: 200, min: 10, max: 1000, unit: '개', main: true },
    { key: 'badCodeTries', page: 'set-jam', group: '잘못된 초대 코드', label: '차단까지 허용하는 실패 횟수', type: 'number', def: 8, min: 3, max: 50, unit: '번', main: true },
    { key: 'badCodeBlockMin', page: 'set-jam', group: '잘못된 초대 코드', label: '차단 시간', type: 'number', def: 10, min: 1, max: 1440, unit: '분', main: true },
    { key: 'nearbyAnnounce', page: 'set-jam', group: '근처 찾기 (같은 네트워크, UDP 3032)', label: '내 Jam 을 근처에 알리기', type: 'bool', def: true, main: true, help: 'Jam 이름 · 호스트 이름 · 접속 주소만 알려요. 초대 비밀키는 보내지 않아요' },
    { key: 'nearbyScan', page: 'set-jam', group: '근처 찾기 (같은 네트워크, UDP 3032)', label: '근처 Jam 찾기', type: 'bool', def: true, main: true },
    { key: 'nearbyIntervalSec', page: 'set-jam', group: '근처 찾기 (같은 네트워크, UDP 3032)', label: '알림 간격', type: 'number', def: 2, min: 1, max: 30, unit: '초', main: true },
    { key: 'resumePublish', page: 'set-jam', group: '다른 기기에서 이어 보기 (같은 브라우저 계정)', label: '내가 연 Jam 을 내 다른 기기에서 찾을 수 있게', type: 'bool', def: true, main: true, help: '중계 서버로 연 Jam 만. 서버에는 무작위 ID 와 암호문만 맡기고(Jam 이 열려 있는 동안 · 메모리에만), 같은 계정으로 잠금을 푼 기기만 풀 수 있어요. 같은 계정 기기는 승인 없이 들어와요' },
    { key: 'resumeAutoFind', page: 'set-jam', group: '다른 기기에서 이어 보기 (같은 브라우저 계정)', label: '계정 잠금을 풀면 내 다른 기기의 Jam 찾기', type: 'bool', def: true },
    { key: 'pingEnabled', page: 'set-jam', group: '핑', label: '핑 찍기 · 보기', type: 'bool', def: true, help: '핑 키를 누른 채 클릭 → 휠이 열리면 방향으로 끌어서 고르기: 위 ⚠️ 조심 · 아래 ❓ 뭐지? · 오른쪽 👀 이거 봐 · 왼쪽 🏃 갈게요 · 그대로 놓으면 📍 여기' },
    { key: 'pingKey', page: 'set-jam', group: '핑', label: '핑 키 (누른 채 클릭 · 드래그)', type: 'select', def: 'alt', options: [['alt', 'Alt'], ['g', 'G (글자 칸 밖에서만, 게임 키와 겹칠 수 있어요)']] },
    { key: 'pingSeconds', page: 'set-jam', group: '핑', label: '핑 표시 시간', type: 'number', def: 6, min: 2, max: 30, unit: '초' },
    { key: 'pingToastOther', page: 'set-jam', group: '핑', label: '다른 페이지에서 찍은 핑은 알림으로', type: 'bool', def: true },

    // ---------- 화면 미러링 ----------
    { key: 'mirrorMaxRes', page: 'set-mirror', group: '화질', label: '최대 해상도', type: 'select', def: 'native', options: [['720', '1280×720'], ['1080', '1920×1080'], ['1440', '2560×1440'], ['native', '탭 원래 크기 (최대 3840×2160)']] },
    { key: 'mirrorMaxFps', page: 'set-mirror', group: '화질', label: '최대 초당 장수', type: 'select', def: '60', options: [['15', '15fps'], ['24', '24fps'], ['30', '30fps'], ['60', '60fps']] },
    { key: 'mirrorMaxMbps', page: 'set-mirror', group: '화질', label: '참여자 1명당 최대 비트레이트', type: 'number', def: 50, min: 1, max: 200, step: 1, unit: 'Mbps' },
    { key: 'mirrorMinMbps', page: 'set-mirror', group: '화질', label: '최소 비트레이트 (이 밑으로는 해상도를 줄임)', type: 'number', def: 2, min: 0.5, max: 50, step: 0.5, unit: 'Mbps' },
    { key: 'mirrorStartMbps', page: 'set-mirror', group: '화질', label: '시작 비트레이트', type: 'number', def: 8, min: 1, max: 200, step: 1, unit: 'Mbps' },
    { key: 'mirrorCodec', page: 'set-mirror', group: '화질', label: '영상 형식', type: 'select', def: 'auto', options: [['auto', '자동 (하드웨어 H.264 → VP8)'], ['h264', 'H.264 하드웨어만 (없으면 VP8)'], ['vp8', 'VP8 (소프트웨어, 호환성 최고)']] },
    { key: 'mirrorKeySec', page: 'set-mirror', group: '화질', label: '키프레임 간격', type: 'number', def: 4, min: 1, max: 20, unit: '초', help: '짧을수록 끊긴 뒤 빨리 회복, 길수록 데이터가 적어요' },
    { key: 'mirrorAdaptive', page: 'set-mirror', group: '자동 조절', label: '연결 상태에 따라 자동 조절', type: 'bool', def: true },
    { key: 'mirrorPriority', page: 'set-mirror', group: '자동 조절', label: '느려지면 먼저 줄일 것', type: 'select', def: 'fps', options: [['fps', '초당 장수 먼저 (글자가 또렷하게)'], ['quality', '화질 먼저 (움직임이 부드럽게)']] },
    { key: 'mirrorSessionMbps', page: 'set-mirror', group: '자동 조절', label: '한 Jam 영상 합계 한도', type: 'number', def: 0, min: 0, max: 10000, step: 10, unit: 'Mbps', main: true, help: '0 = 제한 없음' },
    { key: 'pauseOnHostTyping', page: 'set-mirror', group: '호스트 화면 보호', label: '호스트가 글자를 입력하는 동안 영상 멈춤', type: 'bool', def: true, warnOff: '끄면 호스트가 입력하는 글자가 실시간으로 보여요' },
    { key: 'pauseOnSecret', page: 'set-mirror', group: '호스트 화면 보호', label: '비밀 입력 칸 · 로그인/결제 화면에서 영상 멈춤', type: 'bool', def: true, warnOff: '끄면 로그인 · 결제 화면이 참여자에게 보여요' },
    { key: 'remoteBlockSensitive', page: 'set-mirror', group: '참여자 조작 보호', label: '개인정보 · 결제 · 계정 버튼 원격 클릭 막기', type: 'bool', def: true, main: true, warnOff: '끄면 조작 권한이 있는 참여자가 로그인 · 결제 버튼을 누를 수 있어요' },
    { key: 'remoteBlockSecret', page: 'set-mirror', group: '참여자 조작 보호', label: '비밀 입력 칸에 원격 입력 막기', type: 'bool', def: true, main: true, warnOff: '끄면 참여자가 비밀번호 칸에 입력할 수 있어요 (호스트에게 그대로 보임)' },
    { key: 'remoteAllowFullKeys', page: 'set-mirror', group: '참여자 조작 보호', label: '"키보드 전체" 권한을 줄 수 있게', type: 'bool', def: true },
    { key: 'autoRevoke', page: 'set-mirror', group: '참여자 조작 보호', label: '다른 사이트 · 로그인 화면으로 가면 권한 자동 회수', type: 'bool', def: true, warnOff: '끄면 다른 사이트에서도 참여자 조작이 계속돼요' },

    // ---------- 같이 보는 파일 ----------
    { key: 'fileMaxMB', page: 'set-files', group: '크기 · 개수', label: '파일 하나 최대 크기', type: 'number', def: 2048, min: 1, max: 8192, unit: 'MB', main: true, help: '파일은 메모리에만 있어요. 큰 파일은 그만큼 메모리를 써요' },
    { key: 'fileMaxCount', page: 'set-files', group: '크기 · 개수', label: '한 Jam 에 공유할 수 있는 파일 수', type: 'number', def: 100, min: 1, max: 1000, unit: '개', main: true },
    { key: 'fileRoomMaxMB', page: 'set-files', group: '크기 · 개수', label: '한 Jam 공유 파일 합계', type: 'number', def: 8192, min: 10, max: 65536, unit: 'MB', main: true },
    { key: 'fileFolderMax', page: 'set-files', group: '크기 · 개수', label: 'HTML 폴더 묶음 최대 파일 수', type: 'number', def: 5000, min: 10, max: 50000, unit: '개', main: true },
    { key: 'fileAutoDownload', page: 'set-files', group: '받기', label: '호스트가 공유하면 바로 받기', type: 'bool', def: false, help: '꺼져 있으면 "받아서 열기" 를 눌러야 받아요' },
    { key: 'fileKeepAfterLeave', page: 'set-files', group: '받기', label: 'Jam 을 나가도 받은 파일 유지 (앱을 끌 때까지)', type: 'bool', def: false },
    { key: 'fileHtmlNetDefault', page: 'set-files', group: '공유', label: 'HTML 공유할 때 "인터넷 허용" 을 기본으로 체크', type: 'bool', def: false, main: true },
    { key: 'fileSpeed', page: 'set-files', group: '공유', label: '참여자 1명에게 보내는 속도', type: 'select', def: 'fast', main: true, options: [['normal', '보통 (약 3MB/s)'], ['fast', '빠르게 (약 6MB/s)'], ['max', '최대 (같은 네트워크 권장)']] },

    // ---------- 보안 · 개인정보 ----------
    { key: 'httpsFirst', page: 'set-security', group: '접속', label: 'HTTPS 우선 (http 주소를 https 로 먼저 시도)', type: 'bool', def: true, main: true, help: 'https 가 안 되는 사이트만 http 로 열어요. 같은 네트워크(사설 IP · localhost)는 그대로' },
    { key: 'contentBlock', page: 'set-security', group: '추적 · 광고 (주소창 🛡 에서 사이트마다 끌 수 있어요)', label: '차단', type: 'select', def: 'trackers', main: true, options: [['trackers', '추적기 차단 (권장 · 페이지 모양은 그대로)'], ['ads', '추적기 + 광고 차단'], ['off', '끔']], help: 'EasyPrivacy · uBlock 목록으로 웹페이지가 부르는 추적 · 광고 주소를 막아요. 광고까지 막으면 Jam 상대와 페이지 모양이 조금 다를 수 있어요', warnOff: '끄면 사이트를 옮겨 다니며 나를 추적하는 요청이 그대로 나가요' },
    { key: 'blockListHours', page: 'set-security', group: '추적 · 광고 (주소창 🛡 에서 사이트마다 끌 수 있어요)', label: '차단 목록 새로 받기', type: 'number', def: 24, min: 6, max: 168, unit: '시간마다', main: true },
    { key: 'thirdPartyCookies', page: 'set-security', group: '추적 · 광고 (주소창 🛡 에서 사이트마다 끌 수 있어요)', label: '서드파티 쿠키', type: 'select', def: 'block', main: true, options: [['block', '차단 (보고 있는 사이트의 쿠키만)'], ['allow', '허용']], help: '다른 회사가 여러 사이트에 심어 둔 쿠키로 나를 따라오는 것을 막아요. 로그인이 안 되는 사이트는 🛡 에서 그 사이트만 허용하세요' },
    { key: 'permPrompt', page: 'set-security', group: '사이트 권한 (위치 · 알림 · 카메라 · 마이크 · 클립보드 읽기 · MIDI)', label: '사이트가 권한을 요청하면', type: 'select', def: 'ask', main: true, options: [['ask', '물어보기 (답을 사이트마다 기억)'], ['deny', '묻지 않고 모두 거절']], help: '허용 · 차단한 사이트는 아래 목록이나 주소창 🛡 에서 바꿀 수 있어요. 화면 캡처 · 그 밖의 권한은 항상 거절해요' },
    { key: 'lookalikeWarn', page: 'set-security', group: '로그인 · 비밀번호', label: '저장한 사이트와 비슷한 가짜 주소 경고', type: 'bool', def: true, main: true, help: '예) naver.com 을 저장했는데 navver.com · xn--… 에서 로그인 칸이 보이면 경고하고 🔑 채우기를 막아요' },
    { key: 'noPwSaveAfterRemoteMin', page: 'set-security', group: '로그인 · 비밀번호', label: '원격 조작이 들어온 사이트는 비밀번호 저장 안 묻기', type: 'number', def: 30, min: 0, max: 1440, unit: '분', main: true, help: '0 이면 끔' },
    { key: 'clipboardWarn', page: 'set-security', group: '탐색', label: '사이트가 클립보드에 복사하면 경고', type: 'bool', def: true },
    { key: 'jamNavSensitive', page: 'set-security', group: '탐색', label: '로그인 · 결제 주소는 Jam 에 공유하지 않기', type: 'bool', def: true, help: '항상 켜 두기를 권해요 (주소에 인증 코드가 들어 있을 수 있어요)', locked: true },

    // ---------- 소리 ----------
    { key: 'muteNewTabs', page: 'set-sound', group: '탭', label: '새 탭은 음소거로 시작', type: 'bool', def: false, help: '탭의 🔊 / 🔇 로 탭마다 켜고 끌 수 있어요' },
    { key: 'muteJamTab', page: 'set-sound', group: '탭', label: 'Jam 탭은 음소거로 시작', type: 'bool', def: false },

    // ---------- 업데이트 ----------
    { key: 'updateAuto', page: 'set-update', group: '확인 · 받기', label: '새 버전을 자동으로 확인하고 받기', type: 'bool', def: true, main: true, warnOff: '끄면 보안 수정도 직접 ☰ → 업데이트 확인 을 눌러야 받아요' },
    { key: 'updateCheckHours', page: 'set-update', group: '확인 · 받기', label: '확인 간격', type: 'number', def: 4, min: 1, max: 24, unit: '시간', main: true, help: '앱을 켜고 5초 뒤에도 한 번 확인해요' },
    { key: 'updateInstall', page: 'set-update', group: '설치', label: '받은 업데이트 설치', type: 'select', def: 'quit', main: true, options: [['quit', '앱을 끌 때'], ['idle', '쓰지 않을 때 자동으로 다시 켜서 (Jam 중이 아닐 때)'], ['manual', '내가 "지금 재시작" 을 누를 때만']] },
    { key: 'updateIdleMin', page: 'set-update', group: '설치', label: '"쓰지 않을 때" 기준', type: 'number', def: 30, min: 5, max: 240, unit: '분', main: true },
    { key: 'updateVerify', page: 'set-update', group: '설치', label: '업데이트 서명 확인 (배포 키로 서명한 설치 파일만 설치)', type: 'bool', def: true, locked: true, help: 'GitHub 릴리스가 바뀌어도 가짜 설치 파일은 설치되지 않아요. 끌 수 없어요' },
  ];

  const DEFAULTS = Object.fromEntries(S.map((s) => [s.key, s.def]));

  /** 값 정리 (범위 · 형식이 틀리면 기본값) */
  function clean(input) {
    const out = { ...DEFAULTS };
    if (!input || typeof input !== 'object') return out;
    for (const s of S) {
      if (!(s.key in input)) continue;
      const v = input[s.key];
      if (s.locked) continue;
      if (s.type === 'bool') out[s.key] = v === true || v === false ? v : s.def;
      else if (s.type === 'select') out[s.key] = s.options.some((o) => o[0] === String(v)) ? String(v) : s.def;
      else if (s.type === 'number') {
        const n = Number(v);
        out[s.key] = Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, n)) : s.def;
      }
    }
    return out;
  }

  /** 호스트 Jam 서버에 넘길 값 (바이트 · ms 단위) */
  function serverLimits(p) {
    p = clean(p);
    const MB = 1024 * 1024;
    return {
      maxMembers: p.maxMembers,
      maxPending: p.maxPending,
      approvalMs: p.approvalSec * 1000,
      resumeMs: p.resumeMin * 60e3,
      maxQueue: p.maxQueue,
      maxFailures: p.badCodeTries,
      blockMs: p.badCodeBlockMin * 60e3,
      mirrorRate: (p.mirrorSessionMbps * 1e6) / 8, // 0 = 제한 없음
      fileMax: p.fileMaxMB * MB,
      fileRoomMax: p.fileRoomMaxMB * MB,
      fileMaxCount: p.fileMaxCount,
      filePerTick: { normal: 2, fast: 4, max: 16 }[p.fileSpeed] || 4,
    };
  }

  const api = { PAGES, SCHEMA: S, DEFAULTS, clean, serverLimits };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JamPrefs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
