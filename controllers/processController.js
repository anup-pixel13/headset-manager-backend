import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/helpers.js';

// ============================================
// GET ALL PROCESSES
// ============================================
// GET /api/processes
export const getAllProcesses = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, name, category
       FROM processes
       ORDER BY name ASC`
    );

    res.json(successResponse(rows));
  } catch (error) {
    console.error('❌ Get processes error:', error);
    res.status(500).json(errorResponse('Failed to fetch processes'));
  }
};

export default {
  getAllProcesses
};