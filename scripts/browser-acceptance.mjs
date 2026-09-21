/**
 * 真实浏览器验收（Playwright + Chromium）：
 *  A. /petri/stress 1000 细胞稳定 60fps、DPR 缩放 backing store 正确；
 *  B. 正式页建舱 -> SSE 出快照 -> 画布有细胞绘制（像素非空）；
 *  C. 暂停后快照停止推进；
 *  D. 悬停出现圆形显微镜镜头（像素环）。
 */
import { chromium } from 'playwright-core';

const CHROMIUM = process.env.CHROME_PATH || `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux/chrome`;

function fmt(label, ok, extra = '') {
  console.log(`${ok ? '✔' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
}

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [browser error]', m.text().slice(0, 160));
});
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 160)));

// ---------- A. 渲染压测 ----------
await page.goto('http://localhost:5173/petri/stress', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500); // 让 FPS 统计窗口（500ms）稳定
const stress = await page.evaluate(() => {
  const cv = document.querySelector('canvas');
  return {
    fpsText: document.body.innerText.match(/(\d+)\s*FPS/)?.[1],
    backingW: cv?.width,
    backingH: cv?.height,
    cssW: cv?.clientWidth,
    dpr: window.devicePixelRatio,
  };
});
const fps = Number(stress.fpsText);
fmt('1000 细胞同屏帧率 ≥ 55（目标60）', fps >= 55, `实测 ${fps} FPS`);
const ratio = stress.backingW / stress.cssW;
fmt('按设备像素比缩放（DPR=2 时 backing≈2×CSS，不发虚）', Math.abs(ratio - 2) < 0.05, `backing=${stress.backingW} css=${stress.cssW} ratio=${ratio.toFixed(2)}`);

// 画布确实画了东西：采样像素，统计非背景像素数量
function nonEmptyPixels() {
  return page.evaluate(() => {
    const cv = document.querySelector('canvas');
    const g = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const data = g.getImageData(0, 0, w, h).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 16) {
      // 细胞/边缘是高亮青绿/紫/红，背景很暗
      if (data[i] + data[i + 1] + data[i + 2] > 140) lit++;
    }
    return lit;
  });
}
const lit = await nonEmptyPixels();
fmt('画布上有细胞/菌落被实际绘制', lit > 200, `亮像素采样 ${lit}`);

// 2000 细胞也不应崩（允许降级到中/低画质）
await page.click('text=2000 细胞');
await page.waitForTimeout(2500);
const s2 = await page.evaluate(() => document.body.innerText.match(/(\d+)\s*FPS/)?.[1]);
fmt('2000 细胞压力下仍可交互渲染', Number(s2) >= 28, `${s2} FPS`);
await page.click('text=1000 细胞');
await page.waitForTimeout(1500);

// ---------- B. 正式页建舱 ----------
await page.goto('http://localhost:5173/petri', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200); // 等标本列表加载
// 选「噬菌体捕食」预设，填种子，建舱
await page.click('text=噬菌体捕食');
await page.fill('input[value]', 'browser-acceptance');
await page.click('text=接种并开始培养');
await page.waitForTimeout(2500);
const runInfo = await page.evaluate(() => {
  const txt = document.body.innerText;
  const hasCounts = /实时种群/.test(txt);
  const simTime = txt.match(/(\d{2}:\d{2})\s*\/\s*30:00/)?.[1];
  return { hasCounts, simTime };
});
fmt('建舱后 SSE 连通并出现实时种群面板', runInfo.hasCounts);
fmt('模拟时间开始推进', !!runInfo.simTime && runInfo.simTime !== '00:00', `t=${runInfo.simTime}`);

const lit2 = await page.evaluate(() => {
  const cv = document.querySelector('canvas');
  const g = cv.getContext('2d');
  const data = g.getImageData(0, 0, cv.width, cv.height).data;
  let lit = 0;
  for (let i = 0; i < data.length; i += 16) if (data[i] + data[i + 1] + data[i + 2] > 140) lit++;
  return lit;
});
fmt('正式页画布绘制出活细胞', lit2 > 100, `亮像素 ${lit2}`);

// ---------- C. 暂停 ----------
const tBefore = await page.evaluate(() => document.body.innerText.match(/(\d{2}:\d{2})\s*\/\s*30:00/)?.[1]);
await page.click('button:has(svg.lucide-pause)');
await page.waitForTimeout(1200);
const tAfter = await page.evaluate(() => document.body.innerText.match(/(\d{2}:\d{2})\s*\/\s*30:00/)?.[1]);
fmt('暂停后模拟时间冻结', tBefore === tAfter, `${tBefore} == ${tAfter}`);

// ---------- D. 悬停显微镜镜头 ----------
await page.click('button:has(svg.lucide-play)');
await page.waitForTimeout(800);
const box = await page.evaluate(() => {
  const cv = document.querySelector('canvas');
  const r = cv.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
// 在画布中心附近移动触发镜头
await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
await page.waitForTimeout(400);
const lensLit = await page.evaluate(() => {
  const cv = document.querySelector('canvas');
  const g = cv.getContext('2d');
  const cx = cv.width / 2, cy = cv.height / 2;
  // 沿半径约 0.42*min/2 的圆周找亮环（镜头圈）
  const R = Math.min(cv.width, cv.height) * 0.21;
  let ring = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.05) {
    const x = Math.round(cx + Math.cos(a) * R), y = Math.round(cy + Math.sin(a) * R);
    const i = (y * cv.width + x) * 4;
    const d = g.getImageData(x, y, 1, 1).data;
    if (d[1] > 150 && d[0] < 120) ring++; // 青绿镜头圈
  }
  return ring;
});
fmt('悬停出现显微镜圆形镜头圈', lensLit > 20, `环上亮点 ${lensLit}`);
const readout = await page.evaluate(() => /镜下细胞[\s\S]{0,40}(生物量|潜伏|分裂|生长)/.test(document.body.innerText));
fmt('镜头对准细胞时显示单细胞读数', readout);

await browser.close();
console.log('\n浏览器验收完成');
