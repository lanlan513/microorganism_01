import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Gauge,
  Syringe,
  Microscope,
  Fingerprint as FingerprintIcon,
  Archive,
  RotateCcw,
  Leaf,
  Sparkles,
  X,
} from 'lucide-react';
import type { Microbe } from '../../shared/types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../../shared/types';
import type {
  AntibioticId,
  ArchiveListItem,
  EcoFingerprint,
  InoculumItem,
  Snapshot,
} from '../../shared/petri';
import { ANTIBIOTIC_COLORS, ANTIBIOTIC_LABELS, ANTIBIOTIC_MECHANISM, TOTAL_TICKS } from './petri-constants';
import { petriApi } from './api';
import { InoculumPicker } from './InoculumPicker';
import { PetriCanvas } from './PetriCanvas';
import { PopulationChart } from './PopulationChart';
import { LensInfo } from './PetriRenderer';
import { renderSpecimen } from './specimens-render';

const SPEEDS = [1, 2, 5, 10, 25, 50, 100];
const DOSE_CONCENTRATIONS = [0.5, 1, 2, 4];

interface ChartPoint {
  tick: number;
  counts: Snapshot['counts'];
}

export function PetriDishPage({ specimens }: { specimens: Microbe[] }) {
  const [selected, setSelected] = useState<Map<number, number>>(new Map());
  const [seed, setSeed] = useState('expedition-007');
  const [runId, setRunId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [showCarbon, setShowCarbon] = useState(true);
  const [showEdge, setShowEdge] = useState(true);
  const [showFlagella, setShowFlagella] = useState(true);
  const [lens, setLens] = useState<LensInfo | null>(null);
  const [fps, setFps] = useState(60);
  const [quality, setQuality] = useState('high');
  const [fingerprint, setFingerprint] = useState<EcoFingerprint | null>(null);
  const [archives, setArchives] = useState<ArchiveListItem[]>([]);
  const [showArchives, setShowArchives] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const snapshotRef = useRef<Snapshot | null>(null);
  const historyRef = useRef<ChartPoint[]>([]);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const lastChartTick = useRef(-1);

  useEffect(() => {
    petriApi.listArchives().then(setArchives).catch(() => undefined);
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  const handleSnapshot = useCallback((snap: Snapshot) => {
    snapshotRef.current = snap;
    setSnapshot(snap);
    setPaused(snap.status === 'paused');
    setSpeed(snap.speed);
    // 曲线降采样：每 6 tick 记一个点
    if (snap.tick - lastChartTick.current >= 6 || snap.tick === 0) {
      lastChartTick.current = snap.tick;
      historyRef.current.push({ tick: snap.tick, counts: snap.counts });
      if (historyRef.current.length > 400) historyRef.current.shift();
    }
    if (snap.fingerprint) setFingerprint(snap.fingerprint);
  }, []);

  const startRun = async (inoculaOverride?: InoculumItem[], seedOverride?: string) => {
    const inocula = inoculaOverride ?? [...selected.entries()].map(([specimenId, count]) => ({ specimenId, count }));
    if (inocula.length === 0) {
      flash('请至少接种一种标本');
      return;
    }
    setBusy(true);
    try {
      unsubscribeRef.current?.();
      historyRef.current = [];
      lastChartTick.current = -1;
      setFingerprint(null);
      const { runId: id } = await petriApi.createRun({
        inocula,
        seed: seedOverride ?? seed,
      });
      setRunId(id);
      unsubscribeRef.current = petriApi.subscribe(id, { onSnapshot: handleSnapshot });
      petriApi.listArchives().then(setArchives).catch(() => undefined);
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => unsubscribeRef.current?.(), []);

  const sendControl = async (cmd: Parameters<typeof petriApi.control>[1]) => {
    if (!runId) return;
    try {
      const r = await petriApi.control(runId, cmd);
      if (cmd.type === 'restart' && r.restarted && r.runId) {
        unsubscribeRef.current?.();
        historyRef.current = [];
        lastChartTick.current = -1;
        setFingerprint(null);
        setRunId(r.runId);
        unsubscribeRef.current = petriApi.subscribe(r.runId, { onSnapshot: handleSnapshot });
      }
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const dose = async (drug: AntibioticId, concentration: number) => {
    await sendControl({ type: 'dose', drug, concentration });
    flash(`已施加 ${ANTIBIOTIC_LABELS[drug]} ${concentration} MIC（已留痕）`);
  };

  const quickPreset = (kind: 'competition' | 'phage' | 'extremes' | 'stress') => {
    const presets: Record<string, [number, number][]> = {
      competition: [[1, 60], [2, 40], [3, 30], [4, 20], [9, 20]],
      phage: [[1, 80], [2, 30], [15, 15]],
      extremes: [[21, 20], [24, 20], [9, 20], [6, 20]],
      stress: [[2, 60], [1, 40], [4, 30]],
    };
    const next = new Map<number, number>();
    for (const [id, count] of presets[kind]) next.set(id, count);
    setSelected(next);
  };

  const totalCells = snapshot?.counts.totalCells ?? 0;
  const counts = snapshot?.counts;
  const ratio = (n: number) => {
    const denom = (counts?.totalCells ?? 0) + (counts?.virions ?? 0);
    return denom ? ((n / denom) * 100).toFixed(1) : '0.0';
  };

  return (
    <div className="min-h-screen pt-24 pb-12 px-4 md:px-6">
      <div className="max-w-[1500px] mx-auto">
        {/* 标题 */}
        <div className="mb-5 flex items-end justify-between flex-wrap gap-3">
          <div>
            <div className="font-mono text-[11px] tracking-[0.3em] uppercase text-glow-primary mb-1 flex items-center gap-2">
              <Microscope className="w-3.5 h-3.5" /> Living Collection · 活体培养
            </div>
            <h1 className="font-display text-4xl font-bold text-text-light">培养皿科考站</h1>
            <p className="text-text-muted text-sm mt-1 font-mono">
              模拟权威在服务端 · 浏览器只绘制与播放 · 每一步均写入存档
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary-ghost" onClick={() => setShowArchives(true)}>
              <Archive className="w-4 h-4" /> 科考档案
            </button>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* 左：接种配置 */}
          <div className="col-span-12 lg:col-span-3 glass-card p-4 h-[70vh] lg:h-[calc(100vh-180px)] flex flex-col">
            {!runId ? (
              <>
                <InoculumPicker specimens={specimens} selected={selected} onChange={setSelected} />
                <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
                  <div className="flex gap-1 flex-wrap">
                    {[
                      ['competition', '菌群竞争'],
                      ['phage', '噬菌体捕食'],
                      ['extremes', '极端古菌'],
                      ['stress', '耐药压力'],
                    ].map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => quickPreset(k as never)}
                        className="px-2 py-0.5 rounded-full text-[10px] font-mono border border-white/10 text-text-muted hover:text-glow-primary hover:border-glow-primary/40"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="block text-[11px] text-text-muted font-mono">种子（决定全部随机）</label>
                  <input
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-background-deep/70 border border-glow-primary/15 text-sm font-mono text-text-light focus:outline-none focus:border-glow-primary/50"
                  />
                  <button
                    onClick={() => startRun()}
                    disabled={busy}
                    className="btn-primary w-full disabled:opacity-50"
                  >
                    <Sparkles className="w-4 h-4" /> {busy ? '建舱中…' : '接种并开始培养'}
                  </button>
                  <p className="text-[10px] text-text-muted/70 font-mono leading-relaxed">
                    同一接种清单 + 同一颗种子，任何一次运行都产生逐格完全相同的种群数量序列与生态指纹。
                  </p>
                </div>
              </>
            ) : (
              <div className="flex flex-col h-full">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-display text-lg text-text-light flex items-center gap-2">
                    <Leaf className="w-4 h-4 text-glow-primary" /> 培养中
                  </h3>
                  <button
                    onClick={() => {
                      unsubscribeRef.current?.();
                      setRunId(null);
                      setSnapshot(null);
                      setFingerprint(null);
                    }}
                    className="text-text-muted hover:text-glow-primary text-xs font-mono"
                  >
                    换新培养皿
                  </button>
                </div>

                {/* 时间控制 */}
                <div className="rounded-xl bg-background-deep/60 border border-white/5 p-3 mb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      onClick={() => sendControl({ type: paused ? 'resume' : 'pause' })}
                      className="w-9 h-9 rounded-full border border-glow-primary/40 text-glow-primary hover:bg-glow-primary/10 flex items-center justify-center"
                    >
                      {paused ? <Play className="w-4 h-4 ml-0.5" /> : <Pause className="w-4 h-4" />}
                    </button>
                    <div className="flex-1">
                      <div className="flex justify-between text-[10px] font-mono text-text-muted mb-0.5">
                        <span>模拟时间</span>
                        <span>{formatMin(snapshot?.simMinutes ?? 0)} / 30:00</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-background-card overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-glow-primary to-glow-purple transition-all"
                          style={{ width: `${((snapshot?.tick ?? 0) / TOTAL_TICKS) * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    <Gauge className="w-3.5 h-3.5 text-text-muted mr-1" />
                    {SPEEDS.map((s) => (
                      <button
                        key={s}
                        onClick={() => sendControl({ type: 'setSpeed', speed: s })}
                        className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
                          speed === s && !paused
                            ? 'border-glow-primary/60 text-glow-primary bg-glow-primary/10'
                            : 'border-white/10 text-text-muted hover:text-text-light'
                        }`}
                      >
                        {s}×
                      </button>
                    ))}
                    <button
                      onClick={() => sendControl({ type: 'restart' })}
                      className="ml-auto px-2 py-0.5 rounded text-[11px] font-mono border border-white/10 text-text-muted hover:text-glow-gold"
                      title="用同清单同种子重新建舱"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* 抗菌素施加 */}
                <div className="rounded-xl bg-background-deep/60 border border-white/5 p-3 mb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Syringe className="w-3.5 h-3.5 text-glow-orange" />
                    <span className="text-xs font-mono text-text-light">抗菌素干预</span>
                  </div>
                  {(Object.keys(ANTIBIOTIC_LABELS) as AntibioticId[]).map((drug) => (
                    <div key={drug} className="mb-2 last:mb-0">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="w-2 h-2 rounded-full" style={{ background: ANTIBIOTIC_COLORS[drug] }} />
                        <span className="text-[11px] text-text-light font-mono flex-1">{ANTIBIOTIC_LABELS[drug]}</span>
                      </div>
                      <div className="flex gap-1">
                        {DOSE_CONCENTRATIONS.map((c) => (
                          <button
                            key={c}
                            onClick={() => dose(drug, c)}
                            className="flex-1 py-0.5 rounded text-[10px] font-mono border border-white/10 text-text-muted hover:text-white hover:border-white/30"
                            style={{ borderColor: undefined }}
                            title={ANTIBIOTIC_MECHANISM[drug]}
                          >
                            {c} MIC
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* 显示开关 */}
                <div className="rounded-xl bg-background-deep/60 border border-white/5 p-3 mb-3 space-y-1.5">
                  {[
                    ['碳源场', showCarbon, setShowCarbon] as const,
                    ['菌落边缘', showEdge, setShowEdge] as const,
                    ['鞭毛', showFlagella, setShowFlagella] as const,
                  ].map(([label, val, setter]) => (
                    <label key={label} className="flex items-center gap-2 text-[11px] font-mono text-text-muted cursor-pointer">
                      <input type="checkbox" checked={val} onChange={(e) => setter(e.target.checked)} className="accent-[#00ffc8]" />
                      {label}
                    </label>
                  ))}
                  <div className="text-[10px] font-mono text-text-muted/70 pt-1 border-t border-white/5">
                    渲染 {fps} fps · 画质 {quality === 'high' ? '高' : quality === 'medium' ? '中（自适应）' : '性能（自适应）'} · 同屏 {totalCells} 细胞
                  </div>
                </div>

                {/* 曲线 */}
                <div className="rounded-xl bg-background-deep/60 border border-white/5 p-2 flex-1 min-h-0">
                  <PopulationChart historyRef={historyRef} totalTicks={TOTAL_TICKS} />
                </div>
              </div>
            )}
          </div>

          {/* 中：画布 */}
          <div className="col-span-12 lg:col-span-6">
            <div className="glass-card p-2 h-[58vh] lg:h-[calc(100vh-180px)]">
              <PetriCanvas
                snapshotRef={snapshotRef}
                showCarbon={showCarbon}
                showEdge={showEdge}
                showFlagella={showFlagella}
                paused={paused}
                onFocusChange={setLens}
                onFps={(f, q) => {
                  setFps(f);
                  setQuality(q);
                }}
              />
            </div>
            {/* 事件流 */}
            {snapshot && snapshot.events.length > 0 && (
              <div className="mt-2 space-y-1">
                {snapshot.events.map((e, i) => (
                  <div
                    key={i}
                    className={`text-[11px] font-mono px-3 py-1 rounded-lg border ${
                      e.kind === 'extinction'
                        ? 'border-glow-red/30 text-glow-red bg-glow-red/5'
                        : e.kind === 'dose'
                          ? 'border-glow-orange/30 text-glow-orange bg-glow-orange/5'
                          : 'border-glow-primary/30 text-glow-primary bg-glow-primary/5'
                    }`}
                  >
                    t={e.tick} ·{' '}
                    {e.kind === 'extinction'
                      ? `灭绝事件：${specimens.find((s) => s.id === e.specimenId)?.name ?? `标本#${e.specimenId}`}`
                      : e.kind === 'dose'
                        ? `施加 ${ANTIBIOTIC_LABELS[e.drug]} ${e.concentration} MIC（${e.source === 'regimen' ? '预设方案' : '操作者'}）`
                        : '培养结束，生态指纹已封存'}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 右：读数 / 显微镜 / 指纹 */}
          <div className="col-span-12 lg:col-span-3 space-y-4">
            {/* 种群四分类 */}
            <div className="glass-card p-4">
              <h3 className="font-display text-lg text-text-light mb-3">实时种群</h3>
              {(['bacteria', 'fungi', 'archaea', 'virus'] as const).map((cat) => {
                const n = cat === 'virus' ? counts?.virions ?? 0 : counts?.[cat] ?? 0;
                return (
                  <div key={cat} className="mb-2 last:mb-0">
                    <div className="flex justify-between text-[11px] font-mono mb-0.5">
                      <span className="text-text-muted">{CATEGORY_LABELS[cat]}</span>
                      <span className="text-text-light">
                        {n} <span className="text-text-muted">({ratio(n)}%)</span>
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-background-deep overflow-hidden">
                      <div
                        className="h-full transition-all duration-200"
                        style={{ width: `${ratio(n)}%`, background: CATEGORY_COLORS[cat] }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 显微镜下单细胞读数 */}
            <div className="glass-card p-4">
              <h3 className="font-display text-lg text-text-light mb-2 flex items-center gap-2">
                <Microscope className="w-4 h-4 text-glow-primary" /> 镜下细胞
              </h3>
              {lens?.focus ? (
                <CellReadout focus={lens.focus} specimens={specimens} />
              ) : (
                <p className="text-[11px] text-text-muted font-mono leading-relaxed">
                  将鼠标悬停在培养皿上，出现显微镜圆形视野；对准单个细胞可读取它当前的质量、朝向、运动与受胁迫状态。
                </p>
              )}
            </div>

            {/* 生态指纹 */}
            <div className="glass-card p-4">
              <h3 className="font-display text-lg text-text-light mb-2 flex items-center gap-2">
                <FingerprintIcon className="w-4 h-4 text-glow-purple" /> 生态指纹
              </h3>
              {fingerprint ? (
                <FingerprintCard fp={fingerprint} specimens={specimens} />
              ) : (
                <p className="text-[11px] text-text-muted font-mono">
                  培养结束（30 模拟小时）后封存指纹：含各采样代细胞数、四类占比、最终优势种与灭绝顺序，并对逐格数量序列做 SHA-256。
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 glass-card px-5 py-2.5 text-sm font-mono text-glow-primary animate-fade-in-up">
          {toast}
        </div>
      )}

      {/* 档案抽屉 */}
      {showArchives && <ArchivesDrawer onClose={() => setShowArchives(false)} archives={archives} />}
    </div>
  );
}

function CellReadout({
  focus,
  specimens,
}: {
  focus: NonNullable<LensInfo>['focus'];
  specimens: Microbe[];
}) {
  if (!focus) return null;
  const m = specimens.find((s) => s.id === focus.cell.sp);
  const spec = renderSpecimen(focus.cell.sp);
  const state =
    focus.cell.st === 1
      ? { label: '潜伏感染（即将裂解）', color: '#ff8a7a' }
      : focus.cell.st === 2
        ? { label: '抗生素胁迫：生长受抑', color: '#ff9f43' }
        : focus.cell.m / focus.cell.m0 >= 0.95
          ? { label: '成熟，即将二分裂', color: '#00ffc8' }
          : { label: '营养生长中', color: '#5fffe0' };
  return (
    <div className="space-y-1.5 text-[11px] font-mono">
      <div className="text-text-light text-sm">{m?.name}</div>
      <div className="text-text-muted italic">{m?.scientificName}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1">
        <span className="text-text-muted">细胞 id</span>
        <span className="text-text-light text-right">#{focus.cell.id}</span>
        <span className="text-text-muted">生物量</span>
        <span className="text-text-light text-right">{focus.cell.m.toFixed(3)} / {focus.cell.m0.toFixed(2)}</span>
        <span className="text-text-muted">朝向</span>
        <span className="text-text-light text-right">{Math.round((focus.cell.h * 180) / Math.PI)}°</span>
        <span className="text-text-muted">形态</span>
        <span className="text-text-light text-right">{spec.shape}</span>
        <span className="text-text-muted">到视野中心</span>
        <span className="text-text-light text-right">{(focus.worldDist * 1000).toFixed(1)}‰</span>
      </div>
      <div className="mt-1 px-2 py-1 rounded border text-center" style={{ borderColor: state.color + '55', color: state.color }}>
        {state.label}
      </div>
    </div>
  );
}

function FingerprintCard({ fp, specimens }: { fp: EcoFingerprint; specimens: Microbe[] }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(fp.digest);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const last = fp.series[fp.series.length - 1];
  return (
    <div className="space-y-2.5 text-[11px] font-mono">
      <div>
        <div className="text-text-muted mb-0.5">指纹摘要（点击复制）</div>
        <button
          onClick={copy}
          className="w-full text-left px-2 py-1.5 rounded-lg border border-glow-purple/30 bg-glow-purple/5 text-glow-purple break-all hover:bg-glow-purple/10"
        >
          {copied ? '已复制 ✓' : fp.digest}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-background-deep/60 p-2">
          <div className="text-text-muted text-[10px]">最终优势种</div>
          <div className="text-glow-primary text-[12px] mt-0.5">
            {fp.finalDominant ? specimens.find((s) => s.id === fp.finalDominant!.specimenId)?.name : '无活细胞'}
          </div>
          {fp.finalDominant && <div className="text-text-muted text-[10px]">×{fp.finalDominant.count}</div>}
        </div>
        <div className="rounded-lg bg-background-deep/60 p-2">
          <div className="text-text-muted text-[10px]">终态细胞 / 粒子</div>
          <div className="text-text-light text-[12px] mt-0.5">
            {last.counts.totalCells} / {last.counts.virions}
          </div>
        </div>
      </div>
      <div>
        <div className="text-text-muted text-[10px] mb-1">灭绝顺序</div>
        {fp.extinctionOrder.length === 0 ? (
          <div className="text-text-muted/70">全部存活至终点</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {fp.extinctionOrder.map((e) => (
              <span key={e.specimenId} className="px-1.5 py-0.5 rounded border border-glow-red/25 text-glow-red text-[10px]">
                {specimens.find((s) => s.id === e.specimenId)?.name ?? e.name}
                <span className="text-text-muted/70"> @{e.tick}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <details className="group">
        <summary className="cursor-pointer text-text-muted hover:text-text-light list-none flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform inline-block">▸</span> 各采样代序列（第 N 代）
        </summary>
        <div className="mt-1 max-h-40 overflow-y-auto petri-scroll rounded-lg bg-background-deep/60 p-1.5">
          {fp.series.map((s) => (
            <div key={s.gen} className="flex items-center gap-1 py-0.5 text-[10px]">
              <span className="text-text-muted w-10">G{s.gen}</span>
              <span className="text-text-light w-12">n={s.counts.totalCells}</span>
              <span className="w-8" style={{ color: CATEGORY_COLORS.bacteria }}>{Math.round(s.ratios.bacteria * 100)}%</span>
              <span className="w-8" style={{ color: CATEGORY_COLORS.fungi }}>{Math.round(s.ratios.fungi * 100)}%</span>
              <span className="w-8" style={{ color: CATEGORY_COLORS.archaea }}>{Math.round(s.ratios.archaea * 100)}%</span>
              <span className="w-8" style={{ color: CATEGORY_COLORS.virus }}>{Math.round(s.ratios.virus * 100)}%</span>
            </div>
          ))}
        </div>
      </details>
      <div className="text-text-muted/60 text-[10px] break-all">countsDigest: {fp.countsDigest.slice(0, 32)}…</div>
    </div>
  );
}

function ArchivesDrawer({ onClose, archives }: { onClose: () => void; archives: ArchiveListItem[] }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-background-deep/70 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-md h-full glass-card rounded-none border-l border-glow-primary/20 p-5 overflow-y-auto petri-scroll"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-2xl text-text-light flex items-center gap-2">
            <Archive className="w-5 h-5 text-glow-primary" /> 科考档案
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-light">
            <X className="w-5 h-5" />
          </button>
        </div>
        {archives.length === 0 && <p className="text-text-muted font-mono text-sm">还没有任何培养记录。</p>}
        <div className="space-y-2">
          {archives.map((a) => (
            <div key={a.runId} className="rounded-xl border border-white/10 bg-background-deep/50 p-3 font-mono">
              <div className="text-glow-primary text-xs break-all">{a.runId}</div>
              <div className="text-[10px] text-text-muted mt-1">{a.createdAt}</div>
              <div className="text-[11px] text-text-light mt-1">
                接种 {a.inocula.length} 种 · 种子 {a.seed} · t={a.tick}
              </div>
              <div className="flex gap-1 mt-1 flex-wrap">
                {a.inocula.slice(0, 6).map((it) => (
                  <span key={it.specimenId} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-text-muted">
                    #{it.specimenId}×{it.count}
                  </span>
                ))}
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className={`text-[10px] ${a.status === 'finished' ? 'text-glow-primary' : 'text-glow-gold'}`}>
                  {a.status === 'finished' ? '已封存' : '进行中'}
                </span>
                {a.digest && <span className="text-[10px] text-glow-purple/80 break-all text-right flex-1 ml-2">{a.digest.slice(0, 18)}…</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
