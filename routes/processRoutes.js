import express from 'express';
import { getAllProcesses } from '../controllers/processController.js';
import { verifySession } from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/processes
router.get('/', verifySession, getAllProcesses);

export default router;