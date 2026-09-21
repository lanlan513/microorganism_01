/**
 * 培养皿画布：承载 DishRenderer，负责 DPR、rAF 重绘、悬停拾取与镜头读数。
 * 绘制节奏与播放解耦 —— 每帧从 usePetriPlayer 取当前插值帧。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DishRenderer } from './dishRenderer';
import type { usePetriPlayer } from './usePetriPlayer';
import type { RunSpeciesInfo } from '../../../shared/sim/types';
import type { CodecCell } from '../../../shared/sim/codec';

interface Props {
  player: ReturnType<typeof usePetriPlayer>;
  species: RunSpeciesInfo[];
}

const STATE_LABEL = ['活跃', '感染中', '游离颗粒'];

export function DishCanvas({ player, species }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<DishRenderer | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<CodecCell | null>(null);
  const [edgeOn, setEdgeOn] = useState(true);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);

  const categoryById = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of species) m.set(s.microbeId, { bacteria: 0, fungi: 1, virus: 2, archaea: 3 }[s.category]);
    return m;
  }, [species]);

  const speciesById = useMemo(() => {
    const m = new Map<number, RunSpeciesInfo>();
    for (const s of species) m.set(s.microbeId, s);
    return m;
  }, [species]);

  // 初始化与 DPR 尺寸
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const renderer = new DishRenderer(canvas);
    rendererRef.current = renderer;

    const apply = () => {
      const size = Math.min(wrap.clientWidth, 640);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      renderer.resize(size, dpr);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // rAF 重绘：单条持久循环，最新插值帧/悬停点经 ref 读取，避免每帧重建循环
  const rf = player.renderedFrame;
  const frameRef = useRef(rf);
  frameRef.current = rf;
  const edgeRef = useRef(edgeOn);
  edgeRef.current = edgeOn;
  const catRef = useRef(categoryById);
  catRef.current = categoryById;
  const posRef = useRef(player.position);
  posRef.current = player.position;
  const lenRef = useRef(player.frames.length);
  lenRef.current = player.frames.length;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const renderer = rendererRef.current;
      const cur = frameRef.current;
      if (!renderer || !cur) return;
      renderer.draw({
        frame: cur.frame,
        categoryById: catRef.current,
        tick: Math.round(cur.tick),
        hoverWorld: hoverRef.current,
        lensRadiusPx: 120,
        lensZoom: 4,
        showColonyEdge: edgeRef.current,
        elapsed: posRef.current / Math.max(1, lenRef.current - 1),
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas || !rf) return;
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const [wx, wy] = renderer.toWorld(cssX, cssY);
    if (wx * wx + wy * wy > 500 * 500) {
      hoverRef.current = null;
      setHover(null);
      setPicked(null);
      return;
    }
    const h = { x: wx, y: wy };
    hoverRef.current = h;
    setHover(h);
    setPicked(renderer.pickCell({
      frame: rf.frame,
      categoryById,
      tick: 0,
      hoverWorld: null,
      lensRadiusPx: 0,
      lensZoom: 1,
      showColonyEdge: false,
      elapsed: 0,
    }, wx, wy));
  };

  const onLeave = () => {
    hoverRef.current = null;
    setHover(null);
    setPicked(null);
  };

  const pickedSpecies = picked ? speciesById.get(picked.speciesId) : null;

  return (
    <div ref={wrapRef} className="relative w-full flex justify-center select-none">
      <div className="relative">
        <canvas
          ref={canvasRef}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
          className="rounded-full cursor-crosshair touch-none"
        />
        <button
          onClick={() => setEdgeOn((v) => !v)}
          className="absolute top-2 left-2 text-[10px] font-mono px-2 py-1 rounded-full border border-glow-primary/30 text-text-muted hover:text-glow-primary bg-background-deep/70"
        >
          菌落边缘 {edgeOn ? '开' : '关'}
        </button>
        {hover && (
          <div className="pointer-events-none absolute bottom-2 left-2 right-2 text-[10px] font-mono text-text-light bg-background-deep/80 rounded-lg px-3 py-2 border border-glow-primary/20">
            {picked && pickedSpecies ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span className="text-glow-primary">{pickedSpecies.name}</span>
                <span className="italic text-text-muted">{pickedSpecies.scientificName}</span>
                <span>状态：{STATE_LABEL[picked.state]}</span>
                <span>生物质：{picked.biomass.toFixed(2)}</span>
                <span>坐标：({picked.x.toFixed(0)}, {picked.y.toFixed(0)})</span>
                {picked.state === 1 && <span className="text-glow-red">距裂解 {picked.timer} 代</span>}
                {picked.state === 2 && <span className="text-glow-orange">游离 {picked.timer} 代</span>}
                <span>id #{picked.id}</span>
              </div>
            ) : (
              <span className="text-text-muted">
                镜下无菌（{hover.x.toFixed(0)}, {hover.y.toFixed(0)}）— 4× 显微视野
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
