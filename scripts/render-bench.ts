/**
 * 渲染性能基准：用 no-op 链式 Canvas 代理在 Node 中量纯 JS 绘制开销
 * （不含真实光栅化与 GPU，但覆盖全部状态切换与路径构建）。
 * npx tsx scripts/render-bench.ts
 */
import { DishRenderer } from '../src/components/petri/dishRenderer.ts';
import type { CodecCell, CodecFrame } from '../shared/sim/codec.ts';

function makeCtx() {
  const gradient = { addColorStop() {} };
  const target = function () {} as unknown as CanvasRenderingContext2D;
  const ctx = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'canvas') return canvasStub;
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
      if (prop === 'measureText') return () => ({ width: 10 });
      // 数值/字符串属性可写可读
      if (prop in valueStore) return valueStore[prop as string];
      return (..._args: unknown[]) => ctx;
    },
    set(_t, prop, value) {
      valueStore[prop as string] = value;
      return true;
    },
  });
  const valueStore: Record<string, unknown> = {};
  return ctx;
}

const canvasStub = {
  width: 0,
  height: 0,
  style: {} as CSSStyleDeclaration,
  getContext: () => ctxInstance,
} as unknown as HTMLCanvasElement;

const ctxInstance = makeCtx();

function synthFrame(n: number): CodecFrame {
  const cells: CodecCell[] = [];
  let seed = 12345;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 480;
    const cat = i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : i % 10 === 8 ? 2 : 3;
    const state = cat === 2 ? (rand() < 0.3 ? 1 : 2) : rand() < 0.05 ? 1 : 0;
    const species = cat === 0 ? 1 : cat === 1 ? 11 : cat === 2 ? 15 : 24;
    cells.push({
      id: i + 1,
      speciesId: species,
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      angle: rand() * Math.PI * 2,
      biomass: 0.5 + rand() * 2,
      state,
      timer: state === 1 ? 5 + Math.floor(rand() * 20) : Math.floor(rand() * 100),
    });
  }
  return { tick: 300, cells, carbonPermille: 800_000, antibioticPeakPermille: 900 };
}

function bench(label: string, fn: () => void, iters: number) {
  fn(); // 预热
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - t0) / iters;
  console.log(`${label}: ${ms.toFixed(2)} ms/帧 ${ms < 16.7 ? '✓ <16.7ms' : '✗ 超 16.7ms 预算'}`);
  return ms;
}

const N = 1400;
const renderer = new DishRenderer(canvasStub);
renderer.resize(640, 2);
const frame = synthFrame(N);
const categoryById = new Map([[1, 0], [11, 1], [15, 2], [24, 3]]);

const baseOpts = {
  frame,
  categoryById,
  tick: 300,
  hoverWorld: null,
  lensRadiusPx: 120,
  lensZoom: 4,
  showColonyEdge: true,
  elapsed: 0.3,
};

bench(`${N} 细胞 · 普通视图（含菌落边缘）`, () => renderer.draw(baseOpts), 200);
bench(`${N} 细胞 · 无边缘`, () => renderer.draw({ ...baseOpts, showColonyEdge: false }), 200);

const hoverOpts = { ...baseOpts, hoverWorld: { x: 120, y: -80 } };
bench(`${N} 细胞 · 悬停镜头 4×（只画镜内）`, () => renderer.draw(hoverOpts), 200);

// 分批：单批 6ms 预算下需要几批画完
const project = (x: number, y: number): [number, number] => renderer.toPx(x, y);
let cursor = 0;
let batches = 0;
const t0 = performance.now();
while (cursor < N) {
  const r = renderer.drawCells(baseOpts, project, 1, cursor, 6, false);
  cursor = r.next;
  batches++;
  if (r.done) break;
}
console.log(`6ms 时间片：${batches} 批画完 ${N} 细胞，实际 ${(performance.now() - t0).toFixed(1)}ms`);
