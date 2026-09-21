/**
 * 培养皿 Canvas 渲染器 —— 纯手写，无图形库。
 *
 * 职责边界：只画服务端帧。细胞位置/数量/状态来自 CodecFrame，
 * 渲染器不推演任何生态量；鞭毛摆动等纯视觉相位由 (tick, cellId) 决定，
 * 与墙钟无关，同一帧永远画成同一张图。
 *
 * 性能：
 *  - 按 devicePixelRatio 建位图、CSS 像素坐标绘图（高分屏不发虚）；
 *  - 菌落边缘用 40×40 占用网格 + marching squares（每帧 O(N)）；
 *  - drawCells 带时间预算分批绘制，超预算即停并返回游标，
 *    由后续帧续画，避免长任务压垮主线程（目标 1000 细胞 60fps）。
 */
import type { CodecCell, CodecFrame } from '../../../shared/sim/codec';
import { WORLD_RADIUS } from '../../../shared/sim/constants';

export interface DrawOptions {
  frame: CodecFrame;
  categoryById: Map<number, number>; // speciesId -> 0 细菌 /1 真菌 /2 病毒 /3 古菌
  tick: number;
  hoverWorld: { x: number; y: number } | null;
  lensRadiusPx: number;
  lensZoom: number;
  showColonyEdge: boolean;
  /** 0..1 播放进度，只驱动装饰呼吸，不影响任何几何位置 */
  elapsed: number;
}

const CATEGORY_COLOR = ['#00ffc8', '#b47cd4', '#ff6b5e', '#f1c40f'];
const EDGE_N = 40;
const INIT_CARBON_TOTAL_PERMILLE = 2_528_000;

export class DishRenderer {
  private ctx: CanvasRenderingContext2D;
  dpr = 1;
  cssSize = 0;
  private occ = new Uint8Array(EDGE_N * EDGE_N);

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.ctx = ctx;
  }

  resize(cssSize: number, dpr: number) {
    this.cssSize = cssSize;
    this.dpr = dpr;
    const canvas = this.ctx.canvas;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
  }

  private scale(): number {
    return (this.cssSize / (WORLD_RADIUS * 2)) * 0.96;
  }

  private center(): [number, number] {
    return [this.cssSize / 2, this.cssSize / 2];
  }

  /** 模型坐标 → 普通视图 CSS 像素 */
  toPx(x: number, y: number): [number, number] {
    const s = this.scale();
    const [cx, cy] = this.center();
    return [cx + x * s, cy + y * s];
  }

  /** CSS 像素 → 模型坐标（悬停拾取） */
  toWorld(px: number, py: number): [number, number] {
    const s = this.scale();
    const [cx, cy] = this.center();
    return [(px - cx) / s, (py - cy) / s];
  }

  draw(opts: DrawOptions) {
    const { ctx, cssSize, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bg = ctx.createRadialGradient(cssSize / 2, cssSize / 2, cssSize * 0.1, cssSize / 2, cssSize / 2, cssSize * 0.55);
    bg.addColorStop(0, '#0d2b27');
    bg.addColorStop(1, '#05120f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssSize, cssSize);

    const [cx, cy] = this.center();
    const rPx = WORLD_RADIUS * this.scale();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rPx + 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,255,200,0.03)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(143,181,175,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
    ctx.clip();

    this.drawCarbonGlow(opts, cx, cy, rPx);
    if (opts.showColonyEdge) this.drawColonyEdge(opts);
    this.drawCells(opts, (x, y) => this.toPx(x, y), 1, 0, 6, false);

    ctx.restore();

    if (opts.hoverWorld) {
      const [hx, hy] = this.toPx(opts.hoverWorld.x, opts.hoverWorld.y);
      this.drawLens(opts, hx, hy);
    }
  }

  private drawCarbonGlow(opts: DrawOptions, cx: number, cy: number, rPx: number) {
    const { ctx } = this;
    const ratio = Math.min(1, opts.frame.carbonPermille / INIT_CARBON_TOTAL_PERMILLE);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rPx);
    g.addColorStop(0, `rgba(0,255,200,${0.06 * ratio})`);
    g.addColorStop(1, 'rgba(0,255,200,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - rPx, cy - rPx, rPx * 2, rPx * 2);
  }

  private buildOccupancy(cells: CodecCell[]) {
    this.occ.fill(0);
    const cs = (WORLD_RADIUS * 2) / EDGE_N;
    for (const c of cells) {
      if (c.state === 2) continue;
      const ix = Math.max(0, Math.min(EDGE_N - 1, Math.floor((c.x + WORLD_RADIUS) / cs)));
      const iy = Math.max(0, Math.min(EDGE_N - 1, Math.floor((c.y + WORLD_RADIUS) / cs)));
      this.occ[iy * EDGE_N + ix] = 1;
    }
  }

  private drawColonyEdge(opts: DrawOptions) {
    const { ctx } = this;
    this.buildOccupancy(opts.frame.cells);
    const cs = (WORLD_RADIUS * 2) / EDGE_N;
    const s = this.scale();
    const half = WORLD_RADIUS;
    const [ccx, ccy] = this.center();

    const worldToPx = (wx: number, wy: number): [number, number] => [ccx + wx * s, ccy + wy * s];

    ctx.save();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = 'rgba(0,255,200,0.3)';
    ctx.beginPath();
    for (let iy = 0; iy < EDGE_N - 1; iy++) {
      for (let ix = 0; ix < EDGE_N - 1; ix++) {
        const a = this.occ[iy * EDGE_N + ix] ? 1 : 0;
        const b = this.occ[iy * EDGE_N + ix + 1] ? 1 : 0;
        const c = this.occ[(iy + 1) * EDGE_N + ix + 1] ? 1 : 0;
        const d = this.occ[(iy + 1) * EDGE_N + ix] ? 1 : 0;
        const mask = a | (b << 1) | (c << 2) | (d << 3);
        if (mask === 0 || mask === 15) continue;

        const wx0 = -half + ix * cs;
        const wy0 = -half + iy * cs;
        const ep = (edge: number): [number, number] => {
          let fx = 0;
          let fy = 0;
          if (edge === 0) { fx = 0.5; fy = 0; }
          else if (edge === 1) { fx = 1; fy = 0.5; }
          else if (edge === 2) { fx = 0.5; fy = 1; }
          else { fx = 0; fy = 0.5; }
          return worldToPx(wx0 + fx * cs, wy0 + fy * cs);
        };
        for (const seg of MARCHING[mask]) {
          const [x1, y1] = ep(seg[0]);
          const [x2, y2] = ep(seg[1]);
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 分批画细胞。project 决定模型坐标→屏幕坐标（普通视图 / 镜头共用）。
   * 每 64 个细胞检查一次时间预算，超时返回游标。
   */
  drawCells(
    opts: DrawOptions,
    project: (x: number, y: number) => [number, number],
    detailZoom: number,
    start: number,
    budgetMs: number,
    lensOnly: boolean
  ): { next: number; done: boolean } {
    const { ctx } = this;
    const t0 = performance.now();
    const cells = opts.frame.cells;
    const base = this.scale();
    let i = start;
    for (; i < cells.length; i++) {
      if ((i & 63) === 0 && performance.now() - t0 > budgetMs) {
        return { next: i, done: false };
      }
      const c = cells[i];
      // 镜头只重绘视野内细胞，进一步省钱
      if (lensOnly && opts.hoverWorld) {
        const w = opts.hoverWorld;
        const viewR = opts.lensRadiusPx / (base * detailZoom);
        if (Math.abs(c.x - w.x) > viewR || Math.abs(c.y - w.y) > viewR) continue;
      }
      const [px, py] = project(c.x, c.y);
      const cat = opts.categoryById.get(c.speciesId) ?? 0;
      const color = CATEGORY_COLOR[cat];
      const phase = (c.id * 12.9898 + opts.tick * 0.9) % (Math.PI * 2);
      drawOrganism(ctx, px, py, c, color, phase, base, detailZoom);
    }
    return { next: i, done: true };
  }

  private drawLens(opts: DrawOptions, hx: number, hy: number) {
    const { ctx, cssSize } = this;
    const R = opts.lensRadiusPx;
    const zoom = opts.lensZoom;
    const base = this.scale();
    const w = opts.hoverWorld!;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cssSize, cssSize);
    ctx.arc(hx, hy, R, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(2,12,10,0.5)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(hx, hy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#071d19';
    ctx.fillRect(hx - R, hy - R, R * 2, R * 2);

    const project = (x: number, y: number): [number, number] => [
      hx + (x - w.x) * base * zoom,
      hy + (y - w.y) * base * zoom,
    ];
    this.drawCells(opts, project, zoom, 0, 6, true);

    ctx.beginPath();
    ctx.arc(hx, hy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,255,200,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx, hy, R - 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,255,200,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0,255,200,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx - R + 10, hy);
    ctx.lineTo(hx + R - 10, hy);
    ctx.moveTo(hx, hy - R + 10);
    ctx.lineTo(hx, hy + R - 10);
    ctx.stroke();

    const barLen = 50 * base * zoom;
    ctx.strokeStyle = 'rgba(232,245,242,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(hx - R + 14, hy + R - 16);
    ctx.lineTo(hx - R + 14 + barLen, hy + R - 16);
    ctx.stroke();
    ctx.fillStyle = 'rgba(232,245,242,0.8)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText('50 μm', hx - R + 14, hy + R - 21);
    ctx.restore();
  }

  pickCell(opts: DrawOptions, worldX: number, worldY: number): CodecCell | null {
    let best: CodecCell | null = null;
    let bestD = 14 * 14;
    for (let i = opts.frame.cells.length - 1; i >= 0; i--) {
      const c = opts.frame.cells[i];
      const dx = c.x - worldX;
      const dy = c.y - worldY;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
}

/* marching squares：0=上边 1=右边 2=下边 3=左边 */
const MARCHING: Record<number, number[][]> = {
  1: [[2, 0]], 2: [[0, 1]], 3: [[2, 1]], 4: [[1, 2]],
  5: [[2, 0], [1, 2]], 6: [[0, 2]], 7: [[2, 3]], 8: [[3, 2]],
  9: [[3, 0]], 10: [[0, 1], [3, 2]], 11: [[3, 1]], 12: [[1, 3]],
  13: [[1, 0]], 14: [[0, 3]],
};

/* ───────────────────── 单个细胞的手绘 ───────────────────── */

function drawOrganism(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  c: CodecCell,
  color: string,
  phase: number,
  baseScale: number,
  zoom: number
) {
  const r = (2.6 + c.biomass * 0.8) * Math.max(0.7, Math.min(1.15, baseScale * 3.6));
  const detail = zoom > 1.5;

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(c.angle);

  if (c.state === 2) {
    drawVirion(ctx, r, color, phase, detail);
  } else if (color === CATEGORY_COLOR[1]) {
    drawFungus(ctx, r, color, phase, detail, c.state === 1);
  } else if (color === CATEGORY_COLOR[3]) {
    drawArchaeon(ctx, r, color, c.id, phase, detail, c.state === 1);
  } else {
    drawBacterium(ctx, r, color, phase, detail, c.state === 1);
  }
  ctx.restore();

  if (c.state === 1) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,107,94,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, r * 1.6 + Math.sin(phase * 2) * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBacterium(
  ctx: CanvasRenderingContext2D,
  r: number,
  color: string,
  phase: number,
  detail: boolean,
  infected: boolean
) {
  const len = r * 2.3;
  if (detail) {
    ctx.strokeStyle = 'rgba(0,255,200,0.55)';
    ctx.lineWidth = 0.7;
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(-len * 0.5, k * r * 0.7);
      for (let i = 1; i <= 5; i++) {
        const t = i / 5;
        const wag = Math.sin(phase * 3 + t * 6 + k) * r * 0.7 * t;
        ctx.lineTo(-len * 0.5 - t * r * 2.2, k * r * 0.7 + wag);
      }
      ctx.stroke();
    }
  }
  ctx.shadowColor = color;
  ctx.shadowBlur = detail ? 8 : 3;
  roundedRod(ctx, -len / 2, -r * 0.72, len, r * 1.44, r * 0.72, color, infected ? 0.55 : 0.92);
  ctx.shadowBlur = 0;
  if (detail) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.ellipse(-len * 0.12, -r * 0.22, r * 0.42, r * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFungus(
  ctx: CanvasRenderingContext2D,
  r: number,
  color: string,
  phase: number,
  detail: boolean,
  infected: boolean
) {
  ctx.shadowColor = color;
  ctx.shadowBlur = detail ? 7 : 3;
  const lobes: Array<[number, number, number]> = [
    [0, 0, 1], [0.8, -0.35, 0.62], [-0.7, 0.3, 0.58], [0.2, 0.75, 0.5],
  ];
  ctx.fillStyle = hexWithAlpha(color, infected ? 0.5 : 0.85);
  for (const [ox, oy, rr] of lobes) {
    ctx.beginPath();
    ctx.arc(ox * r, oy * r, r * rr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  if (detail) {
    ctx.strokeStyle = 'rgba(180,124,212,0.7)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(
      Math.sin(phase) * r * 0.4, -r * 1.8,
      Math.cos(phase * 0.7) * r * 0.3, -r * 2.2
    );
    ctx.stroke();
  }
}

function drawArchaeon(
  ctx: CanvasRenderingContext2D,
  r: number,
  color: string,
  id: number,
  phase: number,
  detail: boolean,
  infected: boolean
) {
  ctx.shadowColor = color;
  ctx.shadowBlur = detail ? 7 : 3;
  ctx.beginPath();
  const verts = 7;
  for (let i = 0; i <= verts; i++) {
    const a = (i / verts) * Math.PI * 2;
    const wob = 1 + Math.sin(i * 3.7 + id + phase * 0.2) * 0.14;
    const rr = r * 1.05 * wob;
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr * 0.92;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = hexWithAlpha(color, infected ? 0.5 : 0.9);
  ctx.fill();
  ctx.strokeStyle = 'rgba(241,196,15,0.5)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawVirion(
  ctx: CanvasRenderingContext2D,
  r: number,
  color: string,
  phase: number,
  detail: boolean
) {
  const headR = r * 1.1;
  ctx.shadowColor = color;
  ctx.shadowBlur = detail ? 8 : 3;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * headR;
    const y = Math.sin(a) * headR;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = hexWithAlpha(color, 0.95);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = color;
  ctx.lineWidth = detail ? 1 : 0.8;
  ctx.beginPath();
  ctx.moveTo(0, headR * 0.8);
  ctx.lineTo(0, headR * 0.8 + r * 1.9);
  ctx.stroke();

  if (detail) {
    const sway = Math.sin(phase * 4) * r * 0.4;
    ctx.strokeStyle = 'rgba(255,107,94,0.8)';
    ctx.beginPath();
    ctx.moveTo(0, headR * 0.8 + r * 1.9);
    ctx.lineTo(-r * 0.9 + sway, headR * 0.8 + r * 2.6);
    ctx.moveTo(0, headR * 0.8 + r * 1.9);
    ctx.lineTo(r * 0.9 + sway, headR * 0.8 + r * 2.6);
    ctx.stroke();
  }
}

function roundedRod(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  color: string,
  alpha: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = hexWithAlpha(color, alpha);
  ctx.fill();
}

function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
