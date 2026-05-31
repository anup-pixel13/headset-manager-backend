import express from 'express';
import {
  getAllTransfers,
  transferHeadset,
  processChange,
  processChangeV2
} from '../controllers/transferController.js';
import { verifySession, requireITStaff } from '../middleware/authMiddleware.js';

const router = express.Router();

// ============================================
// TRANSFER ROUTES
// ============================================

// Get all transfers
router.get('/', verifySession, getAllTransfers);

// Transfer headset between agents (IT Staff only)
router.post('/headset', verifySession, requireITStaff, transferHeadset);

// Process change - legacy (IT Staff only)
router.post('/process-change', verifySession, requireITStaff, processChange);

// ✅ Process change v2 (Option 2 + two-row deposits)
router.post('/process-change-v2', verifySession, requireITStaff, processChangeV2);

export default router;