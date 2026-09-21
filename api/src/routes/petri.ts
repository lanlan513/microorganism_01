import { Router } from 'express';
import type { Request, Response } from 'express';
import { RunManager } from '../services/PetriRunManager.js';
import type { CreateRunRequest, RunControl, AntibioticId } from '../../../shared/petri.js';
import { ANTIBIOTIC_LABELS } from '../../../shared/petri.js';

export const petriRouter = Router();

const DRUGS: AntibioticId[] = ['penicillin', 'ciprofloxacin', 'amphotericin'];

/** 建舱 */
petriRouter.post('/runs', (req: Request, res: Response) => {
  try {
    const body = req.body as CreateRunRequest;
    if (!body || !Array.isArray(body.inocula) || body.seed === undefined) {
      return res.status(400).json({ success: false, error: '参数缺失：inocula / seed 必填' });
    }
    const run = RunManager.create(body);
    res.json({
      success: true,
      data: {
        runId: run.runId,
        info: run.info,
      },
    });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

/** 运行时信息 */
petriRouter.get('/runs/:runId', (req, res) => {
  const run = RunManager.get(req.params.runId);
  if (!run) return res.status(404).json({ success: false, error: '运行不存在或已归档' });
  res.json({ success: true, data: { info: run.info, fingerprint: run.fingerprint ?? null } });
});

/** SSE：权威快照流（浏览器只画不算） */
petriRouter.get('/runs/:runId/stream', (req, res) => {
  const run = RunManager.get(req.params.runId);
  if (!run) return res.status(404).json({ success: false, error: '运行不存在' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  let lastSentTick = -1;

  const send = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 连接即先推一帧（重连时无需等下一拍）
  const snap0 = (() => {
    const { sim, info } = run;
    return {
      runId: run.runId,
      tick: sim.tick,
      gen: Math.floor(sim.tick / 120),
      simMinutes: sim.tick,
      status: info.status,
      speed: info.speed,
      counts: sim.getCounts(),
      cells: sim.snapshotCells(),
      virions: sim.snapshotVirions(),
      field: sim.sampleField(),
      events: sim.events,
      fingerprint: run.fingerprint,
    };
  })();
  send('snapshot', snap0);
  lastSentTick = snap0.tick;

  const onSnapshot = (snap: typeof snap0) => {
    if (snap.tick === lastSentTick && !snap.fingerprint) return;
    lastSentTick = snap.tick;
    send('snapshot', snap);
  };
  const onFinished = (fp: unknown) => send('finished', fp);

  run.emitter.on('snapshot', onSnapshot);
  run.emitter.on('finished', onFinished);

  const heartbeat = setInterval(() => send('ping', { t: Date.now() }), 15000);
  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    run.emitter.off('snapshot', onSnapshot);
    run.emitter.off('finished', onFinished);
  });
});

/** 暂停 / 继续 / 调速 / 给药 / 重启 */
petriRouter.post('/runs/:runId/control', (req, res) => {
  try {
    const cmd = req.body as RunControl;
    if (!cmd || typeof cmd.type !== 'string') {
      return res.status(400).json({ success: false, error: '非法指令' });
    }
    if (cmd.type === 'dose' && (!DRUGS.includes(cmd.drug) || !(cmd.concentration > 0))) {
      return res.status(400).json({ success: false, error: '非法给药参数' });
    }
    if (cmd.type === 'setSpeed' && (typeof cmd.speed !== 'number' || cmd.speed < 0 || cmd.speed > 100)) {
      return res.status(400).json({ success: false, error: '速度需在 0-100' });
    }
    const result = RunManager.control(req.params.runId, cmd);
    if (cmd.type === 'restart') {
      return res.json({ success: true, data: { runId: result.runId, info: result.info, restarted: true } });
    }
    res.json({ success: true, data: { info: result.info } });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

/** 档案列表 */
petriRouter.get('/archives', (_req, res) => {
  res.json({ success: true, data: RunManager.listArchives() });
});

/** 单份档案（逐条留痕记录） */
petriRouter.get('/archives/:runId', (req, res) => {
  const lines = RunManager.getArchive(req.params.runId);
  if (!lines) return res.status(404).json({ success: false, error: '档案不存在' });
  res.json({ success: true, data: { runId: req.params.runId, lines } });
});

/** 从档案重放并校验指纹（科考记录复核） */
petriRouter.get('/archives/:runId/verify', (req, res) => {
  const fp = RunManager.replay(req.params.runId);
  if (!fp) return res.status(404).json({ success: false, error: '档案不存在或缺少建舱记录' });
  res.json({ success: true, data: { replayedDigest: fp.digest, fingerprint: fp } });
});

/** 抗菌素元数据 */
petriRouter.get('/antibiotics', (_req, res) => {
  res.json({
    success: true,
    data: DRUGS.map((id) => ({ id, label: ANTIBIOTIC_LABELS[id] })),
  });
});
