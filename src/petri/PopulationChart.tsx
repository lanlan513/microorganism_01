import { useEffect, useRef } from 'react';
import type { PopulationCounts } from '../../shared/petri';

interface Point {
  tick: number;
  counts: PopulationCounts;
}

interface Props {
  historyRef: React.MutableRefObject<Point[]>;
  totalTicks: number;
}

const COLORS = {
  bacteria: '#00ffc8',
  fungi: '#c79bff',
  archaea: '#ffe66d',
  virus: '#ff8a7a',
};

/** 四类种群数量随模拟时间变化的堆叠折线（纯 Canvas 手绘）。 */
export function PopulationChart({ historyRef, totalTicks }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const pts = historyRef.current;
      const padL = 34;
      const padB = 16;
      const padT = 8;
      const plotW = w - padL - 6;
      const plotH = h - padB - padT;

      // 网格
      ctx.strokeStyle = 'rgba(0,255,200,0.08)';
      ctx.lineWidth = 1;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(143,181,175,0.7)';
      let maxV = 10;
      for (const p of pts) {
        maxV = Math.max(maxV, p.counts.bacteria, p.counts.fungi, p.counts.archaea, p.counts.virus);
      }
      const gridN = 3;
      for (let i = 0; i <= gridN; i++) {
        const y = padT + (plotH * i) / gridN;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - 6, y);
        ctx.stroke();
        const val = Math.round(maxV * (1 - i / gridN));
        ctx.fillText(String(val), 4, y + 3);
      }

      if (pts.length < 2) return;
      const xOf = (tick: number) => padL + (tick / totalTicks) * plotW;
      const yOf = (v: number) => padT + plotH - (v / maxV) * plotH;

      const series: { key: keyof typeof COLORS; get: (c: PopulationCounts) => number }[] = [
        { key: 'bacteria', get: (c) => c.bacteria },
        { key: 'fungi', get: (c) => c.fungi },
        { key: 'archaea', get: (c) => c.archaea },
        { key: 'virus', get: (c) => c.virus },
      ];

      for (const s of series) {
        ctx.strokeStyle = COLORS[s.key];
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        pts.forEach((p, i) => {
          const x = xOf(p.tick);
          const y = yOf(s.get(p.counts));
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [historyRef, totalTicks]);

  return (
    <div className="w-full">
      <canvas ref={ref} className="w-full h-28 block" />
      <div className="flex gap-3 justify-center text-[10px] font-mono mt-1">
        {(Object.keys(COLORS) as (keyof typeof COLORS)[]).map((k) => (
          <span key={k} className="flex items-center gap-1 text-text-muted">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: COLORS[k] }} />
            {k === 'bacteria' ? '细菌' : k === 'fungi' ? '真菌' : k === 'archaea' ? '古菌' : '病毒粒子'}
          </span>
        ))}
      </div>
    </div>
  );
}
