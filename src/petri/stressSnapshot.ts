/**
 * 渲染压测：合成 1000+ 细胞的快照，直接喂给生产渲染路径（不经过服务端，仅用于帧率验收）。
 * 通过 URL ?stress=1 触发。细胞数据结构与服务端 Snapshot 完全一致。
 */
import type { CellSnapshot, Snapshot, VirionSnapshot } from '../../shared/petri';

// 与生产渲染器相同的确定性伪随机（仅用于生成压测几何，不影响任何真实模拟）
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildStressSnapshot(nCells = 1000, nVirions = 200, tick = 720): Snapshot {
  const rnd = mulberry(20260920);
  const cells: CellSnapshot[] = [];
  // 覆盖四分类、多形态的标本
  const spPool = [1, 2, 3, 4, 7, 9, 10, 15, 21, 24];
  for (let i = 0; i < nCells; i++) {
    // 在培养皿圆盘内均匀投放
    const ang = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 0.45;
    const sp = spPool[Math.floor(rnd() * spPool.length)];
    const st: 0 | 1 | 2 = rnd() < 0.06 ? 1 : rnd() < 0.08 ? 2 : 0;
    cells.push({
      id: i + 1,
      sp,
      x: 0.5 + Math.cos(ang) * r,
      y: 0.5 + Math.sin(ang) * r,
      m: 0.5 + rnd() * 0.6,
      m0: 0.5,
      st,
      h: rnd() * Math.PI * 2,
    });
  }
  const virions: VirionSnapshot[] = [];
  for (let i = 0; i < nVirions; i++) {
    const ang = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 0.45;
    virions.push({ sp: 15, x: 0.5 + Math.cos(ang) * r, y: 0.5 + Math.sin(ang) * r });
  }
  const size = 32;
  const carbon: number[] = [];
  for (let i = 0; i < size * size; i++) carbon.push(rnd() * 1.2);
  return {
    runId: 'stress',
    tick,
    gen: Math.floor(tick / 120),
    simMinutes: tick,
    status: 'running',
    speed: 1,
    counts: {
      totalCells: nCells,
      virions: nVirions,
      bacteria: cells.filter((c) => [1, 2, 3, 4, 7].includes(c.sp)).length,
      fungi: cells.filter((c) => [9, 10].includes(c.sp)).length,
      archaea: cells.filter((c) => [21, 24].includes(c.sp)).length,
      virus: nVirions,
    },
    cells,
    virions,
    field: { size, carbon, drugs: {} },
    events: [],
  };
}
