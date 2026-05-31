import express from 'express';
import {
  getMonthlyReport,
  getInventoryReport,
  getDepositReport,
  getAgentReport
} from '../controllers/reportController.js';
import { verifySession, requireManager } from '../middleware/authMiddleware.js';

const router = express.Router();

// ============================================
// REPORT ROUTES
// ============================================

// Monthly report
// GET /api/reports/monthly?year=2026&month=4
router.get('/monthly', verifySession, requireManager, getMonthlyReport);

// Inventory report
router.get('/inventory', verifySession, getInventoryReport);

// Deposit report
// GET /api/reports/deposits?start_date=2026-01-01&end_date=2026-04-30
router.get('/deposits', verifySession, requireManager, getDepositReport);

// Agent report
router.get('/agents', verifySession, getAgentReport);

export default router;