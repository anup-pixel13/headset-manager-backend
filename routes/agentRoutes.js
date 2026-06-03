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

// TEMP: auth bypass to isolate route-loading issue
const verifySession = (req, res, next) => {
  req.user = { id: 1, name: 'debug-admin', role: 'admin' };
  next();
};
const requireAdmin = (req, res, next) => next();
const requireITStaff = (req, res, next) => next();

const router = express.Router();

router.get('/processes', verifySession, getProcesses);
router.get('/staff/:role', verifySession, getStaffByRole);
router.get('/dropdown', verifySession, getAgentsForDropdown);
router.get('/pending-ids', verifySession, getPendingEmployeeIds);

router.get('/', verifySession, getAllAgents);
router.post('/', verifySession, requireAdmin, createAgent);
router.get('/:id/deassign-form', verifySession, requireAdmin, getDeassignFormData);
router.post('/:id/deassign', verifySession, requireAdmin, deassignAgent);
router.get('/:id', verifySession, getAgentById);
router.patch('/:id/employee-id', verifySession, requireITStaff, updateEmployeeId);

export default router;