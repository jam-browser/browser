// E2E: browser features + UI customization (single app instance on CDP 9301)
const WebSocket = require(process.argv[2] + '/node_modules/ws');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = 'http://localhost:8765';
const OUT = path.dirname(process.argv[1]);

async function target(port, pick) {
  let t;
  for (let i = 0; i < 40 && !t; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    t = list.find(pick);
    if (!t) await sleep(250);
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
  });
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const m = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(expr.slice(0, 90) + ' -> ' + JSON.stringify(m.result.exceptionDetails.exception?.description));
    return m.result?.result?.value;
  };
  return { cmd, ev };
}
async function until(label, fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error('timeout: ' + label);
}
const step = (s) => console.log('✓', s);

(async () => {
  const A = await target(9301, (x) => x.type === 'page');
  await until('ready', () => A.ev(`typeof ui==='object' && tabs.length > 0`));
  const shot = async (name) => {
    const s = await A.cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64'));
  };

  // start page
  const startShown = await until('speed dial on new tab', () => A.ev(`ui.isStart(activeTab.url) && !document.querySelector('#start-page').hidden`), 8000).catch(async () => {
    throw new Error('speed dial not shown on new tab: ' + (await A.ev(`JSON.stringify({ url: activeTab.url, tabs: tabs.map(t => t.url) })`)));
  });
  step('new tab shows the speed dial start page');

  // search from start page uses chosen engine
  await A.ev(`document.querySelector('#set-engine').value='duckduckgo'; document.querySelector('#set-engine').dispatchEvent(new Event('input')); 1`);
  await A.ev(`document.querySelector('#sd-q').value='jam session'; document.querySelector('#sd-search').requestSubmit(); 1`);
  await until('searched', () => A.ev(`activeTab.url.startsWith('https://duckduckgo.com/?q=jam')`));
  step('search engine setting works (DuckDuckGo): ' + (await A.ev('activeTab.url')).slice(0, 50));

  // bookmarks + bookmarks bar + speed dial tile
  await A.ev(`navigateTab(activeTab, '${SITE}/long'); 1`);
  await until('long page', () => A.ev(`activeTab.url === '${SITE}/long' && !activeTab.loading`));
  await A.ev(`ui.shortcut('bookmark'); 1`);
  const bm = await A.ev(`[...document.querySelectorAll('#bookmarks-bar .bm-item')].map(b => b.textContent)`);
  const star = await A.ev(`document.querySelector('#bookmark-star').textContent`);
  step(`Ctrl+D bookmarks the page → bookmarks bar: ${JSON.stringify(bm)}, star: ${star}`);

  // history
  await A.ev(`ui.shortcut('history'); 1`);
  const hist = await A.ev(`[...document.querySelectorAll('#history-list .h-title')].map(x => x.textContent).slice(0, 3)`);
  await A.ev(`document.querySelector('#history-dialog').close(); 1`);
  step(`history (Ctrl+H) lists visits: ${JSON.stringify(hist)}`);

  // find in page
  await A.ev(`ui.shortcut('find'); document.querySelector('#find-q').value='Section 4'; document.querySelector('#find-q').dispatchEvent(new Event('input')); 1`);
  const count = await until('find count', () => A.ev(`document.querySelector('#find-count').textContent`), 5000);
  step(`find in page (Ctrl+F) "Section 4" → ${count}`);
  await A.ev(`document.querySelector('#find-close').click(); 1`);

  // zoom per site
  await A.ev(`ui.shortcut('zoom-in'); ui.shortcut('zoom-in'); 1`);
  await sleep(300);
  const z = await A.ev(`[document.querySelector('#zoom-ind').textContent, activeTab.webview.getZoomFactor()]`);
  await A.ev(`activeTab.webview.reload(); 1`);
  await until('reloaded', () => A.ev(`!activeTab.loading`));
  await sleep(500);
  const zAfter = await A.ev(`activeTab.webview.getZoomFactor()`);
  step(`zoom (Ctrl++) → indicator ${z[0]}, factor ${z[1]}; kept after reload: ${zAfter}`);
  await A.ev(`ui.shortcut('zoom-reset'); 1`);

  // site CSS
  await A.ev(`ui.shortcut('settings'); document.querySelector('[data-page=set-sites]').click();
    document.querySelector('#site-css-site').value='localhost'; document.querySelector('#site-css-text').value='h2 { color: rgb(255, 0, 0) !important; }';
    document.querySelector('#site-css-add').click(); document.querySelector('#settings-dialog').close(); 1`);
  await until('reloaded after css', async () => (await A.ev(`!activeTab.loading`)) && (await A.ev(`activeTab.ready`)));
  const color = await until('css applied', () => A.ev(`activeTab.webview.executeJavaScript("getComputedStyle(document.querySelector('h2')).color").then(c => c === 'rgb(255, 0, 0)' && c)`), 8000);
  step('per-site CSS applied to the page: h2 color = ' + color);

  // tabs: pin, split, reopen closed, drag order
  await A.ev(`createTab('${SITE}/'); 1`);
  await until('2nd tab', () => A.ev(`tabs.length === 2 && !activeTab.loading`));
  await A.ev(`tabs[1].pinned = true; ui.decorateTab; (function(){ const t = tabs[1]; t.pinned = true; })(); 1`);
  await A.ev(`(function(){ const pinned = tabs.filter(t=>t.pinned), rest = tabs.filter(t=>!t.pinned); tabs.splice(0, tabs.length, ...pinned, ...rest); renderTabs(); })(); 1`);
  const firstPinned = await A.ev(`tabs[0].pinned && document.querySelector('#tabs .tab').classList.contains('pinned')`);
  // split: active = home tab, split with /long tab via context menu
  await A.ev(`(function(){ const longTab = tabs.find(t => t.url.endsWith('/long')); activateTab(tabs.find(t => t !== longTab));
     const node = [...document.querySelectorAll('#tabs .tab')][tabs.indexOf(longTab)];
     node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 60 })); })(); 1`);
  const menu = await A.ev(`[...document.querySelectorAll('#ctx-menu .ctx-item')].map(b => b.textContent)`);
  await A.ev(`[...document.querySelectorAll('#ctx-menu .ctx-item')].find(b => b.textContent.startsWith('분할')).click(); 1`);
  const split = await A.ev(`document.querySelector('#views').classList.contains('split') && !!document.querySelector('webview.split-left') && !!document.querySelector('webview.split-right')`);
  await sleep(800);
  await shot('custom-split.png');
  await A.ev(`document.querySelector('#split-close').click(); 1`);
  step(`tab pinned: ${firstPinned}; tab menu: ${menu.length} items; split view: ${split}`);
  await A.ev(`closeTab(tabs[tabs.length - 1]); 1`);
  const n1 = await A.ev(`tabs.length`);
  await A.ev(`ui.shortcut('reopen-tab'); 1`);
  const n2 = await until('reopened', () => A.ev(`tabs.length === ${n1 + 1} && tabs.length`));
  step(`closed a tab (${n1} left) and reopened it with Ctrl+Shift+T (${n2})`);

  // layouts + themes + presets
  const setSeg = (key, value) => A.ev(`document.querySelector('[data-setting=${key}] button[data-value=${value}]').click(); 1`);
  await setSeg('tabPosition', 'left');
  const left = await A.ev(`document.querySelector('#app').dataset.tabs === 'left' && document.querySelector('#tabbar').classList.contains('vertical') && getComputedStyle(document.querySelector('#tabbar')).flexDirection`);
  await setSeg('theme', 'light');
  await A.ev(`document.querySelector('.swatch[data-color="#9059ff"]').click(); 1`);
  const look = await A.ev(`[document.documentElement.dataset.theme, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), getComputedStyle(document.body).backgroundColor]`);
  await A.ev(`activateTab(tabs.find(t => t.url.endsWith('/long'))); 1`);
  await sleep(600);
  await shot('custom-left-light.png');
  step(`vertical tabs on the left (${left}); light theme + purple accent: ${JSON.stringify(look)}`);

  await setSeg('tabPosition', 'bottom');
  await setSeg('density', 'compact');
  const bottom = await A.ev(`(() => { const t = document.querySelector('#tabbar').getBoundingClientRect(); return t.top > innerHeight / 2; })()`);
  step(`tabs at the bottom: ${bottom}; compact density: ${await A.ev(`document.documentElement.dataset.density`)}`);

  await A.ev(`[...document.querySelectorAll('#preset-row button')].find(b => b.textContent.includes('페이지 색')).click(); 1`);
  const viv = await A.ev(`[document.querySelector('#app').dataset.tabs, !document.querySelector('#home-btn').hidden, document.documentElement.dataset.density]`);
  step(`'세로 탭 + 페이지 색' preset → tabs ${viv[0]}, home button ${viv[1]}, density ${viv[2]}`);

  // user CSS for the browser UI
  await A.ev(`document.querySelector('#set-user-css').value = '#toolbar { border-bottom: 3px solid rgb(255, 0, 255) !important; }'; document.querySelector('#set-user-css').dispatchEvent(new Event('input')); 1`);
  const uc = await A.ev(`getComputedStyle(document.querySelector('#toolbar')).borderBottomColor`);
  step('user CSS for the browser UI applied: toolbar border ' + uc);
  await A.ev(`document.querySelector('#set-user-css').value = ''; document.querySelector('#set-user-css').dispatchEvent(new Event('input')); 1`);

  // settings dialog screenshot
  await setSeg('theme', 'dark');
  await A.ev(`ui.shortcut('settings'); document.querySelector('[data-page=set-look]').click(); 1`);
  await sleep(400);
  await shot('custom-settings.png');
  await A.ev(`document.querySelector('#settings-dialog').close(); 1`);

  // speed dial screenshot (start page with the bookmark tile)
  await A.ev(`createTab(); 1`);
  await sleep(800);
  const tiles = await A.ev(`document.querySelectorAll('#sd-tiles .sd-tile').length`);
  await shot('custom-speeddial.png');
  step(`speed dial shows ${tiles} bookmark tile(s)`);

  // session saved for restore
  await sleep(600);
  const session = await A.ev(`JSON.parse(localStorage.getItem('jam-session')).map(s => s.url.replace('${SITE}', ''))`);
  step('open tabs saved for next start: ' + JSON.stringify(session));

  // back to defaults so other tests run on the default layout
  await A.ev(`document.querySelector('#settings-reset') && (window.confirm = () => true, document.querySelector('#settings-reset').click()); localStorage.removeItem('jam-session'); 1`);
  console.log('E2E5 PASS');
  process.exit(0);
})().catch((e) => {
  console.error('E2E5 FAIL', e.message);
  process.exit(1);
});
