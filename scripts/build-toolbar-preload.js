'use strict';
// 앱 UI 창용 preload 를 만든다: 확장 아이콘 줄(<browser-action-list>) 을 쓸 수 있게 해 준다.
// 앱 창은 sandbox 라서 preload 에서 node_modules 를 require 할 수 없으므로,
// electron-chrome-extensions 의 browser-action 코드(electron 만 require)를 그대로 감싸 한 파일로 만든다.
// npm install / npm ci 뒤에 자동으로 실행된다 (postinstall).
const fs = require('fs');
const path = require('path');

const src = require.resolve('electron-chrome-extensions/browser-action', {
  paths: [path.join(__dirname, '..')],
});
const out = path.join(__dirname, '..', 'src', 'generated', 'toolbar-preload.js');

const code = fs.readFileSync(src, 'utf8');
const wrapped = `// 자동 생성 파일 (scripts/build-toolbar-preload.js). 직접 고치지 마세요.
'use strict';
(function () {
  const module = { exports: {} };
  const exports = module.exports;
${code}
  // 앱 UI 문서에서만 확장 아이콘 줄을 쓴다
  if (location.protocol === 'file:') module.exports.injectBrowserAction();
})();
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, wrapped);
console.log('toolbar preload ->', path.relative(process.cwd(), out));
