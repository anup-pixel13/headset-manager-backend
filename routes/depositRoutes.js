import express from 'express';
import {
  getAllDeposits,
  getDepositById,
  processRefund,
  getPendingRefunds,
  getDepositSummary
} from '../controllers/depositController.js';
import { verifySession, requireITStaff } from '../middleware/authMiddleware.js';

const router = express.Router();

// ============================================
// SPECIAL ROUTES (before /:id)
// ============================================

// Get pending refunds
router.get('/pending-refunds', verifySession, getPendingRefunds);

// Get deposit summary
router.get('/summary', verifySession, getDepositSummary);

// ============================================
// CRUD ROUTES
// ============================================

// Get all deposits
// GET /api/deposits?search=ENC&deposit_type=voix&refund_status=pending
router.get('/', verifySession, getAllDeposits);

// Get single deposit
router.get('/:id', verifySession, getDepositById);

// Process refund (IT Staff only)
router.patch('/:id/refund', verifySession, requireITStaff, processRefund);

export default router;