import express from 'express';

import { verifySession, requireAdmin } from '../middleware/authMiddleware.js';

import {
  createRepairLot,
  listRepairLots,
  getRepairLotById,
  addItemsToRepairLot,
  removeRepairLotItem,
  sendRepairLot,
  receiveRepairLotItems,
  startRepairReplacement,
  rehandoverRepairedHeadset,
  getTempReplacements,
  closeReplacementAgentExit, // ✅ NEW
} from '../controllers/repairController.js';

const router = express.Router();

router.use(verifySession);
router.use(requireAdmin);

// Lots
router.post('/lots', createRepairLot);
router.get('/lots', listRepairLots);
router.get('/lots/:id', getRepairLotById);

// Temp replacements listing
router.get('/replacements', getTempReplacements);

router.post('/lots/:id/items', addItemsToRepairLot);
router.delete('/lots/:id/items/:itemId', removeRepairLotItem);

router.post('/lots/:id/send', sendRepairLot);
router.post('/lots/:id/receive', receiveRepairLotItems);

// Replacement workflow
router.post('/start-replacement', startRepairReplacement);
router.post('/re-handover', rehandoverRepairedHeadset);

// ✅ NEW: agent exit closure (no rehandover later)
router.post('/close-replacement-agent-exit', closeReplacementAgentExit);

export default router;