// 앱 아이콘 만들기: npx electron scripts/make-icon.js  →  build/icon.png (512×512)
// (electron-builder 가 이 PNG 로 Windows 아이콘(.ico)을 만든다)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 512;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2ee6a6"/><stop offset="0.55" stop-color="#1f8fd6"/><stop offset="1" stop-color="#7b4dff"/>
    </linearGradient>
  </defs>
  <rect x="24" y="24" width="464" height="464" rx="112" fill="url(#g)"/>
  <!-- 함께 보는 두 개의 커서 -->
  <path d="M150 120 L150 330 L205 280 L240 365 L275 350 L240 268 L320 268 Z" fill="#ffffff" stroke="#0b2a3a" stroke-width="10" stroke-linejoin="round"/>
  <path d="M290 190 L290 360 L334 320 L362 388 L390 376 L362 310 L426 310 Z" fill="#ffd43b" stroke="#0b2a3a" stroke-width="10" stroke-linejoin="round"/>
</svg>`;

// 숨긴 창의 화면 캡처는 멈출 수 있어서, 페이지 안에서 SVG → 캔버스 → PNG 로 변환한다
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 200, height: 200, show: false });
  await win.loadURL('data:text/html;charset=utf-8,<body></body>');
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = ${SIZE};
      c.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('svg load failed'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
  })`);
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('saved', out);
  app.exit(0);
});
