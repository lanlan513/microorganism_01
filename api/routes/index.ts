import { Router } from 'express';
import { MicrobeController } from '../src/controllers/MicrobeController.js';
import { PetriController } from '../src/controllers/PetriController.js';

const router = Router();

/* 培养皿（服务端权威模拟） */
router.get('/petri/catalog', PetriController.catalog);
router.get('/petri/runs', PetriController.list);
router.post('/petri/runs', PetriController.create);
router.get('/petri/runs/:runId', PetriController.get);
router.get('/petri/runs/:runId/ticks', PetriController.ticks);
router.get('/petri/runs/:runId/journal', PetriController.journal);
router.get('/petri/runs/:runId/frames', PetriController.frames);
router.post('/petri/runs/:runId/verify', PetriController.verify);

/* 标本 */
router.get('/microbes', MicrobeController.getAll);
router.get('/microbes/stats', MicrobeController.getStats);
router.get('/microbes/category/:category', MicrobeController.getByCategory);
router.get('/microbes/:id', MicrobeController.getById);
router.get('/microbes/:id/related', MicrobeController.getRelated);
router.get('/stats', MicrobeController.getStats);

export default router;
