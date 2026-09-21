/**
 * RunManager —— 服务端权威的运行时与存档。
 *
 * 设计：
 *  - 每个 run 独占一个 PetriSimulation，推进循环（setInterval）只在服务端；
 *  - speed=0 暂停；speed=1..100 表示每秒推进 60*speed 个 tick（前端插值播放）；
 *  - 每个 wall-clock 帧（约 16.6ms）把应推进的 tick 数一次性跑完，再把最新快照推给订阅者；
 *  - 所有动作（建舱/暂停/加速/给药/完成/指纹）都 append 到 api/archives/<runId>/run.jsonl；
 *  - 快照全量、顺序、只读：前端无法修改任何模拟状态。
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import microbesData from '../data/microbesData.json' with { type: 'json' };
import type {
  AntibioticId,
  ArchiveListItem,
  CreateRunRequest,
  EcoFingerprint,
  RunControl,
  RunInfo,
  Snapshot,
} from '../../../shared/petri.js';
import {
  ENGINE_VERSION,
  PetriSimulation,
  TOTAL_TICKS,
  TICKS_PER_GENERATION,
} from '../petri/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_ROOT = path.join(__dirname, '../../archives');
const TICK_HZ = 60; // 1x：每秒推进 60 tick
const FRAME_MS = 50; // 服务端拍帧间隔（20fps 的权威拍；前端可插帧到 60fps）

interface SpecimenMeta {
  name: string;
  scientificName: string;
  category: 'bacteria' | 'fungi' | 'virus' | 'archaea';
}

const SPECIMEN_META = new Map<number, SpecimenMeta>(
  (microbesData as unknown as { id: number; name: string; scientificName: string; category: SpecimenMeta['category'] }[]).map(
    (m) => [m.id, { name: m.name, scientificName: m.scientificName, category: m.category }]
  )
);

export interface ActiveRun {
  runId: string;
  sim: PetriSimulation;
  info: RunInfo;
  emitter: EventEmitter;
  timer: NodeJS.Timeout | null;
  lastFrameAt: number;
  createdAt: string;
  finishedAt?: string;
  pendingDose: { drug: AntibioticId; concentration: number } | null;
  fingerprint?: EcoFingerprint;
}

interface ArchiveLine {
  type: 'created' | 'control' | 'dose' | 'checkpoint' | 'fingerprint';
  at: string;
  tick?: number;
  seed?: string;
  inocula?: CreateRunRequest['inocula'];
  regimen?: CreateRunRequest['regimen'];
  engineVersion?: string;
  inoculaHash?: string;
  action?: string;
  speed?: number;
  drug?: AntibioticId;
  concentration?: number;
  source?: 'regimen' | 'operator';
  counts?: Snapshot['counts'];
  status?: string;
  fingerprint?: EcoFingerprint;
}

class RunManagerClass {
  private runs = new Map<string, ActiveRun>();

  constructor() {
    mkdirSync(ARCHIVE_ROOT, { recursive: true });
  }

  listArchives(): ArchiveListItem[] {
    if (!existsSync(ARCHIVE_ROOT)) return [];
    const out: ArchiveListItem[] = [];
    for (const id of readdirSync(ARCHIVE_ROOT)) {
      const file = path.join(ARCHIVE_ROOT, id, 'run.jsonl');
      if (!existsSync(file)) continue;
      try {
        const lines = this.parseArchive(id);
        const created = lines.find((l) => l.type === 'created');
        const last = lines[lines.length - 1];
        const done = lines.find((l) => l.type === 'fingerprint');
        out.push({
          runId: id,
          createdAt: created?.at ?? '',
          finishedAt: done?.at,
          status: last?.type === 'fingerprint' ? 'finished' : last?.status ?? 'unknown',
          seed: created?.seed ?? '',
          inocula: created?.inocula ?? [],
          tick: last?.tick ?? 0,
          totalTicks: TOTAL_TICKS,
          digest: done?.fingerprint?.digest,
        });
      } catch {
        // 损坏的档案行忽略
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  private parseArchive(runId: string): ArchiveLine[] {
    const file = path.join(ARCHIVE_ROOT, runId, 'run.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ArchiveLine);
  }

  getArchive(runId: string): ArchiveLine[] | null {
    const lines = this.parseArchive(runId);
    return lines.length ? lines : null;
  }

  create(req: CreateRunRequest): ActiveRun {
    if (!req.inocula?.length) throw new Error('接种清单为空');
    if (req.inocula.some((it) => it.count < 1 || it.count > 500)) throw new Error('每种接种数量需在 1-500 之间');
    for (const it of req.inocula) {
      if (!SPECIMEN_META.has(it.specimenId)) throw new Error(`未知标本 ${it.specimenId}`);
    }
    const runId =
      'run-' +
      Date.now().toString(36) +
      '-' +
      Math.abs(hashStr(req.seed + '|' + JSON.stringify(req.inocula))).toString(36).slice(0, 6);

    const sim = new PetriSimulation(req, runId);
    const info: RunInfo = {
      runId,
      status: 'running',
      tick: 0,
      totalTicks: TOTAL_TICKS,
      speed: 1,
      seed: sim.seed,
      inocula: sim.inocula,
      createdAt: new Date().toISOString(),
    };
    const run: ActiveRun = {
      runId,
      sim,
      info,
      emitter: new EventEmitter(),
      timer: null,
      lastFrameAt: Date.now(),
      createdAt: info.createdAt,
      pendingDose: null,
    };
    this.runs.set(runId, run);

    const dir = path.join(ARCHIVE_ROOT, runId);
    mkdirSync(dir, { recursive: true });
    this.append(runId, {
      type: 'created',
      engineVersion: ENGINE_VERSION,
      at: info.createdAt,
      seed: sim.seed,
      inocula: sim.inocula,
      regimen: req.regimen ?? [],
      inoculaHash: sim.inoculaHash,
    });

    this.startLoop(run);
    return run;
  }

  get(runId: string): ActiveRun | undefined {
    return this.runs.get(runId);
  }

  /** 从档案完整重放（验证用：不进活动表，直接跑完返回指纹）。 */
  replay(runId: string): EcoFingerprint | null {
    const lines = this.getArchive(runId);
    if (!lines) return null;
    const created = lines.find((l) => l.type === 'created');
    if (!created) return null;
    const sim = new PetriSimulation(
      { seed: created.seed!, inocula: created.inocula!, regimen: created.regimen ?? [] },
      runId
    );
    // 重放操作者给药（预设方案已在 req 内）。
    // 实时运行中 applyDose 作用于「当前 sim.tick」的场，下一次 step 扩散并生效。
    // 因此重放时在 sim.tick 等于档案 tick 时、step 之前施加。
    const operatorDoses = lines.filter((l) => l.type === 'dose' && l.source === 'operator');
    const applyPending = () => {
      for (const d of operatorDoses) {
        if (d.tick === sim.tick) sim.applyDose(d.drug!, d.concentration!, 'operator');
      }
    };
    applyPending(); // tick=0 给药
    while (!sim.finished) {
      sim.step();
      applyPending(); // 到达该 tick 后施加（场被写入，下次 step 扩散生效）
    }
    return sim.fingerprint(SPECIMEN_META);
  }

  control(runId: string, cmd: RunControl) {
    const run = this.runs.get(runId);
    if (!run) throw new Error('运行不存在或已归档');
    const { sim } = run;

    switch (cmd.type) {
      case 'pause':
        run.info.status = 'paused';
        this.stopLoop(run);
        this.append(runId, { type: 'control', at: new Date().toISOString(), action: 'pause', tick: sim.tick });
        break;
      case 'resume':
        if (!sim.finished) {
          run.info.status = 'running';
          this.startLoop(run);
          this.append(runId, { type: 'control', at: new Date().toISOString(), action: 'resume', tick: sim.tick });
        }
        break;
      case 'setSpeed': {
        const speed = Math.max(0, Math.min(100, Math.round(cmd.speed)));
        run.info.speed = speed;
        if (speed === 0) {
          run.info.status = 'paused';
          this.stopLoop(run);
        } else if (run.info.status === 'paused') {
          run.info.status = 'running';
          this.startLoop(run);
        }
        this.append(runId, { type: 'control', at: new Date().toISOString(), action: 'setSpeed', speed, tick: sim.tick });
        break;
      }
      case 'dose':
        sim.applyDose(cmd.drug, cmd.concentration, 'operator');
        this.append(runId, {
          type: 'dose',
          at: new Date().toISOString(),
          tick: sim.tick,
          drug: cmd.drug,
          concentration: cmd.concentration,
          source: 'operator',
        });
        break;
      case 'restart': {
        // 用同一份清单与种子重新建舱（新 runId，新档案）
        const created = this.readCreated(runId);
        this.stopLoop(run);
        return this.create(created);
      }
    }
    return run;
  }

  private readCreated(runId: string): CreateRunRequest {
    const lines = this.getArchive(runId);
    const c = lines?.find((l) => l.type === 'created');
    if (!c || !c.seed || !c.inocula) throw new Error('档案缺少建舱记录');
    return { seed: c.seed, inocula: c.inocula, regimen: c.regimen ?? [] };
  }

  private startLoop(run: ActiveRun) {
    if (run.timer) return;
    run.lastFrameAt = Date.now();
    run.timer = setInterval(() => this.tickFrame(run), FRAME_MS);
    if (typeof run.timer.unref === 'function') run.timer.unref();
  }

  private stopLoop(run: ActiveRun) {
    if (run.timer) {
      clearInterval(run.timer);
      run.timer = null;
    }
  }

  private tickFrame(run: ActiveRun) {
    const { sim, info } = run;
    if (info.status !== 'running' || sim.finished) {
      if (sim.finished && info.status !== 'finished') {
        info.status = 'finished';
        this.finalize(run);
      }
      return;
    }

    const now = Date.now();
    const elapsedSec = Math.min(0.25, (now - run.lastFrameAt) / 1000); // 上限防止后台标签页爆冲
    run.lastFrameAt = now;
    const ticksToRun = Math.max(1, Math.round(elapsedSec * TICK_HZ * info.speed));

    for (let i = 0; i < ticksToRun && !sim.finished; i++) sim.step();

    info.tick = sim.tick;
    const snap = this.buildSnapshot(run);
    run.emitter.emit('snapshot', snap);

    // 周期性整状态存档
    if (sim.tick % 300 === 0 || sim.finished) {
      this.append(run.runId, {
        type: 'checkpoint',
        at: new Date().toISOString(),
        tick: sim.tick,
        counts: sim.getCounts(),
      });
    }
    if (sim.finished) {
      info.status = 'finished';
      this.finalize(run);
    }
  }

  private finalize(run: ActiveRun) {
    this.stopLoop(run);
    const fp = run.sim.fingerprint(SPECIMEN_META);
    run.fingerprint = fp;
    this.append(run.runId, {
      type: 'fingerprint',
      at: new Date().toISOString(),
      tick: run.sim.tick,
      fingerprint: fp,
    });
    run.finishedAt = new Date().toISOString();
    run.emitter.emit('finished', fp);
    // 终态再推一帧（含指纹）
    run.emitter.emit('snapshot', this.buildSnapshot(run));
  }

  private buildSnapshot(run: ActiveRun): Snapshot {
    const { sim, info } = run;
    return {
      runId: run.runId,
      tick: sim.tick,
      gen: Math.floor(sim.tick / TICKS_PER_GENERATION),
      simMinutes: sim.tick,
      status: info.status,
      speed: info.speed,
      counts: sim.getCounts(),
      cells: sim.snapshotCells(),
      virions: sim.snapshotVirions(),
      field: sim.sampleField(),
      events: sim.events,
      fingerprint: run.fingerprint,
    };
  }

  private append(runId: string, record: Record<string, unknown>) {
    const file = path.join(ARCHIVE_ROOT, runId, 'run.jsonl');
    appendFileSync(file, JSON.stringify(record) + '\n');
  }
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const RunManager = new RunManagerClass();
