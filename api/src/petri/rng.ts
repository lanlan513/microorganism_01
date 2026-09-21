/**
 * 确定性随机数与哈希原语。
 *
 * 铁律：模拟内核中严禁出现 Math.random / Date.now / performance.now。
 * 所有随机来源都必须可由种子复现。
 *
 * - hashSeed：任意字符串/整数 -> 32 位无符号整数（FNV-1a，带逐字符乘加）
 * - mulberry32：32 位种子 -> (() => uint32) 与 (() => float64 in [0,1))
 *
 * 这里的全部运算都是 IEEE 754 双精度与 uint32 位运算，
 * 不依赖宿主平台（无 Math.*、无 locale、无排序不稳定问题）。
 */

export function hashSeed(input: string | number): number {
  // FNV-1a 32 位
  let h = 0x811c9dc5;
  const s = typeof input === 'number' ? numToCanonical(input) : input;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 整数/浮点种子的规范字符串：整数直接十进制，浮点用最小可往返表示。 */
function numToCanonical(n: number): string {
  if (Number.isInteger(n)) return String(n | 0);
  return String(n);
}

/** 对一段规范文本做 FNV-1a（用于指纹内容的 SHA 之前的子哈希） */
export function fnv1a(s: string): number {
  return hashSeed(s);
}

export interface DeterministicRng {
  /** 返回原始 uint32 */
  nextU32(): number;
  /** 返回 [0,1) 双精度浮点 */
  next(): number;
  /** 返回 [min,max) */
  range(min: number, max: number): number;
  /** 以概率 p 返回 true */
  chance(p: number): boolean;
  /** 从数组中按下标确定性抽取（不修改数组） */
  pick<T>(arr: readonly T[]): T;
}

export function mulberry32(seed: string | number): DeterministicRng {
  let a = hashSeed(seed) >>> 0;

  function nextU32(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  function next(): number {
    // 24 位尾数 + 额外 24 位拼接，保证 [0,1) 的双精度粒度
    const hi = nextU32() >>> 8; // 24 bits
    const lo = nextU32() >>> 8; // 24 bits
    return (hi * 0x1000000 + lo) / 0x1000000000000; // 2^48
  }

  return {
    nextU32,
    next,
    range(min, max) {
      return min + (max - min) * next();
    },
    chance(p) {
      if (p <= 0) return false;
      if (p >= 1) return true;
      return next() < p;
    },
    pick(arr) {
      return arr[nextU32() % arr.length];
    },
  };
}

/**
 * 简易确定性 SHA-256（纯 TS 实现，避免依赖 Node crypto，
 * 使得同一份引擎代码在任何宿主下指纹一致；Node 端用 crypto 交叉校验）。
 * 输出 64 位小写十六进制。
 */
export function sha256(message: string): string {
  const bytes = utf8Bytes(message);
  return sha256Bytes(bytes);
}

function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Bytes(data: Uint8Array): string {
  const len = data.length;
  const bitLenHi = Math.floor(len / 0x20000000) >>> 0;
  const bitLenLo = (len << 3) >>> 0;
  const withPad = (((len + 8) >> 6) + 1) * 64;
  const buf = new Uint8Array(withPad);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(withPad - 8, bitLenHi);
  dv.setUint32(withPad - 4, bitLenLo);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [h0, h1, h2, h3, h4, h5, h6, h7] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(h4, 6) ^ rotr(h4, 11) ^ rotr(h4, 25);
      const ch = (h4 & h5) ^ (~h4 & h6);
      const t1 = (h7 + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(h0, 2) ^ rotr(h0, 13) ^ rotr(h0, 22);
      const maj = (h0 & h1) ^ (h0 & h2) ^ (h1 & h2);
      const t2 = (S0 + maj) >>> 0;
      h7 = h6;
      h6 = h5;
      h5 = h4;
      h4 = (h3 + t1) >>> 0;
      h3 = h2;
      h2 = h1;
      h1 = h0;
      h0 = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + h0) >>> 0;
    H[1] = (H[1] + h1) >>> 0;
    H[2] = (H[2] + h2) >>> 0;
    H[3] = (H[3] + h3) >>> 0;
    H[4] = (H[4] + h4) >>> 0;
    H[5] = (H[5] + h5) >>> 0;
    H[6] = (H[6] + h6) >>> 0;
    H[7] = (H[7] + h7) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += H[i].toString(16).padStart(8, '0');
  }
  return hex;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
