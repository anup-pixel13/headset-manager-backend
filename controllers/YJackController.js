import YJack from '../models/YJack.js';
import { successResponse, errorResponse, paginatedResponse } from '../utils/helpers.js';

export const getYJacks = async (req, res) => {
  try {
    const { total, pageNum, limitNum, rows } = await YJack.list(req.query);

    const formatted = rows.map(r => ({
      headsetId: r.headset_id,
      yjackNumber: r.headset_number,
      trainerName: r.trainer_name || null,
      assignedAt: r.assigned_at || null,
      unassignedAt: r.unassigned_at || null,
      isActive: r.is_active === 1
    }));

    return res.json(paginatedResponse(formatted, total, pageNum, limitNum));
  } catch (e) {
    console.error('❌ getYJacks error:', e);
    return res.status(500).json(errorResponse('Failed to fetch Y-Jacks'));
  }
};

export const assignYJack = async (req, res) => {
  try {
    const { headset_id, trainer_name, notes } = req.body;
    if (!headset_id) return res.status(400).json(errorResponse('headset_id is required'));
    if (!trainer_name) return res.status(400).json(errorResponse('trainer_name is required'));

    const result = await YJack.assign({
      headset_id,
      trainer_name,
      assigned_by: req.user?.id || null,
      notes: notes || null
    });

    return res.status(201).json(successResponse(result, 'Y-Jack assigned successfully'));
  } catch (e) {
    console.error('❌ assignYJack error:', e);
    return res.status(e.statusCode || 500).json(errorResponse(e.message || 'Failed to assign Y-Jack'));
  }
};

export const unassignYJack = async (req, res) => {
  try {
    const { headset_id, notes } = req.body;
    if (!headset_id) return res.status(400).json(errorResponse('headset_id is required'));

    const result = await YJack.unassign({
      headset_id,
      unassigned_by: req.user?.id || null,
      notes: notes || null
    });

    return res.json(successResponse(result, 'Y-Jack de-assigned successfully'));
  } catch (e) {
    console.error('❌ unassignYJack error:', e);
    return res.status(e.statusCode || 500).json(errorResponse(e.message || 'Failed to de-assign Y-Jack'));
  }
};

export default { getYJacks, assignYJack, unassignYJack };