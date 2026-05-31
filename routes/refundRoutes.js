// routes/refundRoutes.js
import express from 'express';
import { verifySession, requireAdmin } from '../middleware/authMiddleware.js';
import { listRefundRequests, processRefundRequest,
	markRefundNotEligible,   // ✅ add
	reopenRefundRequest,     // ✅ add (reversible)
 } from '../controllers/refundController.js';

const router = express.Router();

// List refund requests (Admin only)
router.get('/', verifySession, requireAdmin, listRefundRequests);

// Mark refund processed (Admin only)
router.post('/:id/process', verifySession, requireAdmin, processRefundRequest);

// ✅ Mark refund as not eligible (Admin only)
router.post('/:id/not-eligible', verifySession, requireAdmin, markRefundNotEligible);

// ✅ Reopen refund back to in_progress (Admin only) - reversible
router.post('/:id/reopen', verifySession, requireAdmin, reopenRefundRequest);

export default router;