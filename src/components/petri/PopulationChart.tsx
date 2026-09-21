/**
 * 种群数量曲线 —— 手写 Canvas 折线，无图表库。
 * 数据全部来自服务端 ticks，前端只描点。
 */
import { useEffect, useRef } from 'react';
import type { TickCount } from '../../../shared/sim/types';

interface Props {
  ticks: TickCount[];
  position: number;
  totalTicks: number;
  extinctionTicks: Array<{ tick: number; speciesId: number }>;
  height?: number;
}

const LINES: Array<{ key: keyof Pick<TickCount, 'bacteria' | 'fungi' | 'virus' | 'archaea'>; color: string; label: string }> = [
  { key: 'bacteria', color: '#00ffc8', label: '细菌' },
  { key: 'fungi', color: '#b47cd4', label: '真菌' },
  { key: 'virus', color: '#ff6b5e', label: '病毒' },
  { key: 'archaea', color: '#f1c40f', label: '古菌' },
];

export function PopulationChart({ ticks, position, totalTicks, extinctionTicks, height = 150 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || ticks.length === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth;
    const cssH = height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const padL = 34;
    const padR = 8;
    const padT = 8;
    const padB = 18;
    const w = cssW - padL - padR;
    const h = cssH - padT - padB;

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#071d19';
    ctx.fillRect(0, 0, cssW, cssH);

    let maxPop = 10;
    for (const t of ticks) maxPop = Math.max(maxPop, t.total);
    const maxCarbon = Math.max(1, ticks[0].carbon);

    const xOf = (tick: number) => padL + (tick / Math.max(1, totalTicks)) * w;
    const yPop = (n: number) => padT + h - (n / maxPop) * h;

    // 网格
    ctx.strokeStyle = 'rgba(0,255,200,0.08)';
    ctx.fillStyle = 'rgba(143,181,175,0.7)';
    ctx.lineWidth = 1;
    ctx.font = '9px "JetBrains Mono", monospace';
    for (let g = 0; g <= 4; g++) {
      const y = padT + (h * g) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + w, y);
      ctx.stroke();
      const val = Math.round(maxPop * (1 - g / 4));
      ctx.fillText(String(val), 4, y + 3);
    }
    for (let g = 0; g <= 4; g++) {
      const x = padL + (w * g) / 4;
      ctx.fillText(String(Math.round((totalTicks * g) / 4)), x - 8, cssH - 5);
    }

    // 碳（虚线琥珀，右轴语义但按左轴比例画）
    ctx.strokeStyle = 'rgba(255,179,71,0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ticks.forEach((t, i) => {
      const x = xOf(t.tick);
      const y = padT + h - (t.carbon / maxCarbon) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // 四类
    for (const line of LINES) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ticks.forEach((t, i) => {
        const x = xOf(t.tick);
        const y = yPop(t[line.key]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // 灭绝标记
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (const e of extinctionTicks) {
      const x = xOf(e.tick);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x - 3, padT + 6);
      ctx.lineTo(x + 3, padT + 6);
      ctx.closePath();
      ctx.fill();
    }

    // 播放头
    const px = xOf(Math.min(position, totalTicks));
    ctx.strokeStyle = 'rgba(232,245,242,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, padT + h);
    ctx.stroke();
  }, [ticks, position, totalTicks, extinctionTicks, height]);

  return (
    <div>
      <canvas ref={ref} style={{ width: '100%', height, display: 'block', borderRadius: 8 }} />
      <div className="flex flex-wrap gap-3 mt-1 text-[10px] font-mono text-text-muted">
        {LINES.map((l) => (
          <span key={l.key} className="flex items-center gap-1">
            <span style={{ background: l.color }} className="inline-block w-2 h-2 rounded-full" />
            {l.label}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 border-t border-dashed border-glow-orange" />
          碳源
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-0 h-0 border-x-4 border-x-transparent border-b-[6px] border-b-white/60" />
          灭绝点
        </span>
      </div>
    </div>
  );
}
