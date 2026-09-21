/**
 * PetriSimulation —— 培养皿生态演替的确定性模拟内核（权威实现）。
 *
 * 权威原则：
 *  1) 本文件只使用纯运算（Float64Array、确定性 RNG），不依赖 DOM、Date、Math.random；
 *  2) 同一份「接种清单 + 种子 + 给药事件」重放，逐 tick 的每种标本计数序列必须字节级一致；
 *  3) 前端不持有本文件，任何前端改动都无法影响结果。
 *
 * 物理模型（1 tick = 模拟 1 分钟）：
 *  - 碳源场 / 抗菌素场：GRID×GRID 网格，五点显式扩散，培养皿外节点恒空，无通量内边界；
 *  - 细胞：Monod 比生长、维持能耗、碳守恒（摄取/矿化/裂解释碳）、
 *          run-and-tumble 鞭毛运动（确定性反射边界）、阈值二分裂；
 *  - 抗菌素：扩散+半衰期衰减，抑制生长并按 -ln(1-kill)=k·C·(1-resistance) 概率裂解；
 *  - 病毒：游离粒子布朗扩散并指数失活，接触易感宿主后潜伏、裂解释放子代；
 *  - 灭绝/优势种随演化自然产生，逐 tick 记录。
 */

import type {
  AntibioticId,
  CellSnapshot,
  CreateRunRequest,
  EcoFingerprint,
  GenSample,
  InoculumItem,
  PopulationCounts,
  RegimenDose,
  RunEventData,
  VirionSnapshot,
} from '../../../shared/petri.js';
import { DeterministicRng, mulberry32, sha256 } from './rng.js';
import { SpecimenTrait, traitOf } from './traits.js';

export const ENGINE_VERSION = 'petri-core-1.0.0';
export const TOTAL_TICKS = 1800; // 30 小时模拟
export const TICKS_PER_GENERATION = 120; // 指纹中的「一代」= 120 min（约等于快生菌 2-4 个细胞周期）
export const FINGERPRINT_GENS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const GRID = 64;
const FIELD_SAMPLE = 32; // 下发前端的降采样场边长
const DISH_R = 0.455;
const DISH_CENTER = 0.5;
const INITIAL_CARBON_PER_NODE = 1.0;
const CARBON_INFLOW = 0.00012; // 每节点每 tick 的缓慢碳源补给（培养基缓释）
const DIFFUSE = 0.1; // 五点扩散系数（显式稳定上限 0.25）
const DRUG_DECAY = 0.999; // 半衰期 ≈ ln2/0.001 ≈ 693 tick ≈ 11.5h
const DRUG_KILL_RATE = 0.04; // 单位浓度下、无抗性时的每 tick 死亡系数
const STARVE_THRESHOLD = 0.4; // 质量低于初始质量的 40% 进入饥饿
const DAUGHTER_MASS = 0.5; // 二分裂：子细胞质量=亲代一半，质量达到 1.0 时分裂
const CONTACT_DIST = 0.016; // 病毒吸附宿主的接触半径（世界坐标）
const MAX_VIRIONS = 3000;
const MAX_CELLS = 30000;

const DRUGS: AntibioticId[] = ['penicillin', 'ciprofloxacin', 'amphotericin'];

interface Cell {
  id: number;
  sp: number;
  x: number;
  y: number;
  m: number;
  m0: number;
  st: 0 | 1 | 2;
  h: number;
  infectedTick: number; // 被感染的 tick（st===1 时有效）
  infectedBy: number; // 感染它的病毒标本 id（st===1 时有效）
}

interface Virion {
  id: number;
  sp: number;
  x: number;
  y: number;
  h: number;
}

export interface DoseRecord {
  tick: number;
  drug: AntibioticId;
  concentration: number;
  source: 'regimen' | 'operator';
}

/** 每个标本逐 tick 存活数（指纹的逐格数量序列） */
export interface TickRecord {
  tick: number;
  counts: Record<number, number>;
  virions: number;
}

export class PetriSimulation {
  readonly runId: string;
  readonly seed: string;
  readonly inocula: InoculumItem[];
  readonly regimen: RegimenDose[];

  tick = 0;
  finished = false;
  cells: Cell[] = [];
  virions: Virion[] = [];

  private carbon: Float64Array = new Float64Array(GRID * GRID);
  private drugs: Record<AntibioticId, Float64Array> = {
    penicillin: new Float64Array(GRID * GRID),
    ciprofloxacin: new Float64Array(GRID * GRID),
    amphotericin: new Float64Array(GRID * GRID),
  };

  private rng: DeterministicRng;
  private nextCellId = 1;
  private nextVirionId = 1;
  private aliveBySpecimen: Record<number, number> = {};
  private everInoculated = new Set<number>();
  private extinctTick = new Map<number, number>();
  private lastCount: Record<number, number> = {};

  /** 逐 tick 计数序列（完整存档与指纹依据） */
  tickRecords: TickRecord[] = [];
  events: RunEventData[] = [];
  doseHistory: DoseRecord[] = [];
  /** t=300k 的完整快照（供存档/回放），最后一帧单独保存 */
  checkpoints: { tick: number; cells: Cell[]; virions: Virion[]; carbon: number[] }[] = [];

  constructor(req: CreateRunRequest, runId: string) {
    this.runId = runId;
    this.seed = typeof req.seed === 'number' ? String(req.seed) : req.seed;
    this.inocula = req.inocula
      .filter((it) => it.count > 0)
      .map((it) => ({ specimenId: it.specimenId, count: Math.floor(it.count) }));
    this.regimen = req.regimen ?? [];
    const carbonScale = req.initialCarbon !== undefined ? req.initialCarbon : 1;
    if (this.inocula.length === 0) throw new Error('接种清单为空');
    for (const it of this.inocula) traitOf(it.specimenId); // 校验标本存在

    // 接种布局也由（种子+清单哈希）决定，与推进流分开
    const initRng = mulberry32(`petri-init|${this.seed}|${this.canonicalInocula()}`);
    this.rng = mulberry32(`petri-step|${this.seed}|${this.canonicalInocula()}`);

    this.initFields(carbonScale, initRng);
    this.placeInocula(initRng);

    for (const sp of this.everInoculated) {
      this.lastCount[sp] =
        traitOf(sp).category === 'virus' ? this.virions.filter((v) => v.sp === sp).length : this.aliveBySpecimen[sp] ?? 0;
    }
    this.recordTick();
  }

  // ------------------------------------------------------------ 初始化

  private initFields(scale: number, rng: DeterministicRng) {
    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        const i = iy * GRID + ix;
        if (!this.insideDishGrid(ix, iy)) continue;
        // 基础均匀碳源 + 由种子决定的细微空间异质性，打破平面对称
        const wobble = 0.94 + rng.next() * 0.12;
        this.carbon[i] = INITIAL_CARBON_PER_NODE * scale * wobble;
      }
    }
  }

  private placeInocula(rng: DeterministicRng) {
    // 不同标本从培养皿内不同的接种扇区/径向起始，沿 id 顺序严格确定
    this.inocula.forEach((it, order) => {
      const trait = traitOf(it.specimenId);
      this.everInoculated.add(it.specimenId);
      if (trait.category === 'virus') {
        // 病毒接种物是游离病毒粒子，进入粒子池（不是细胞）
        for (let k = 0; k < it.count; k++) {
          if (this.virions.length >= MAX_VIRIONS) break;
          const ang = rng.range(0, Math.PI * 2);
          const r = rng.range(0.02, 0.3);
          this.virions.push({
            id: this.nextVirionId++,
            sp: it.specimenId,
            x: clamp01(DISH_CENTER + Math.cos(ang) * r),
            y: clamp01(DISH_CENTER + Math.sin(ang) * r),
            h: rng.range(0, Math.PI * 2),
          });
        }
        this.aliveBySpecimen[it.specimenId] = 0;
        return;
      }
      const sector = (order / this.inocula.length) * Math.PI * 2;
      const baseR = 0.16 + (order % 3) * 0.03;
      for (let k = 0; k < it.count; k++) {
        if (this.cells.length >= MAX_CELLS) break;
        const ang = sector + rng.range(-0.55, 0.55);
        const r = baseR + rng.range(-0.05, 0.05);
        const x = clamp01(DISH_CENTER + Math.cos(ang) * r);
        const y = clamp01(DISH_CENTER + Math.sin(ang) * r);
        this.cells.push({
          id: this.nextCellId++,
          sp: it.specimenId,
          x,
          y,
          m: 1,
          m0: 1,
          st: 0,
          h: rng.range(0, Math.PI * 2),
          infectedTick: -1,
          infectedBy: -1,
        });
        this.aliveBySpecimen[it.specimenId] = (this.aliveBySpecimen[it.specimenId] ?? 0) + 1;
      }
    });
  }

  // ------------------------------------------------------------ 每步推进

  /** 推进一 tick。外部只能通过 step 改变世界。 */
  step() {
    if (this.finished) return;
    this.tick++;
    this.events = [];

    // (0) 预设方案给药（确定性事件流的一部分）
    for (const dose of this.regimen) {
      if (dose.atTick === this.tick) this.applyDose(dose.drug, dose.concentration, 'regimen');
    }

    this.diffuseDrugs();
    this.diffuseCarbon();

    // (1) 细胞：运动 / 局部碳摄取 / 生长 / 二分裂 / 死亡
    const survivors: Cell[] = [];
    const newDaughters: Cell[] = [];

    for (const cell of this.cells) {
      const trait = traitOf(cell.sp);
      let alive = true;

      // 感染潜伏细胞：按【病毒】的潜伏期到点裂解
      if (cell.st === 1 && cell.infectedTick >= 0) {
        const virusTrait = traitOf(cell.infectedBy);
        if (this.tick - cell.infectedTick >= (virusTrait.latency ?? 0)) {
          this.lysisByVirus(cell, virusTrait);
          alive = false;
        }
      }

      if (alive) {
        // 运动（所有细胞都要消耗同样的随机数预算，保证 RNG 轨迹稳定）
        this.moveCell(cell, trait);

        if (cell.st !== 1) {
          // 药物胁迫与裂解死亡
          const stress = this.drugStress(cell.x, cell.y, trait);
          cell.st = stress.pressure > 0.45 ? 2 : 0;
          if (this.rng.chance(stress.killProb)) {
            this.depositCarbon(cell.x, cell.y, cell.m * 0.5); // 裂解残余碳回场
            alive = false;
          } else {
            // 生长（碳守恒：摄取 -> 生物量 + 呼吸矿化，摄取时即时扣减碳场）
            this.growCell(cell, trait, stress.pressure);
            if (cell.m >= 1.0) {
              newDaughters.push(this.divide(cell, trait));
            }
            // 饥饿死亡
            if (cell.m < cell.m0 * STARVE_THRESHOLD) {
              const p = (STARVE_THRESHOLD * cell.m0 - cell.m) * 0.05;
              if (this.rng.chance(p)) {
                this.depositCarbon(cell.x, cell.y, cell.m * 0.4);
                alive = false;
              }
            }
          }
        }
      }

      if (alive) survivors.push(cell);
      else this.decrementCount(cell.sp);
    }

    // 子细胞追加到队尾，本 tick 不参与迭代（顺序确定）
    for (const d of newDaughters) {
      this.aliveBySpecimen[d.sp] = (this.aliveBySpecimen[d.sp] ?? 0) + 1;
      survivors.push(d);
    }
    this.cells = survivors;

    // (2) 病毒：失活 / 运动 / 吸附感染
    this.stepVirions();

    // (3) 灭绝检测（顺序按标本 id）
    this.detectExtinctions();

    this.recordTick();
    if (this.tick % 300 === 0) this.saveCheckpoint();
    if (this.tick >= TOTAL_TICKS) this.finish();
  }

  private diffuseCarbon() {
    const g = this.carbon;
    const out = new Float64Array(GRID * GRID);
    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        const i = iy * GRID + ix;
        if (!this.insideDishGrid(ix, iy)) continue;
        const c = g[i];
        const l = ix > 0 ? g[i - 1] : c;
        const r = ix < GRID - 1 ? g[i + 1] : c;
        const u = iy > 0 ? g[i - GRID] : c;
        const d = iy < GRID - 1 ? g[i + GRID] : c;
        out[i] = c + DIFFUSE * (l + r + u + d - 4 * c) + CARBON_INFLOW;
      }
    }
    this.carbon = out;
  }

  private diffuseDrugs() {
    for (const drug of DRUGS) {
      const g = this.drugs[drug];
      const out = new Float64Array(GRID * GRID);
      for (let iy = 0; iy < GRID; iy++) {
        for (let ix = 0; ix < GRID; ix++) {
          const i = iy * GRID + ix;
          if (!this.insideDishGrid(ix, iy)) continue;
          const c = g[i];
          const l = ix > 0 ? g[i - 1] : c;
          const rr = ix < GRID - 1 ? g[i + 1] : c;
          const u = iy > 0 ? g[i - GRID] : c;
          const d = iy < GRID - 1 ? g[i + GRID] : c;
          out[i] = (c + DIFFUSE * (l + rr + u + d - 4 * c)) * DRUG_DECAY;
        }
      }
      this.drugs[drug] = out;
    }
  }

  private moveCell(cell: Cell, trait: SpecimenTrait) {
    if (trait.speed > 0) {
      if (trait.motility === 'flagellum' || trait.motility === 'archaellum') {
        if (this.rng.chance(trait.tumble)) {
          cell.h = this.rng.range(0, Math.PI * 2);
        } else {
          cell.h += this.rng.range(-0.08, 0.08);
        }
      } else {
        cell.h = this.rng.range(0, Math.PI * 2);
      }
    } else {
      cell.h += this.rng.range(-0.02, 0.02); // 无动力细胞的微小热扰动（也占用随机预算）
    }
    const nx = cell.x + Math.cos(cell.h) * trait.speed;
    const ny = cell.y + Math.sin(cell.h) * trait.speed;
    // 确定性圆形边界反射
    const dx = nx - DISH_CENTER;
    const dy = ny - DISH_CENTER;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > DISH_R) {
      const ux = dx / dist;
      const uy = dy / dist;
      const over = dist - DISH_R;
      cell.x = nx - 2 * over * ux;
      cell.y = ny - 2 * over * uy;
      // 反射朝向
      const dot = Math.cos(cell.h) * ux + Math.sin(cell.h) * uy;
      cell.h = cell.h - 2 * dot * Math.atan2(uy, ux) + Math.PI;
    } else {
      cell.x = nx;
      cell.y = ny;
    }
    cell.x = clamp01(cell.x);
    cell.y = clamp01(cell.y);
  }

  private drugStress(x: number, y: number, trait: SpecimenTrait): { pressure: number; killProb: number } {
    let pressure = 0;
    let killRate = 0;
    for (const drug of DRUGS) {
      const c = this.sample(this.drugs[drug], x, y);
      if (c <= 0) continue;
      const suscept = 1 - trait.resistance[drug];
      pressure += c * suscept;
      // -ln(S) = k·C·sensitivity，每日 tick 死亡概率 1-exp(-...)
      killRate += DRUG_KILL_RATE * c * suscept;
    }
    const killProb = killRate > 0 ? 1 - Math.exp(-killRate) : 0;
    return { pressure, killProb };
  }

  private growCell(cell: Cell, trait: SpecimenTrait, pressure: number) {
    const cLocal = this.sample(this.carbon, cell.x, cell.y);
    // 抗生素同时抑制生长（抑菌效应）
    const inhibition = 1 / (1 + pressure * 1.2);
    const monod = cLocal / (trait.ks + cLocal);
    const synthesis = trait.muMax * monod * inhibition;
    const maint = trait.maintenance;
    // 生物量增量；维持能耗总是被呼吸矿化（不回场），合成部分按得率索取碳
    const dm = synthesis - maint;
    if (dm <= 0) {
      cell.m += dm; // 碳饥饿：消耗自身储备
      return;
    }
    const need = dm / trait.yield;
    const got = this.takeCarbon(cell.x, cell.y, need);
    // 实际合成受可得碳限制
    const realSynthesis = got * trait.yield;
    cell.m += realSynthesis - maint;
  }

  private divide(parent: Cell, trait: SpecimenTrait): Cell {
    const ang = this.rng.range(0, Math.PI * 2);
    const off = trait.visualRadius * 0.9;
    parent.m = DAUGHTER_MASS;
    parent.m0 = DAUGHTER_MASS;
    parent.h = ang;
    let x = parent.x + Math.cos(ang) * off;
    let y = parent.y + Math.sin(ang) * off;
    const dx = x - DISH_CENTER;
    const dy = y - DISH_CENTER;
    if (Math.sqrt(dx * dx + dy * dy) > DISH_R) {
      x = parent.x - Math.cos(ang) * off;
      y = parent.y - Math.sin(ang) * off;
    }
    return {
      id: this.nextCellId++,
      sp: parent.sp,
      x: clamp01(x),
      y: clamp01(y),
      m: DAUGHTER_MASS,
      m0: DAUGHTER_MASS,
      st: 0,
      h: ang + Math.PI,
      infectedTick: -1,
      infectedBy: -1,
    };
  }

  private lysisByVirus(cell: Cell, virusTrait: SpecimenTrait) {
    const burst = virusTrait.burst ?? 0;
    this.depositCarbon(cell.x, cell.y, cell.m * 0.3);
    for (let b = 0; b < burst; b++) {
      if (this.virions.length >= MAX_VIRIONS) break;
      const ang = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(0, CONTACT_DIST * 1.5);
      this.virions.push({
        id: this.nextVirionId++,
        sp: virusTrait.id,
        x: clamp01(cell.x + Math.cos(ang) * r),
        y: clamp01(cell.y + Math.sin(ang) * r),
        h: ang,
      });
    }
  }

  private stepVirions() {
    if (this.virions.length === 0) return;

    // 失活（顺序遍历，稳定压缩）
    const alive: Virion[] = [];
    for (const v of this.virions) {
      const decay = traitOf(v.sp).virionDecay ?? 0.001;
      if (!this.rng.chance(decay)) alive.push(v);
    }
    this.virions = alive;

    // 空间哈希桶（每 tick 重建，桶序/插入序确定）
    const bucket = new Map<number, Cell[]>();
    const keyOf = (x: number, y: number) => {
      const kx = Math.floor(x / CONTACT_DIST);
      const ky = Math.floor(y / CONTACT_DIST);
      return ky * 100000 + kx;
    };
    for (const c of this.cells) {
      if (c.st !== 0) continue;
      const key = keyOf(c.x, c.y);
      let arr = bucket.get(key);
      if (!arr) {
        arr = [];
        bucket.set(key, arr);
      }
      arr.push(c);
    }

    const remaining: Virion[] = [];
    for (const v of this.virions) {
      const trait = traitOf(v.sp);
      // 所有粒子先统一运动（固定随机数预算，保证 RNG 轨迹不因数据分叉）
      v.h = this.rng.range(0, Math.PI * 2);
      v.x = clamp01(v.x + Math.cos(v.h) * trait.speed);
      v.y = clamp01(v.y + Math.sin(v.h) * trait.speed);

      const hosts = trait.hosts ?? [];
      if (hosts.length === 0) {
        remaining.push(v);
        continue;
      }

      // 在相邻空间桶中找最近的易感宿主；等距取 id 小者 —— 完全确定
      let best: Cell | null = null;
      let bestDist = CONTACT_DIST;
      const kx = Math.floor(v.x / CONTACT_DIST);
      const ky = Math.floor(v.y / CONTACT_DIST);
      for (let by = ky - 1; by <= ky + 1; by++) {
        for (let bx = kx - 1; bx <= kx + 1; bx++) {
          const arr = bucket.get(by * 100000 + bx);
          if (!arr) continue;
          for (const c of arr) {
            if (c.st !== 0 || !hosts.includes(c.sp)) continue;
            const ddx = c.x - v.x;
            const ddy = c.y - v.y;
            const d = Math.sqrt(ddx * ddx + ddy * ddy);
            if (d < bestDist || (d === bestDist && best && c.id < best.id)) {
              bestDist = d;
              best = c;
            }
          }
        }
      }
      if (best) {
        best.st = 1;
        best.infectedTick = this.tick;
        best.infectedBy = v.sp;
        // 吸附后病毒粒子消失（核酸注入）
      } else {
        remaining.push(v);
      }
    }
    this.virions = remaining;
  }

  // ------------------------------------------------------------ 场操作（双线性 + 守恒）

  private sample(field: Float64Array, x: number, y: number): number {
    const gx = clamp(x * (GRID - 1), 0, GRID - 1 - 1e-9);
    const gy = clamp(y * (GRID - 1), 0, GRID - 1 - 1e-9);
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    const a = field[iy * GRID + ix];
    const b = field[iy * GRID + ix + 1];
    const c = field[(iy + 1) * GRID + ix];
    const d = field[(iy + 1) * GRID + ix + 1];
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  /** 从双线性四点按各自在插值中的权重分摊取碳，保证不出现负值；返回实际取走量。 */
  private takeCarbon(x: number, y: number, need: number): number {
    if (need <= 0) return 0;
    const gx = clamp(x * (GRID - 1), 0, GRID - 1 - 1e-9);
    const gy = clamp(y * (GRID - 1), 0, GRID - 1 - 1e-9);
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    const i00 = iy * GRID + ix;
    const i10 = i00 + 1;
    const i01 = i00 + GRID;
    const i11 = i01 + 1;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    const avail =
      this.carbon[i00] * w00 +
      this.carbon[i10] * w10 +
      this.carbon[i01] * w01 +
      this.carbon[i11] * w11;
    // 至多取走插值可用量的 90%，四个点按其可用性权重分摊
    const take = Math.min(need, avail * 0.9);
    if (take <= 0 || avail <= 0) return 0;
    const deductFrom = (i: number, w: number) => {
      if (w <= 0) return;
      const part = (take * w) / avail; // 该点在 avail 中贡献了 w*C_i，按比例分摊
      this.carbon[i] = Math.max(0, this.carbon[i] - part / w);
    };
    deductFrom(i00, w00);
    deductFrom(i10, w10);
    deductFrom(i01, w01);
    deductFrom(i11, w11);
    return take;
  }

  private depositCarbon(x: number, y: number, amount: number) {
    if (amount <= 0) return;
    const gx = clamp(x * (GRID - 1), 0, GRID - 1 - 1e-9);
    const gy = clamp(y * (GRID - 1), 0, GRID - 1 - 1e-9);
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    this.carbon[iy * GRID + ix] += amount * (1 - fx) * (1 - fy);
    this.carbon[iy * GRID + ix + 1] += amount * fx * (1 - fy);
    this.carbon[(iy + 1) * GRID + ix] += amount * (1 - fx) * fy;
    this.carbon[(iy + 1) * GRID + ix + 1] += amount * fx * fy;
  }

  private insideDishGrid(ix: number, iy: number): boolean {
    const x = (ix + 0.5) / GRID;
    const y = (iy + 0.5) / GRID;
    const dx = x - DISH_CENTER;
    const dy = y - DISH_CENTER;
    return dx * dx + dy * dy <= DISH_R * DISH_R;
  }

  // ------------------------------------------------------------ 给药 / 计数 / 事件

  applyDose(drug: AntibioticId, concentration: number, source: 'regimen' | 'operator') {
    if (concentration <= 0 || this.finished) return;
    const field = this.drugs[drug];
    for (let i = 0; i < field.length; i++) {
      if (this.insideDishGrid(i % GRID, Math.floor(i / GRID))) {
        field[i] += concentration;
      }
    }
    const rec: DoseRecord = { tick: this.tick, drug, concentration, source };
    this.doseHistory.push(rec);
    this.events.push({ kind: 'dose', tick: this.tick, drug, concentration, source });
  }

  private decrementCount(sp: number) {
    this.aliveBySpecimen[sp] = (this.aliveBySpecimen[sp] ?? 1) - 1;
  }

  private detectExtinctions() {
    const virionBySpecimen = this.virionCounts();
    for (const sp of Array.from(this.everInoculated).sort((a, b) => a - b)) {
      const now =
        traitOf(sp).category === 'virus'
          ? virionBySpecimen.get(sp) ?? 0
          : this.aliveBySpecimen[sp] ?? 0;
      const before = this.lastCount[sp] ?? 0;
      if (before > 0 && now === 0 && !this.extinctTick.has(sp)) {
        this.extinctTick.set(sp, this.tick);
        this.events.push({
          kind: 'extinction',
          tick: this.tick,
          specimenId: sp,
          name: this.specimenLabel(sp),
        });
      }
      this.lastCount[sp] = now;
    }
  }

  private virionCounts(): Map<number, number> {
    const m = new Map<number, number>();
    for (const v of this.virions) m.set(v.sp, (m.get(v.sp) ?? 0) + 1);
    return m;
  }

  private specimenLabel(sp: number): string {
    return `${traitOf(sp).category}#${sp}`;
  }

  private recordTick() {
    const counts: Record<number, number> = {};
    const virionBySpecimen = this.virionCounts();
    for (const sp of this.everInoculated) {
      counts[sp] =
        traitOf(sp).category === 'virus'
          ? virionBySpecimen.get(sp) ?? 0
          : this.aliveBySpecimen[sp] ?? 0;
    }
    this.tickRecords.push({ tick: this.tick, counts, virions: this.virions.length });
  }

  private saveCheckpoint() {
    this.checkpoints.push({
      tick: this.tick,
      cells: this.cells.map((c) => ({ ...c })),
      virions: this.virions.map((v) => ({ ...v })),
      carbon: Array.from(this.carbon),
    });
  }

  private finish() {
    this.finished = true;
    this.events.push({ kind: 'finished', tick: this.tick });
    this.saveCheckpoint(); // 终态
  }

  // ------------------------------------------------------------ 快照 / 指纹

  getCounts(): PopulationCounts {
    let bacteria = 0;
    let fungi = 0;
    let archaea = 0;
    for (const c of this.cells) {
      const cat = traitOf(c.sp).category;
      if (cat === 'bacteria') bacteria++;
      else if (cat === 'fungi') fungi++;
      else if (cat === 'archaea') archaea++;
    }
    const virus = this.virions.length;
    return {
      totalCells: bacteria + fungi + archaea,
      virions: virus,
      bacteria,
      fungi,
      archaea,
      virus,
    };
  }

  snapshotCells(): CellSnapshot[] {
    return this.cells.map((c) => ({
      id: c.id,
      sp: c.sp,
      x: round6(c.x),
      y: round6(c.y),
      m: round4(c.m),
      m0: round4(c.m0),
      st: c.st,
      h: round4(c.h),
    }));
  }

  snapshotVirions(): VirionSnapshot[] {
    return this.virions.map((v) => ({ sp: v.sp, x: round6(v.x), y: round6(v.y) }));
  }

  sampleField(): { size: number; carbon: number[]; drugs: Record<string, number[]> } {
    const carbon: number[] = [];
    const drugs: Record<string, number[]> = {};
    for (const drug of DRUGS) drugs[drug] = [];
    for (let iy = 0; iy < FIELD_SAMPLE; iy++) {
      for (let ix = 0; ix < FIELD_SAMPLE; ix++) {
        const wx = (ix + 0.5) / FIELD_SAMPLE;
        const wy = (iy + 0.5) / FIELD_SAMPLE;
        carbon.push(round5(this.sample(this.carbon, wx, wy)));
        for (const drug of DRUGS) drugs[drug].push(round5(this.sample(this.drugs[drug], wx, wy)));
      }
    }
    return { size: FIELD_SAMPLE, carbon, drugs };
  }

  // ------------------------------------------------------------ 指纹（可复现验收）

  private canonicalInocula(): string {
    const sorted = [...this.inocula].sort((a, b) => a.specimenId - b.specimenId);
    return sorted.map((it) => `${it.specimenId}:${it.count}`).join(',');
  }

  get inoculaHash(): string {
    return sha256(`inocula|${ENGINE_VERSION}|${this.canonicalInocula()}`);
  }

  get interventionHash(): string {
    const body = this.doseHistory
      .map((d) => `${d.tick}:${d.drug}:${round6(d.concentration)}:${d.source}`)
      .join(';');
    return sha256(`doses|${ENGINE_VERSION}|${body}`);
  }

  fingerprint(
    specimenNames: Map<number, { name: string; scientificName: string; category: 'bacteria' | 'fungi' | 'virus' | 'archaea' }>
  ): EcoFingerprint {
    // 逐 tick 全标本计数序列的摘要 —— 任何一格不同都会改变
    const countsBody = this.tickRecords
      .map((r) => {
        const keys = Object.keys(r.counts).map(Number).sort((a, b) => a - b);
        return `${r.tick}=${keys.map((k) => `${k}:${r.counts[k]}`).join(',')};v${r.virions}`;
      })
      .join('|');
    const countsDigest = sha256(`tickcounts|${ENGINE_VERSION}|${countsBody}`);

    const series: GenSample[] = FINGERPRINT_GENS.map((gen) => {
      const tick = Math.min(gen * TICKS_PER_GENERATION, TOTAL_TICKS);
      const rec = this.tickRecords[tick];
      let bacteria = 0;
      let fungi = 0;
      let archaea = 0;
      const virus = rec.virions;
      for (const [spStr, n] of Object.entries(rec.counts)) {
        const cat = traitOf(Number(spStr)).category;
        if (cat === 'bacteria') bacteria += n;
        else if (cat === 'fungi') fungi += n;
        else if (cat === 'archaea') archaea += n;
      }
      const totalCells = bacteria + fungi + archaea;
      const denom = totalCells + virus;
      const ratio = (n: number) => (denom === 0 ? 0 : round6(n / denom));
      return {
        gen,
        tick,
        simMinutes: tick,
        counts: {
          totalCells,
          virions: virus,
          bacteria,
          fungi,
          archaea,
          virus,
        },
        ratios: { bacteria: ratio(bacteria), fungi: ratio(fungi), archaea: ratio(archaea), virus: ratio(virus) },
      };
    });

    // 最终优势种：终态活细胞数最多者（病毒粒子不参与“优势种”，但若全场只剩病毒则为 null）
    let dominantSp = -1;
    let dominantN = 0;
    for (const sp of Array.from(this.everInoculated).sort((a, b) => a - b)) {
      const n = this.aliveBySpecimen[sp] ?? 0;
      const cat = traitOf(sp).category;
      if (cat === 'virus') continue;
      if (n > dominantN) {
        dominantN = n;
        dominantSp = sp;
      }
    }
    const info = dominantSp >= 0 ? specimenNames.get(dominantSp) : undefined;
    const finalDominant =
      dominantSp >= 0 && info
        ? {
            specimenId: dominantSp,
            name: info.name,
            scientificName: info.scientificName,
            category: info.category,
            count: dominantN,
          }
        : null;

    const extinctionOrder = Array.from(this.extinctTick.entries())
      .sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]))
      .map(([sp, tick]) => ({ specimenId: sp, name: specimenNames.get(sp)?.name ?? `#${sp}`, tick }));

    const partial: Omit<EcoFingerprint, 'digest'> = {
      engineVersion: ENGINE_VERSION,
      runId: this.runId,
      seed: this.seed,
      inoculaHash: this.inoculaHash,
      interventionHash: this.interventionHash,
      initialCarbon: INITIAL_CARBON_PER_NODE,
      totalTicks: TOTAL_TICKS,
      series,
      countsDigest,
      finalDominant,
      extinctionOrder,
    };

    const digest = sha256(`fingerprint|${ENGINE_VERSION}|${canonicalJson(partial)}`);
    return { ...partial, digest };
  }
}

// ------------------------------------------------------------ 工具

/** 键排序的规范 JSON（指纹序列化唯一入口，禁止直接 JSON.stringify 未排序对象）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function clamp01(v: number): number {
  return clamp(v, 0.0001, 0.9999);
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
