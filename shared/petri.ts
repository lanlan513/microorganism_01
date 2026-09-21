// ============ 培养皿模拟：前后端共享类型 ============
// 模拟权威只存在于服务端（api/src/petri/engine.ts）。
// 浏览器只发送指令、接收快照并负责绘制，不参与任何数值推进。

import type { MicrobeCategory } from './types';

/** 抗菌素种类 */
export type AntibioticId = 'penicillin' | 'ciprofloxacin' | 'amphotericin';

export const ANTIBIOTIC_LABELS: Record<AntibioticId, string> = {
  penicillin: '青霉素',
  ciprofloxacin: '环丙沙星',
  amphotericin: '两性霉素B',
};

export const ANTIBIOTIC_COLORS: Record<AntibioticId, string> = {
  penicillin: '#5ad1ff',
  ciprofloxacin: '#ff9f43',
  amphotericin: '#ff5d8f',
};

export const ANTIBIOTIC_MECHANISM: Record<AntibioticId, string> = {
  penicillin: '抑制细胞壁合成，革兰阳性菌敏感',
  ciprofloxacin: '抑制DNA旋转酶，广谱杀菌',
  amphotericin: '结合真菌细胞膜麦角固醇',
};

/** 接种项：选哪份标本、接种多少个活细胞 */
export interface InoculumItem {
  /** 标本 id（对应 microbesData.json 中的 id，1-24） */
  specimenId: number;
  count: number;
}

/** 建舱请求 */
export interface CreateRunRequest {
  /** 接种清单 */
  inocula: InoculumItem[];
  /** 随机种子：字符串或整数。同清单+同种子 => 逐格相同结果 */
  seed: string | number;
  /** 初始碳源总量（相对单位），缺省取标定值 */
  initialCarbon?: number;
  /** 预设给药方案（进入确定性指纹） */
  regimen?: RegimenDose[];
}

export interface RegimenDose {
  /** 在第几个 tick 给药（模拟分钟） */
  atTick: number;
  drug: AntibioticId;
  /** 均匀施加的浓度（单位 MIC） */
  concentration: number;
}

/** 前端发来的控制指令 */
export type RunControl =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'setSpeed'; speed: number }
  | { type: 'dose'; drug: AntibioticId; concentration: number }
  | { type: 'restart' };

export interface RunInfo {
  runId: string;
  status: 'running' | 'paused' | 'finished';
  tick: number;
  totalTicks: number;
  speed: number;
  seed: string;
  inocula: InoculumItem[];
  createdAt: string;
}

/** 单个细胞的紧凑结构（服务端 -> 前端快照，按属性分桶以便批量绘制） */
export interface CellSnapshot {
  id: number;
  sp: number; // specimenId
  x: number; // 世界坐标 [0,1]
  y: number;
  m: number; // 当前质量
  m0: number; // 初始（分裂）质量，比值用于绘制分裂期形态
  /** 0=正常 1=潜伏感染 2=抗生素胁迫（生长被压制） */
  st: 0 | 1 | 2;
  /** 运动朝向（弧度），供前端绘制鞭毛摆动相位 */
  h: number;
}

export interface VirionSnapshot {
  sp: number;
  x: number;
  y: number;
}

/** 四分类计数 + 总细胞数 */
export interface PopulationCounts {
  totalCells: number; // 活细胞总数（不含病毒粒子）
  virions: number; // 病毒粒子数
  bacteria: number;
  fungi: number;
  archaea: number;
  virus: number;
}

/** 碳源/药物场的低分辨率采样，供前端叠图（权威仍以服务端 64x64 为准） */
export interface FieldSnapshot {
  size: number; // 采样边长（通常 32）
  carbon: number[]; // size*size
  drugs: Partial<Record<AntibioticId, number[]>>;
}

/** SSE 每帧下发的完整快照 */
export interface Snapshot {
  runId: string;
  tick: number;
  gen: number; // tick / TICKS_PER_GENERATION
  simMinutes: number;
  status: 'running' | 'paused' | 'finished';
  speed: number;
  counts: PopulationCounts;
  cells: CellSnapshot[];
  virions: VirionSnapshot[];
  field: FieldSnapshot | null;
  /** 本 tick 发生的事件（灭绝、给药等），供时间轴展示 */
  events: RunEventData[];
  /** 完成时附带指纹 */
  fingerprint?: EcoFingerprint;
}

export type RunEventData =
  | { kind: 'extinction'; tick: number; specimenId: number; name: string }
  | { kind: 'dose'; tick: number; drug: AntibioticId; concentration: number; source: 'regimen' | 'operator' }
  | { kind: 'finished'; tick: number };

/** 指纹中单个采样代记录 */
export interface GenSample {
  gen: number;
  tick: number;
  simMinutes: number;
  counts: PopulationCounts;
  ratios: {
    bacteria: number;
    fungi: number;
    archaea: number;
    virus: number;
  };
}

/** 生态指纹：可复现性的验收凭证 */
export interface EcoFingerprint {
  engineVersion: string;
  runId: string;
  seed: string;
  inoculaHash: string;
  interventionHash: string; // 预设+实际给药全部事件
  initialCarbon: number;
  totalTicks: number;
  /** 采样代序列（逐格种群数量序列的规范摘要） */
  series: GenSample[];
  /** 全部标本计数序列（逐 tick）的 SHA-256，任何差异都会体现在这里 */
  countsDigest: string;
  finalDominant: {
    specimenId: number;
    name: string;
    scientificName: string;
    category: MicrobeCategory;
    count: number;
  } | null;
  /** 灭绝顺序：先灭绝的在前，含灭绝 tick */
  extinctionOrder: { specimenId: number; name: string; tick: number }[];
  /** 整条规范记录的 SHA-256 */
  digest: string;
}

/** 档案列表项 */
export interface ArchiveListItem {
  runId: string;
  createdAt: string;
  finishedAt?: string;
  status: string;
  seed: string;
  inocula: InoculumItem[];
  tick: number;
  totalTicks: number;
  digest?: string;
}

export interface ArchiveDetail {
  runId: string;
  lines: unknown[];
  fingerprint?: EcoFingerprint;
}
