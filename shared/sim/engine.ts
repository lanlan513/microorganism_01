/**
 * 培养皿确定性模拟引擎（服务端权威）。
 *
 * 确定性契约：
 *  - 随机只来自以 seed 为根的 RngStream，细胞按 id 升序迭代；
 *  - 网格扩散 i/j 双重循环固定次序，反射边界，双缓冲交换；
 *  - 不读墙钟、不依赖对象键枚举顺序；
 *  - 落盘计数一律定点整数。
 *
 * 每个固定时间步：
 *  运动 → 空间索引重建 → 病毒吸附/感染推进与裂解 → 代谢（Monod 摄食、
 *  维持消耗、抗生素损伤）→ 真菌分泌抗生素 → 二分裂（拥挤限制）
 *  → 碳/抗生素场扩散衰减与尸体碳回收 → 灭绝记录。
 */
import { createHash } from 'node:crypto';
import { RngStream } from './rng.js';
import { resolveTraits, type SpeciesTraits } from './traits.js';
import { encodeFrame } from './codec.js';
import { WORLD_RADIUS, GRID_N, CELL_SIZE } from './constants.js';
import type {
  EcoFingerprint,
  FingerprintCheckpoint,
  InoculumItem,
  RunSpeciesInfo,
  SimCell,
  SimCategory,
  SimEvent,
  TickCount,
} from './types.js';
import { SIM_CATEGORIES } from './types.js';

export const SPEC_VERSION = 1;

/* ── 世界常数（几何见 ./constants.ts；改动任何速率常数都需升级 SPEC_VERSION） ── */
const INIT_CARBON = 2;
const CARBON_KS_BACT = 0.15;
const CARBON_KS_FUNGI = 0.1;
const CARBON_KS_ARCH = 0.02;
const CARBON_DIFFUSION = 0.008;
const ANTIBIOTIC_DIFFUSION = 0.055;
const ANTIBIOTIC_DECAY = 0.0045;
const ANTIBIOTIC_DAMAGE = 0.05;
const DEATH_BIOMASS = 0.22;
const CADAVER_CARBON_RETURN = 0.7;
const DENSITY_RADIUS = 16;
const DENSITY_CAP = 7;
const INFECTION_RADIUS = 15;
export const MAX_TICKS = 900;
const HARD_CELL_CAP = 1400;
const STABLE_WINDOW = 160;
const STABLE_WINDOW_START = 400;
const STABLE_REL_TOL = 0.08;
const CHECKPOINT_GENERATIONS = [50, 100, 200, 400, 600];

export interface CatalogEntry {
  name: string;
  scientificName: string;
  category: SimCategory;
}

export interface EngineOptions {
  seed: number | string;
  inoculum: InoculumItem[];
  catalog: Map<number, CatalogEntry>;
}

export interface RunResult {
  ticks: TickCount[];
  events: SimEvent[];
  species: RunSpeciesInfo[];
  /** 逐帧二进制（帧格式见 codec.ts），含 tick 0 */
  frames: Uint8Array;
  /** 每帧在 frames 中的字节偏移 */
  frameOffsets: number[];
  fingerprint: EcoFingerprint;
  maxCells: number;
}

export class SimulationEngine {
  private seedRaw: string;
  private rng: RngStream;
  private inoculum: InoculumItem[];
  private catalog: Map<number, CatalogEntry>;
  private traitsCache = new Map<number, SpeciesTraits>();
  private speciesMeta = new Map<number, RunSpeciesInfo>();

  private cells: SimCell[] = [];
  private carbon = new Float64Array(GRID_N * GRID_N);
  private antibiotic = new Float64Array(GRID_N * GRID_N);
  private nextId = 1;
  private currentTick = 0;

  private ticksOut: TickCount[] = [];
  private eventsOut: SimEvent[] = [];
  private frameChunks: Uint8Array[] = [];
  private frameOffsets: number[] = [];
  private frameBytes = 0;
  private maxCells = 0;
  private transcriptHash = '';
  private chainHash = '';
  private lastSeen = new Map<number, number>();
  private extinctRecorded = new Set<number>();

  constructor(opts: EngineOptions) {
    this.seedRaw = String(opts.seed);
    this.rng = new RngStream(opts.seed);
    this.inoculum = [...opts.inoculum]
      .filter((i) => Number.isInteger(i.count) && i.count > 0 && opts.catalog.has(i.microbeId))
      .sort((a, b) => a.microbeId - b.microbeId);
    this.catalog = opts.catalog;
  }

  run(): RunResult {
    this.initializeWorld();
    this.record(0);

    for (let tick = 1; tick <= MAX_TICKS; tick++) {
      this.step(tick);
      this.record(tick);
      if (this.cells.length > this.maxCells) this.maxCells = this.cells.length;

      if (this.cells.length === 0 && tick >= 30) break;

      // 稳定判定：当前代与 STABLE_WINDOW 代之前相比，四类数量都近似不变
      // （不用相邻代，否则缓慢演替会被误判为"已稳定"而提前收尾）
      if (tick >= STABLE_WINDOW_START && tick - STABLE_WINDOW >= 0) {
        const before = this.ticksOut[tick - STABLE_WINDOW];
        const cur = this.ticksOut[tick];
        let stable = true;
        for (const cat of SIM_CATEGORIES) {
          const denom = Math.max(8, before[cat]);
          if (Math.abs(cur[cat] - before[cat]) / denom > STABLE_REL_TOL) {
            stable = false;
            break;
          }
        }
        if (stable) break;
      }
    }

    return this.buildResult();
  }

  private traitsFor(id: number): SpeciesTraits {
    let t = this.traitsCache.get(id);
    if (!t) {
      const meta = this.catalog.get(id)!;
      t = resolveTraits(id, meta.category);
      this.traitsCache.set(id, t);
      this.speciesMeta.set(id, {
        microbeId: id,
        name: meta.name,
        scientificName: meta.scientificName,
        category: t.category,
        traits: {
          uptakeRate: round4(t.uptakeRate),
          yieldEfficiency: round4(t.yieldEfficiency),
          maintenance: round4(t.maintenance),
          divideThreshold: round4(t.divideThreshold),
          motility: round4(t.motility),
          antibioticTolerance: round4(t.antibioticTolerance),
          antibioticProduction: round4(t.antibioticProduction),
          adsorption: round4(t.adsorption),
          lysisDelay: t.lysisDelay,
          burstSize: t.burstSize,
          virionTtl: t.virionTtl,
        },
      });
    }
    return t;
  }

  private gc(ix: number, iy: number): number {
    return iy * GRID_N + ix;
  }

  private gridOf(x: number, y: number): [number, number] {
    const ix = Math.max(0, Math.min(GRID_N - 1, Math.floor((x + WORLD_RADIUS) / CELL_SIZE)));
    const iy = Math.max(0, Math.min(GRID_N - 1, Math.floor((y + WORLD_RADIUS) / CELL_SIZE)));
    return [ix, iy];
  }

  private insideDish(ix: number, iy: number): boolean {
    const cx = (ix + 0.5) * CELL_SIZE - WORLD_RADIUS;
    const cy = (iy + 0.5) * CELL_SIZE - WORLD_RADIUS;
    return cx * cx + cy * cy <= WORLD_RADIUS * WORLD_RADIUS;
  }

  private initializeWorld() {
    for (let iy = 0; iy < GRID_N; iy++) {
      for (let ix = 0; ix < GRID_N; ix++) {
        if (this.insideDish(ix, iy)) this.carbon[this.gc(ix, iy)] = INIT_CARBON;
      }
    }

    const n = this.inoculum.length;
    const place = this.rng.fork(0x1a7);
    this.inoculum.forEach((item, idx) => {
      const traits = this.traitsFor(item.microbeId);
      const angle = n === 1 ? 0 : (idx / n) * Math.PI * 2;
      const ringR = n === 1 ? 40 : 90;
      const cx = Math.cos(angle) * ringR;
      const cy = Math.sin(angle) * ringR;
      for (let k = 0; k < item.count; k++) {
        const g1 = Math.max(1e-6, place.next());
        const g2 = place.next();
        const r = Math.sqrt(-2 * Math.log(g1)) * 24;
        const a = g2 * Math.PI * 2;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        const [x, y] = clampToDish(px, py);
        const isVirion = traits.category === 'virus';
        this.cells.push({
          id: this.nextId++,
          speciesId: item.microbeId,
          category: traits.category,
          x,
          y,
          angle: place.next() * Math.PI * 2,
          biomass: traits.startBiomass,
          state: isVirion ? 'virion' : 'active',
          lysisIn: 0,
          ttl: isVirion ? 0 : undefined,
        });
      }
      this.lastSeen.set(item.microbeId, 0);
      this.eventsOut.push({
        tick: 0,
        type: 'inoculate',
        speciesId: item.microbeId,
        category: traits.category,
        count: item.count,
      });
    });
    this.maxCells = this.cells.length;
  }

  /* ─────────────────────── 单步 ─────────────────────── */

  private step(tick: number) {
    this.currentTick = tick;
    this.buildSpatialIndex();
    this.moveCells();
    this.buildSpatialIndex();
    this.virusPhase();
    this.buildSpatialIndex();
    this.metabolismPhase();
    this.diffuseFields();
    this.recordExtinctions(tick);
  }

  private buckets: number[][] = new Array(GRID_N * GRID_N);

  private buildSpatialIndex() {
    for (let i = 0; i < this.buckets.length; i++) {
      if (this.buckets[i]) this.buckets[i].length = 0;
    }
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      const [gx, gy] = this.gridOf(c.x, c.y);
      const key = gy * GRID_N + gx;
      (this.buckets[key] ??= []).push(i);
    }
  }

  private forEachNeighbor(x: number, y: number, radius: number, fn: (j: number) => void) {
    const [gx, gy] = this.gridOf(x, y);
    const reach = Math.ceil(radius / CELL_SIZE);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_N || ny >= GRID_N) continue;
        const arr = this.buckets[ny * GRID_N + nx];
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const j = arr[k];
          const o = this.cells[j];
          const ddx = o.x - x;
          const ddy = o.y - y;
          if (ddx * ddx + ddy * ddy <= radius * radius) fn(j);
        }
      }
    }
  }

  private moveCells() {
    for (const c of this.cells) {
      const t = this.traitsFor(c.speciesId);
      let speed = t.motility;
      if (c.state === 'infected') speed *= 0.3;
      if (speed <= 0) continue;
      const wiggle = c.state === 'virion' ? 1.2 : 0.5;
      c.angle += (this.rng.next() - 0.5) * 2 * wiggle;
      const nx = c.x + Math.cos(c.angle) * speed;
      const ny = c.y + Math.sin(c.angle) * speed;
      const d2 = nx * nx + ny * ny;
      if (d2 > WORLD_RADIUS * WORLD_RADIUS) {
        c.angle = Math.atan2(-c.y, -c.x) + (this.rng.next() - 0.5) * 0.8;
        const k = (WORLD_RADIUS / Math.sqrt(d2)) * 0.999;
        c.x = nx * k;
        c.y = ny * k;
      } else {
        c.x = nx;
        c.y = ny;
      }
    }
  }

  private virusPhase() {
    const dead = new Set<number>();
    const births: SimCell[] = [];

    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      const t = this.traitsFor(c.speciesId);

      if (c.state === 'virion') {
        c.ttl = (c.ttl ?? 0) + 1;
        if (c.ttl >= t.virionTtl) {
          dead.add(i);
          continue;
        }
        let hostIdx = -1;
        this.forEachNeighbor(c.x, c.y, INFECTION_RADIUS, (j) => {
          if (hostIdx !== -1) return;
          const h = this.cells[j];
          if (h.state !== 'active' || h.category === 'virus') return;
          if (t.hosts.length > 0 && !t.hosts.includes(h.speciesId)) return;
          hostIdx = j;
        });
        if (hostIdx !== -1 && this.rng.next() < t.adsorption) {
          const host = this.cells[hostIdx];
          host.state = 'infected';
          host.lysisIn = t.lysisDelay;
          host.infectedBy = c.speciesId;
          dead.add(i);
          this.eventsOut.push({
            tick: this.currentTick,
            type: 'infection',
            speciesId: host.speciesId,
            category: host.category,
          });
        }
      } else if (c.state === 'infected') {
        c.lysisIn -= 1;
        if (c.lysisIn <= 0) {
          dead.add(i);
          const virusSpecies = c.infectedBy ?? c.speciesId;
          const vt = this.traitsFor(virusSpecies);
          for (let b = 0; b < vt.burstSize; b++) {
            if (this.cells.length + births.length - dead.size >= HARD_CELL_CAP) break;
            const [vx, vy] = clampToDish(
              c.x + (this.rng.next() - 0.5) * 10,
              c.y + (this.rng.next() - 0.5) * 10
            );
            births.push({
              id: this.nextId++,
              speciesId: virusSpecies,
              category: 'virus',
              x: vx,
              y: vy,
              angle: this.rng.next() * Math.PI * 2,
              biomass: vt.startBiomass,
              state: 'virion',
              lysisIn: 0,
              ttl: 0,
            });
          }
          this.eventsOut.push({
            tick: this.currentTick,
            type: 'lysis',
            speciesId: virusSpecies,
            category: c.category,
            count: vt.burstSize,
          });
        }
      }
    }

    if (births.length) this.cells.push(...births);
    if (dead.size) this.compact(dead);
  }

  private metabolismPhase() {
    const dead = new Set<number>();
    const births: SimCell[] = [];

    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      if (c.state === 'virion') continue;
      const t = this.traitsFor(c.speciesId);
      const [gx, gy] = this.gridOf(c.x, c.y);
      const gidx = this.gc(gx, gy);

      let neighbors = 0;
      this.forEachNeighbor(c.x, c.y, DENSITY_RADIUS, () => {
        neighbors++;
      });
      // 注意：拥挤只限制"能否分裂"，不折减摄食 —— 否则整个菌落会被
      // 人为冻在接种斑里，暴发与扩散都无从发生。

      let delta = -t.maintenance;
      const localC = this.carbon[gidx];
      if (localC > 0 && t.uptakeRate > 0) {
        const ks =
          c.category === 'bacteria'
            ? CARBON_KS_BACT
            : c.category === 'fungi'
              ? CARBON_KS_FUNGI
              : CARBON_KS_ARCH;
        const want = t.uptakeRate * (localC / (localC + ks));
        const taken = Math.min(want, localC);
        this.carbon[gidx] = localC - taken;
        delta += taken * t.yieldEfficiency;
      }

      const anti = this.antibiotic[gidx];
      if (anti > 0 && c.category !== 'virus') {
        delta -= anti * (1 - t.antibioticTolerance) * ANTIBIOTIC_DAMAGE;
      }

      c.biomass += delta;

      if (c.biomass < DEATH_BIOMASS) {
        dead.add(i);
        this.carbon[gidx] += Math.max(0, c.biomass) * CADAVER_CARBON_RETURN;
        const byAnti = anti * (1 - t.antibioticTolerance) > 0.5;
        this.eventsOut.push({
          tick: this.currentTick,
          type: byAnti ? 'antibiotic_kill' : 'starve',
          speciesId: c.speciesId,
          category: c.category,
        });
        continue;
      }

      if (t.antibioticProduction > 0 && c.state === 'active') {
        this.antibiotic[gidx] += t.antibioticProduction;
      }

      if (
        c.state === 'active' &&
        c.biomass >= t.divideThreshold &&
        neighbors <= DENSITY_CAP &&
        this.cells.length + births.length - dead.size < HARD_CELL_CAP
      ) {
        c.biomass /= 2;
        const splitAngle = c.angle + (this.rng.next() - 0.5) * 1.1;
        const [dx, dy] = clampToDish(
          c.x + Math.cos(splitAngle) * 3,
          c.y + Math.sin(splitAngle) * 3
        );
        births.push({
          id: this.nextId++,
          speciesId: c.speciesId,
          category: c.category,
          x: dx,
          y: dy,
          angle: splitAngle + Math.PI + (this.rng.next() - 0.5) * 0.6,
          biomass: c.biomass,
          state: 'active',
          lysisIn: 0,
        });
        this.eventsOut.push({
          tick: this.currentTick,
          type: 'division',
          speciesId: c.speciesId,
          category: c.category,
        });
      }
    }

    if (births.length) this.cells.push(...births);
    if (dead.size) this.compact(dead);
  }

  private compact(dead: Set<number>) {
    this.cells = this.cells.filter((_, i) => !dead.has(i));
  }

  private diffuseFields() {
    const nextCarbon = new Float64Array(GRID_N * GRID_N);
    const nextAnti = new Float64Array(GRID_N * GRID_N);
    diffuse(this.carbon, nextCarbon, CARBON_DIFFUSION, 0, GRID_N);
    diffuse(this.antibiotic, nextAnti, ANTIBIOTIC_DIFFUSION, ANTIBIOTIC_DECAY, GRID_N);
    this.carbon = nextCarbon;
    this.antibiotic = nextAnti;
  }

  private recordExtinctions(tick: number) {
    const seen = new Set<number>();
    for (const c of this.cells) seen.add(c.speciesId);
    for (const c of this.cells) this.lastSeen.set(c.speciesId, tick);
    for (const id of [...this.lastSeen.keys()]) {
      if (!seen.has(id) && !this.extinctRecorded.has(id)) {
        this.extinctRecorded.add(id);
        this.eventsOut.push({
          tick,
          type: 'extinction',
          speciesId: id,
          category: this.traitsCache.get(id)?.category,
        });
      }
    }
  }

  /* ─────────────────────── 记录 ─────────────────────── */

  private fieldTotals(): { carbon: number; antiPeak: number } {
    let carbon = 0;
    let antiPeak = 0;
    for (let i = 0; i < this.carbon.length; i++) {
      carbon += this.carbon[i];
      if (this.antibiotic[i] > antiPeak) antiPeak = this.antibiotic[i];
    }
    return { carbon, antiPeak };
  }

  private record(tick: number) {
    const comp = { bacteria: 0, fungi: 0, virus: 0, archaea: 0 };
    for (const c of this.cells) comp[c.category]++;
    const { carbon, antiPeak } = this.fieldTotals();
    const carbonI = Math.round(carbon * 1000);
    const antiI = Math.round(antiPeak * 1000);

    const rec: TickCount = {
      tick,
      total: this.cells.length,
      bacteria: comp.bacteria,
      fungi: comp.fungi,
      virus: comp.virus,
      archaea: comp.archaea,
      carbon: carbonI,
      antibioticPeak: antiI,
    };
    this.ticksOut.push(rec);

    const frame = encodeFrame(
      tick,
      this.cells,
      carbonI,
      antiI
    );
    this.frameOffsets.push(this.frameBytes);
    this.frameBytes += frame.byteLength;
    this.frameChunks.push(frame);

    const line = `${rec.tick}|${rec.total}|${rec.bacteria}|${rec.fungi}|${rec.virus}|${rec.archaea}|${rec.carbon}|${rec.antibioticPeak}`;
    this.transcriptHash = createHash('sha256').update(this.transcriptHash + line + '\n').digest('hex');

    const evLine = this.eventsOut
      .filter((e) => e.tick === tick)
      .map((e) => `${e.type}:${e.speciesId ?? '-'}:${e.count ?? ''}`)
      .sort()
      .join(',');
    this.chainHash = createHash('sha256')
      .update(this.chainHash + line + '\n' + evLine + '\n')
      .digest('hex');
  }

  private buildResult(): RunResult {
    const frames = concatChunks(this.frameChunks, this.frameBytes);
    const totalTicks = this.ticksOut[this.ticksOut.length - 1].tick;

    const gens = [...CHECKPOINT_GENERATIONS, totalTicks].filter(
      (g, i, arr) => g <= totalTicks && arr.indexOf(g) === i
    );
    const checkpoints: FingerprintCheckpoint[] = gens.map((g) => {
      const rec = this.ticksOut[g];
      const composition = {
        bacteria: rec.bacteria,
        fungi: rec.fungi,
        virus: rec.virus,
        archaea: rec.archaea,
      };
      const ratioPermille = { bacteria: 0, fungi: 0, virus: 0, archaea: 0 };
      if (rec.total > 0) {
        let used = 0;
        (['bacteria', 'fungi', 'virus'] as const).forEach((cat) => {
          const v = Math.floor((composition[cat] / rec.total) * 1000);
          ratioPermille[cat] = v;
          used += v;
        });
        ratioPermille.archaea = 1000 - used;
      }
      return { generation: g, total: rec.total, composition, ratioPermille };
    });

    let dominantSpeciesId: number | null = null;
    {
      const bySpecies = new Map<number, number>();
      for (const c of this.cells) bySpecies.set(c.speciesId, (bySpecies.get(c.speciesId) ?? 0) + 1);
      let best = 0;
      for (const [id, count] of bySpecies) {
        if (count > best) {
          best = count;
          dominantSpeciesId = id;
        }
      }
    }

    const extinctionOrder = [...this.extinctRecorded]
      .map((id) => ({ id, last: this.lastSeen.get(id) ?? 0 }))
      .sort((a, b) => a.last - b.last || a.id - b.id)
      .map((x) => x.id);

    const concluded: EcoFingerprint['concluded'] =
      this.cells.length === 0 ? 'extinct' : totalTicks >= MAX_TICKS ? 'max-ticks' : 'stable';

    const canonInoc = this.inoculum.map((i) => `${i.microbeId}:${i.count}`).join('|');
    const inoculumHash = createHash('sha256').update(`v${SPEC_VERSION}/${canonInoc}`).digest('hex');

    const fingerprint: EcoFingerprint = {
      specVersion: SPEC_VERSION,
      seed: this.seedRaw,
      inoculumHash,
      transcriptHash: this.transcriptHash,
      chainTip: this.chainHash,
      generations: totalTicks + 1,
      checkpoints,
      dominantSpeciesId,
      extinctionOrder,
      concluded,
    };

    return {
      ticks: this.ticksOut,
      events: this.eventsOut,
      species: [...this.speciesMeta.values()].sort((a, b) => a.microbeId - b.microbeId),
      frames,
      frameOffsets: this.frameOffsets,
      fingerprint,
      maxCells: Math.max(this.maxCells, ...this.ticksOut.map((t) => t.total)),
    };
  }
}

/* ── 纯函数工具 ── */

function clampToDish(x: number, y: number): [number, number] {
  const d2 = x * x + y * y;
  if (d2 <= WORLD_RADIUS * WORLD_RADIUS) return [x, y];
  const k = (WORLD_RADIUS / Math.sqrt(d2)) * 0.999;
  return [x * k, y * k];
}

function diffuse(src: Float64Array, dst: Float64Array, rate: number, decay: number, n: number) {
  const keep = 1 - rate * 4 - decay;
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iy * n + ix;
      const v = src[i];
      const l = ix > 0 ? src[i - 1] : v;
      const r = ix < n - 1 ? src[i + 1] : v;
      const u = iy > 0 ? src[i - n] : v;
      const d = iy < n - 1 ? src[i + n] : v;
      dst[i] = Math.max(0, v * keep + (l + r + u + d) * rate);
    }
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
