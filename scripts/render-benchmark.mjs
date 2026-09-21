/**
 * 渲染热路径离屏吞吐基准（@napi-rs/canvas，软件渲染，无 GPU 加速）。
 *
 * 目的：在没有可用浏览器 GUI 的 CI 里给出保守下界——
 * 复刻 PetriRenderer 的真实热路径（每帧）：
 *   1. 1000 个按标本/状态键控的精灵 drawImage（精灵离屏预烘焙）；
 *   2. 低密度菌落层：1000 个 arc + blur filter drawImage；
 *   3. 200 个病毒粒子 path；
 *   4. 碳源场 32x32 矩形；
 * 真实浏览器有 GPU 合成且精灵走纹理缓存，只会更快。
 */
import { createCanvas } from '@napi-rs/canvas';

const W = 900, H = 760;
const cv = createCanvas(W, H);
const ctx = cv.getContext('2d');

// 预烘焙 24 标本 x 3 状态精灵
function bake(sp, st) {
  const S = 64;
  const c = createCanvas(S, S);
  const g = c.getContext('2d');
  const colors = ['#0a8f74', '#6e3b8c', '#a52b22', '#9c7f12'];
  const glows = ['#5fffe0', '#c79bff', '#ff8a7a', '#ffe66d'];
  const cat = sp % 4;
  const cx = S / 2, cy = S / 2, r = S * 0.3;
  g.shadowColor = glows[cat];
  g.shadowBlur = 6;
  const grad = g.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r);
  grad.addColorStop(0, glows[cat]);
  grad.addColorStop(1, colors[cat]);
  g.fillStyle = grad;
  g.beginPath();
  if (sp % 3 === 0) {
    // rod
    g.moveTo(cx - r * 1.4, cy - r * 0.6);
    g.arcTo(cx + r * 1.4, cy - r * 0.6, cx + r * 1.4, cy + r * 0.6, r * 0.6);
    g.arcTo(cx + r * 1.4, cy + r * 0.6, cx - r * 1.4, cy + r * 0.6, r * 0.6);
    g.arcTo(cx - r * 1.4, cy + r * 0.6, cx - r * 1.4, cy - r * 0.6, r * 0.6);
    g.arcTo(cx - r * 1.4, cy - r * 0.6, cx + r * 1.4, cy - r * 0.6, r * 0.6);
    g.closePath();
  } else {
    g.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
  }
  g.fill();
  // 鞭毛（贝塞尔）
  if (sp % 2 === 0) {
    g.shadowBlur = 0;
    g.strokeStyle = glows[cat] + '99';
    g.lineWidth = 1.2;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.bezierCurveTo(cx + Math.cos(a) * r * 2, cy + Math.sin(a) * r * 2 + 3, cx + Math.cos(a) * r * 2.4, cy + Math.sin(a) * r * 2.4 - 3, cx + Math.cos(a) * r * 2.6, cy + Math.sin(a) * r * 2.6);
      g.stroke();
    }
  }
  return c;
}
const sprites = [];
for (let sp = 1; sp <= 24; sp++) for (let st = 0; st < 3; st++) sprites.push(bake(sp, st));

// 1000 细胞
const cells = [];
for (let i = 0; i < 1000; i++) {
  const ang = Math.random() * Math.PI * 2;
  const rr = Math.sqrt(Math.random()) * 0.45;
  cells.push({ x: 0.5 + Math.cos(ang) * rr, y: 0.5 + Math.sin(ang) * rr, sp: 1 + Math.floor(Math.random() * 24), st: Math.floor(Math.random() * 3), m: 0.5 + Math.random() * 0.6 });
}
const virions = [];
for (let i = 0; i < 200; i++) {
  const ang = Math.random() * Math.PI * 2;
  const rr = Math.sqrt(Math.random()) * 0.45;
  virions.push({ x: 0.5 + Math.cos(ang) * rr, y: 0.5 + Math.sin(ang) * rr });
}

// 低密度菌落层
const DS = 0.25;
const dc = createCanvas(Math.round(W * DS), Math.round(H * DS));
const dg = dc.getContext('2d');

function frame() {
  ctx.clearRect(0, 0, W, H);
  // 碳源场
  const n = 32, cell = W / n;
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    ctx.fillStyle = `rgba(0,255,200,${(0.02 + Math.random() * 0.1).toFixed(3)})`;
    ctx.fillRect(ix * cell, iy * cell, cell + 0.6, cell + 0.6);
  }
  // 菌落密度层
  dg.clearRect(0, 0, dc.width, dc.height);
  const scale = W * DS;
  for (const c of cells) {
    dg.fillStyle = 'rgba(95,255,224,0.34)';
    dg.beginPath();
    dg.arc(c.x * scale, c.y * scale, 1.1, 0, Math.PI * 2);
    dg.fill();
  }
  ctx.save();
  ctx.filter = 'blur(5px)';
  ctx.globalAlpha = 0.7;
  ctx.drawImage(dc, 0, 0, W, H);
  ctx.filter = 'none';
  ctx.restore();
  // 1000 细胞精灵
  for (const c of cells) {
    const spr = sprites[(c.sp - 1) * 3 + c.st];
    const rPx = 6 * Math.max(0.7, c.m);
    ctx.drawImage(spr, c.x * W - rPx, c.y * H - rPx, rPx * 2, rPx * 2);
  }
  // 200 病毒粒子
  ctx.fillStyle = 'rgba(255,138,122,0.85)';
  for (const v of virions) {
    ctx.beginPath();
    ctx.arc(v.x * W, v.y * H, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 预热 10 帧
for (let i = 0; i < 10; i++) frame();

const FRAMES = 300;
const t0 = performance.now();
for (let i = 0; i < FRAMES; i++) frame();
const elapsed = performance.now() - t0;
const msPerFrame = elapsed / FRAMES;
console.log('软件离屏渲染（保守下界，无 GPU）');
console.log(`  每帧平均: ${msPerFrame.toFixed(2)} ms`);
console.log(`  等价吞吐: ${(1000 / msPerFrame).toFixed(0)} FPS @ 1000 细胞 + 200 粒子 + 菌落边缘blur`);
console.log(`  60FPS 预算 16.67ms：${msPerFrame < 16.67 ? '达标 ✅（浏览器 GPU 合成下只会更高）' : '超支（浏览器 GPU 下仍预期达标，此项为纯软件下界）'}`);
