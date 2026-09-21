/**
 * 标定 & 可复现性自检：npx tsx scripts/sim-tune.ts
 *
 *  - 同一配置跑两次，逐格比对 transcriptHash（必须完全一致）
 *  - 不同接种必须产生不同指纹
 *  - 打印种群序列摘要，供标定生态常数
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SimulationEngine, type CatalogEntry, type EngineOptions } from '../shared/sim/engine.js';
import type { InoculumItem, SimCategory } from '../shared/sim/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  readFileSync(resolve(here, '../api/src/data/microbesData.json'), 'utf8')
) as Array<{ id: number; name: string; scientificName: string; category: SimCategory }>;

const catalog = new Map<number, CatalogEntry>();
for (const m of raw) catalog.set(m.id, { name: m.name, scientificName: m.scientificName, category: m.category });

function run(opts: { label: string; seed: number; inoculum: InoculumItem[] }) {
  const engineOpts: EngineOptions = { seed: opts.seed, inoculum: opts.inoculum, catalog };
  const r1 = new SimulationEngine(engineOpts).run();
  const r2 = new SimulationEngine(engineOpts).run();
  const ok = r1.fingerprint.transcriptHash === r2.fingerprint.transcriptHash;
  console.log(`\n=== ${opts.label} (seed=${opts.seed}) ===`);
  console.log(`deterministic: ${ok ? 'PASS' : 'FAIL'}`);
  console.log(`ticks=${r1.ticks.length} maxCells=${r1.maxCells} concluded=${r1.fingerprint.concluded}`);
  console.log(`transcript=${r1.fingerprint.transcriptHash.slice(0, 24)}…`);
  const sample = [0, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, r1.ticks.length - 1];
  console.log('  tick  total  bact  fungi  virus  arch   carbon   antiPeak');
  for (const t of sample) {
    const r = r1.ticks[t];
    if (!r) continue;
    console.log(
      String(r.tick).padStart(6),
      String(r.total).padStart(6),
      String(r.bacteria).padStart(5),
      String(r.fungi).padStart(6),
      String(r.virus).padStart(6),
      String(r.archaea).padStart(6),
      String(r.carbon).padStart(8),
      String(r.antibioticPeak).padStart(8)
    );
  }
  const dom = r1.fingerprint.dominantSpeciesId;
  console.log(
    'dominant:',
    dom !== null ? `${dom} ${catalog.get(dom)?.name}` : '（全部灭绝）',
    '| extinction:',
    r1.fingerprint.extinctionOrder.map((id) => `${id}:${catalog.get(id)?.name}`).join(' → ') || '无'
  );
  return r1.fingerprint.transcriptHash;
}

const scenarios: Array<{ label: string; seed: number; inoculum: InoculumItem[] }> = [
  {
    label: '经典演替：细菌+青霉+古菌',
    seed: 42,
    inoculum: [
      { microbeId: 1, count: 30 }, // 大肠杆菌
      { microbeId: 11, count: 6 }, // 产黄青霉
      { microbeId: 24, count: 8 }, // 激烈火球菌
    ],
  },
  {
    label: 'T4 猎菌：大肠杆菌+T4+酵母',
    seed: 7,
    inoculum: [
      { microbeId: 1, count: 40 },
      { microbeId: 15, count: 6 },
      { microbeId: 9, count: 8 },
    ],
  },
  {
    label: '耐药者生存：葡萄球菌+铜绿+青霉',
    seed: 99,
    inoculum: [
      { microbeId: 2, count: 24 },
      { microbeId: 4, count: 12 },
      { microbeId: 11, count: 8 },
      { microbeId: 23, count: 8 },
    ],
  },
  {
    label: '纯细菌暴发',
    seed: 42,
    inoculum: [{ microbeId: 1, count: 30 }],
  },
  {
    label: '同清单换种子',
    seed: 123,
    inoculum: [
      { microbeId: 1, count: 30 },
      { microbeId: 11, count: 6 },
      { microbeId: 24, count: 8 },
    ],
  },
  {
    label: '青霉压制：葡萄球菌+青霉（无耐药菌）',
    seed: 42,
    inoculum: [
      { microbeId: 2, count: 36 },
      { microbeId: 11, count: 10 },
    ],
  },
  {
    label: '接种量微扰（1 个之差）',
    seed: 42,
    inoculum: [
      { microbeId: 1, count: 29 },
      { microbeId: 11, count: 6 },
      { microbeId: 24, count: 8 },
    ],
  },
];

const hashes = scenarios.map((s) => run(s));
const unique = new Set(hashes);
console.log(`\n不同接种/种子指纹数：${unique.size}/${hashes.length}`, unique.size === hashes.length ? 'PASS' : 'FAIL（有碰撞！）');
