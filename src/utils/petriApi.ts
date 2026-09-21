/**
 * 培养皿前端 API：只做"请求 / 解码 / 展示"，不含任何推进逻辑。
 * 所有帧数据以 ArrayBuffer 拉取，交给共享解码器（与服务端同一套格式）。
 */
import { decodeFrames, type CodecFrame } from '../../shared/sim/codec';
import type {
  CreateRunRequest,
  RunInfo,
  TickCount,
  EcoFingerprint,
} from '../../shared/sim/types';

const API_BASE = '/api/petri';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json();
  if (!body.success) throw new Error(body.error || '请求失败');
  return body.data as T;
}

export interface CatalogEntryView {
  microbeId: number;
  name: string;
  scientificName: string;
  category: 'bacteria' | 'fungi' | 'virus' | 'archaea';
}

export interface VerifyView {
  runId: string;
  matched: boolean;
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

export const petriApi = {
  catalog: () => json<CatalogEntryView[]>('/catalog'),
  listRuns: () => json<RunInfo[]>('/runs'),
  createRun: (req: CreateRunRequest) =>
    json<RunInfo>('/runs', { method: 'POST', body: JSON.stringify(req) }),
  getRun: (id: string) => json<RunInfo>(`/runs/${id}`),
  getTicks: (id: string) => json<TickCount[]>(`/runs/${id}/ticks`),
  getJournal: (id: string) =>
    json<
      Array<{ tick: number; events: Array<{ type: string; speciesId?: number }> }>
    >(`/runs/${id}/journal`),

  /** 取帧区间；返回解码后的帧（解码逻辑与后端同源，但只用于画） */
  async frames(id: string, from: number, to: number): Promise<{ frames: CodecFrame[]; ticks: number[] }> {
    const res = await fetch(`${API_BASE}/runs/${id}/frames?from=${from}&to=${to}`);
    if (!res.ok) throw new Error(`帧请求失败 ${res.status}`);
    const ticksHeader = res.headers.get('X-Frame-Ticks') ?? '';
    const ticks = ticksHeader ? ticksHeader.split(',').map(Number) : [];
    const buf = await res.arrayBuffer();
    return { frames: decodeFrames(new Uint8Array(buf)), ticks };
  },

  verify: (id: string) =>
    json<VerifyView>(`/runs/${id}/verify`, { method: 'POST' }),
};

export type { RunInfo, TickCount, EcoFingerprint };
