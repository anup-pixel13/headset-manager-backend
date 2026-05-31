import express from 'express';
import { verifySession, requireITStaff } from '../middleware/authMiddleware.js';
import { getYJacks, assignYJack, unassignYJack } from '../controllers/yjackController.js';

const router = express.Router();

router.get('/', verifySession, requireITStaff, getYJacks);
router.post('/assign', verifySession, requireITStaff, assignYJack);
router.post('/unassign', verifySession, requireITStaff, unassignYJack);

export default router;