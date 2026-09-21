/**
 * codec 往返测试：编码→解码逐字段核对。npx tsx scripts/codec-test.ts
 */
import { encodeFrame, decodeFrames, FRAME_HEADER_SIZE, FRAME_CELL_SIZE } from '../shared/sim/codec.js';

function approx(a: number, b: number, eps = 1 / 32 + 1e-6) {
  return Math.abs(a - b) <= eps;
}

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error('FAIL:', msg);
  }
}

const cells = [
  { id: 1, speciesId: 15, x: 123.4, y: -77.1, angle: 0.5, biomass: 1.23, state: 'active' as const, lysisIn: 0 },
  { id: 4294967290, speciesId: 24, x: -499.9, y: 499.2, angle: 5.9, biomass: 3.9, state: 'infected' as const, lysisIn: 17 },
  { id: 99, speciesId: 1, x: 0, y: 0, angle: 0, biomass: 0.05, state: 'virion' as const, lysisIn: 0, ttl: 120 },
];

const frame = encodeFrame(317, cells, 2_528_000, 987);
check(frame.byteLength === FRAME_HEADER_SIZE + cells.length * FRAME_CELL_SIZE, `长度应为 头+N×${FRAME_CELL_SIZE}，实际 ${frame.byteLength}`);

const decoded = decodeFrames(frame);
check(decoded.length === 1, '应解出一帧');
const f = decoded[0];
check(f.tick === 317, `tick 应为 317，实际 ${f.tick}`);
check(f.carbonPermille === 2_528_000, '碳总量字段');
check(f.antibioticPeakPermille === 987, '抗生素峰值字段');
check(f.cells.length === 3, '细胞数应为 3');

const c0 = f.cells[0];
check(c0.id === 1 && c0.speciesId === 15, '细胞0 id/species');
check(approx(c0.x, 123.4) && approx(c0.y, -77.1), '细胞0 坐标');
check(c0.state === 0, '细胞0 状态 active');
check(Math.abs(c0.biomass - 1.23) < 0.03, '细胞0 生物质');

const c1 = f.cells[1];
check(c1.id === 4294967290 && c1.speciesId === 24, '细胞1 大 id/species');
check(approx(c1.x, -499.9) && approx(c1.y, 499.2), '细胞1 边界坐标');
check(c1.state === 1 && c1.timer === 17, '细胞1 感染与裂解倒计时');

const c2 = f.cells[2];
check(c2.id === 99 && c2.speciesId === 1 && c2.state === 2, '细胞2 颗粒');
check(c2.timer === 120, '细胞2 ttl');

// 多帧拼接
const multi = new Uint8Array(frame.byteLength * 2);
multi.set(frame, 0);
multi.set(frame, frame.byteLength);
const two = decodeFrames(multi);
check(two.length === 2 && two[1].tick === 317 && two[1].cells.length === 3, '多帧拼接');

if (failures === 0) {
  console.log('codec 往返测试全部 PASS');
} else {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
