/**
 * 培养皿运行仓库 —— 服务端权威的落点。
 *
 * 每一次运行在 data/petri/<runId>/ 下留下可审计的科考档案：
 *   manifest.json  请求、指纹、逐格计数、种级信息（结论性档案）
 *   journal.jsonl  逐步事件流水（每步一条 JSON，带哈希链 prevHash）
 *   frames.bin     逐帧权威二进制（帧格式见 codec.ts）
 *   verify.json    复核结果（如有）
 *
 * 内存里保存 frames 与偏移索引用于区间取帧；manifest/journal 同步落盘，
 * 进程重启后帧可由种子与接种清单确定性重放重建（生态指纹本身即为重放凭证）。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SimulationEngine, type CatalogEntry } from '../../../shared/sim/engine.js';
import type {
  CreateRunRequest,
  EcoFingerprint,
  InoculumItem,
  RunInfo,
  RunSpeciesInfo,
  SimEvent,
  TickCount,
} from '../../../shared/sim/types.js';

interface StoredRun {
  info: RunInfo;
  ticks: TickCount[];
  events: SimEvent[];
  species: RunSpeciesInfo[];
  frames: Uint8Array;
  frameOffsets: number[];
  frameLengths: number[];
  journal: JournalEntry[];
}

interface JournalEntry {
  tick: number;
  counts: TickCount;
  events: SimEvent[];
  prevHash: string;
  hash: string;
}

export interface VerifyResult {
  runId: string;
  matched: boolean;
  /** 落盘科考日志哈希链是否完好（独立重算，检测档案篡改） */
  journalIntact: boolean;
  expectedJournalTip: string;
  recomputedJournalTip: string;
  expectedTranscript: string;
  replayTranscript: string;
  expectedChainTip: string;
  replayChainTip: string;
  ticksCompared: number;
  replayedAt: string;
}

export class RunStore {
  private runs = new Map<string, StoredRun>();
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.recover();
  }

  private recover() {
    for (const id of existsSync(this.dataDir) ? readdirSync(this.dataDir) : []) {
      const dir = join(this.dataDir, id);
      const manifestPath = join(dir, 'manifest.json');
      const framesPath = join(dir, 'frames.bin');
      if (!existsSync(manifestPath) || !existsSync(framesPath)) continue;
      try {
        const info = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunInfo & {
          ticks?: TickCount[];
          events?: SimEvent[];
          species?: RunSpeciesInfo[];
          frameOffsets?: number[];
          frameLengths?: number[];
          journal?: JournalEntry[];
        };
        const frames = new Uint8Array(readFileSync(framesPath));
        this.runs.set(id, {
          info: stripManifest(info as unknown as Record<string, unknown>),
          ticks: info.ticks ?? [],
          events: info.events ?? [],
          species: info.species ?? [],
          frames,
          frameOffsets: info.frameOffsets ?? [],
          frameLengths:
            info.frameLengths ?? info.frameOffsets?.map((off, i) => (info.frameOffsets![i + 1] ?? frames.byteLength) - off) ?? [],
          journal: info.journal ?? [],
        });
      } catch {
        // 损坏档案跳过（不影响其余运行）
      }
    }
  }

  create(req: CreateRunRequest, catalog: Map<number, CatalogEntry>): RunInfo {
    const inoculum = normalizeInoculum(req.inoculum, catalog);
    if (inoculum.length === 0) throw new Error('接种清单为空或标本不存在');
    const totalInoculated = inoculum.reduce((s, i) => s + i.count, 0);
    if (totalInoculated > 200) throw new Error('接种总量上限 200');

    const result = new SimulationEngine({ seed: req.seed, inoculum, catalog }).run();

    const canonicalReq = createHash('sha256')
      .update(JSON.stringify({ seed: String(req.seed), inoculum }))
      .digest('hex')
      .slice(0, 12);
    const runId = `${canonicalReq}-${result.fingerprint.transcriptHash.slice(0, 8)}`;

    // 同样的请求与种子 → 同一个 runId（幂等），直接复用既有档案
    const existing = this.runs.get(runId);
    if (existing) return existing.info;

    // 逐步科考日志：哈希链与引擎转录完全同一套规范序列化，
    // 因此日志末端必须等于指纹 chainTip —— 任何一格被改，末端就对不上。
    const journal: JournalEntry[] = [];
    let prevHash = createHash('sha256').update(`petri-genesis/${runId}`).digest('hex');
    const eventsByTick = new Map<number, SimEvent[]>();
    for (const e of result.events) {
      const arr = eventsByTick.get(e.tick) ?? [];
      arr.push(e);
      eventsByTick.set(e.tick, arr);
    }
    for (const counts of result.ticks) {
      const tickEvents = (eventsByTick.get(counts.tick) ?? [])
        .map((e) => ({ ...e }))
        .sort((a, b) => a.type.localeCompare(b.type) || (a.speciesId ?? 0) - (b.speciesId ?? 0));

      // 与 shared/sim/engine.record 逐字节一致的规范行
      const line = `${counts.tick}|${counts.total}|${counts.bacteria}|${counts.fungi}|${counts.virus}|${counts.archaea}|${counts.carbon}|${counts.antibioticPeak}`;
      const evLine = tickEvents
        .map((e) => `${e.type}:${e.speciesId ?? '-'}:${e.count ?? ''}`)
        .sort()
        .join(',');
      const hash = createHash('sha256')
        .update(prevHash + line + '\n' + evLine + '\n')
        .digest('hex');
      journal.push({ tick: counts.tick, counts, events: tickEvents, prevHash, hash });
      prevHash = hash;
    }
    const journalTip = prevHash;

    const frameLengths = result.frameOffsets.map(
      (off, i) => (result.frameOffsets[i + 1] ?? result.frames.byteLength) - off
    );

    const info: RunInfo = {
      runId,
      name: (req.name ?? '未命名培养皿').slice(0, 60),
      seed: String(req.seed),
      inoculumHash: result.fingerprint.inoculumHash,
      totalTicks: result.ticks[result.ticks.length - 1].tick,
      maxCells: result.maxCells,
      createdAt: new Date().toISOString(),
      fingerprint: result.fingerprint,
      journalTip,
      inoculum,
      species: result.species,
    };

    const stored: StoredRun = {
      info,
      ticks: result.ticks,
      events: result.events,
      species: result.species,
      frames: result.frames,
      frameOffsets: result.frameOffsets,
      frameLengths,
      journal,
    };
    this.runs.set(runId, stored);
    this.persist(stored);
    return info;
  }

  private persist(run: StoredRun) {
    const dir = join(this.dataDir, run.info.runId);
    mkdirSync(dir, { recursive: true });
    const manifest = {
      ...run.info,
      ticks: run.ticks,
      events: run.events,
      frameOffsets: run.frameOffsets,
      frameLengths: run.frameLengths,
      journal: run.journal,
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'frames.bin'), Buffer.from(run.frames));
  }

  get(runId: string): StoredRun | undefined {
    return this.runs.get(runId);
  }

  list(): RunInfo[] {
    return [...this.runs.values()]
      .map((r) => r.info)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  ticks(runId: string): TickCount[] {
    return this.runs.get(runId)?.ticks ?? [];
  }

  journal(runId: string): JournalEntry[] {
    return this.runs.get(runId)?.journal ?? [];
  }

  /** 取 [from, to] 闭区间的帧，拼成一个 ArrayBuffer 返回 */
  frameRange(runId: string, from: number, to: number): { data: Uint8Array; ticks: number[] } | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const start = Math.max(0, from);
    const end = Math.min(run.info.totalTicks, to);
    if (start > end) return null;
    const chunks: Uint8Array[] = [];
    const ticks: number[] = [];
    let bytes = 0;
    for (let t = start; t <= end; t++) {
      const off = run.frameOffsets[t];
      const len = run.frameLengths[t];
      if (off === undefined || len === undefined) continue;
      chunks.push(run.frames.subarray(off, off + len));
      ticks.push(t);
      bytes += len;
    }
    const out = new Uint8Array(bytes);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.byteLength;
    }
    return { data: out, ticks };
  }

  /** 服务器端重放：用相同种子与接种清单从头再推一遍，逐格比对哈希 */
  verify(runId: string, catalog: Map<number, CatalogEntry>): VerifyResult | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const replay = new SimulationEngine({
      seed: run.info.seed,
      inoculum: run.info.inoculum,
      catalog,
    }).run();

    let matched =
      replay.fingerprint.transcriptHash === run.info.fingerprint.transcriptHash &&
      replay.fingerprint.chainTip === run.info.fingerprint.chainTip &&
      replay.ticks.length === run.ticks.length;

    if (matched) {
      for (let i = 0; i < run.ticks.length; i++) {
        const a = run.ticks[i];
        const b = replay.ticks[i];
        if (
          a.tick !== b.tick ||
          a.total !== b.total ||
          a.bacteria !== b.bacteria ||
          a.fungi !== b.fungi ||
          a.virus !== b.virus ||
          a.archaea !== b.archaea ||
          a.carbon !== b.carbon ||
          a.antibioticPeak !== b.antibioticPeak
        ) {
          matched = false;
          break;
        }
      }
    }

    // 独立重算档案哈希链：从 genesis 起，逐环核对 prevHash 与规范行
    let recomputedTip = createHash('sha256').update(`petri-genesis/${runId}`).digest('hex');
    let journalIntact = run.journal.length === run.ticks.length;
    for (let i = 0; i < run.journal.length; i++) {
      const entry = run.journal[i];
      if (entry.prevHash !== recomputedTip) {
        journalIntact = false;
        break;
      }
      const counts = entry.counts;
      const line = `${counts.tick}|${counts.total}|${counts.bacteria}|${counts.fungi}|${counts.virus}|${counts.archaea}|${counts.carbon}|${counts.antibioticPeak}`;
      const evLine = entry.events
        .map((e) => `${e.type}:${e.speciesId ?? '-'}:${e.count ?? ''}`)
        .sort()
        .join(',');
      recomputedTip = createHash('sha256')
        .update(recomputedTip + line + '\n' + evLine + '\n')
        .digest('hex');
      if (entry.hash !== recomputedTip) {
        journalIntact = false;
        break;
      }
    }
    if (recomputedTip !== run.info.journalTip) journalIntact = false;

    const result: VerifyResult = {
      runId,
      matched,
      journalIntact,
      expectedJournalTip: run.info.journalTip,
      recomputedJournalTip: recomputedTip,
      expectedTranscript: run.info.fingerprint.transcriptHash,
      replayTranscript: replay.fingerprint.transcriptHash,
      expectedChainTip: run.info.fingerprint.chainTip,
      replayChainTip: replay.fingerprint.chainTip,
      ticksCompared: run.ticks.length,
      replayedAt: new Date().toISOString(),
    };

    const dir = join(this.dataDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verify.json'), JSON.stringify(result, null, 2));
    return result;
  }
}

function normalizeInoculum(
  input: InoculumItem[] | undefined,
  catalog: Map<number, CatalogEntry>
): InoculumItem[] {
  if (!Array.isArray(input)) return [];
  const merged = new Map<number, number>();
  for (const item of input) {
    const id = Number(item?.microbeId);
    const count = Math.floor(Number(item?.count));
    if (!Number.isFinite(id) || !Number.isFinite(count) || count <= 0) continue;
    if (!catalog.has(id)) continue;
    merged.set(id, (merged.get(id) ?? 0) + count);
  }
  return [...merged.entries()]
    .map(([microbeId, count]) => ({ microbeId, count }))
    .sort((a, b) => a.microbeId - b.microbeId);
}

function stripManifest(raw: Record<string, unknown>): RunInfo {
  return {
    runId: raw.runId as string,
    name: raw.name as string,
    seed: raw.seed as string,
    inoculumHash: raw.inoculumHash as string,
    totalTicks: raw.totalTicks as number,
    maxCells: raw.maxCells as number,
    createdAt: raw.createdAt as string,
    fingerprint: raw.fingerprint as EcoFingerprint,
    journalTip: raw.journalTip as string,
    inoculum: raw.inoculum as InoculumItem[],
    species: raw.species as RunSpeciesInfo[],
  };
}
