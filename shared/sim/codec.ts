/**
 * 权威帧的二进制编解码（服务端与前端共用，纯函数、零依赖）。
 *
 * 每一代（tick）一条记录：
 *   Header 12B
 *     u16 tick
 *     u16 cellCount
 *     u32 carbonTotalPermille
 *     u32 antibioticPeakPermille
 *   每个细胞 13B：
 *     u32 id
 *     i16 xQ   坐标定点，SCALE=32（分辨率 1/32 模型单位，范围 ±1023）
 *     i16 yQ
 *     u8  speciesId
 *     u8  angleQ 角度 256 分
 *     u8  state   0=active 1=infected 2=virion
 *     u8  biomassQ 生物质 0..4 → 0..255
 *     u8  timerQ   infected: 距裂解 tick；virion: 已漂移 tick
 *
 * 前端只解码、绘制，不允许据此自行推演下一帧。
 */

export const FRAME_TICK_OFFSET = 0;
export const FRAME_HEADER_SIZE = 12;
export const FRAME_CELL_SIZE = 13;
const SCALE = 32;

export interface CodecCell {
  id: number;
  speciesId: number;
  x: number;
  y: number;
  angle: number;
  biomass: number;
  state: number;
  timer: number;
}

export interface CodecFrame {
  tick: number;
  carbonPermille: number;
  antibioticPeakPermille: number;
  cells: CodecCell[];
}

export function encodeFrame(
  tick: number,
  cells: Array<{
    id: number;
    speciesId: number;
    x: number;
    y: number;
    angle: number;
    biomass: number;
    state: 'active' | 'infected' | 'virion';
    lysisIn: number;
    ttl?: number;
  }>,
  carbonPermille: number,
  antibioticPeakPermille: number
): Uint8Array {
  const buf = new ArrayBuffer(FRAME_HEADER_SIZE + cells.length * FRAME_CELL_SIZE);
  const dv = new DataView(buf);
  let p = 0;
  dv.setUint16(p, tick);
  p += 2;
  dv.setUint16(p, cells.length);
  p += 2;
  dv.setUint32(p, carbonPermille >>> 0);
  p += 4;
  dv.setUint32(p, antibioticPeakPermille >>> 0);
  p += 4; // 12 字节头结束

  const stateCode = (s: string): number => (s === 'infected' ? 1 : s === 'virion' ? 2 : 0);
  for (const c of cells) {
    dv.setUint32(p, c.id);
    p += 4;
    const xq = Math.max(-32767, Math.min(32767, Math.round(c.x * SCALE)));
    const yq = Math.max(-32767, Math.min(32767, Math.round(c.y * SCALE)));
    dv.setInt16(p, xq);
    p += 2;
    dv.setInt16(p, yq);
    p += 2;
    dv.setUint8(p, c.speciesId & 0xff);
    p += 1; // → 角度
    dv.setUint8(p, Math.floor(((c.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * 256) & 0xff);
    p += 1; // → 状态
    dv.setUint8(p, stateCode(c.state));
    p += 1; // → 生物质
    dv.setUint8(p, Math.max(0, Math.min(255, Math.round((c.biomass / 4) * 255))));
    p += 1; // → 计时
    const timer = c.state === 'virion' ? (c.ttl ?? 0) : Math.max(0, c.lysisIn);
    dv.setUint8(p, Math.min(255, timer));
    p += 1;
  }
  return new Uint8Array(buf);
}

/** 解码整段缓冲（含一帧或多帧拼接） */
export function decodeFrames(bytes: Uint8Array): CodecFrame[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: CodecFrame[] = [];
  let p = 0;
  while (p + FRAME_HEADER_SIZE <= bytes.byteLength) {
    const tick = dv.getUint16(p);
    const count = dv.getUint16(p + 2);
    const carbon = dv.getUint32(p + 4);
    const anti = dv.getUint32(p + 8);
    p += FRAME_HEADER_SIZE;
    const cells: CodecCell[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const id = dv.getUint32(p);
      const x = dv.getInt16(p + 4) / SCALE;
      const y = dv.getInt16(p + 6) / SCALE;
      const speciesId = dv.getUint8(p + 8);
      const angle = (dv.getUint8(p + 9) / 256) * Math.PI * 2;
      const state = dv.getUint8(p + 10);
      const biomass = (dv.getUint8(p + 11) / 255) * 4;
      const timer = dv.getUint8(p + 12);
      cells[i] = { id, speciesId, x, y, angle, biomass, state, timer };
      p += FRAME_CELL_SIZE;
    }
    out.push({ tick, carbonPermille: carbon, antibioticPeakPermille: anti, cells });
  }
  return out;
}
