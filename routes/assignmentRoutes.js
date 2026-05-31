import express from 'express';
import { verifySession, requireITStaff } from '../middleware/authMiddleware.js';
import { signatureUpload } from '../middleware/signatureUploadMiddleware.js';

import {
  // existing
  getAllAssignments,
  getAssignmentById,
  assignHeadset,
  verifyAssignment,
  returnHeadset,
  getPendingVerifications,
  getActiveAssignmentByAgent,

  // signatures / pending
  addAssignmentSignature,
  getAssignmentSignatureStatus,
  getPendingSignatures,
  getPendingPermanentIds,

  // ✅ NEW (for AssignmentSign auto-fill)
  getAssignmentDetails,
} from '../controllers/assignmentController.js';

const router = express.Router();

// ============================================
// SPECIAL ROUTES (must be BEFORE /:id)
// ============================================

// Pending verifications
router.get('/pending-verifications', verifySession, getPendingVerifications);

// Pending signatures (IT only)
router.get('/pending-signatures', verifySession, requireITStaff, getPendingSignatures);
router.get('/pending-permanent-ids', verifySession, requireITStaff, getPendingPermanentIds);
// ============================================
// LIST ROUTES
// ============================================

// Get all assignments
// GET /api/assignments?search=ENC&is_active=true&is_verified=false
router.get('/', verifySession, getAllAssignments);
//router.get('/pending-permanent-ids', verifySession, requireITStaff, getPendingPermanentIds);
// ============================================
// SIGNATURE / DETAILS ROUTES (must be BEFORE /:id)
// ============================================

// ✅ Assignment details (TL/Manager/Agent/Headset) for auto-fill on signature screen
router.get('/active-by-agent/:agentId', verifySession, requireITStaff, getActiveAssignmentByAgent);
router.get('/:id/details', verifySession, requireITStaff, getAssignmentDetails);

// Signature status
router.get('/:id/signature-status', verifySession, requireITStaff, getAssignmentSignatureStatus);

// Add/update a signature (file upload)
router.post('/:id/signatures', verifySession, requireITStaff, signatureUpload, addAssignmentSignature);

// ============================================
// SINGLE ASSIGNMENT ROUTES
// ============================================

// Get single assignment
router.get('/:id', verifySession, getAssignmentById);

// Assign headset to agent (IT Staff only)
router.post('/', verifySession, requireITStaff, assignHeadset);

// Verify assignment after test call (IT Staff only)
router.patch('/:id/verify', verifySession, requireITStaff, verifyAssignment);

// Return headset (IT Staff only)
router.patch('/:id/return', verifySession, requireITStaff, returnHeadset);

export default router;