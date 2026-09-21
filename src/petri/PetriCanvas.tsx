import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/petri';
import { PetriRenderer, LensInfo } from './PetriRenderer';
import { FpsMeter } from './timeSlice';

interface Props {
  snapshotRef: React.MutableRefObject<Snapshot | null>;
  showCarbon: boolean;
  showEdge: boolean;
  showFlagella: boolean;
  paused: boolean;
  onFocusChange?: (lens: LensInfo | null) => void;
  onFps?: (fps: number, quality: string) => void;
}

export function PetriCanvas({ snapshotRef, showCarbon, showEdge, showFlagella, paused, onFocusChange, onFps }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PetriRenderer | null>(null);
  const mouseRef = useRef<{ x: number; y: number; inside: boolean }>({ x: 0, y: 0, inside: false });
  const [size, setSize] = useState({ w: 0, h: 0 });

  // 渲染选项同步（不重建渲染器）
  const optsRef = useRef({ showCarbon, showEdge, showFlagella, paused });
  optsRef.current = { showCarbon, showEdge, showFlagella, paused };

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const renderer = new PetriRenderer(canvas);
    rendererRef.current = renderer;

    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      renderer.resize(rect.width, rect.height);
      setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(wrap);

    const fps = new FpsMeter();
    let raf = 0;
    let lastFocusId: number | null = null;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const snap = snapshotRef.current;
      const o = optsRef.current;
      renderer.options.showCarbon = o.showCarbon;
      renderer.options.showColonyEdge = o.showEdge;
      renderer.options.showFlagella = o.showFlagella;
      renderer.options.paused = o.paused;

      // 悬停镜头
      const m = mouseRef.current;
      if (m.inside && snap) {
        const w = renderer.screenToWorld(m.x, m.y);
        renderer.setLens(w.wx, w.wy, snap);
      } else {
        renderer.setLens(null, null, null);
      }

      if (snap) renderer.draw(snap);

      const f = fps.tick();
      onFps?.(f, renderer.quality);

      const fid = renderer.lens?.focus?.id ?? null;
      if (fid !== lastFocusId) {
        lastFocusId = fid;
        onFocusChange?.(renderer.lens);
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, inside: true };
  };
  const handleLeave = () => {
    mouseRef.current.inside = false;
  };

  return (
    <div ref={wrapRef} className="relative w-full h-full overflow-hidden rounded-2xl">
      <canvas
        ref={canvasRef}
        className="block cursor-crosshair"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      />
      {size.w > 0 && (
        <div className="absolute left-3 bottom-3 font-mono text-[10px] text-text-muted/70 pointer-events-none select-none">
          培养皿 · 世界坐标 [0,1] · {Math.round(size.w)}×{Math.round(size.h)}px
        </div>
      )}
    </div>
  );
}
