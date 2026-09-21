/**
 * 生态性状：把馆内标本映射到培养皿里的四个生态位。
 *
 * 同一种标本的性状在任何运行中恒定（由 speciesModifier 对 microbeId
 * 做稳定哈希得到），少数关键种有生物学依据的显式覆盖：
 *   - 产黄青霉 (11)：青霉素产量拉满，正是它压制了细菌
 *   - T4 噬菌体 (15)：专一侵染大肠杆菌
 *   - 铜绿假单胞菌 (4)：天然耐药 / 生物膜，耐受性高
 *   - 枯草芽孢杆菌 (3)：芽孢耐受
 *   - 激烈火球菌 (24)：代时极短（furiosus）
 *
 * 所有速率均以"每 tick"计；生物质与碳为任意模型单位。
 */
import type { SimCategory } from './types.js';
import { speciesModifier } from './rng.js';

export interface SpeciesTraits {
  category: SimCategory;
  /** 碳摄取最大速率（r 策略最高） */
  uptakeRate: number;
  /** 碳→生物质转化效率 0-1 */
  yieldEfficiency: number;
  /** 每 tick 维持消耗；低于此则挨饿掉生物量 */
  maintenance: number;
  /** 分裂所需生物质阈值 */
  divideThreshold: number;
  /** 运动性：每 tick 期望位移（模型单位） */
  motility: number;
  /** 抗生素耐受性 0-1：承受的损伤折减（1=免疫） */
  antibioticTolerance: number;
  /** 抗生素分泌速率（每 tick 注入所在网格的量，仅真菌） */
  antibioticProduction: number;
  /** 病毒：接触吸附概率 0-1/tick */
  adsorption: number;
  /** 病毒：从感染到裂解的 tick 数 */
  lysisDelay: number;
  /** 病毒：裂解释放的子代颗粒数 */
  burstSize: number;
  /** 病毒：可侵染的标本 id 列表；空数组表示该类全部可侵染 */
  hosts: number[];
  /** 病毒颗粒的寿命 tick（找不到宿主即失活） */
  virionTtl: number;
  /** 初始生物质 */
  startBiomass: number;
}

/** 各类的基线性状 */
const BASE_TRAITS: Record<SimCategory, Omit<SpeciesTraits, 'category'>> = {
  bacteria: {
    uptakeRate: 0.16,
    yieldEfficiency: 0.62,
    maintenance: 0.014,
    divideThreshold: 2.0,
    motility: 2.2,
    antibioticTolerance: 0.12,
    antibioticProduction: 0,
    adsorption: 0,
    lysisDelay: 0,
    burstSize: 0,
    hosts: [],
    virionTtl: 0,
    startBiomass: 1.0,
  },
  fungi: {
    uptakeRate: 0.12,
    yieldEfficiency: 0.5,
    maintenance: 0.005,
    divideThreshold: 2.8,
    motility: 0,
    antibioticTolerance: 0.85,
    antibioticProduction: 0.0045,
    adsorption: 0,
    lysisDelay: 0,
    burstSize: 0,
    hosts: [],
    virionTtl: 0,
    startBiomass: 1.6,
  },
  archaea: {
    // 寡营养：摄取慢、极省、耐造，在贫瘠碳源下后程反超
    uptakeRate: 0.014,
    yieldEfficiency: 0.74,
    maintenance: 0.001,
    divideThreshold: 2.6,
    motility: 1.6,
    antibioticTolerance: 0.7,
    antibioticProduction: 0,
    adsorption: 0,
    lysisDelay: 0,
    burstSize: 0,
    hosts: [],
    virionTtl: 0,
    startBiomass: 1.3,
  },
  virus: {
    uptakeRate: 0,
    yieldEfficiency: 0,
    maintenance: 0,
    divideThreshold: 0,
    motility: 2.2,
    antibioticTolerance: 1,
    antibioticProduction: 0,
    adsorption: 0.16,
    lysisDelay: 26,
    burstSize: 14,
    hosts: [],
    virionTtl: 260,
    startBiomass: 0.2,
  },
};

/** 显式生物学覆盖（倍率或绝对值） */
interface Override {
  category: SimCategory;
  mult?: Partial<Record<keyof SpeciesTraits, number>>;
  hosts?: number[];
}

const SPECIES_OVERRIDES: Record<number, Override> = {
  // 产黄青霉：青霉素生产者
  11: { category: 'fungi', mult: { antibioticProduction: 9.0, divideThreshold: 1.05, maintenance: 0.9 } },
  // 黑曲霉：也产抗生类次级代谢物，但弱得多
  10: { category: 'fungi', mult: { antibioticProduction: 1.6 } },
  // 白色念珠菌：条件致病，生长稍快
  12: { category: 'fungi', mult: { uptakeRate: 1.25, divideThreshold: 0.9 } },
  // 铜绿假单胞菌：天然多重耐药
  4: { category: 'bacteria', mult: { antibioticTolerance: 5.0 } },
  // 枯草芽孢杆菌：芽孢 → 耐胁迫
  3: { category: 'bacteria', mult: { antibioticTolerance: 2.4, maintenance: 0.85 } },
  // 金黄色葡萄球菌：堆聚，运动性差
  2: { category: 'bacteria', mult: { motility: 0.35, uptakeRate: 1.1 } },
  // 霍乱弧菌：单极鞭毛，运动极活跃
  7: { category: 'bacteria', mult: { motility: 1.5 } },
  // 大肠杆菌：经典模式菌，r 策略代表
  1: { category: 'bacteria', mult: { uptakeRate: 1.12, divideThreshold: 0.95 } },
  // 嗜酸乳杆菌：产酸，耐受力略强
  5: { category: 'bacteria', mult: { antibioticTolerance: 1.4 } },
  // 结核分枝杆菌：富脂质壁、慢生长
  6: { category: 'bacteria', mult: { uptakeRate: 0.8, divideThreshold: 1.3, maintenance: 0.8, antibioticTolerance: 1.8 } },
  // 双歧杆菌：厌氧慢生
  8: { category: 'bacteria', mult: { motility: 0.2, divideThreshold: 1.15 } },
  // 酿酒酵母：出芽快
  9: { category: 'fungi', mult: { divideThreshold: 0.85, uptakeRate: 1.2 } },
  // 双孢蘑菇 / 灵芝：大型真菌菌丝，极慢
  13: { category: 'fungi', mult: { divideThreshold: 1.8, uptakeRate: 0.75, motility: 0 } },
  14: { category: 'fungi', mult: { divideThreshold: 1.8, uptakeRate: 0.75, motility: 0 } },
  // 激烈火球菌：代时 37 分钟，最嗜热 → 最快分裂
  24: { category: 'archaea', mult: { uptakeRate: 1.25, divideThreshold: 0.78 } },
  // 詹氏甲烷球菌：化能自养，在本皿（有机碳）里吃得慢
  21: { category: 'archaea', mult: { uptakeRate: 0.72 } },
  // 盐生盐杆菌：视紫红质，不依赖有机碳的部分用低维持体现
  23: { category: 'archaea', mult: { maintenance: 0.7, uptakeRate: 0.85 } },
  22: { category: 'archaea', mult: { antibioticTolerance: 1.3 } },
  // T4 噬菌体：专一侵染大肠杆菌
  15: { category: 'virus', hosts: [1], mult: { adsorption: 1.2, burstSize: 1.0 } },
  // 烟草花叶病毒：植物宿主，皿内无宿主 → 颗粒漂移至终
  16: { category: 'virus', hosts: [-1], mult: { virionTtl: 2.2 } },
  // 流感：宿主为黏膜，皿内无宿主
  17: { category: 'virus', hosts: [-2], mult: { virionTtl: 1.2 } },
  18: { category: 'virus', hosts: [-3], mult: { virionTtl: 1.2 } },
  // HIV：侵染目标在本皿映射为无对应（免疫细胞缺席）
  19: { category: 'virus', hosts: [-4], mult: { virionTtl: 1.4 } },
  // 腺病毒：无对应宿主，但颗粒稳定
  20: { category: 'virus', hosts: [-5], mult: { virionTtl: 2.6 } },
};

export function getCategory(id: number, fallback: SimCategory): SimCategory {
  return SPECIES_OVERRIDES[id]?.category ?? fallback;
}

const TRAIT_SALTS: Record<keyof SpeciesTraits, number> = {
  category: 0,
  uptakeRate: 1,
  yieldEfficiency: 2,
  maintenance: 3,
  divideThreshold: 4,
  motility: 5,
  antibioticTolerance: 6,
  antibioticProduction: 7,
  adsorption: 8,
  lysisDelay: 9,
  burstSize: 10,
  hosts: 11,
  virionTtl: 12,
  startBiomass: 13,
};

/** 取某号标本在培养皿中实际使用的全套性状 */
export function resolveTraits(microbeId: number, fallbackCategory: SimCategory): SpeciesTraits {
  const category = getCategory(microbeId, fallbackCategory);
  const base = BASE_TRAITS[category];
  const ov = SPECIES_OVERRIDES[microbeId];
  const mult = ov?.mult ?? {};

  const apply = (key: keyof SpeciesTraits, value: number): number =>
    value * speciesModifier(microbeId, TRAIT_SALTS[key]) * (mult[key] ?? 1);

  const traits: SpeciesTraits = {
    category,
    uptakeRate: apply('uptakeRate', base.uptakeRate),
    yieldEfficiency: Math.min(0.95, apply('yieldEfficiency', base.yieldEfficiency)),
    maintenance: apply('maintenance', base.maintenance),
    divideThreshold: apply('divideThreshold', base.divideThreshold),
    motility: apply('motility', base.motility),
    antibioticTolerance: Math.min(1, apply('antibioticTolerance', base.antibioticTolerance)),
    antibioticProduction: apply('antibioticProduction', base.antibioticProduction),
    adsorption: apply('adsorption', base.adsorption),
    lysisDelay: Math.max(4, Math.round(apply('lysisDelay', base.lysisDelay))),
    burstSize: Math.max(1, Math.round(apply('burstSize', base.burstSize))),
    hosts: ov?.hosts ?? [],
    virionTtl: Math.max(10, Math.round(apply('virionTtl', base.virionTtl))),
    startBiomass: apply('startBiomass', base.startBiomass),
  };
  return traits;
}
