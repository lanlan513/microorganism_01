/**
 * PetriRenderer —— 纯手写 Canvas 2D 渲染器。
 *
 * 硬约束：
 *  - 不使用任何图形库（无 pixi/three/d3/chart.js），全部 path/arc/bezierCurveTo；
 *  - 按设备像素比 (devicePixelRatio) 设置 backing store，1000 细胞同屏不发虚；
 *  - 精灵离屏预烘焙（按标本+状态），每帧只做 drawImage 批量贴图，稳 60fps；
 *  - 菌落边缘：先在小尺寸密度画布画光晕，再放大模糊并做边缘高光；
 *  - 悬停出现圆形「显微镜视野」：裁剪圆形、放大倍数、十字标尺、单细细胞状态；
 *  - 自适应降级：根据实测帧时关闭菌落边缘/鞭毛等非必要效果；
 *  - 主线程时间片：大快照解析通过 timeSlice() 分片（见 timeSlice.ts）。
 */
import type { CellSnapshot, FieldSnapshot, Snapshot, VirionSnapshot } from '../../shared/petri';
import { renderSpecimen, RenderSpecimen } from './specimens-render';

const TWO_PI = Math.PI * 2;
const DISH_PAD = 18; // CSS px 留白

/** 精灵在离屏画布上的边长（px，@1x），再按实际显示半径缩放贴图 */
const SPRITE_PX = 32;

export interface LensInfo {
  /** 悬停视野中心（世界坐标） */
  x: number;
  y: number;
  /** 镜头半径（CSS px） */
  radius: number;
  /** 放大倍数 */
  magnification: number;
  /** 视野中心最近细胞（供侧栏读清单个细胞在做什么） */
  focus: {
    id: number;
    specimen: RenderSpecimen;
    cell: CellSnapshot;
    worldDist: number;
  } | null;
}

export interface RenderOptions {
  showCarbon: boolean;
  showColonyEdge: boolean;
  showFlagella: boolean;
  paused: boolean;
}

export class PetriRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  // 精灵缓存：key -> 离屏 canvas
  private sprites = new Map<string, HTMLCanvasElement>();

  // 菌落密度层（离屏，低分辨率）
  private densityCanvas: HTMLCanvasElement;
  private densityCtx: CanvasRenderingContext2D;
  private densityScale = 0.25;

  // 视野
  lens: LensInfo | null = null;
  options: RenderOptions = {
    showCarbon: true,
    showColonyEdge: true,
    showFlagella: true,
    paused: false,
  };

  // 自适应质量
  quality: 'high' | 'medium' | 'low' = 'high';
  private frameTimes: number[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.ctx = ctx;
    this.densityCanvas = document.createElement('canvas');
    const dctx = this.densityCanvas.getContext('2d');
    if (!dctx) throw new Error('离屏 Canvas 不可用');
    this.densityCtx = dctx;
  }

  /** 按 DPR 与 CSS 尺寸重建 backing store（ResizeObserver 调用）。 */
  resize(cssW: number, cssH: number) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    // DPR 变化后精灵需要重烤（尺寸与锐度相关）
    this.sprites.clear();
  }

  /** 培养皿圆在 CSS 像素下的几何参数（正方形区域居中于画布）。 */
  private dishGeometry() {
    const size = Math.max(120, Math.min(this.cssW, this.cssH) - DISH_PAD * 2);
    const cx = this.cssW / 2;
    const cy = this.cssH / 2;
    const radius = size / 2;
    return { size, cx, cy, radius };
  }

  worldToScreen(wx: number, wy: number) {
    const { cx, cy, radius } = this.dishGeometry();
    return { sx: cx + (wx - 0.5) * radius * 2, sy: cy + (wy - 0.5) * radius * 2 };
  }

  screenToWorld(sx: number, sy: number) {
    const { cx, cy, radius } = this.dishGeometry();
    return { wx: 0.5 + (sx - cx) / (radius * 2), wy: 0.5 + (sy - cy) / (radius * 2) };
  }

  /** 设置悬停镜头（null 关闭）。会同步算出焦点细胞。 */
  setLens(worldX: number | null, worldY: number | null, snap: Snapshot | null) {
    if (worldX === null || worldY === null || !snap) {
      this.lens = null;
      return;
    }
    const { radius } = this.dishGeometry();
    // 找视野中心最近细胞
    let focus: LensInfo['focus'] = null;
    let bestD = Infinity;
    for (const cell of snap.cells) {
      const dx = cell.x - worldX;
      const dy = cell.y - worldY;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        focus = {
          id: cell.id,
          specimen: renderSpecimen(cell.sp),
          cell,
          worldDist: Math.sqrt(d),
        };
      }
    }
    // 焦点离中心太远则不算（镜头主要看区域，不强求有细胞）
    this.lens = {
      x: worldX,
      y: worldY,
      radius: Math.min(150, radius * 0.42),
      magnification: 3.4,
      focus: focus && focus.worldDist < 0.06 ? focus : null,
    };
  }

  /** 报告一次帧耗时（ms），用于自适应降级。 */
  reportFrame(ms: number) {
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length < 20) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    if (avg > 15 && this.quality === 'high') this.quality = 'medium';
    else if (avg > 22 && this.quality === 'medium') this.quality = 'low';
    else if (avg < 9 && this.quality !== 'high') this.quality = 'high';
  }

  // ------------------------------------------------------------ 主绘制

  draw(snap: Snapshot) {
    const t0 = performance.now();
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const dish = this.dishGeometry();

    this.drawDishBackground(ctx, dish, snap.field);
    if (this.options.showCarbon && snap.field) this.drawCarbonField(ctx, dish, snap.field);

    // 菌落边缘（中/高质量）
    const edgeOn = this.options.showColonyEdge && this.quality !== 'low';
    if (edgeOn) this.drawColonyEdge(snap, dish);

    // 细胞批量贴图
    this.drawCells(ctx, dish, snap.cells, 1, null);

    // 病毒粒子
    this.drawVirions(ctx, dish, snap.virions);

    // 培养皿玻璃边界与刻度
    this.drawDishRim(ctx, dish);

    // 显微镜悬停视野（最上层）
    if (this.lens) this.drawLens(ctx, dish, snap);

    this.reportFrame(performance.now() - t0);
  }

  private drawDishBackground(
    ctx: CanvasRenderingContext2D,
    dish: { cx: number; cy: number; radius: number },
    field: FieldSnapshot | null
  ) {
    // 琼脂底
    const g = ctx.createRadialGradient(dish.cx, dish.cy, dish.radius * 0.1, dish.cx, dish.cy, dish.radius);
    g.addColorStop(0, 'rgba(12, 38, 34, 0.92)');
    g.addColorStop(0.8, 'rgba(7, 24, 22, 0.94)');
    g.addColorStop(1, 'rgba(4, 14, 13, 0.98)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(dish.cx, dish.cy, dish.radius, 0, TWO_PI);
    ctx.fill();

    // 培养皿外圈投影
    ctx.save();
    ctx.strokeStyle = 'rgba(0,255,200,0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    void field;
  }

  private drawCarbonField(
    ctx: CanvasRenderingContext2D,
    dish: { cx: number; cy: number; radius: number },
    field: FieldSnapshot
  ) {
    const n = field.size;
    const cell = (dish.radius * 2) / n;
    ctx.save();
    ctx.beginPath();
    ctx.arc(dish.cx, dish.cy, dish.radius - 1, 0, TWO_PI);
    ctx.clip();
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const c = field.carbon[iy * n + ix];
        if (c <= 0.01) continue;
        // 碳源浓淡（青绿），贫碳区自然变暗——抢碳的空间格局可见
        const a = Math.min(0.16, c * 0.05);
        ctx.fillStyle = `rgba(0,255,200,${a.toFixed(3)})`;
        ctx.fillRect(
          dish.cx - dish.radius + ix * cell,
          dish.cy - dish.radius + iy * cell,
          cell + 0.6,
          cell + 0.6
        );
      }
    }
    ctx.restore();
  }

  /** 菌落边缘：低密度密度图画柔光斑 -> 放大模糊 -> 沿密度梯度描一圈亮边。 */
  private drawColonyEdge(snap: Snapshot, dish: { cx: number; cy: number; radius: number }) {
    const ds = this.densityScale;
    const w = Math.max(2, Math.round(this.cssW * ds));
    const h = Math.max(2, Math.round(this.cssH * ds));
    if (this.densityCanvas.width !== w || this.densityCanvas.height !== h) {
      this.densityCanvas.width = w;
      this.densityCanvas.height = h;
    }
    const d = this.densityCtx;
    d.setTransform(1, 0, 0, 1, 0, 0);
    d.clearRect(0, 0, w, h);
    const scale = (dish.radius * 2 * ds);
    const ox = (dish.cx - dish.radius) * ds;
    const oy = (dish.cy - dish.radius) * ds;
    const dotR = Math.max(0.8, 3.2 * ds * (this.quality === 'medium' ? 0.8 : 1));
    for (const c of snap.cells) {
      const spec = renderSpecimen(c.sp);
      d.fillStyle = c.st === 1 ? 'rgba(255,138,122,0.5)' : hexToRgba(spec.glow, 0.34);
      d.beginPath();
      d.arc(ox + c.x * scale, oy + c.y * scale, dotR, 0, TWO_PI);
      d.fill();
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(dish.cx, dish.cy, dish.radius - 1, 0, TWO_PI);
    ctx.clip();
    // 柔光晕（菌体聚集区）
    ctx.globalAlpha = this.quality === 'medium' ? 0.5 : 0.75;
    ctx.imageSmoothingEnabled = true;
    ctx.filter = this.quality === 'medium' ? 'blur(3px)' : 'blur(5px)';
    ctx.drawImage(this.densityCanvas, 0, 0, w, h, 0, 0, this.cssW, this.cssH);
    ctx.filter = 'none';

    // 边缘高光：对密度图再做一次放大偏移叠描，呈现菌落轮廓
    if (this.quality === 'high') {
      ctx.globalAlpha = 0.5;
      ctx.globalCompositeOperation = 'lighter';
      ctx.filter = 'blur(1.2px)';
      ctx.drawImage(this.densityCanvas, -1.5, -1.5, w, h, -1, -1, this.cssW, this.cssH);
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  private drawCells(
    ctx: CanvasRenderingContext2D,
    dish: { cx: number; cy: number; radius: number },
    cells: CellSnapshot[],
    magnification: number,
    lensCenter: { x: number; y: number } | null
  ) {
    const pxPerWorld = dish.radius * 2;
    ctx.save();
    for (const cell of cells) {
      const key = `${cell.sp}:${cell.st}`;
      let sprite = this.sprites.get(key);
      if (!sprite) {
        sprite = this.bakeSprite(cell.sp, cell.st);
        this.sprites.set(key, sprite);
      }
      const sx = dish.cx + (cell.x - 0.5) * pxPerWorld;
      const sy = dish.cy + (cell.y - 0.5) * pxPerWorld;

      // 镜头裁剪：基础层在镜头圆内不画（留给放大层），避免重影
      if (lensCenter) {
        const lx = dish.cx + (lensCenter.x - 0.5) * pxPerWorld;
        const ly = dish.cy + (lensCenter.y - 0.5) * pxPerWorld;
        const dx = sx - lx;
        const dy = sy - ly;
        const r = this.lens?.radius ?? 0;
        if (dx * dx + dy * dy < r * r) continue;
      }

      const spec = renderSpecimen(cell.sp);
      const worldR = this.visualRadius(cell, spec);
      const rPx = Math.max(1.6, worldR * pxPerWorld) * magnification;
      // 分裂期拉长/增大：质量比 m/m0 驱动形态
      const growth = Math.max(0.6, Math.min(1.9, cell.m / cell.m0));
      ctx.drawImage(sprite, sx - rPx * growth, sy - rPx * growth, rPx * 2 * growth, rPx * 2 * growth);
    }
    ctx.restore();
  }

  private visualRadius(cell: CellSnapshot, spec: RenderSpecimen): number {
    // 视觉世界半径：直接用物种常量；病毒粒子统一细小
    const base =
      spec.category === 'virus'
        ? 0.0034
        : spec.shape === 'yeast'
          ? 0.007
          : spec.shape === 'hypha'
            ? 0.008
            : spec.shape === 'rod' || spec.shape === 'curved'
              ? 0.005
              : 0.0044;
    void cell;
    return base;
  }

  // ------------------------------------------------------------ 精灵烘焙（手写形态）

  private bakeSprite(sp: number, st: 0 | 1 | 2): HTMLCanvasElement {
    const spec = renderSpecimen(sp);
    const S = SPRITE_PX;
    const cv = document.createElement('canvas');
    cv.width = S * this.dpr;
    cv.height = S * this.dpr;
    const g = cv.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    const cx = S / 2;
    const cy = S / 2;
    const r = S * 0.34;

    const body = st === 1 ? '#ff8a7a' : st === 2 ? mixColor(spec.base, '#ff5d5d', 0.4) : spec.base;
    const light = st === 1 ? '#ffd0c8' : spec.glow;

    g.lineCap = 'round';
    g.lineJoin = 'round';

    // 鞭毛（仅正常/胁迫状态画，感染态不画）
    if (this.options.showFlagella && spec.flagella > 0 && st !== 1 && this.quality !== 'low') {
      g.strokeStyle = hexToRgba(light, 0.55);
      g.lineWidth = 0.7;
      const count = spec.flagella;
      for (let i = 0; i < count; i++) {
        const baseAng = (i / count) * TWO_PI + (count === 1 ? 0 : 0);
        g.beginPath();
        g.moveTo(cx + Math.cos(baseAng) * r, cy + Math.sin(baseAng) * r);
        // 手画正弦波鞭毛（两段贝塞尔），相位由鞭毛序号决定
        const len = r * 1.5;
        const amp = r * 0.4;
        const a0 = baseAng;
        const px = cx + Math.cos(a0) * r;
        const py = cy + Math.sin(a0) * r;
        const ex = px + Math.cos(a0) * len;
        const ey = py + Math.sin(a0) * len;
        const nx = -Math.sin(a0);
        const ny = Math.cos(a0);
        const ph = i * 1.7;
        g.moveTo(px, py);
        g.bezierCurveTo(
          px + Math.cos(a0) * len * 0.33 + nx * amp * Math.sin(ph),
          py + Math.sin(a0) * len * 0.33 + ny * amp * Math.sin(ph),
          px + Math.cos(a0) * len * 0.66 - nx * amp * Math.sin(ph + 1),
          py + Math.sin(a0) * len * 0.66 - ny * amp * Math.sin(ph + 1),
          ex,
          ey
        );
        g.stroke();
      }
    }

    // 主体（按形态手画）
    g.shadowColor = hexToRgba(light, 0.7);
    g.shadowBlur = st === 1 ? 6 : 4;
    const grad = g.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    grad.addColorStop(0, light);
    grad.addColorStop(0.55, body);
    grad.addColorStop(1, mixColor(body, '#000000', 0.45));
    g.fillStyle = grad;

    this.traceBody(g, spec.shape, cx, cy, r);
    g.fill();
    g.shadowBlur = 0;

    // 高光
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.beginPath();
    g.ellipse(cx - r * 0.3, cy - r * 0.35, r * 0.3, r * 0.18, -0.6, 0, TWO_PI);
    g.fill();

    // 感染态：内部注入的核酸线圈（红点+线圈）
    if (st === 1) {
      g.strokeStyle = 'rgba(120,10,5,0.85)';
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i <= 10; i++) {
        const a = (i / 10) * TWO_PI * 1.6;
        const rr = (i / 10) * r * 0.6;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }

    return cv;
  }

  private traceBody(g: CanvasRenderingContext2D, shape: string, cx: number, cy: number, r: number) {
    g.beginPath();
    switch (shape) {
      case 'rod':
        // 胶囊状杆菌
        roundedRect(g, cx - r * 1.5, cy - r * 0.62, r * 3, r * 1.24, r * 0.62);
        break;
      case 'curved':
        // 弧菌：逗号形（弧）
        g.arc(cx, cy + r * 0.3, r * 1.15, Math.PI * 1.05, Math.PI * 1.75);
        g.arc(cx, cy + r * 0.3, r * 0.55, Math.PI * 1.75, Math.PI * 1.05, true);
        g.closePath();
        break;
      case 'yeast':
        // 酵母：大圆 + 出芽小体
        g.arc(cx - r * 0.1, cy, r * 0.95, 0, TWO_PI);
        g.moveTo(cx + r * 0.75, cy - r * 0.28);
        g.arc(cx + r * 0.62, cy - r * 0.42, r * 0.42, 0, TWO_PI);
        break;
      case 'hypha':
        // 菌丝片段：长条分隔
        roundedRect(g, cx - r * 1.7, cy - r * 0.4, r * 3.4, r * 0.8, r * 0.4);
        break;
      case 'icosahedron':
        // 二十面体（六边形近似）+ 尾丝（噬菌体）
        polygon(g, cx, cy, r * 0.95, 6, -Math.PI / 2);
        break;
      case 'filament':
        // 丝状：细长杆
        roundedRect(g, cx - r * 2, cy - r * 0.28, r * 4, r * 0.56, r * 0.28);
        break;
      case 'enveloped':
        // 包膜病毒：圆 + 表面棘突
        g.arc(cx, cy, r * 0.85, 0, TWO_PI);
        break;
      case 'coccal':
      case 'coccus':
      default:
        g.arc(cx, cy, r * 0.92, 0, TWO_PI);
        break;
    }
  }

  private drawVirions(
    ctx: CanvasRenderingContext2D,
    dish: { cx: number; cy: number; radius: number },
    virions: VirionSnapshot[]
  ) {
    const pxPerWorld = dish.radius * 2;
    ctx.save();
    for (const v of virions) {
      const spec = renderSpecimen(v.sp);
      const sx = dish.cx + (v.x - 0.5) * pxPerWorld;
      const sy = dish.cy + (v.y - 0.5) * pxPerWorld;
      const rPx = 2.2;
      ctx.fillStyle = hexToRgba(spec.glow, 0.85);
      ctx.beginPath();
      if (spec.shape === 'icosahedron') {
        // 噬菌体：小头 + 尾针
        polygon(ctx, sx, sy, rPx, 6, -Math.PI / 2);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(spec.glow, 0.7);
        ctx.lineWidth = 0.6;
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * TWO_PI + Math.PI / 4;
          ctx.beginPath();
          ctx.moveTo(sx, sy + rPx);
          ctx.lineTo(sx + Math.cos(a) * rPx * 1.6, sy + rPx + Math.abs(Math.sin(a)) * rPx * 1.8 + 1);
          ctx.stroke();
        }
      } else if (spec.shape === 'filament') {
        roundedRect(ctx, sx - rPx * 2, sy - 0.8, rPx * 4, 1.6, 0.8);
        ctx.fill();
      } else {
        // 包膜病毒：圆 + 棘突小点
        ctx.arc(sx, sy, rPx, 0, TWO_PI);
        ctx.fill();
        ctx.fillStyle = hexToRgba(spec.glow, 0.5);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * TWO_PI;
          ctx.beginPath();
          ctx.arc(sx + Math.cos(a) * rPx, sy + Math.sin(a) * rPx, 0.7, 0, TWO_PI);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ 显微镜悬停视野

  private drawLens(
    ctx: CanvasRenderingContext2D,
    dish: { cx: number; cy: number; radius: number },
    snap: Snapshot
  ) {
    const lens = this.lens!;
    const pxPerWorld = dish.radius * 2;
    const lx = dish.cx + (lens.x - 0.5) * pxPerWorld;
    const ly = dish.cy + (lens.y - 0.5) * pxPerWorld;
    const R = lens.radius;
    const mag = lens.magnification;

    // 外部压暗遮罩（挖洞）
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.cssW, this.cssH);
    ctx.arc(lx, ly, R, 0, TWO_PI);
    ctx.clip('evenodd');
    ctx.fillStyle = 'rgba(2,10,9,0.45)';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.restore();

    // 圆形放大视野
    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, R - 1, 0, TWO_PI);
    ctx.clip();

    // 视野底（更亮的琼脂）
    const g = ctx.createRadialGradient(lx, ly, R * 0.1, lx, ly, R);
    g.addColorStop(0, 'rgba(20,52,46,0.98)');
    g.addColorStop(1, 'rgba(8,26,23,0.98)');
    ctx.fillStyle = g;
    ctx.fillRect(lx - R, ly - R, R * 2, R * 2);

    // 放大绘制镜头内细胞：以镜头中心为缩放锚点
    for (const cell of snap.cells) {
      const sx = dish.cx + (cell.x - 0.5) * pxPerWorld;
      const sy = dish.cy + (cell.y - 0.5) * pxPerWorld;
      const mx = lx + (sx - lx) * mag;
      const my = ly + (sy - ly) * mag;
      if ((mx - lx) ** 2 + (my - ly) ** 2 > R * R) continue;
      const key = `${cell.sp}:${cell.st}`;
      let sprite = this.sprites.get(key);
      if (!sprite) {
        sprite = this.bakeSprite(cell.sp, cell.st);
        this.sprites.set(key, sprite);
      }
      const spec = renderSpecimen(cell.sp);
      const worldR = this.visualRadius(cell, spec);
      const rPx = Math.max(1.6, worldR * pxPerWorld) * mag;
      const growth = Math.max(0.6, Math.min(1.9, cell.m / cell.m0));
      const isFocus = lens.focus?.id === cell.id;
      ctx.globalAlpha = isFocus ? 1 : 0.92;
      ctx.drawImage(sprite, mx - rPx * growth, my - rPx * growth, rPx * 2 * growth, rPx * 2 * growth);
      ctx.globalAlpha = 1;
    }
    // 镜头内病毒粒子
    for (const v of snap.virions) {
      const sx = dish.cx + (v.x - 0.5) * pxPerWorld;
      const sy = dish.cy + (v.y - 0.5) * pxPerWorld;
      const mx = lx + (sx - lx) * mag;
      const my = ly + (sy - ly) * mag;
      if ((mx - lx) ** 2 + (my - ly) ** 2 > R * R) continue;
      const spec = renderSpecimen(v.sp);
      ctx.fillStyle = spec.glow;
      ctx.beginPath();
      ctx.arc(mx, my, 2.4 * mag * 0.7, 0, TWO_PI);
      ctx.fill();
    }
    ctx.restore();

    // 十字分划板
    ctx.save();
    ctx.strokeStyle = 'rgba(180,255,240,0.55)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(lx - R * 0.85, ly);
    ctx.lineTo(lx + R * 0.85, ly);
    ctx.moveTo(lx, ly - R * 0.85);
    ctx.lineTo(lx, ly + R * 0.85);
    ctx.stroke();
    // 微米标尺
    ctx.strokeStyle = 'rgba(180,255,240,0.9)';
    ctx.lineWidth = 1.4;
    const barW = R * 0.5;
    ctx.beginPath();
    ctx.moveTo(lx - barW / 2, ly + R * 0.72);
    ctx.lineTo(lx + barW / 2, ly + R * 0.72);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200,255,245,0.9)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${mag.toFixed(1)}×  5 μm`, lx, ly + R * 0.72 - 5);
    ctx.restore();

    // 镜头金属圈
    ctx.save();
    ctx.strokeStyle = 'rgba(0,255,200,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, TWO_PI);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,255,200,0.18)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(lx, ly, R + 3, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
  }

  private drawDishRim(ctx: CanvasRenderingContext2D, dish: { cx: number; cy: number; radius: number }) {
    ctx.save();
    // 玻璃高光
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(dish.cx, dish.cy, dish.radius - 3, Math.PI * 1.1, Math.PI * 1.7);
    ctx.stroke();
    // 外缘
    ctx.strokeStyle = 'rgba(0,255,200,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(dish.cx, dish.cy, dish.radius, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
  }
}

// ------------------------------------------------------------ 颜色/路径工具

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function mixColor(a: string, b: string, t: number): string {
  const pa = a.replace('#', '');
  const pb = b.replace('#', '');
  const ar = parseInt(pa.substring(0, 2), 16);
  const ag = parseInt(pa.substring(2, 4), 16);
  const ab = parseInt(pa.substring(4, 6), 16);
  const br = parseInt(pb.substring(0, 2), 16);
  const bg = parseInt(pb.substring(2, 4), 16);
  const bb = parseInt(pb.substring(4, 6), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}

function roundedRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

function polygon(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, sides: number, rot: number) {
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TWO_PI;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}
