import express from 'express';
import {
  getAllAgents,
  getAgentById,
  getAgentsForDropdown,
  getPendingEmployeeIds,
  updateEmployeeId,
  getProcesses,
  getStaffByRole,
  createAgent,
  getDeassignFormData,
  deassignAgent,
} from '../controllers/agentController.js';
//import { verifySession, requireITStaff } from '../middleware/authMiddleware.js';
//import { requireAdmin } from '../middleware/authMiddleware.js';
//import { createAgent } from '../controllers/agentController.js';
import { verifySession, requireAdmin, requireITStaff } from '../middleware/authMiddleware.js';

// ...


const router = express.Router();

// ============================================
// DROPDOWN/LOOKUP ROUTES
// ============================================

// Get processes for dropdown
router.get('/processes', verifySession, getProcesses);

// Get staff by role (managers, tls, trainers)
router.get('/staff/:role', verifySession, getStaffByRole);

// Get agents for dropdown (simple list)
router.get('/dropdown', verifySession, getAgentsForDropdown);

// Get agents with pending employee IDs
router.get('/pending-ids', verifySession, getPendingEmployeeIds);

// ============================================
// AGENT CRUD ROUTES
// ============================================

// Get all agents with filters
// GET /api/agents?search=john&status=active&process_id=1&has_headset=false
router.get('/', verifySession, getAllAgents);
// Get pending signatures



// Create agent (Admin only)
router.post('/', verifySession, requireAdmin, createAgent);

// De-assign form data (IT Staff only)
router.get('/:id/deassign-form', verifySession, requireAdmin, getDeassignFormData);

// Submit de-assign + make inactive (IT Staff only)
router.post('/:id/deassign', verifySession, requireAdmin, deassignAgent);

// Get single agent by ID
router.get('/:id', verifySession, getAgentById);

// Update permanent employee ID (IT Staff only)
router.patch('/:id/employee-id', verifySession, requireITStaff, updateEmployeeId);


export default router;