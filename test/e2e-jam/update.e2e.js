// E2E: 자동 업데이트 서명 확인 (패키지 앱 + 로컬 업데이트 서버)
//   node test/e2e-jam/update.e2e.js <앱 폴더>      — 먼저 npx electron-builder --win --dir, 환경 변수 JAM_BROWSER_RELEASE_KEY = 배포 비밀키
//  ① 배포 키로 서명한 "9.9.9" → 받고 서명 확인 → 준비됨   ② 다른 키로 서명한 것 → 거부하고 받은 파일 삭제
//  설치는 하지 않아요 (확인이 끝나면 앱을 강제로 끔 → 끌 때 설치 안 됨). 끝나면 업데이트 캐시도 지움
const P = require('./ports');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { signFile } = require('../../shared/update-sign');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const exe = path.join(app, 'dist', 'win-unpacked', 'Jam Browser.exe');
const keyPath = process.env.JAM_BROWSER_RELEASE_KEY;
if (!fs.existsSync(exe) || !keyPath) {
  console.log('건너뜀: 패키지 앱(dist/win-unpacked)과 JAM_BROWSER_RELEASE_KEY 가 필요해요');
  process.exit(0);
}
const feedDir = path.join(P.out, 'update-feed');
const cacheDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'jam-browser-updater');
const VERSION = '9.9.9';
const NAME = `JamBrowser-Setup-${VERSION}.exe`;

async function makeFeed(privPem) {
  fs.rmSync(feedDir, { recursive: true, force: true });
  fs.mkdirSync(feedDir, { recursive: true });
  const file = path.join(feedDir, NAME);
  fs.writeFileSync(file, crypto.randomBytes(512 * 1024)); // 진짜 설치 파일이 아님 (설치하지 않음)
  const buf = fs.readFileSync(file);
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
  fs.writeFileSync(path.join(feedDir, 'latest.yml'), `version: ${VERSION}\nfiles:\n  - url: ${NAME}\n    sha512: ${sha512}\n    size: ${buf.length}\npath: ${NAME}\nsha512: ${sha512}\nreleaseDate: '2026-11-19T00:00:00.000Z'\n`);
  fs.writeFileSync(`${file}.sig`, JSON.stringify(await signFile(privPem, VERSION, file)) + '\n');
}
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = path.join(feedDir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, ''));
      if (!f.startsWith(feedDir) || !fs.existsSync(f)) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
async function cdp(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page');
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => ws.once('open', r));
        let id = 0;
        const p = new Map();
        ws.on('message', (raw) => {
          const m = JSON.parse(raw);
          if (p.has(m.id)) p.get(m.id)(m), p.delete(m.id);
        });
        return {
          ev: (e) => new Promise((r) => { const n = ++id; p.set(n, (m) => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); }),
          close: () => ws.close(),
        };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('앱에 연결하지 못했어요');
}
async function runOnce(feedUrl, label, want) {
  const prof = path.join(P.out, 'ud-update');
  fs.rmSync(prof, { recursive: true, force: true });
  const child = spawn(exe, [`--remote-debugging-port=${P.host}`, `--user-data-dir=${prof}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], {
    env: { ...process.env, JAM_TEST_OFFSCREEN: '1', JAM_UPDATE_FEED: feedUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  try {
    const A = await cdp(P.host);
    const end = Date.now() + 90000;
    let st = null;
    while (Date.now() < end) {
      st = (await A.ev(`jamApp.appInfo().then(i => i.update)`)) || {};
      if (st.state === want) break;
      await sleep(500);
    }
    A.close();
    if (st.state !== want) throw new Error(`${label}: 상태 ${JSON.stringify(st)} (기대: ${want})\n${log.slice(-800)}`);
    if (/JAM-MAIN-ERROR/.test(log)) throw new Error(`${label}: 메인 프로세스 오류\n${log}`);
    return { st, log };
  } finally {
    child.kill(); // 강제 종료 → "끌 때 설치" 가 실행되지 않음
    await sleep(1500);
  }
}

(async () => {
  // --dir 빌드에는 업데이트 설정 파일이 없어요 (설치 파일 빌드만 만듦) → 테스트 동안만 넣어 둠
  const upd = path.join(path.dirname(exe), 'resources', 'app-update.yml');
  const madeUpd = !fs.existsSync(upd);
  if (madeUpd) fs.writeFileSync(upd, 'owner: jam-browser\nrepo: browser\nprovider: github\nupdaterCacheDirName: jam-browser-updater\n');
  process.on('exit', () => madeUpd && fs.rmSync(upd, { force: true }));
  const realKey = fs.readFileSync(keyPath, 'utf8');
  await makeFeed(realKey);
  const srv = await serve();
  const feed = `http://127.0.0.1:${srv.address().port}`;
  try {
    const a = await runOnce(feed, '정상 서명', 'ready');
    if (!a.st.verified || !/서명 확인됨/.test(a.log)) throw new Error('verified 표시 없음 ' + JSON.stringify(a.st));
    console.log(`✓ 배포 키로 서명한 ${VERSION}: 받기 → 서명 확인 → 준비됨 (${JSON.stringify(a.st)})`);

    // 다른 키로 서명 (공격자가 GitHub 릴리스를 바꾼 경우)
    const evil = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(path.join(feedDir, `${NAME}.sig`), JSON.stringify(await signFile(evil, VERSION, path.join(feedDir, NAME))) + '\n');
    const b = await runOnce(feed, '가짜 서명', 'error');
    if (!b.st.verifyFailed) throw new Error('서명 실패 표시 없음 ' + JSON.stringify(b.st));
    const left = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { recursive: true }).filter((f) => String(f).endsWith(NAME)) : [];
    if (left.length) throw new Error('거부한 파일이 남아 있어요: ' + left.join(', '));
    console.log(`✓ 다른 키로 서명한 ${VERSION}: 거부 ("${b.st.message}"), 받은 파일 삭제됨`);
    console.log('\nE2E update OK');
  } finally {
    srv.close();
    // 테스트용 9.9.9 가 업데이트 캐시에 남지 않게
    try {
      for (const f of fs.readdirSync(path.join(cacheDir, 'pending'))) {
        const full = path.join(cacheDir, 'pending', f);
        if (f.includes(VERSION) || (f === 'update-info.json' && fs.readFileSync(full, 'utf8').includes(VERSION))) fs.rmSync(full, { force: true });
      }
    } catch {}
  }
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e.message || e);
  process.exit(1);
});
