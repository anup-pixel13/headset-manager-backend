import express from 'express';
import {
  getAllHeadsets,
  getHeadsetById,
  addHeadset,
  updateHeadset,
  deleteHeadset,
  getHeadsetBrands,
  getAvailableHeadsets,
  getInventorySummary
} from '../controllers/headsetController.js';
import { verifySession, requireITStaff } from '../middleware/authMiddleware.js';
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

// Get single headset - GET /api/headsets/:id
router.get('/:id', verifySession, getHeadsetById);
// Add new headset - POST /api/headsets
router.post('/', verifySession, requireITStaff, headsetImagesUpload, addHeadset);

// Update headset - PUT /api/headsets/:id
router.put('/:id', verifySession, requireITStaff, updateHeadset);

// Delete headset - DELETE /api/headsets/:id
router.delete('/:id', verifySession, requireITStaff, deleteHeadset);

export default router;