/**
 * 24 份标本的生理参数表（确定性模拟的唯一生物学参数来源）。
 *
 * 时间单位：1 tick = 模拟 1 分钟。
 * 生长模型：Monod 动力学
 *   净比生长 = muMax * C/(ks+C) * 药物抑制 - maintenance
 * 碳源：以「一个成熟细胞的生物量」为 1 个碳单位。
 *
 * 数值依据：
 *  - muMax ≈ ln2 / 最适倍增分钟数（+维持能耗回补）
 *  - 细菌倍增 20-90 min；结核分枝杆菌极慢（~20h）
 *  - 真菌（酵母/菌丝）倍增 80-300 min
 *  - 古菌整体慢、寡营养亲和（ks 小）、维持能耗低、对经典抗菌素天然耐受
 *  - 病毒不代谢碳源：必须感染易感宿主，潜伏后裂解释放子代
 * 抗性 resistance 取 0..1：1 为完全不受该药影响；
 * 青霉素天然靶点是细菌细胞壁，故所有真菌/古菌 resistance=1。
 */

export type CellShape =
  | 'rod' // 杆菌
  | 'coccus' // 球菌
  | 'curved' // 弧菌
  | 'yeast' // 酵母样出芽
  | 'hypha' // 菌丝片段
  | 'icosahedron' // 二十面体病毒
  | 'filament' // 丝状病毒（杆状核衣壳）
  | 'enveloped' // 包膜病毒
  | 'coccal'; // 古菌球形

export type MotilityKind = 'flagellum' | 'archaellum' | 'brownian' | 'none';

export interface SpecimenTrait {
  id: number;
  category: 'bacteria' | 'fungi' | 'virus' | 'archaea';
  /** 最大比生长速率（每 tick），饱和碳源下 */
  muMax: number;
  /** Monod 半饱和常数（碳场浓度单位）；越小=寡营养亲和越强 */
  ks: number;
  /** 维持能耗：每 tick 呼吸消耗的生物量比例（碳直接矿化，不回场） */
  maintenance: number;
  /** 碳源 -> 生物量转化得率（<1，差额以呼吸热散失） */
  yield: number;
  /** 运动方式 */
  motility: MotilityKind;
  /** 每 tick 位移（世界坐标单位，世界为 [0,1]） */
  speed: number;
  /** run-and-tumble：每 tick 重新定向的概率 */
  tumble: number;
  /** 渲染形态 */
  shape: CellShape;
  /** 相对绘制半径（世界坐标下的细胞视觉尺度） */
  visualRadius: number;
  /** 对三种抗菌素的抗性 0..1 */
  resistance: { penicillin: number; ciprofloxacin: number; amphotericin: number };

  // —— 仅病毒 ——
  /** 易感宿主标本 id 列表；空=该培养体系中无宿主（无法复制，终将衰减灭绝） */
  hosts?: number[];
  /** 感染后到裂解的 tick 数（潜伏期） */
  latency?: number;
  /** 裂解释放的子代病毒粒子数 */
  burst?: number;
  /** 游离病毒粒子每 tick 的失活比例 */
  virionDecay?: number;
}

const R_FULL = { penicillin: 1, ciprofloxacin: 1, amphotericin: 1 };

export const SPECIMEN_TRAITS: SpecimenTrait[] = [
  // ================= 细菌（8） =================
  {
    id: 1, category: 'bacteria', // 大肠杆菌：最适倍增 ~20min，周身鞭毛
    muMax: 0.04, ks: 0.03, maintenance: 0.0015, yield: 0.55,
    motility: 'flagellum', speed: 0.0032, tumble: 0.12,
    shape: 'rod', visualRadius: 0.0062,
    resistance: { penicillin: 0.35, ciprofloxacin: 0.1, amphotericin: 1 },
  },
  {
    id: 2, category: 'bacteria', // 金黄色葡萄球菌：~25min，无动力，革兰阳性对青霉素高度敏感
    muMax: 0.031, ks: 0.04, maintenance: 0.0016, yield: 0.55,
    motility: 'none', speed: 0, tumble: 0,
    shape: 'coccus', visualRadius: 0.0048,
    resistance: { penicillin: 0.05, ciprofloxacin: 0.2, amphotericin: 1 },
  },
  {
    id: 3, category: 'bacteria', // 枯草芽孢杆菌：~26min，周生鞭毛
    muMax: 0.029, ks: 0.045, maintenance: 0.0015, yield: 0.56,
    motility: 'flagellum', speed: 0.0024, tumble: 0.1,
    shape: 'rod', visualRadius: 0.006,
    resistance: { penicillin: 0.2, ciprofloxacin: 0.2, amphotericin: 1 },
  },
  {
    id: 4, category: 'bacteria', // 铜绿假单胞菌：单端极鞭毛，对青霉素天然耐药
    muMax: 0.029, ks: 0.05, maintenance: 0.0017, yield: 0.54,
    motility: 'flagellum', speed: 0.003, tumble: 0.08,
    shape: 'rod', visualRadius: 0.0056,
    resistance: { penicillin: 0.9, ciprofloxacin: 0.35, amphotericin: 1 },
  },
  {
    id: 5, category: 'bacteria', // 嗜酸乳杆菌：~45min，无动力
    muMax: 0.016, ks: 0.06, maintenance: 0.0013, yield: 0.52,
    motility: 'none', speed: 0, tumble: 0,
    shape: 'rod', visualRadius: 0.005,
    resistance: { penicillin: 0.3, ciprofloxacin: 0.4, amphotericin: 1 },
  },
  {
    id: 6, category: 'bacteria', // 结核分枝杆菌：~20h 倍增，蜡质壁，两类药均难渗入
    muMax: 0.004, ks: 0.08, maintenance: 0.0009, yield: 0.5,
    motility: 'none', speed: 0, tumble: 0,
    shape: 'rod', visualRadius: 0.0052,
    resistance: { penicillin: 0.95, ciprofloxacin: 0.7, amphotericin: 1 },
  },
  {
    id: 7, category: 'bacteria', // 霍乱弧菌：~22min，单端鞭毛、运动极强
    muMax: 0.034, ks: 0.035, maintenance: 0.0016, yield: 0.55,
    motility: 'flagellum', speed: 0.0035, tumble: 0.09,
    shape: 'curved', visualRadius: 0.0056,
    resistance: { penicillin: 0.4, ciprofloxacin: 0.15, amphotericin: 1 },
  },
  {
    id: 8, category: 'bacteria', // 双歧杆菌：~50min，无动力
    muMax: 0.014, ks: 0.07, maintenance: 0.0012, yield: 0.52,
    motility: 'none', speed: 0, tumble: 0,
    shape: 'rod', visualRadius: 0.005,
    resistance: { penicillin: 0.3, ciprofloxacin: 0.4, amphotericin: 1 },
  },

  // ================= 真菌（6） =================
  {
    id: 9, category: 'fungi', // 酿酒酵母：~80min，出芽
    muMax: 0.0088, ks: 0.05, maintenance: 0.001, yield: 0.5,
    motility: 'brownian', speed: 0.0003, tumble: 0.5,
    shape: 'yeast', visualRadius: 0.008,
    resistance: { ...R_FULL, amphotericin: 0.2 },
  },
  {
    id: 10, category: 'fungi', // 黑曲霉：菌丝顶端生长，慢
    muMax: 0.0045, ks: 0.06, maintenance: 0.0009, yield: 0.48,
    motility: 'none', speed: 0, tumble: 0,
    shape: 'hypha', visualRadius: 0.009,
    resistance: { ...R_FULL, amphotericin: 0.3 },
  },
  {
    id: 11, category: 'fungi', // 产黄青霉：产青霉素的霉菌，自身不受细菌类抗生素影响
    muMax: 0.0052, ks: 0.06, maintenance: 0.0009, yield: 0.48,
    motility: 'none', speed: 0, tumble: 0,
    shape: 'hypha', visualRadius: 0.009,
    resistance: { ...R_FULL, amphotericin: 0.35 },
  },
  {
    id: 12, category: 'fungi', // 白色念珠菌：酵母相 ~100min
    muMax: 0.0072, ks: 0.055, maintenance: 0.001, yield: 0.5,
    motility: 'brownian', speed: 0.00025, tumble: 0.5,
    shape: 'yeast', visualRadius: 0.0072,
    resistance: { ...R_FULL, amphotericin: 0.25 },
  },
  {
    id: 13, category: 'fungi', // 双孢蘑菇：大型真菌菌丝，极慢
    muMax: 0.003, ks: 0.08, maintenance: 0.0008, yield: 0.46,
    motility: 'none', speed: 0, tumble: 0,
    shape: 'hypha', visualRadius: 0.01,
    resistance: { ...R_FULL, amphotericin: 0.45 },
  },
  {
    id: 14, category: 'fungi', // 灵芝：木质化菌丝，极慢
    muMax: 0.0034, ks: 0.08, maintenance: 0.0008, yield: 0.46,
    motility: 'none', speed: 0, tumble: 0,
    shape: 'hypha', visualRadius: 0.01,
    resistance: { ...R_FULL, amphotericin: 0.5 },
  },

  // ================= 病毒（6） =================
  {
    id: 15, category: 'virus', // T4噬菌体：宿主大肠杆菌，潜伏期~25min，裂解量~40
    muMax: 0, ks: 0, maintenance: 0, yield: 0,
    motility: 'brownian', speed: 0.006, tumble: 1,
    shape: 'icosahedron', visualRadius: 0.0032,
    resistance: R_FULL,
    hosts: [1], latency: 25, burst: 24, virionDecay: 0.003,
  },
  {
    id: 16, category: 'virus', // 烟草花叶病毒：植物宿主，培养皿中无宿主
    muMax: 0, ks: 0, maintenance: 0, yield: 0,
    motility: 'brownian', speed: 0.0012, tumble: 1,
    shape: 'filament', visualRadius: 0.0028,
    resistance: R_FULL, hosts: [], latency: 0, burst: 0, virionDecay: 0.001,
  },
  {
    id: 17, category: 'virus', // 流感病毒：动物宿主，无宿主
    muMax: 0, ks: 0, maintenance: 0, yield: 0,
    motility: 'brownian', speed: 0.0014, tumble: 1,
    shape: 'enveloped', visualRadius: 0.003,
    resistance: R_FULL, hosts: [], latency: 0, burst: 0, virionDecay: 0.0012,
  },
  {
    id: 18, category: 'virus', // 新冠病毒：动物宿主，无宿主
    muMax: 0, ks: 0, maintenance: 0, yield: 0,
    motility: 'brownian', speed: 0.0014, tumble: 1,
    shape: 'enveloped', visualRadius: 0.003,
    resistance: R_FULL, hosts: [], latency: 0, burst: 0, virionDecay: 0.0012,
  },
  {
    id: 19, category: 'virus', // HIV：动物宿主，无宿主
    muMax: 0, ks: 0, maintenance: 0, yield: 0,
    motility: 'brownian', speed: 0.0012, tumble: 1,
    shape: 'enveloped', visualRadius: 0.003,
    resistance: R_FULL, hosts: [], latency: 0, burst: 0, virionDecay: 0.0008,
  },
  {
    id: 20, category: 'virus', // 腺病毒：动物宿主，无宿主
    muMax: 0, ks: 0, maintenance: 0, yield: 0,
    motility: 'brownian', speed: 0.001, tumble: 1,
    shape: 'icosahedron', visualRadius: 0.0028,
    resistance: R_FULL, hosts: [], latency: 0, burst: 0, virionDecay: 0.0006,
  },

  // ================= 古菌（4） =================
  {
    id: 21, category: 'archaea', // 詹氏甲烷球菌：产甲烷，慢，高寡营养亲和
    muMax: 0.0042, ks: 0.018, maintenance: 0.0006, yield: 0.5,
    motility: 'flagellum', speed: 0.0009, tumble: 0.15,
    shape: 'coccal', visualRadius: 0.0046,
    resistance: { penicillin: 1, ciprofloxacin: 0.95, amphotericin: 1 },
  },
  {
    id: 22, category: 'archaea', // 嗜酸热硫化叶菌：嗜酸耐热，慢
    muMax: 0.0052, ks: 0.03, maintenance: 0.0006, yield: 0.5,
    motility: 'flagellum', speed: 0.0011, tumble: 0.14,
    shape: 'coccal', visualRadius: 0.005,
    resistance: { penicillin: 1, ciprofloxacin: 0.9, amphotericin: 1 },
  },
  {
    id: 23, category: 'archaea', // 盐生盐杆菌：紫膜，古菌鞭毛
    muMax: 0.006, ks: 0.05, maintenance: 0.0007, yield: 0.5,
    motility: 'archaellum', speed: 0.0016, tumble: 0.18,
    shape: 'rod', visualRadius: 0.0054,
    resistance: { penicillin: 1, ciprofloxacin: 0.9, amphotericin: 1 },
  },
  {
    id: 24, category: 'archaea', // 激烈火球菌：100°C 下倍增最快的古菌之一（~37min）
    muMax: 0.0082, ks: 0.04, maintenance: 0.0007, yield: 0.5,
    motility: 'flagellum', speed: 0.0014, tumble: 0.13,
    shape: 'coccal', visualRadius: 0.005,
    resistance: { penicillin: 1, ciprofloxacin: 0.9, amphotericin: 1 },
  },
];

const BY_ID = new Map(SPECIMEN_TRAITS.map((t) => [t.id, t]));

export function traitOf(specimenId: number): SpecimenTrait {
  const t = BY_ID.get(specimenId);
  if (!t) throw new Error(`未知标本 id: ${specimenId}`);
  return t;
}
