import { Router } from 'express';
import { MicrobeController } from '../src/controllers/MicrobeController.js';
import { petriRouter } from '../src/routes/petri.js';

const router = Router();

router.get('/microbes', MicrobeController.getAll);
router.get('/microbes/stats', MicrobeController.getStats);
router.get('/microbes/category/:category', MicrobeController.getByCategory);
router.get('/microbes/:id', MicrobeController.getById);
router.get('/microbes/:id/related', MicrobeController.getRelated);
router.get('/stats', MicrobeController.getStats);

// 培养皿活体模拟（服务端权威）
router.use('/petri', petriRouter);

export default router;
