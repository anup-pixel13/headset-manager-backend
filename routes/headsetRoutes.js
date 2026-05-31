import express from 'express';
import {
  getAllHeadsets,
  getHeadsetById,
  addHeadset,
  updateHeadset,
  deleteHeadset,
  getHeadsetBrands,
  getAvailableHeadsets,
  getInventorySummary,
  markHeadsetLost,
  markHeadsetDamaged,
  retireHeadset,
  getHeadsetAssignments,
  getHeadsetRepairs,
} from '../controllers/headsetController.js';
import { verifySession, requireAdmin } from '../middleware/authMiddleware.js';
import { headsetImagesUpload } from '../middleware/uploadMiddleware.js';
const router = express.Router();

// ============================================
// SPECIFIC ROUTES FIRST (before /:id)
// ============================================

// Get all headset brands (for dropdowns)
router.get('/brands', verifySession, getHeadsetBrands);

// Get available headsets (for assignment dropdown)
router.get('/available', verifySession, getAvailableHeadsets);

// Get inventory summary (dashboard)
router.get('/summary', verifySession, getInventorySummary);

// ============================================
// CRUD ROUTES
// ============================================

// Get all headsets - GET /api/headsets
router.get('/', verifySession, getAllHeadsets);

// Add new headset - POST /api/headsets
//router.post('/', verifySession, requireITStaff, addHeadset);
// Actions
router.post('/:id/mark-lost', verifySession, requireAdmin, markHeadsetLost);
router.post('/:id/mark-damaged', verifySession, requireAdmin, markHeadsetDamaged);
router.post('/:id/retire', verifySession, requireAdmin, retireHeadset);
router.get('/:id/assignments', verifySession, getHeadsetAssignments);
router.get('/:id/repairs', verifySession, getHeadsetRepairs);
// Get single headset - GET /api/headsets/:id
router.get('/:id', verifySession, getHeadsetById);
// Add new headset - POST /api/headsets
router.post('/', verifySession, requireAdmin, headsetImagesUpload, addHeadset);
router.put('/:id', verifySession, requireAdmin, updateHeadset);
router.delete('/:id', verifySession, requireAdmin, deleteHeadset);

export default router;