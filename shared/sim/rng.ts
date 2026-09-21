/**
 * 确定性随机数。
 *
 * 只有两条规矩：
 *  1. 一次运行只用一棵以种子为根的随机流（RngStream），引擎内部所有掷骰
 *     都经过它，绝不调用 Math.random / Date.now。
 *  2. 掷骰调用顺序由模拟状态决定，而状态的迭代顺序按细胞 id 排序，
 *     因此"同接种 + 同种子"在任何机器上都走出完全相同的随机序列。
 */

/** 32 位字符串/数值种子归一化为无符号整数（FNV-1a） */
export function hashSeed(seed: number | string): number {
  const s = typeof seed === 'number' ? Number.isFinite(seed) ? seed.toString() : '0' : seed;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 对任意字节串做稳定 FNV-1a（用于接种清单规范化哈希的辅助） */
export function fnv1aBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32：确定性 32 位 PRNG */
export class RngStream {
  private state: number;

  constructor(seed: number | string) {
    this.state = hashSeed(seed) >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 整数 [min, max] */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 从同一根流派生一条子流（各用途独立，互不串扰） */
  fork(tag: number): RngStream {
    const child = new RngStream((this.state ^ Math.imul(tag + 1, 0x9e3779b9)) >>> 0);
    // 消耗父流一次，保证即便多个 tag 碰撞状态也不会整体重复
    this.next();
    return child;
  }
}

/**
 * 按标本 id 派生稳定性状修饰因子。
 * 不消耗运行随机流 —— 它是"标本固有属性"，同一种标本在任何运行中
 * 表现一致；不同标本则系统性地不同（保证不同接种指纹相异的根基之一）。
 */
export function speciesModifier(speciesId: number, salt: number): number {
  let h = (speciesId * 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = (h ^ (h >>> 16)) >>> 0;
  // 映射到 [0.82, 1.18]：种间差异显著但不颠覆生态位
  return 0.82 + (h / 4294967296) * 0.36;
}
