'use strict';
/**
 * 같이 보는 파일 (설계안 3단계) — 메인 프로세스
 *
 *  - 호스트가 고른 로컬 파일(PDF · HTML(+폴더) · 이미지 · 텍스트 · SWF)을 메모리에만 보관하고
 *    jamfile://<파일ID>/ 주소로 보여 준다. 다운로드 폴더 · 디스크에는 저장하지 않는다.
 *  - 파일은 "묶음(pack)" 하나로 다룬다: 'JFP1' + 머리 길이(4바이트) + 머리 JSON + 내용들.
 *    Jam 으로 보낼 때도 이 묶음 그대로 보내고, SHA-256 으로 확인한다.
 *  - jamfile:// 응답에는 CSP 를 붙여 인터넷 접속을 막는다 (공유 HTML 의 스크립트가 밖으로 보낼 수 없음).
 *    PDF 는 pdf.js 로 그려서 PDF 안의 스크립트를 실행하지 않는다. SWF 는 Ruffle(네트워크 끔)로.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEME = 'jamfile';
// 한도는 설정(같이 보는 파일)에서 바꿈 — setLimits. 기본은 넉넉하게
const LIM = { pack: 2048 * 1024 * 1024, store: 8192 * 1024 * 1024, entries: 5000, depth: 8, htmlNet: false };
const mbText = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(b % 1024 ** 3 ? 1 : 0)}GB` : `${Math.round(b / 1024 / 1024)}MB`);
const tooBig = () => new Error(`파일이 너무 커요 (최대 ${mbText(LIM.pack)}, 설정 → 같이 보는 파일)`);
const FID_RE = /^[a-z0-9]{16}$/;

const MIME = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', xml: 'text/xml; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm', swf: 'application/x-shockwave-flash',
};
// 한 파일로 공유할 수 있는 형식 → 종류
const KIND_OF = {
  pdf: 'pdf', html: 'html', htm: 'html',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  txt: 'text', md: 'text', csv: 'text', log: 'text', json: 'text',
  swf: 'swf',
};
// HTML 폴더 묶음에 같이 넣을 수 있는 형식 (실행 파일 · 소리 · 동영상은 빼요)
const BUNDLE_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md', 'csv', 'xml', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'wasm', 'swf', 'pdf']);

const extOf = (p) => path.extname(String(p)).slice(1).toLowerCase();
const mimeOf = (p) => MIME[extOf(p)] || 'application/octet-stream';
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>:"|?*\\/]/g, '_').slice(0, 120) || 'file';
const newFid = () => Array.from(crypto.randomBytes(16), (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');

// ---------- 묶음 ----------
function pack(entries, entry) {
  let off = 0;
  const list = entries.map((e) => {
    const r = { p: e.p, o: off, l: e.bytes.length };
    off += e.bytes.length;
    return r;
  });
  const head = Buffer.from(JSON.stringify({ v: 1, entry, entries: list }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return Buffer.concat([Buffer.from('JFP1'), len, head, ...entries.map((e) => e.bytes)]);
}
function validPath(p) {
  if (typeof p !== 'string' || !p || p.length > 300 || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s && s !== '.' && s !== '..' && !/[\u0000-\u001f]/.test(s));
}
/** 묶음 풀기 — 형식이 이상하면 throw */
function unpack(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.length > LIM.pack || buf.toString('latin1', 0, 4) !== 'JFP1') throw new Error('bad pack');
  const hl = buf.readUInt32BE(4);
  if (hl > 512 * 1024 || 8 + hl > buf.length) throw new Error('bad head');
  const head = JSON.parse(buf.toString('utf8', 8, 8 + hl));
  if (!head || head.v !== 1 || !Array.isArray(head.entries) || !head.entries.length || head.entries.length > LIM.entries) throw new Error('bad head');
  const base = 8 + hl;
  const entries = new Map();
  for (const e of head.entries) {
    if (!validPath(e.p) || !Number.isInteger(e.o) || !Number.isInteger(e.l) || e.o < 0 || e.l < 0 || base + e.o + e.l > buf.length) throw new Error('bad entry');
    entries.set(e.p, buf.subarray(base + e.o, base + e.o + e.l));
  }
  if (!entries.has(head.entry)) throw new Error('no entry');
  return { entry: head.entry, entries };
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// HTML 이 있는 폴더를 묶음 (하위 폴더 LIM.depth 까지, 허용 형식만)
function collectFolder(dir) {
  const out = [];
  let total = 0;
  const walk = (d, rel, depth) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const full = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (depth < LIM.depth) walk(full, r, depth + 1);
      } else if (ent.isFile() && BUNDLE_EXT.has(extOf(ent.name))) {
        const st = fs.statSync(full);
        total += st.size;
        if (total > LIM.pack) throw tooBig();
        if (out.length >= LIM.entries) throw new Error(`파일이 너무 많아요 (최대 ${LIM.entries}개, 설정 → 같이 보는 파일)`);
        out.push({ p: r, bytes: fs.readFileSync(full) });
      }
    }
  };
  walk(dir, '', 0);
  return out;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CSP = [
  "default-src 'self' jamfile: data: blob:",
  "script-src 'self' jamfile: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' jamfile: 'unsafe-inline' data:",
  "img-src 'self' jamfile: data: blob:",
  "font-src 'self' jamfile: data:",
  "connect-src 'self' jamfile: data: blob:", // ← 인터넷으로 보내는 요청(fetch · XHR · WebSocket) 차단
  "media-src 'none'", // 소리 · 동영상 없음
  "worker-src 'self' jamfile: blob:",
  "frame-src 'self' jamfile: data: blob:",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ');
// 호스트가 "인터넷 허용" 을 켜고 공유한 HTML: https 로만 바깥 요청 허용 (소리 · 동영상 · 플러그인 · 양식 보내기는 그대로 막음)
const CSP_NET = [
  "default-src 'self' jamfile: data: blob: https:",
  "script-src 'self' jamfile: blob: https: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' jamfile: https: 'unsafe-inline' data:",
  "img-src 'self' jamfile: data: blob: https:",
  "font-src 'self' jamfile: data: https:",
  "connect-src 'self' jamfile: data: blob: https: wss:",
  "media-src 'none'",
  "worker-src 'self' jamfile: blob:",
  "frame-src 'self' jamfile: data: blob: https:",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ');

function setupJamFiles({ ipcMain, dialog, getWindow, getSession, appDir }) {
  const debugLog = process.env.JAM_TEST_OFFSCREEN ? (m) => console.log(m) : null;
  const store = new Map(); // fid → { fid, name, kind, size, sha, entry, entries, pack, at, count }
  const fromApp = (e) => {
    const w = getWindow();
    return !!w && e.sender === w.webContents;
  };
  const nm = (...p) => path.join(appDir, 'node_modules', ...p);
  const ASSETS = {
    // /_jam/<경로> → 앱 안의 파일 (정해진 폴더만)
    'pdfjs/build/': nm('pdfjs-dist', 'build'),
    'pdfjs/cmaps/': nm('pdfjs-dist', 'cmaps'),
    'pdfjs/standard_fonts/': nm('pdfjs-dist', 'standard_fonts'),
    'pdfjs/wasm/': nm('pdfjs-dist', 'wasm'),
    'pdfjs/iccs/': nm('pdfjs-dist', 'iccs'),
    'ruffle/': nm('@ruffle-rs', 'ruffle'),
    '': path.join(appDir, 'src', 'viewer'),
  };

  function keep(rec) {
    store.set(rec.fid, rec);
    // 메모리 한도: 오래된 것부터 정리
    let total = 0;
    for (const r of store.values()) total += r.size;
    for (const r of [...store.values()].sort((a, b) => a.at - b.at)) {
      if (total <= LIM.store || r.fid === rec.fid) continue;
      store.delete(r.fid);
      total -= r.size;
    }
    return meta(rec);
  }
  const meta = (r) => ({ fid: r.fid, name: r.name, kind: r.kind, size: r.size, sha: r.sha, entry: r.entry, count: r.count, net: r.net });
  // net: 인터넷 허용 (HTML 만, 호스트가 공유할 때 켬)
  function record(fid, name, kind, buf, net = false) {
    const { entry, entries } = unpack(buf);
    return { fid, name: cleanName(name), kind, size: buf.length, sha: sha256(buf), entry, entries, pack: buf, at: Date.now(), count: entries.size, net: kind === 'html' && net === true };
  }
  function fromFile(file, withFolder, net = false) {
    const kind = KIND_OF[extOf(file)];
    if (!kind) throw new Error('공유할 수 없는 형식이에요 (PDF · HTML · 이미지 · 텍스트 · SWF 만)');
    const name = path.basename(file);
    let buf;
    if (kind === 'html' && withFolder) {
      const dir = path.dirname(file);
      const entries = collectFolder(dir);
      const entry = path.relative(dir, file).split(path.sep).join('/');
      if (!entries.some((e) => e.p === entry)) entries.push({ p: entry, bytes: fs.readFileSync(file) });
      buf = pack(entries, entry);
    } else {
      const st = fs.statSync(file);
      if (st.size > LIM.pack) throw tooBig();
      const p = kind === 'html' ? cleanName(name) : 'file';
      buf = pack([{ p, bytes: fs.readFileSync(file) }], p);
    }
    if (buf.length > LIM.pack) throw tooBig();
    return keep(record(newFid(), name, kind, buf, net));
  }

  // 호스트: 파일 고르기
  ipcMain.handle('file:pick', async (e) => {
    if (!fromApp(e)) return null;
    const r = await dialog.showOpenDialog(getWindow(), {
      title: 'Jam 에 공유할 파일',
      properties: ['openFile'],
      filters: [
        { name: '공유할 수 있는 파일', extensions: Object.keys(KIND_OF) },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'HTML', extensions: ['html', 'htm'] },
        { name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'Flash (SWF)', extensions: ['swf'] },
      ],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    let withFolder = false;
    let net = false;
    if (KIND_OF[extOf(file)] === 'html') {
      const c = await dialog.showMessageBox(getWindow(), {
        type: 'question',
        buttons: ['폴더의 이미지 · 스크립트도 함께', '이 파일만', '취소'],
        defaultId: 0,
        cancelId: 2,
        title: 'HTML 공유',
        message: '같은 폴더에 있는 이미지 · 스타일 · 스크립트도 함께 공유할까요?',
        detail: `${path.dirname(file)}\n(하위 폴더 ${LIM.depth}단계까지, 최대 ${mbText(LIM.pack)} · ${LIM.entries}개. 실행 파일 · 소리 · 동영상은 빼요)`,
        checkboxLabel: '인터넷 접속 허용 (https 의 이미지 · 스크립트 · API). 참여자에게 표시돼요',
        checkboxChecked: LIM.htmlNet,
      });
      if (c.response === 2) return null;
      withFolder = c.response === 0;
      net = !!c.checkboxChecked;
    }
    try {
      return fromFile(file, withFolder, net);
    } catch (err) {
      return { error: err.message };
    }
  });
  // 테스트 · 자동화용: 경로로 바로 (앱 화면에서만)
  ipcMain.handle('file:from-path', (e, file, withFolder, net) => {
    if (!fromApp(e) || !process.env.JAM_TEST_OFFSCREEN) return null;
    try {
      return fromFile(String(file), !!withFolder, net === true);
    } catch (err) {
      return { error: err.message };
    }
  });
  // 웹의 PDF 를 Jam 파일로 (그 탭의 세션 = 내 로그인 쿠키로 받아서 내 PC 메모리에만)
  ipcMain.handle('file:from-web', async (e, url) => {
    if (!fromApp(e) || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { error: '주소가 이상해요' };
    try {
      const res = await getSession().fetch(url, { redirect: 'follow' });
      if (!res.ok) return { error: `받지 못했어요 (${res.status})` };
      const len = Number(res.headers.get('content-length') || 0);
      if (len > LIM.pack) return { error: tooBig().message };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > LIM.pack) return { error: tooBig().message };
      if (bytes.toString('latin1', 0, 5) !== '%PDF-') return { error: 'PDF 파일이 아니에요' };
      let name = decodeURIComponent(new URL(res.url || url).pathname.split('/').pop() || 'document.pdf');
      if (!/\.pdf$/i.test(name)) name += '.pdf';
      return keep(record(newFid(), name, 'pdf', pack([{ p: 'file', bytes }], 'file')));
    } catch (err) {
      return { error: err.message };
    }
  });
  // 호스트: 보낼 묶음
  ipcMain.handle('file:bytes', (e, fid) => {
    if (!fromApp(e)) return null;
    const r = store.get(String(fid));
    return r ? new Uint8Array(r.pack.buffer, r.pack.byteOffset, r.pack.length) : null;
  });
  // 참여자: 받은 묶음 보관 (해시 · 형식 확인)
  ipcMain.handle('file:store', (e, m, bytes) => {
    if (!fromApp(e) || !m || !FID_RE.test(String(m.fid))) return { error: 'bad' };
    if (!['pdf', 'html', 'image', 'text', 'swf'].includes(m.kind)) return { error: 'bad kind' };
    const buf = Buffer.from(bytes);
    if (buf.length !== m.size || sha256(buf) !== m.sha) return { error: '받은 파일이 손상됐어요 (해시 불일치)' };
    try {
      return keep(record(m.fid, m.name, m.kind, buf, m.net === true));
    } catch (err) {
      return { error: `파일 형식이 이상해요: ${err.message}` };
    }
  });
  ipcMain.handle('file:has', (e, fid) => fromApp(e) && store.has(String(fid)));
  ipcMain.handle('file:drop', (e, fid) => {
    if (fromApp(e)) store.delete(String(fid));
  });

  // ---------- jamfile:// ----------
  const respond = (body, type, status = 200, extra = {}, net = false) =>
    new Response(body, { status, headers: { 'Content-Type': type, 'Content-Security-Policy': net ? CSP_NET : CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra } });
  const notFound = () => respond('없는 파일이에요', 'text/plain; charset=utf-8', 404);
  function asset(rel) {
    for (const [prefix, dir] of Object.entries(ASSETS)) {
      if (!rel.startsWith(prefix)) continue;
      const sub = rel.slice(prefix.length);
      if (!validPath(sub)) return null;
      const full = path.join(dir, ...sub.split('/'));
      if (!full.startsWith(dir + path.sep)) return null;
      try {
        return respond(fs.readFileSync(full), mimeOf(full));
      } catch {
        return null;
      }
    }
    return null;
  }
  function page(r) {
    const title = esc(r.name);
    if (r.kind === 'pdf') return asset('pdf.html');
    if (r.kind === 'swf') return asset('swf.html');
    if (r.kind === 'html') return respond(null, 'text/plain', 302, { Location: `/${r.entry.split('/').map(encodeURIComponent).join('/')}` });
    if (r.kind === 'image') {
      return respond(`<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;background:#1b1b1b;display:grid;place-items:center;min-height:100vh}img{max-width:100%;height:auto;display:block}</style><img src="/file" alt="${title}">`, 'text/html; charset=utf-8');
    }
    if (r.kind === 'text') {
      const text = r.entries.get('file').toString('utf8');
      return respond(`<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;background:#fff;color:#111}pre{margin:0;padding:24px 32px;font:14px/1.6 Consolas,"Malgun Gothic",monospace;white-space:pre-wrap;word-break:break-word}</style><pre>${esc(text)}</pre>`, 'text/html; charset=utf-8');
    }
    return notFound();
  }
  function handle(req) {
    let u;
    try {
      u = new URL(req.url);
    } catch {
      return notFound();
    }
    const fid = u.hostname;
    // 일반 웹페이지가 jamfile:// 를 불러오거나(<img>, <iframe>, fetch) 링크로 여는 것은 막는다.
    // 앱이 직접 여는 이동(Sec-Fetch-Site: none)과 jamfile 페이지 안에서의 요청만 허용
    const fetchSite = req.headers.get('sec-fetch-site');
    const ref = req.referrer && req.referrer !== 'about:client' ? req.referrer : req.headers.get('referer') || '';
    const fromJamfile = ref.startsWith(`${SCHEME}://`);
    if ((fetchSite && fetchSite !== 'none' && fetchSite !== 'same-origin' && !fromJamfile) || (ref && !fromJamfile)) {
      if (debugLog) debugLog(`jamfile blocked ${req.url} site=${fetchSite} ref=${ref}`);
      return respond('웹페이지에서는 공유 파일을 열 수 없어요', 'text/plain; charset=utf-8', 403);
    }
    let rel;
    try {
      rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    } catch {
      return notFound();
    }
    if (rel.startsWith('_jam/')) return asset(rel.slice(5)) || notFound();
    const r = store.get(fid);
    if (!FID_RE.test(fid) || !r) {
      return respond('<!doctype html><meta charset="utf-8"><title>파일 없음</title><body style="font:15px sans-serif;padding:40px">이 파일은 아직 받지 않았거나 지워졌어요. Jam 패널의 📎 파일 목록에서 받아 주세요.</body>', 'text/html; charset=utf-8', 404);
    }
    r.at = Date.now();
    if (!rel) return page(r) || notFound();
    if (rel === '_meta') return respond(JSON.stringify(meta(r)), 'application/json; charset=utf-8');
    if (rel === 'file' && r.entries.has('file')) return respond(r.entries.get('file'), r.kind === 'pdf' ? 'application/pdf' : mimeOf(r.name));
    let b = r.entries.get(rel);
    if (!b) {
      // Windows 에서 만든 HTML 은 대소문자가 틀린 링크가 흔함
      const low = rel.toLowerCase();
      for (const [p, v] of r.entries) if (p.toLowerCase() === low) b = v;
    }
    return b ? respond(b, mimeOf(rel), 200, {}, r.net) : notFound();
  }

  return {
    attach(ses) {
      ses.protocol.handle(SCHEME, handle);
      // 요청한 화면(frame)의 주소로 한 번 더 막기: 일반 웹페이지 안에서 jamfile:// 를 <img> · <iframe> 등으로 불러오는 것
      // (referrer 를 안 보내는 요청도 여기서 걸림). 앱이 직접 여는 이동(mainFrame)은 그대로
      // (실제 등록은 main.js 의 onBeforeRequest 하나에서 blockedRequest 를 부름)
    },
    blockedRequest(d) {
      if (d.resourceType === 'mainFrame') return false;
      let from = '';
      try {
        const f = d.frame;
        from = (d.resourceType === 'subFrame' ? f && f.parent && f.parent.url : f && f.url) || '';
      } catch {}
      if (from && !from.startsWith(`${SCHEME}://`)) {
        if (debugLog) debugLog(`jamfile blocked (frame) ${d.url} from=${from}`);
        return true;
      }
      return false;
    },
    has: (fid) => store.has(fid),
    // 설정(shared/prefs.js) 적용
    setLimits(pr) {
      const MB = 1024 * 1024;
      if (pr.fileMaxMB) LIM.pack = pr.fileMaxMB * MB;
      if (pr.fileRoomMaxMB) LIM.store = Math.max(pr.fileRoomMaxMB * MB, LIM.pack);
      if (pr.fileFolderMax) LIM.entries = pr.fileFolderMax;
      LIM.htmlNet = pr.fileHtmlNetDefault === true;
    },
    _internal: { pack, unpack, store },
  };
}

module.exports = { setupJamFiles, SCHEME, pack, unpack, FID_RE, KIND_OF, LIM };
