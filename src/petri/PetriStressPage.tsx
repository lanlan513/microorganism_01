import { useRef, useState } from 'react';
import { PetriCanvas } from './PetriCanvas';
import { buildStressSnapshot } from './stressSnapshot';
import type { Snapshot } from '../../shared/petri';

/** /petri/stress —— 1000 细胞渲染帧率验收页（纯前端合成负载，不连服务端）。 */
export function PetriStressPage() {
  const ref = useRef<Snapshot | null>(buildStressSnapshot(1000, 200));
  const [fps, setFps] = useState(60);
  const [quality, setQuality] = useState('high');
  const [n, setN] = useState(1000);

  const rebuild = (count: number) => {
    setN(count);
    ref.current = buildStressSnapshot(count, Math.round(count * 0.2));
  };

  return (
    <div className="min-h-screen pt-24 pb-12 px-6">
      <div className="max-w-[1300px] mx-auto">
        <h1 className="font-display text-3xl text-text-light mb-1">渲染帧率验收</h1>
        <p className="text-text-muted font-mono text-xs mb-4">
          合成 {n} 细胞 + {Math.round(n * 0.2)} 病毒粒子，走与正式页面完全相同的 Canvas 绘制路径（DPR 缩放、精灵批绘、菌落边缘、鞭毛、显微镜镜头）。
        </p>
        <div className="flex gap-2 mb-3">
          {[500, 1000, 1500, 2000].map((c) => (
            <button
              key={c}
              onClick={() => rebuild(c)}
              className={`px-3 py-1 rounded-full font-mono text-xs border ${
                n === c ? 'border-glow-primary text-glow-primary bg-glow-primary/10' : 'border-white/10 text-text-muted'
              }`}
            >
              {c} 细胞
            </button>
          ))}
        </div>
        <div className="glass-card p-2 h-[72vh]">
          <PetriCanvas
            snapshotRef={ref}
            showCarbon
            showEdge
            showFlagella
            paused={false}
            onFps={(f, q) => {
              setFps(f);
              setQuality(q);
            }}
          />
        </div>
        <div className="mt-3 flex items-center gap-6 font-mono">
          <div className={`text-3xl font-bold ${fps >= 55 ? 'text-glow-primary' : fps >= 30 ? 'text-glow-gold' : 'text-glow-red'}`}>
            {fps} <span className="text-base text-text-muted">FPS</span>
          </div>
          <div className="text-sm text-text-muted">
            自适应画质：{quality === 'high' ? '高' : quality === 'medium' ? '中' : '性能'} · 目标 60FPS @1000 细胞
          </div>
          <div className={`text-sm ${fps >= 55 ? 'text-glow-primary' : 'text-glow-red'}`}>
            {fps >= 55 ? '✅ 达标' : '⚠️ 未达标（已自动降级）'}
          </div>
        </div>
      </div>
    </div>
  );
}
