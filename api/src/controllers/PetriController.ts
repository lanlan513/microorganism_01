import type { Request, Response } from 'express';
import { petriStore, petriCatalog } from '../services/petriService.js';
import type { CreateRunRequest } from '../../../shared/sim/types.js';

export class PetriController {
  /** 可接种标本目录（携带培养皿生态位与性状，供前端选型） */
  static catalog(_req: Request, res: Response) {
    try {
      const data = [...petriCatalog.entries()].map(([id, e]) => ({ microbeId: id, ...e }));
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  static list(_req: Request, res: Response) {
    try {
      res.json({ success: true, data: petriStore.list() });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  static create(req: Request, res: Response) {
    try {
      const body = req.body as CreateRunRequest;
      if (!body || body.seed === undefined || body.seed === null) {
        return res.status(400).json({ success: false, error: '缺少 seed（种子）' });
      }
      if (!Array.isArray(body.inoculum)) {
        return res.status(400).json({ success: false, error: '缺少 inoculum 接种清单' });
      }
      const info = petriStore.create(body, petriCatalog);
      res.json({ success: true, data: info });
    } catch (error) {
      const msg = (error as Error).message;
      const status = msg.includes('为空') || msg.includes('上限') || msg.includes('缺少') ? 400 : 500;
      res.status(status).json({ success: false, error: msg });
    }
  }

  static get(req: Request, res: Response) {
    try {
      const run = petriStore.get(req.params.runId);
      if (!run) return res.status(404).json({ success: false, error: '培养皿不存在' });
      res.json({ success: true, data: run.info });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  static ticks(req: Request, res: Response) {
    try {
      const run = petriStore.get(req.params.runId);
      if (!run) return res.status(404).json({ success: false, error: '培养皿不存在' });
      res.json({ success: true, data: run ? petriStore.ticks(run.info.runId) : [] });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  static journal(req: Request, res: Response) {
    try {
      const run = petriStore.get(req.params.runId);
      if (!run) return res.status(404).json({ success: false, error: '培养皿不存在' });
      res.json({ success: true, data: petriStore.journal(run.info.runId) });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  /** 逐帧权威数据：二进制 application/octet-stream，区间 ?from=&to= */
  static frames(req: Request, res: Response) {
    try {
      const run = petriStore.get(req.params.runId);
      if (!run) return res.status(404).json({ success: false, error: '培养皿不存在' });
      const from = Math.max(0, parseInt(String(req.query.from ?? '0'), 10) || 0);
      const requestedTo = parseInt(String(req.query.to ?? String(run.info.totalTicks)), 10);
      const to = Number.isFinite(requestedTo)
        ? Math.min(run.info.totalTicks, requestedTo)
        : run.info.totalTicks;
      const chunk = petriStore.frameRange(run.info.runId, from, to);
      if (!chunk) return res.status(416).json({ success: false, error: '帧区间无效' });

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Frame-Ticks', chunk.ticks.join(','));
      res.setHeader('X-Frame-From', String(from));
      res.setHeader('X-Frame-To', String(to));
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(Buffer.from(chunk.data));
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  static verify(req: Request, res: Response) {
    try {
      const run = petriStore.get(req.params.runId);
      if (!run) return res.status(404).json({ success: false, error: '培养皿不存在' });
      const result = petriStore.verify(run.info.runId, petriCatalog);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }
}
