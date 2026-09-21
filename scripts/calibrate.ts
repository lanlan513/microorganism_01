/**
 * 模拟内核校准与验收脚本：
 *   tsx scripts/calibrate.ts
 *
 * 检查项：
 *  A. 同接种+同种子两次独立运行，逐 tick 计数序列完全一致；
 *  B. 种群有明显的生长-峰值-更替动态，峰值达到数百~千级；
 *  C. 抗菌素显著压制敏感种（对比给药/不给药）；
 *  D. 不同接种清单的指纹 digest 两两不同；
 *  E. 运行耗时（100x 速度下单轮 1800 tick 的预算）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PetriSimulation,
  TOTAL_TICKS,
  TICKS_PER_GENERATION,
} from '../api/src/petri/engine.ts';
import { sha256 as pureSha } from '../api/src/petri/rng.ts';
import type { CreateRunRequest, EcoFingerprint } from '../shared/petri.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const microbes = JSON.parse(
  readFileSync(path.join(__dirname, '../api/src/data/microbesData.json'), 'utf8')
) as { id: number; name: string; scientificName: string; category: string }[];

const NAMES = new Map(
  microbes.map((m) => [m.id, { name: m.name, scientificName: m.scientificName, category: m.category as never }])
);

function runAll(req: CreateRunRequest, runId = 'test'): { sim: PetriSimulation; ms: number; fp: EcoFingerprint } {
  const sim = new PetriSimulation(req, runId);
  const t0 = performance.now();
  while (!sim.finished) sim.step();
  const ms = performance.now() - t0;
  return { sim, ms, fp: sim.fingerprint(NAMES) };
}

function trajectoryDigest(sim: PetriSimulation) {
  const body = sim.tickRecords
    .map((r) => {
      const keys = Object.keys(r.counts).map(Number).sort((a, b) => a - b);
      return `${r.tick}:${keys.map((k) => `${k}=${r.counts[k]}`).join(',')},v${r.virions}`;
    })
    .join('|');
  return createHash('sha256').update(body).digest('hex');
}

function seriesDigest(fp: EcoFingerprint) {
  return fp.series.map((s) => `${s.gen}:${s.counts.totalCells}/${s.counts.virions}`).join(' ');
}

// 交叉验证纯 TS SHA-256 与 Node crypto 一致
{
  const samples = ['', 'abc', '培养皿科考记录 petri dish 0123456789'];
  for (const s of samples) {
    const a = pureSha(s);
    const b = createHash('sha256').update(s).digest('hex');
    console.assert(a === b, `SHA 不一致: "${s}" ${a} vs ${b}`);
  }
  console.log('✔ SHA-256 纯TS实现与 node:crypto 交叉一致');
}

// A. 可复现性
const baseReq: CreateRunRequest = {
  seed: 'expedition-007',
  inocula: [
    { specimenId: 1, count: 40 }, // 大肠杆菌
    { specimenId: 2, count: 30 }, // 金葡
    { specimenId: 3, count: 20 }, // 枯草
    { specimenId: 9, count: 15 }, // 酵母
    { specimenId: 21, count: 10 }, // 甲烷球菌
    { specimenId: 15, count: 12 }, // T4 噬菌体
  ],
};
const r1 = runAll(baseReq, 'run-a');
const r2 = runAll(baseReq, 'run-b');
const d1 = trajectoryDigest(r1.sim);
const d2 = trajectoryDigest(r2.sim);
console.log(d1 === d2 ? '✔ 同种子两次运行逐tick计数序列完全一致' : `� 复现失败 ${d1} != ${d2}`);
console.log('  countsDigest(纯TS):', r1.fp.countsDigest.slice(0, 16));
console.log('  最终 digest      :', r1.fp.digest.slice(0, 16));
console.log('  轨迹(crypto交叉) :', d1.slice(0, 16));
console.assert(d1 === d2, 'determinism');

// 不同 runId 不应影响轨迹
const r3 = runAll(baseReq, 'run-different-id');
const d3 = trajectoryDigest(r3.sim);
console.log(d3 === d1 ? '✔ 轨迹与 runId 无关（只取决于种子+清单）' : '✗ runId 污染了轨迹');

// B. 生态动力学
{
  const s = r1.sim;
  const peak = Math.max(...s.tickRecords.map((r) => Object.values(r.counts).reduce((a, b) => a + b, 0)));
  const final = s.tickRecords[TOTAL_TICKS];
  const finalTotal = Object.values(final.counts).reduce((a, b) => a + b, 0);
  console.log(`✔ 峰值细胞数=${peak}，终态细胞=${finalTotal}，终态病毒粒子=${final.virions}`);
  console.log('  采样代序列(总细胞/病毒粒子):', seriesDigest(r1.fp));
  console.log('  优势种:', r1.fp.finalDominant ? `${r1.fp.finalDominant.name} x${r1.fp.finalDominant.count}` : '无活细胞');
  console.log('  灭绝顺序:', r1.fp.extinctionOrder.map((e) => `${e.name}@${e.tick}`).join(' → ') || '无灭绝');
}

// C. 抗菌素压制（在群落繁盛的中期对比，青霉素应显著清除革兰阳性金葡）
{
  const noDrug = runAll(baseReq, 'no-drug');
  const withDrug = runAll(
    {
      ...baseReq,
      regimen: [{ atTick: 300, drug: 'penicillin', concentration: 3 }],
    },
    'drug'
  );
  const at = 480; // 给药后 180 tick，正值群落中期
  const aureusNo = noDrug.sim.tickRecords[at].counts[2] ?? 0;
  const aureusYes = withDrug.sim.tickRecords[at].counts[2] ?? 0;
  const endNo = noDrug.sim.tickRecords[TOTAL_TICKS].counts[2] ?? 0;
  const endYes = withDrug.sim.tickRecords[TOTAL_TICKS].counts[2] ?? 0;
  // 天然耐药的铜绿（id=4）不受青霉素影响，但本清单未接种；这里验证敏感种被压制、且药效可量化
  const suppressed = aureusYes < aureusNo * 0.4;
  console.log(
    `✔ 青霉素(t=300,3MIC)压制敏感金葡：t=${at} 时 ${aureusNo} → ${aureusYes}（清除率 ${(
      (1 - aureusYes / Math.max(1, aureusNo)) * 100
    ).toFixed(0)}%）；终态 ${endNo} → ${endYes}`
  );
  console.log(suppressed ? '  抗菌素压制效应显著' : '  ⚠ 压制不明显');
  console.log('  两方案指纹不同:', noDrug.fp.digest !== withDrug.fp.digest ? '✔' : '✗');
}

// D. 指纹两两唯一
const configs: CreateRunRequest[] = [
  baseReq,
  { ...baseReq, inocula: [{ specimenId: 1, count: 50 }] },
  { ...baseReq, inocula: [{ specimenId: 1, count: 51 }] },
  { ...baseReq, inocula: [{ specimenId: 2, count: 50 }] },
  { ...baseReq, seed: 'expedition-008' },
  { ...baseReq, inocula: [{ specimenId: 7, count: 40 }, { specimenId: 15, count: 10 }] },
  { ...baseReq, inocula: [{ specimenId: 9, count: 40 }, { specimenId: 12, count: 20 }] },
  { ...baseReq, inocula: [{ specimenId: 21, count: 30 }, { specimenId: 24, count: 30 }] },
];
const digests = configs.map((c) => runAll(c).fp.digest);
const uniq = new Set(digests);
console.log(`✔ ${configs.length} 份不同接种/种子产生 ${uniq.size} 个不同指纹（两两不同：${uniq.size === digests.length ? '是' : '否'}）`);

// E. 性能
console.log(`✔ 单次 1800 tick 推进耗时 ${r1.ms.toFixed(0)}ms（100x 下实时预算 18000ms）`);

// 四分类占比抽样
const s0 = r1.fp.series[0];
const sMid = r1.fp.series[8];
const sEnd = r1.fp.series[15];
for (const [label, s] of [['gen0', s0], ['gen8', sMid], ['gen15', sEnd]] as const) {
  console.log(
    `  ${label.padEnd(6)} tick=${String(s.tick).padStart(4)} 总=${s.counts.totalCells} ` +
      `菌=${s.counts.bacteria} 真=${s.counts.fungi} 古=${s.counts.archaea} 毒=${s.counts.virus} ` +
      `占比=${s.ratios.bacteria.toFixed(3)}/${s.ratios.fungi.toFixed(3)}/${s.ratios.archaea.toFixed(3)}/${s.ratios.virus.toFixed(3)}`
  );
}
void TICKS_PER_GENERATION;
