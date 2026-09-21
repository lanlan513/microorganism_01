import { useEffect, useMemo, useState } from 'react';
import { petriApi, type CatalogEntryView, type RunInfo } from '../utils/petriApi';
import { Inoculator } from '../components/petri/Inoculator';
import { DishCanvas } from '../components/petri/DishCanvas';
import { PopulationChart } from '../components/petri/PopulationChart';
import { FingerprintPanel } from '../components/petri/FingerprintPanel';
import { usePetriPlayer, BASE_FPS } from '../components/petri/usePetriPlayer';
import type { InoculumItem, TickCount } from '../../shared/sim/types';
import { Play, Pause, FlaskConical, Gauge } from 'lucide-react';

const SPEEDS = [1, 2, 5, 10, 25, 50, 100];

export function IncubatorPage() {
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [run, setRun] = useState<RunInfo | null>(null);
  const [ticks, setTicks] = useState<TickCount[]>([]);
  const [extinctions, setExtinctions] = useState<Array<{ tick: number; speciesId: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    petriApi.catalog().then(setCatalog).catch((e) => setErr(e.message));
  }, []);

  const create = async (seed: string, inoculum: InoculumItem[], name: string) => {
    setBusy(true);
    setErr(null);
    try {
      const info = await petriApi.createRun({ seed: seed || '0', inoculum, name });
      const [t, journal] = await Promise.all([
        petriApi.getTicks(info.runId),
        petriApi.getJournal(info.runId),
      ]);
      setRun(info);
      setTicks(t);
      setExtinctions(
        journal
          .flatMap((j) =>
            j.events
              .filter((e) => e.type === 'extinction' && e.speciesId !== undefined)
              .map((e) => ({ tick: j.tick, speciesId: e.speciesId! }))
          )
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container mx-auto px-4 md:px-6 pt-28 pb-16">
      <header className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <FlaskConical className="w-7 h-7 text-glow-primary" />
          <h1 className="font-display text-3xl md:text-4xl text-text-light">活体培养皿</h1>
        </div>
        <p className="text-sm text-text-muted max-w-3xl">
          把馆内任意标本接种进同一枚培养皿，观察它们按真实生态规律分裂、争夺碳源、被抗菌素压制、完成优势种更替。
          所有推进都在服务器按固定时间步确定性执行，逐代写入科考档案；同一份接种清单与种子，任何时刻重放都逐格一致。
          把鼠标移入皿中，可在 4 倍显微镜视野里看清单个细胞的状态。
        </p>
      </header>

      {err && (
        <div className="mb-4 rounded-lg border border-glow-red/40 bg-glow-red/10 text-glow-red text-xs px-4 py-2">
          {err}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">
        <div className="space-y-6">
          <Inoculator catalog={catalog} onCreate={create} busy={busy} />
          {run && <FingerprintPanel run={run} />}
        </div>

        <div className="space-y-4">
          {!run ? (
            <EmptyDish />
          ) : (
            <DishWorkspace run={run} ticks={ticks} extinctions={extinctions} />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyDish() {
  return (
    <div className="glass-card min-h-[480px] flex flex-col items-center justify-center text-center p-10">
      <div className="w-24 h-24 rounded-full border border-glow-primary/25 flex items-center justify-center mb-4 animate-pulse-glow">
        <FlaskConical className="w-10 h-10 text-glow-primary/70" />
      </div>
      <p className="text-text-muted text-sm">培养皿尚未接种</p>
      <p className="text-text-muted/60 text-xs mt-1">从左侧选择标本，或直接点一个预设组合</p>
    </div>
  );
}

function DishWorkspace({
  run,
  ticks,
  extinctions,
}: {
  run: RunInfo;
  ticks: TickCount[];
  extinctions: Array<{ tick: number; speciesId: number }>;
}) {
  const player = usePetriPlayer(run.runId, run.totalTicks);

  useEffect(() => {
    void player.loadChunk(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.runId]);

  const currentCount = useMemo(() => {
    const i = Math.min(ticks.length - 1, Math.floor(player.position));
    return ticks[i];
  }, [ticks, player.position]);

  const generation = Math.floor(player.position);

  return (
    <div className="space-y-4">
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <div className="text-text-light text-sm">{run.name}</div>
            <div className="text-[10px] font-mono text-text-muted">
              {run.runId} · seed {run.seed}
            </div>
          </div>
          <CurrentCounts rec={currentCount} />
        </div>

        <DishCanvas player={player} species={run.species} />

        {/* 时间控制 */}
        <div className="mt-4 space-y-2">
          <input
            type="range"
            min={0}
            max={run.totalTicks}
            value={generation}
            onChange={(e) => player.seek(Number(e.target.value))}
            className="w-full accent-[#00ffc8]"
          />
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={player.togglePlay}
              className="w-9 h-9 rounded-full border border-glow-primary/50 text-glow-primary bg-glow-primary/10 hover:bg-glow-primary/20 flex items-center justify-center"
              aria-label={player.playing ? '暂停' : '播放'}
            >
              {player.playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>
            <span className="font-mono text-xs text-text-light w-24">
              第 {generation} / {run.totalTicks} 代
            </span>
            <div className="flex items-center gap-1 text-[10px] font-mono text-text-muted">
              <Gauge className="w-3.5 h-3.5" />
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => player.changeSpeed(s)}
                  className={`px-2 py-1 rounded-full border transition ${
                    player.speed === s
                      ? 'text-glow-primary border-glow-primary/60 bg-glow-primary/10'
                      : 'border-white/10 hover:text-text-light'
                  }`}
                >
                  {s}×
                </button>
              ))}
            </div>
            <span className="text-[10px] text-text-muted ml-auto font-mono">
              基准 {BASE_FPS} 代/秒{player.loading ? ' · 取帧中…' : ''}
            </span>
          </div>
        </div>
      </div>

      <div className="glass-card p-4">
        <h3 className="text-sm text-text-light mb-2">种群序列（服务端权威计数）</h3>
        <PopulationChart
          ticks={ticks}
          position={player.position}
          totalTicks={run.totalTicks}
          extinctionTicks={extinctions}
        />
      </div>

      <SpeciesLegend run={run} />
    </div>
  );
}

function CurrentCounts({ rec }: { rec?: TickCount }) {
  if (!rec) return null;
  const items: Array<[string, number, string]> = [
    ['细菌', rec.bacteria, 'text-glow-primary'],
    ['真菌', rec.fungi, 'text-glow-purple'],
    ['病毒', rec.virus, 'text-glow-red'],
    ['古菌', rec.archaea, 'text-glow-gold'],
  ];
  return (
    <div className="flex gap-3 font-mono text-xs">
      {items.map(([label, n, cls]) => (
        <span key={label} className="flex flex-col items-end">
          <span className={`text-base ${cls}`}>{n}</span>
          <span className="text-[9px] text-text-muted">{label}</span>
        </span>
      ))}
    </div>
  );
}

function SpeciesLegend({ run }: { run: RunInfo }) {
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm text-text-light mb-2">接种物种 · 本皿实际性状</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {run.species.map((s) => (
          <div key={s.microbeId} className="text-[11px] font-mono bg-white/[0.02] rounded-lg px-3 py-2">
            <div className="text-text-light">
              {s.name} <span className="italic text-text-muted">{s.scientificName}</span>
            </div>
            <div className="text-text-muted mt-0.5 flex flex-wrap gap-x-3">
              <span>摄取 {s.traits.uptakeRate}</span>
              <span>转化 {s.traits.yieldEfficiency}</span>
              <span>维持 {s.traits.maintenance}</span>
              <span>运动 {s.traits.motility}</span>
              <span>耐抗 {s.traits.antibioticTolerance}</span>
              {s.traits.antibioticProduction > 0 && <span className="text-glow-purple">产抗 {s.traits.antibioticProduction}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
