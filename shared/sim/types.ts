/**
 * 培养皿模拟 —— 共享类型定义
 *
 * 重要约定：本文件与引擎中的所有计算都是确定性的。
 * 同一份接种清单 + 同一个种子，在任何机器、任何时间重放，
 * 都必须产生逐格（逐 tick）完全相同的种群序列。
 * 前端只允许消费这些类型来"画"，不允许在浏览器里推进模拟。
 */

/** 四类标本即四个生态位 */
export type SimCategory = 'bacteria' | 'fungi' | 'virus' | 'archaea';

export const SIM_CATEGORIES: SimCategory[] = ['bacteria', 'fungi', 'virus', 'archaea'];

/** 接种清单中的一条：把某号标本接种 count 个细胞 */
export interface InoculumItem {
  microbeId: number;
  count: number;
}

/** 建培养皿请求 */
export interface CreateRunRequest {
  /** 任意字符串；服务器做规范化哈希，字段顺序不影响结果 */
  name?: string;
  seed: number | string;
  inoculum: InoculumItem[];
}

/** 病毒生命周期状态（非病毒始终为 active） */
export type CellState = 'active' | 'infected' | 'virion';

/**
 * 细胞 / 颗粒。
 * 坐标以模型单位计（圆盘半径 500）。
 * 角度与生物质用于前端渲染细节。
 */
export interface SimCell {
  id: number;
  speciesId: number;
  category: SimCategory;
  x: number;
  y: number;
  /** 朝向（弧度），决定杆状朝向、鞭毛摆动方向 */
  angle: number;
  /** 生物质；达到分裂阈值即二分裂，低于饥饿阈值即死亡 */
  biomass: number;
  state: CellState;
  /** infected：距裂解释放还剩多少 tick；其余：0 */
  lysisIn: number;
  /** infected：侵染它的病毒标本 id（裂解时按该种释放子代） */
  infectedBy?: number;
  /** virion：已游离多少 tick（达到寿命即失活） */
  ttl?: number;
}

/** 某一代（tick）的种群快照计数 —— 指纹与科考日志的基本单位 */
export interface TickCount {
  tick: number;
  total: number;
  bacteria: number;
  fungi: number;
  virus: number;
  archaea: number;
  /** 培养皿内剩余可利用碳总量（定点整数，千分之一模型单位） */
  carbon: number;
  /** 抗生素场峰值（定点整数，千分之一单位） */
  antibioticPeak: number;
}

/** 逐步科考日志中的事件类型 */
export type SimEventType =
  | 'inoculate'
  | 'division'
  | 'starve'
  | 'antibiotic_kill'
  | 'infection'
  | 'lysis'
  | 'extinction';

export interface SimEvent {
  tick: number;
  type: SimEventType;
  speciesId?: number;
  category?: SimCategory;
  /** extinction：该种最后一只个体消失的 tick */
  count?: number;
}

/** 指纹中的检查点：第 N 代 */
export interface FingerprintCheckpoint {
  generation: number;
  total: number;
  composition: Record<SimCategory, number>;
  /** 四类占比，千分位整数（0-1000，合计 1000；total=0 时为 0） */
  ratioPermille: Record<SimCategory, number>;
}

/** 生态指纹：一份接种运行的身份摘要 */
export interface EcoFingerprint {
  specVersion: number;
  seed: string;
  inoculumHash: string;
  /** 逐格计数规范序列（含事件）的 SHA-256，可复现性的最终凭证 */
  transcriptHash: string;
  /** 引擎内逐格哈希链末端（空串起链，重放即得） */
  chainTip: string;
  generations: number;
  checkpoints: FingerprintCheckpoint[];
  /** 最终优势种（末代数量最多的标本 id）；全部灭绝为 null */
  dominantSpeciesId: number | null;
  /** 灭绝顺序：按"该种最后出现的 tick"升序排列的标本 id；未灭绝/未接种者不在其列 */
  extinctionOrder: number[];
  concluded: 'stable' | 'extinct' | 'max-ticks';
}

/** 建培养皿响应 */
export interface RunInfo {
  runId: string;
  name: string;
  seed: string;
  inoculumHash: string;
  totalTicks: number;
  maxCells: number;
  createdAt: string;
  fingerprint: EcoFingerprint;
  /**
   * 科考档案哈希链末端（以 petri-genesis/<runId> 锚定起链）。
   * 落盘 journal.jsonl 最后一环必须等于此值，逐格留痕的防篡改凭证。
   */
  journalTip: string;
  inoculum: InoculumItem[];
  species: RunSpeciesInfo[];
}

/** 运行中实际登场的标本信息（供前端画图例与镜头读数） */
export interface RunSpeciesInfo {
  microbeId: number;
  name: string;
  scientificName: string;
  category: SimCategory;
  /** 该种在本皿中实际采用的性状（已按标本 id 漂移），便于科考标注 */
  traits: Record<string, number>;
}

/** 帧二进制格式常量见 shared/sim/codec.ts（FRAME_HEADER_SIZE / FRAME_CELL_SIZE） */
