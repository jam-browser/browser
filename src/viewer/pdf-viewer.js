// Jam Browser 공유 PDF 뷰어
//  - pdf.js 로 쪽마다 canvas 에 그림 (보이는 쪽만, 화면 밖은 나중에) + 글자 층 (선택 · Ctrl+F 찾기)
//  - 쪽은 창 폭에 맞춘 크기 × 확대 배율. 쪽 위치가 같은 비율이라 Jam 의 스크롤 동기화(요소 + 비율)가
//    서로 창 크기 · 확대가 달라도 같은 쪽 같은 곳을 맞춰 줌
//  - PDF 안의 스크립트 · 양식 스크립트는 실행하지 않음 (enableScripting 없음, isEvalSupported: false)
import * as pdfjs from '/_jam/pdfjs/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/_jam/pdfjs/build/pdf.worker.min.mjs';

const $ = (s) => document.querySelector(s);
const pagesEl = $('#pages');
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
let zoom = 1;
let doc = null;
const pages = []; // { n, div, w, h (scale 1 크기), rendered: 배율, task, text }
let renderGen = 0;

const baseWidth = () => Math.max(320, Math.min(1100, window.innerWidth - 48));

function layout() {
  const bw = baseWidth() * zoom;
  for (const p of pages) {
    const scale = bw / p.w;
    p.div.style.width = `${Math.round(bw)}px`;
    p.div.style.height = `${Math.round(p.h * scale)}px`;
    p.div.style.setProperty('--scale-factor', String(scale));
    p.div.style.setProperty('--total-scale-factor', String(scale));
  }
  $('#zoom').textContent = `${Math.round(zoom * 100)}%`;
  renderGen++;
  for (const p of pages) p.rendered = 0;
  queueVisible();
}

async function renderPage(p) {
  const gen = renderGen;
  const bw = baseWidth() * zoom;
  const scale = bw / p.w;
  if (p.rendered === scale) return;
  p.rendered = scale;
  try {
    const page = await doc.getPage(p.n);
    if (gen !== renderGen) return;
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    p.task?.cancel();
    p.task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport });
    await p.task.promise;
    if (gen !== renderGen) return;
    p.div.querySelector('canvas')?.remove();
    p.div.prepend(canvas);
    // 글자 층 (투명 글자 — 선택 · 찾기)
    p.div.querySelector('.textLayer')?.remove();
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    p.div.appendChild(tl);
    const text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: page.getViewport({ scale }) });
    await text.render();
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
  }
}

let io = null;
function queueVisible() {
  io?.disconnect();
  io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) if (en.isIntersecting) renderPage(pages[Number(en.target.dataset.n) - 1]);
    },
    { rootMargin: '1200px 0px' }
  );
  for (const p of pages) io.observe(p.div);
}

function currentPage() {
  const y = 60;
  let best = 1;
  for (const p of pages) {
    const r = p.div.getBoundingClientRect();
    if (r.top - 20 <= y) best = p.n;
    else break;
  }
  return best;
}
const updatePageInfo = () => doc && ($('#pageinfo').textContent = `${currentPage()} / ${doc.numPages}`);
addEventListener('scroll', () => requestAnimationFrame(updatePageInfo), { passive: true });

// 확대 · 축소 · 폭 맞춤 — 보던 쪽 위치를 그대로 유지
function setZoom(z) {
  const anchor = pages[currentPage() - 1];
  const r = anchor?.div.getBoundingClientRect();
  const frac = r ? (60 - r.top) / r.height : 0;
  zoom = z;
  layout();
  if (anchor) {
    const r2 = anchor.div.getBoundingClientRect();
    scrollBy(0, r2.top + frac * r2.height - 60);
  }
}
$('#zin').onclick = () => setZoom(ZOOMS.find((z) => z > zoom + 1e-6) || zoom);
$('#zout').onclick = () => setZoom([...ZOOMS].reverse().find((z) => z < zoom - 1e-6) || zoom);
$('#fit').onclick = () => setZoom(1);
let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => setZoom(zoom), 150);
});

async function main() {
  let meta = { name: 'PDF' };
  try {
    meta = await (await fetch('/_meta')).json();
  } catch {}
  document.title = meta.name;
  $('#name').textContent = meta.name;
  try {
    doc = await pdfjs.getDocument({
      url: '/file',
      cMapUrl: '/_jam/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/_jam/pdfjs/standard_fonts/',
      wasmUrl: '/_jam/pdfjs/wasm/',
      iccUrl: '/_jam/pdfjs/iccs/',
      isEvalSupported: false,
      enableXfa: false,
    }).promise;
  } catch (e) {
    $('#msg').textContent = `PDF 를 열 수 없어요: ${e.message}`;
    return;
  }
  pagesEl.replaceChildren();
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const div = document.createElement('div');
    div.className = 'pg';
    div.id = `p${n}`;
    div.dataset.n = String(n);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(n);
    div.appendChild(num);
    pagesEl.appendChild(div);
    pages.push({ n, div, w: vp.width, h: vp.height, rendered: 0, task: null });
  }
  layout();
  updatePageInfo();
  window.__pdf = { pages: doc.numPages, page: currentPage, zoom: () => zoom }; // 테스트 · 디버그용
}
main();
