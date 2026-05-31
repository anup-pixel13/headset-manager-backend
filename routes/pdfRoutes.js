import express from 'express';
import {
  generateDepositForm,
  // generateRefundForm, // ❌ no longer used
  storeSignature,
  getPdfDocuments,
  generateProcessChangeForm
} from '../controllers/pdfController.js';
import { verifySession, requireITStaff } from '../middleware/authMiddleware.js';

const router = express.Router();

// Get all PDF documents
router.get('/documents', verifySession, getPdfDocuments);

// Generate deposit form PDF (STRICT gated: signatures + permanent ID)
router.post('/deposit-form/:assignment_id', verifySession, requireITStaff, generateDepositForm);

// ❌ Refund form PDF route removed as per new flow
// router.post('/refund-form/:deposit_id', verifySession, requireITStaff, generateRefundForm);

// Store signature (legacy endpoint; not used by AssignmentSign flow)
router.post('/signature', verifySession, storeSignature);

// Process change form PDF (still available)
router.post('/process-change-form/:deposit_id', verifySession, requireITStaff, generateProcessChangeForm);

export default router;