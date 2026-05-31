import express from 'express';
import {
  getDashboardStats,
  getQuickStats,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead
} from '../controllers/dashboardController.js';
import { verifySession } from '../middleware/authMiddleware.js';

const router = express.Router();

// Dashboard stats (with date filters)
// GET /api/dashboard/stats?start_date=2024-01-01&end_date=2024-03-31
router.get('/stats', verifySession, getDashboardStats);

// Quick stats for header/navbar
router.get('/quick-stats', verifySession, getQuickStats);

// Notifications
router.get('/notifications', verifySession, getNotifications);
router.patch('/notifications/:id/read', verifySession, markNotificationRead);
router.patch('/notifications/read-all', verifySession, markAllNotificationsRead);

export default router;