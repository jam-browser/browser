// E2E 용 파일 만들기: 5쪽 PDF, HTML 폴더(이미지 · 스크립트 · 둘째 페이지), 최소 SWF
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const out = path.join(__dirname, 'fixtures');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'site', 'img'), { recursive: true });

// ---- PDF (5쪽, 쪽마다 큰 글자 + 색 막대) ----
function makePdf(pages) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= pages; i++) {
    const body = `0.${i} 0.4 0.8 rg 50 700 500 60 re f BT /F1 48 Tf 0 0 0 rg 60 600 Td (Page ${i} of ${pages}) Tj ET BT /F1 14 Tf 60 560 Td (Jam Browser shared PDF test - searchable text ${i}) Tj ET`;
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`;
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
fs.writeFileSync(path.join(out, 'test-5p.pdf'), makePdf(5));

// ---- PNG (8x8 단색) ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.forEach((v, k) => (raw[y * (w * 3 + 1) + 1 + x * 3 + k] = v));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(out, 'site', 'img', 'dot.png'), png(8, 8, [255, 64, 0]));

// ---- HTML 폴더 ----
fs.writeFileSync(path.join(out, 'site', 'index.html'), `<!doctype html><meta charset="utf-8"><title>공유 HTML 테스트</title>
<link rel="stylesheet" href="style.css">
<h1 id="h">로컬 HTML</h1><img id="dot" src="img/dot.png" width="40" height="40"><p><a id="next" href="page2.html">다음 쪽</a></p>
<div style="height:2000px"></div><p id="bottom">끝</p>
<script src="app.js"></script>`);
fs.writeFileSync(path.join(out, 'site', 'style.css'), 'h1{color:rgb(0,128,0)}');
fs.writeFileSync(path.join(out, 'site', 'page2.html'), '<!doctype html><meta charset="utf-8"><title>둘째 쪽</title><h1>둘째 쪽</h1>');
fs.writeFileSync(path.join(out, 'site', 'app.js'), `window.__res = { script: true };
fetch('https://example.com/').then(() => (__res.fetch = 'reached')).catch(() => (__res.fetch = 'blocked'));
fetch('img/dot.png').then((r) => r.arrayBuffer()).then((b) => (__res.local = b.byteLength)).catch((e) => (__res.local = 'err ' + e.message));
try { const ws = new WebSocket('wss://example.com/'); ws.onerror = () => (__res.ws = 'blocked'); ws.onopen = () => (__res.ws = 'open'); } catch (e) { __res.ws = 'blocked'; }
const img = new Image(); img.onload = () => (__res.remoteImg = 'loaded'); img.onerror = () => (__res.remoteImg = 'blocked'); img.src = 'https://www.google.com/favicon.ico';
try { document.cookie = 'a=1'; __res.cookie = document.cookie; } catch (e) { __res.cookie = 'err'; }
`);
fs.writeFileSync(path.join(out, 'site', 'secret.exe'), 'MZ not really'); // 묶음에서 빠져야 함

// ---- SWF (배경색 + 프레임 하나) ----
function swf(r, g, b) {
  // RECT: Nbits=15, 0..11000 x 0..8000 twips (550x400)
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(15, 5); put(0, 15); put(11000, 15); put(0, 15); put(8000, 15);
  while (bits.length % 8) bits.push(0);
  const rect = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, i) => bit && (rect[i >> 3] |= 0x80 >> (i & 7)));
  const tag = (code, data) => {
    const h = Buffer.alloc(2);
    h.writeUInt16LE((code << 6) | data.length);
    return Buffer.concat([h, data]);
  };
  const body = Buffer.concat([rect, Buffer.from([0, 24]), Buffer.from([1, 0]), tag(9, Buffer.from([r, g, b])), tag(1, Buffer.alloc(0)), tag(0, Buffer.alloc(0))]);
  const head = Buffer.alloc(8);
  head.write('FWS', 0, 'latin1');
  head[3] = 10;
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}
fs.writeFileSync(path.join(out, 'game.swf'), swf(0, 160, 255));
// 사이트 보호 E2E 용 차단 목록 (테스트 모드에서는 인터넷 목록 대신 이것)
fs.writeFileSync(path.join(out, 'blocklist.txt'), ['/trk.js', '/trk.gif', ''].join('\n'));
console.log('fixtures in', out);
