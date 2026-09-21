/**
 * 培养皿前端 API：浏览器只做两件事 —— 发送控制指令、接收权威快照。
 * 没有任何模拟计算发生在浏览器里。
 */
import type {
  ArchiveListItem,
  CreateRunRequest,
  EcoFingerprint,
  RunControl,
  RunInfo,
  Snapshot,
} from '../../shared/petri';

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '请求失败');
  return data.data as T;
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '请求失败');
  return data.data as T;
}

export const petriApi = {
  createRun: (req: CreateRunRequest) =>
    postJSON<{ runId: string; info: RunInfo }>('/api/petri/runs', req),

  control: (runId: string, cmd: RunControl) =>
    postJSON<{ info: RunInfo; runId?: string; restarted?: boolean }>(
      `/api/petri/runs/${runId}/control`,
      cmd
    ),

  listArchives: () => getJSON<ArchiveListItem[]>('/api/petri/archives'),
  getArchive: (runId: string) =>
    getJSON<{ runId: string; lines: unknown[] }>(`/api/petri/archives/${runId}`),
  verifyArchive: (runId: string) =>
    getJSON<{ replayedDigest: string; fingerprint: EcoFingerprint }>(
      `/api/petri/archives/${runId}/verify`
    ),

  /** 订阅权威快照流。返回取消订阅函数。 */
  subscribe(
    runId: string,
    handlers: {
      onSnapshot: (snap: Snapshot) => void;
      onFinished?: (fp: EcoFingerprint) => void;
      onError?: (e: Event) => void;
    }
  ): () => void {
    const es = new EventSource(`/api/petri/runs/${runId}/stream`);
    es.addEventListener('snapshot', (ev) => {
      try {
        handlers.onSnapshot(JSON.parse((ev as MessageEvent).data) as Snapshot);
      } catch (e) {
        console.error('快照解析失败', e);
      }
    });
    es.addEventListener('finished', (ev) => {
      handlers.onFinished?.(JSON.parse((ev as MessageEvent).data) as EcoFingerprint);
    });
    es.onerror = (e) => handlers.onError?.(e);
    return () => es.close();
  },
};
