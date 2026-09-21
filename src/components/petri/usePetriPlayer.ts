/**
 * 培养皿播放器 —— 只"播"服务端帧，绝不本地推演。
 *
 * 帧以 128 代为一块从服务器预取（immutable 缓存）；播放时钟用 rAF，
 * 1× = 12 代/秒，100× 即追帧显示到最新可得帧。相邻权威帧之间仅做
 * 位置/角度的线性插值用于平滑，任何插值结果不回灌、不影响数据。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { petriApi } from '../../utils/petriApi';
import type { CodecFrame } from '../../../shared/sim/codec';
import { FRAME_CELL_SIZE, FRAME_HEADER_SIZE } from '../../../shared/sim/codec';

export const BASE_FPS = 12;
const CHUNK = 128;
const PREFETCH_AHEAD = 2;

export type PlayerFrame = CodecFrame;

function frameTickStart(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset + 0).getUint16(0);
}

export function usePetriPlayer(runId: string | null, totalTicks: number) {
  const [frames, setFrames] = useState<(CodecFrame | null)[]>([]);
  const [position, setPosition] = useState(0); // 连续（可插值）的"代"位置
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number>(0);
  const posRef = useRef(0);
  const speedRef = useRef(1);
  const playingRef = useRef(false);
  const loadingChunks = useRef(new Set<number>());
  const framesRef = useRef<(CodecFrame | null)[]>([]);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // 初始化帧数组
  useEffect(() => {
    if (!runId) return;
    setFrames(new Array(totalTicks + 1).fill(null));
    framesRef.current = new Array(totalTicks + 1).fill(null);
    setPosition(0);
    posRef.current = 0;
    setError(null);
  }, [runId, totalTicks]);

  const loadChunk = useCallback(
    async (chunkIdx: number) => {
      if (!runId) return;
      if (loadingChunks.current.has(chunkIdx)) return;
      const from = chunkIdx * CHUNK;
      if (from > totalTicks) return;
      if (framesRef.current[from]) return;
      loadingChunks.current.add(chunkIdx);
      setLoading(true);
      try {
        const to = Math.min(totalTicks, from + CHUNK - 1);
        const { frames: decoded } = await petriApi.frames(runId, from, to);
        const next = [...framesRef.current];
        for (const f of decoded) {
          if (f.tick <= totalTicks) next[f.tick] = f;
        }
        framesRef.current = next;
        setFrames(next);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        loadingChunks.current.delete(chunkIdx);
        setLoading(false);
      }
    },
    [runId, totalTicks]
  );

  // 预取当前位置附近的块
  const ensureAround = useCallback(
    (pos: number, spd: number) => {
      const current = Math.floor(pos / CHUNK);
      const lookahead = spd >= 50 ? PREFETCH_AHEAD + 2 : PREFETCH_AHEAD;
      for (let k = 0; k < lookahead; k++) void loadChunk(current + k);
    },
    [loadChunk]
  );

  // 播放主循环
  useEffect(() => {
    if (!runId) return;
    const step = (ts: number) => {
      rafRef.current = requestAnimationFrame(step);
      if (!playingRef.current) {
        lastTsRef.current = ts;
        return;
      }
      const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;

      let pos = posRef.current + dt * BASE_FPS * speedRef.current;
      if (pos >= totalTicks) {
        pos = totalTicks;
        setPlaying(false);
      }
      posRef.current = pos;
      setPosition(pos);
      ensureAround(pos, speedRef.current);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [runId, totalTicks, ensureAround]);

  const seek = useCallback(
    (tick: number) => {
      const t = Math.max(0, Math.min(totalTicks, tick));
      posRef.current = t;
      setPosition(t);
      ensureAround(t, speedRef.current);
    },
    [totalTicks, ensureAround, speedRef]
  );

  const togglePlay = useCallback(() => {
    if (posRef.current >= totalTicks) {
      posRef.current = 0;
      setPosition(0);
    }
    setPlaying((p) => !p);
  }, [totalTicks]);

  const changeSpeed = useCallback((s: number) => {
    speedRef.current = s;
    setSpeed(s);
  }, []);

  /** 当前用于绘制的插值帧：合并相邻两权威帧的细胞（按 id 匹配） */
  const renderedFrame = useMemo(() => {
    let i0 = Math.floor(position);
    // 目标帧尚未取到时（高倍速追帧），回退到最近一个已得帧，画面不空
    let f0 = frames[i0];
    while (!f0 && i0 > 0) {
      i0 -= 1;
      f0 = frames[i0];
    }
    const alpha = f0 ? position - i0 : 0;
    if (!f0) return null;
    const f1 = alpha > 0 ? frames[Math.min(totalTicks, i0 + 1)] : null;
    if (!f1 || alpha === 0) return { frame: f0, tick: i0, interpolated: false };

    const byId = new Map<number, (typeof f1.cells)[number]>();
    for (const c of f1.cells) byId.set(c.id, c);
    const cells = f0.cells.map((c) => {
      const n = byId.get(c.id);
      if (!n) return c;
      // 角度走最短弧
      let da = n.angle - c.angle;
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      return {
        ...c,
        x: c.x + (n.x - c.x) * alpha,
        y: c.y + (n.y - c.y) * alpha,
        angle: c.angle + da * alpha,
        biomass: c.biomass + (n.biomass - c.biomass) * alpha,
        state: n.state,
        timer: n.timer,
      };
    });
    // 新出现的细胞（分裂子代）在 alpha 后期淡入
    for (const n of f1.cells) {
      if (!f0.cells.some((c) => c.id === n.id) && alpha > 0.5) cells.push(n);
    }
    return {
      frame: { tick: i0, cells, carbonPermille: f0.carbonPermille, antibioticPeakPermille: f0.antibioticPeakPermille },
      tick: position,
      interpolated: true,
    };
  }, [frames, position, totalTicks]);

  const ready = !!frames[0];

  return {
    frames,
    position,
    renderedFrame,
    playing,
    speed,
    loading,
    error,
    ready,
    togglePlay,
    changeSpeed,
    seek,
    loadChunk,
    headerSize: FRAME_HEADER_SIZE,
    cellSize: FRAME_CELL_SIZE,
    tickStart: frameTickStart,
  };
}
