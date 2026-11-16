// Local test site for Jam Browser E2E: login-gated video page, clipboard page, test download.
const http = require('http');
const VIDEO = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.480p.vp9.webm';
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px sans-serif;margin:30px">${body}</body>`;
const loggedIn = (req) => /(^|;\s*)session=ok/.test(req.headers.cookie || '');
// harmless command-like text, used only to check that the browser shows its warning
const SAMPLE = ['c', 'md', ' /c ', 'echo jam-browser-clipboard-test'].join('');

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const html = (s, code = 200, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
      res.end(s);
    };
    if (req.method === 'POST' && u.pathname === '/login') return html('', 302, { Location: '/do-login' });
    if (u.pathname === '/') return html(page('Home', `<h1>Home</h1><p>${loggedIn(req) ? 'logged in' : 'guest'}</p>`));
    if (u.pathname === '/video') {
      if (!loggedIn(req)) return html('', 302, { Location: '/login?next=%2Fvideo' });
      return html(page('Members video', `<h1>Members video</h1><video src="${VIDEO}" controls autoplay muted width="800" height="450"></video>`));
    }
    if (u.pathname === '/login') {
      return html(page('Login', `<h1>Login</h1><form method="post" action="/login"><input name="u" value="me"><button>Log in</button></form>`));
    }
    if (u.pathname === '/do-login') return html('', 302, { 'Set-Cookie': 'session=ok; Path=/', Location: '/' });
    if (u.pathname === '/clip') {
      return html(page('Copy test', `<h1>Copy test</h1><button id="b" onclick="navigator.clipboard.writeText(document.getElementById('t').textContent)">Copy</button><code id="t">${SAMPLE}</code>`));
    }
    if (u.pathname === '/tool.exe') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="tool.exe"' });
      return res.end(Buffer.from('not a real program - jam browser download test'));
    }
    if (u.pathname === '/autodl') {
      return html(page('Auto download', `<h1>Downloading</h1><script>setTimeout(() => location.href = '/tool.exe', 1500)</script>`));
    }
    if (u.pathname === '/long') {
      const paras = Array.from({ length: 60 }, (_, i) => `<h2 id="s${i}">Section ${i}</h2><p>${'Lorem ipsum dolor sit amet. '.repeat(30)}</p>`).join('');
      return html(page('Long page', paras));
    }
    html('not found', 404);
  })
  .listen(8765, '127.0.0.1', () => console.log('test site on 8765'));
