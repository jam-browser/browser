'use strict';
// Jam 테스트 환경: 한 PC 에서 호스트 · 게스트 앱 두 개 + 로컬 중계 서버를 함께 띄운다.
//
//   npm run jam              호스트 + 게스트 + 중계 서버(있으면)
//   npm run jam -- --no-relay    중계 서버 없이 (같은 네트워크 방식 jam:// 만)
//   npm run jam -- --guests 2    게스트 여러 명
//   npm run jam -- --fresh       프로필(로그인·설정·탭)을 지우고 새로 시작
//   npm run jam -- --guest-audio 게스트 창 소리도 켜기 (기본은 호스트만 소리, 겹쳐 들리지 않게)
//   npm run jam -- --debug      각 앱에 CDP 디버그 포트 열기 (JAM_DEV_CDP_PORT 기본 9411 부터 비어 있는 포트를 골라 씀)
//
// 프로필은 .jam-dev/<이름> 에 남아서 다음 실행 때도 로그인·설정이 유지돼요.
// 중계 서버는 옆 폴더의 backend 저장소(../backend/jam-relay.js)를 써요. 없으면 건너뛰어요.
// Ctrl+C 로 전부 종료.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILES = path.join(ROOT, '.jam-dev');
const RELAY_JS = path.join(ROOT, '..', 'backend', 'jam-relay.js');
const RELAY_PORT = Number(process.env.JAM_DEV_RELAY_PORT) || 3031;
const CDP_BASE = Number(process.env.JAM_DEV_CDP_PORT) || 9411;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, d) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const guests = Math.max(1, Math.min(8, Number(opt('--guests', 1)) || 1));
const withRelay = !flag('--no-relay');
const debug = flag('--debug');

if (flag('--fresh')) fs.rmSync(PROFILES, { recursive: true, force: true });

const children = [];
let stopping = false;

function run(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const prefix = `[${label}]`;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) if (line.trim() && !noisy(line)) out.write(`${prefix} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (stopping) return;
    console.log(`${prefix} 종료됨 (code ${code})`);
    // 앱 창을 모두 닫으면 나머지도 정리
    if (label !== 'relay' && children.every((c) => c.label === 'relay' || c.child.exitCode !== null)) stopAll();
  });
  children.push({ label, child });
  return child;
}

// Chromium 이 늘 찍는 잡음은 숨긴다
function noisy(line) {
  return /DevTools listening|gpu_init|ERROR:.*(gles2|angle|cache_util|disk_cache|ssl_client_socket|socket_manager)/i.test(line);
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode === null) child.kill();
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

const electron = require('electron'); // electron 패키지는 실행 파일 경로를 돌려준다
const names = ['host', ...Array.from({ length: guests }, (_, i) => (guests === 1 ? 'guest' : `guest${i + 1}`))];

// 실제로 열 수 있는 포트를 찾는다.
// Windows 는 Hyper-V/WSL 이 포트 범위를 예약하고, 그 범위가 재부팅마다 바뀌어서 고정 포트가 막힐 수 있다.
function canListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}
async function freePorts(start, count) {
  const out = [];
  for (let p = start; out.length < count && p < 65535; p++) if (await canListen(p)) out.push(p);
  return out;
}

(async () => {
  console.log('Jam 테스트 환경');
  if (withRelay) {
    if (!fs.existsSync(RELAY_JS)) {
      console.log(`  중계 서버   건너뜀: ${path.relative(ROOT, RELAY_JS)} 없음 (backend 저장소를 옆에 클론하면 같이 떠요)`);
    } else if (!(await canListen(RELAY_PORT))) {
      console.log(`  중계 서버   건너뜀: 포트 ${RELAY_PORT} 를 쓸 수 없음 (이미 실행 중이거나 Windows 예약 포트. JAM_DEV_RELAY_PORT 로 바꾸기)`);
    } else {
      run('relay', process.execPath, [RELAY_JS], { cwd: path.dirname(RELAY_JS), env: { ...process.env, PORT: String(RELAY_PORT) } });
      console.log(`  중계 서버   ws://127.0.0.1:${RELAY_PORT}  (호스트 앱 Jam 패널의 중계 서버 주소에 127.0.0.1:${RELAY_PORT})`);
    }
  }
  const cdp = debug ? await freePorts(CDP_BASE, names.length) : [];
  names.forEach((name, i) => {
    const args = [ROOT, `--user-data-dir=${path.join(PROFILES, name)}`];
    if (debug) {
      args.push(`--remote-debugging-port=${cdp[i]}`);
      // 자동 조작 중에 창이 가려지거나 최소화돼도 계속 그리게 한다 (안 그러면 입력·크기 변경이 멈춘다)
      args.push('--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows');
    }
    // 같은 PC 에서 같은 영상이 두 번 겹쳐 들리지 않게 게스트는 소리를 끈다 (--guest-audio 로 켜기)
    if (name !== 'host' && !flag('--guest-audio')) args.push('--mute-audio');
    run(name, electron, args, { env: { ...process.env, JAM_DEV_INSTANCE: name } });
    console.log(`  ${name.padEnd(10)}  프로필 .jam-dev/${name}${debug ? `  CDP ${cdp[i]}` : ''}`);
  });
  console.log('\n창 제목의 [host] · [guest] 로 구분해요. Ctrl+C 로 전부 종료.\n');
})();
