// E2E 용 로컬 테스트 사이트 (127.0.0.1:8766): 로그인 폼 · 게임 화면 · 보안 패널 · 긴 페이지 · PDF
const http = require('http');
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px sans-serif;margin:30px">${body}</body>`;
http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/doc.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'test-5p.pdf')));
    }
    // 사이트 보호 E2E: 추적기(목록: fixtures/blocklist.txt) · 서드파티 쿠키 · 권한
    if (u.pathname === '/trk.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end('window.__trk = 1;');
    }
    if (u.pathname === '/trk.gif' || u.pathname === '/ok.gif') {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    }
    if (u.pathname === '/setck') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'jamck=yes; Path=/; Max-Age=3600; SameSite=None; Secure' });
      return res.end(page('Set cookie', '<h1>cookie set</h1>'));
    }
    if (u.pathname === '/showck') {
      global.__lastCookie = { cookie: req.headers.cookie || '', at: Date.now() };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page('Show cookie', 'cookie: ' + (req.headers.cookie || '(none)')));
    }
    if (u.pathname === '/lastck') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(global.__lastCookie || null));
    if (u.pathname === '/track') {
      const other = u.searchParams.get('other') || (req.headers.host.startsWith('127.') ? 'http://localhost:8766' : 'http://127.0.0.1:8766');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page('Track', `<h1>Tracked page</h1><script src="${other}/trk.js"></script><img src="${other}/trk.gif"><img src="${other}/ok.gif" id="ok">
<iframe src="${other}/showck" width="300" height="60"></iframe>`));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (u.pathname === '/pwlogin') {
      return res.end(page('PW Login', `<h1>Sign in</h1><form method="post" action="/pwdone">
        <p><input id="user" name="user" type="text" placeholder="id" style="width:240px;height:30px"></p>
        <p><input id="pass" name="pass" type="password" placeholder="password" style="width:240px;height:30px"></p>
        <button id="go" type="submit">Sign in</button></form>`));
    }
    if (u.pathname === '/pwdone') return res.end(page('Welcome', '<h1>Signed in</h1>'));
    if (u.pathname === '/game') {
      // 움직이는 화면 + 받은 키 · 클릭 기록 (화면 미러링 E2E 용)
      return res.end(page('Test Game', `<canvas id="c" width="640" height="360" style="display:block"></canvas><div id="log"></div>
<script>
window.__log = [];
const c = document.getElementById('c'), x = c.getContext('2d'); let t = 0;
(function draw(){ t++; x.fillStyle = 'hsl(' + (t * 3 % 360) + ',70%,50%)'; x.fillRect(0, 0, 640, 360); x.fillStyle = '#000'; x.font = '40px sans-serif'; x.fillText('frame ' + t, 20, 60); requestAnimationFrame(draw); })();
addEventListener('keydown', (e) => __log.push('d:' + e.code + ':' + e.key));
addEventListener('keyup', (e) => __log.push('u:' + e.code));
addEventListener('mousedown', (e) => __log.push('m:' + e.clientX + ',' + e.clientY + ':' + e.button));
</script>`));
    }
    if (u.pathname === '/doc.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(require('fs').readFileSync(require('path').join(__dirname, '..', 'fixtures', 'test-5p.pdf')));
    }
    if (u.pathname === '/long') {
      // 핑 E2E: 긴 페이지 (위 · 아래에 표시할 곳)
      return res.end(page('Long', `<h1 id="top">위쪽 제목</h1><p id="t1">첫 문단 — 여기에 핑을 찍어요</p><div style="height:3000px"></div><p id="t2">아래 문단</p>
<script>window.__log=[]; for (const id of ['top','t1','t2']) document.getElementById(id).addEventListener('click', () => __log.push('c:' + id));</script>`));
    }
    if (u.pathname === '/panel') {
      // 미러링 보안 E2E: 게임 버튼 · 결제 버튼 · 내 정보 링크 · 일반 칸 · 비밀번호 칸
      return res.end(page('Panel', `<div style="display:grid;grid-template-columns:repeat(3,200px);gap:20px">
<button id="next" style="height:60px">다음 판</button>
<button id="pay" style="height:60px">결제하기</button>
<a id="me" href="/account" style="display:block;height:60px;background:#ddd">내 정보</a>
<input id="q" name="q" style="height:40px" placeholder="검색">
<form onsubmit="return false"><input id="pw" type="password" style="height:40px"></form>
<div id="txt" style="height:60px">그냥 글자</div>
<button id="gear" class="icon-btn" style="height:60px"><img src="/icons/settings.svg" width="24" height="24" alt=""></button></div>
<script>window.__log=[];
for (const id of ['next','pay','me','txt','gear']) document.getElementById(id).addEventListener('click', (e) => { __log.push('c:' + id); if (id === 'me') e.preventDefault(); });
for (const id of ['q','pw']) { const el = document.getElementById(id); el.addEventListener('focus', () => __log.push('f:' + id)); el.addEventListener('input', () => __log.push('i:' + id + ':' + el.value.length)); }
</script>`));
    }
    res.end(page('Home', '<h1>Home</h1>'));
  })
  .listen(8766, '127.0.0.1', () => console.log('pw site on 8766'));
