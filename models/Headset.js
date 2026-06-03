// controllers/headsetController.js
import db from '../config/db.js';
import Headset from '../models/Headset.js';
import {
  successResponse,
  errorResponse,
  paginatedResponse,
  sanitizeString
} from '../utils/helpers.js';

// ============================================
// GET ALL HEADSETS (with filters & pagination)
// ============================================
export const getAllHeadsets = async (req, res) => {
  try {
    const {
      search,
      headset_type,
      status,
      condition,
      is_brand_new,
      brand_id,
      page = 1,
      limit = 20,
      sort_by = 'headset_number',
      sort_order = 'ASC'
    } = req.query;

    const { total, pageNum, limitNum, headsets } = await Headset.list({
      search,
      headset_type,
      status,
      condition,
      is_brand_new,
      brand_id,
      page,
      limit,
      sort_by,
      sort_order
    });

    const formattedHeadsets = headsets.map(h => ({
      id: h.id,
      headsetNumber: h.headset_number,
      headsetType: h.headset_type,
      status: h.status,
      condition: h.condition_status,
      isBrandNew: h.is_brand_new === 1,
      purchaseDate: h.purchase_date,
      warrantyExpiry: h.warranty_expiry,
      images: [h.image_url_1, h.image_url_2].filter(Boolean),
      notes: h.notes,
      brand: {
        name: h.brand_name,
        depositAmount: h.deposit_amount,
        refundAmount: h.refund_amount
      },
      assignment: h.assignment_id ? {
        id: h.assignment_id,
        assignmentDate: h.assignment_date,
        isVerified: h.is_verified === 1,
        agent: {
          id: h.agent_user_id,
          name: h.assigned_to_name,
          employeeId: h.assigned_to_emp_id || h.assigned_to_temp_id
        },
        process: h.process_name
      } : null,
      createdAt: h.created_at,
      updatedAt: h.updated_at
    }));

    res.json(paginatedResponse(formattedHeadsets, total, pageNum, limitNum));
  } catch (error) {
    console.error('❌ Get headsets error:', error);
    res.status(500).json(errorResponse('Failed to fetch headsets'));
  }
};

// ============================================
// GET SINGLE HEADSET BY ID
// ============================================
export const getHeadsetById = async (req, res) => {
  try {
    const { id } = req.params;

    const headset = await Headset.getById(id);
    if (!headset) return res.status(404).json(errorResponse('Headset not found'));

    const currentAssignment = await Headset.getCurrentAssignmentByHeadsetId(id);
    const history = await Headset.getAssignmentHistory(id, 10);
    const repairs = await Headset.getRepairHistory(id, 10);

    res.json(successResponse({
      id: headset.id,
      headsetNumber: headset.headset_number,
      headsetType: headset.headset_type,
      status: headset.status,
      condition: headset.condition_status,
      isBrandNew: headset.is_brand_new === 1,
      purchaseDate: headset.purchase_date,
      warrantyExpiry: headset.warranty_expiry,
      images: [headset.image_url_1, headset.image_url_2].filter(Boolean),
      notes: headset.notes,
      brand: {
        id: headset.brand_id,
        name: headset.brand_name,
        depositAmount: headset.deposit_amount,
        refundAmount: headset.refund_amount,
        description: headset.brand_description
      },
      currentAssignment: currentAssignment ? {
        id: currentAssignment.id,
        assignmentDate: currentAssignment.assignment_date,
        isVerified: currentAssignment.is_verified === 1,
        verificationDate: currentAssignment.verification_date,
        agent: {
          name: currentAssignment.agent_name,
          employeeId: currentAssignment.employee_id || currentAssignment.temp_employee_id,
          email: currentAssignment.agent_email,
          phone: currentAssignment.agent_phone
        },
        process: {
          name: currentAssignment.process_name,
          category: currentAssignment.process_category
        },
        assignedBy: currentAssignment.assigned_by_name,
        verifiedBy: currentAssignment.verified_by_name
      } : null,
      assignmentHistory: history.map(h => ({
        id: h.id,
        agentName: h.agent_name,
        employeeId: h.employee_id || h.temp_employee_id,
        process: h.process_name,
        assignmentDate: h.assignment_date,
        returnDate: h.return_date,
        returnCondition: h.return_condition,
        isVerified: h.is_verified === 1
      })),
      repairHistory: repairs.map(r => ({
        id: r.id,
        issueType: r.issue_type,
        issueDescription: r.issue_description,
        sentDate: r.sent_for_repair_date,
        returnDate: r.actual_return_date,
        status: r.repair_status,
        cost: r.repair_cost,
        vendor: r.repair_vendor,
        reportedBy: r.reported_by_name,
        receivedBy: r.received_by_name
      })),
      createdAt: headset.created_at,
      updatedAt: headset.updated_at
    }));
  } catch (error) {
    console.error('❌ Get headset by ID error:', error);
    res.status(500).json(errorResponse('Failed to fetch headset details'));
  }
};

// ============================================
// ADD NEW HEADSET (multipart images required)
// ============================================
export const addHeadset = async (req, res) => {
  try {
    const headset_number = req.body?.headset_number;
    const brand_id = req.body?.brand_id;
    const headset_type = req.body?.headset_type;

    const purchase_date = req.body?.purchase_date || null;
    const warranty_expiry = req.body?.warranty_expiry || null;
    const notes = req.body?.notes || null;

    const allowedTypes = ['voix_enc', 'voix_3xx', 'voix_nxx', 'tech', 'ojt', 'yjack'];
    if (!allowedTypes.includes(headset_type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid headset_type. Allowed: ${allowedTypes.join(', ')}`
      });
    }

    // Require 2 images
    const file1 = req.files?.image1?.[0];
    const file2 = req.files?.image2?.[0];

    if (!file1 || !file2) {
      return res.status(400).json({
        success: false,
        message: 'Two images are required (image1 and image2).'
      });
    }

    if (!headset_number || !brand_id || !headset_type) {
      return res.status(400).json({
        success: false,
        message: 'Headset number, brand_id, and headset_type are required',
        received: { headset_number, brand_id, headset_type }
      });
    }

    // duplicate check via model
    const exists = await Headset.existsHeadsetNumber(headset_number);
    if (exists) {
      return res.status(400).json({
        success: false,
        message: `Headset number ${String(headset_number).trim().toUpperCase()} already exists`
      });
    }

    const image_url_1 = `/uploads/headset-images/${file1.filename}`;
    const image_url_2 = `/uploads/headset-images/${file2.filename}`;

    const created = await Headset.create({
      headset_number,
      brand_id,
      headset_type,
      purchase_date,
      warranty_expiry,
      notes,
      image_url_1,
      image_url_2
    });

    console.log(`✅ Headset added: ${created.headsetNumber} (ID: ${created.insertId})`);

    res.status(201).json({
      success: true,
      message: `Headset ${created.headsetNumber} added successfully`,
      data: {
        id: created.insertId,
        headsetNumber: created.headsetNumber,
        images: [image_url_1, image_url_2]
      }
    });
  } catch (error) {
    console.error('❌ Add headset error:', error.message);
    console.error('❌ Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to add headset',
      error: error.message
    });
  }
};

// ============================================
// UPDATE HEADSET
// ============================================
export const updateHeadset = async (req, res) => {
  try {
    const { id } = req.params;

    // Check exists
    const headset = await Headset.getById(id);
    if (!headset) return res.status(404).json(errorResponse('Headset not found'));

    // Duplicate check if number changes
    if (req.body?.headset_number && req.body.headset_number !== headset.headset_number) {
      const dup = await Headset.existsHeadsetNumber(req.body.headset_number, id);
      if (dup) return res.status(400).json(errorResponse('Headset number already exists'));
    }

    // Sanitize one field you were sanitizing earlier
    const payload = { ...req.body };
    if (payload.headset_number !== undefined) {
      payload.headset_number = sanitizeString(payload.headset_number).toUpperCase();
    }

    const result = await Headset.update(id, payload);

    // Audit log (keep your behavior)
    await db.query(
      `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, old_values, new_values, action_timestamp)
       VALUES (?, 'headset_updated', 'headsets', ?, ?, ?, NOW())`,
      [
        req.user.id,
        id,
        JSON.stringify({ headset_number: headset.headset_number, status: headset.status }),
        JSON.stringify(req.body)
      ]
    );

    console.log(`✅ Headset updated: ID ${id} by ${req.user.name}`);

    res.json(successResponse({ id: parseInt(id, 10), affectedRows: result.affectedRows }, 'Headset updated successfully'));
  } catch (error) {
    console.error('❌ Update headset error:', error);
    res.status(500).json(errorResponse('Failed to update headset'));
  }
};

// ============================================
// DELETE HEADSET (Soft delete - mark as retired)
// ============================================
export const deleteHeadset = async (req, res) => {
  try {
    const { id } = req.params;

    const headset = await Headset.getById(id);
    if (!headset) return res.status(404).json(errorResponse('Headset not found'));

    if (headset.status === 'assigned') {
      return res.status(400).json(errorResponse('Cannot delete an assigned headset. Return it first.'));
    }

    await Headset.retire(id);

    await db.query(
      `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, old_values, new_values, action_timestamp)
       VALUES (?, 'headset_deleted', 'headsets', ?, ?, ?, NOW())`,
      [
        req.user.id,
        id,
        JSON.stringify({ status: headset.status }),
        JSON.stringify({ status: 'retired' })
      ]
    );

    console.log(`✅ Headset retired: ${headset.headset_number} by ${req.user.name}`);

    res.json(successResponse({ id: parseInt(id, 10) }, 'Headset retired successfully'));
  } catch (error) {
    console.error('❌ Delete headset error:', error);
    res.status(500).json(errorResponse('Failed to delete headset'));
  }
};

// ============================================
// GET HEADSET BRANDS
// ============================================
export const getHeadsetBrands = async (req, res) => {
  try {
    const [brands] = await db.query(
      `SELECT id, brand_name, series_prefix, deposit_amount, refund_amount, description
       FROM headset_brands
       ORDER BY brand_name`
    );
    res.json(successResponse(brands));
  } catch (error) {
    console.error('❌ Get brands error:', error);
    res.status(500).json(errorResponse('Failed to fetch headset brands'));
  }
};

// ============================================
// GET AVAILABLE HEADSETS (For assignment dropdown)
// ============================================
export const getAvailableHeadsets = async (req, res) => {
  try {
    const { headset_type, brand_id } = req.query;

    let query = `
      SELECT 
        h.id,
        h.headset_number,
        h.headset_type,
        h.condition_status,
        h.is_brand_new,
        hb.brand_name,
        hb.deposit_amount,
        hb.refund_amount
      FROM headsets h
      JOIN headset_brands hb ON h.brand_id = hb.id
      WHERE h.status = 'available'
    `;

    const params = [];
    if (headset_type) {
      query += ' AND h.headset_type = ?';
      params.push(headset_type);
    }
    if (brand_id) {
      query += ' AND h.brand_id = ?';
      params.push(brand_id);
    }

    query += ' ORDER BY h.headset_number';

    const [headsets] = await db.query(query, params);

    res.json(successResponse(headsets.map(h => ({
      id: h.id,
      headsetNumber: h.headset_number,
      headsetType: h.headset_type,
      condition: h.condition_status,
      isBrandNew: h.is_brand_new === 1,
      brand: h.brand_name,
      depositAmount: h.deposit_amount,
      refundAmount: h.refund_amount
    }))));
  } catch (error) {
    console.error('❌ Get available headsets error:', error);
    res.status(500).json(errorResponse('Failed to fetch available headsets'));
  }
};

// ============================================
// GET HEADSET INVENTORY SUMMARY
// ============================================
export const getInventorySummary = async (req, res) => {
  try {
    const [overall] = await db.query(`
      SELECT 
        COUNT(*) as total,
        SUM(status = 'available') as available,
        SUM(status = 'assigned') as assigned,
        SUM(status = 'repair') as in_repair,
        SUM(status = 'damaged') as damaged,
        SUM(status = 'lost') as lost,
        SUM(status = 'retired') as retired,
        SUM(is_brand_new = 1) as brand_new
      FROM headsets
    `);

    const [byType] = await db.query(`
      SELECT 
        headset_type,
        COUNT(*) as total,
        SUM(status = 'available') as available,
        SUM(status = 'assigned') as assigned,
        SUM(is_brand_new = 1) as brand_new
      FROM headsets
      GROUP BY headset_type
      ORDER BY headset_type
    `);

    const [byBrand] = await db.query(`
      SELECT 
        hb.brand_name,
        COUNT(*) as total,
        SUM(h.status = 'available') as available,
        SUM(h.status = 'assigned') as assigned
      FROM headsets h
      JOIN headset_brands hb ON h.brand_id = hb.id
      GROUP BY hb.brand_name
      ORDER BY hb.brand_name
    `);

    res.json(successResponse({
      overall: overall[0],
      byType: byType.map(t => ({
        type: t.headset_type,
        total: t.total,
        available: t.available,
        assigned: t.assigned,
        brandNew: t.brand_new
      })),
      byBrand: byBrand.map(b => ({
        brand: b.brand_name,
        total: b.total,
        available: b.available,
        assigned: b.assigned
      }))
    }));
  } catch (error) {
    console.error('❌ Get inventory summary error:', error);
    res.status(500).json(errorResponse('Failed to fetch inventory summary'));
  }
};

export default {
  getAllHeadsets,
  getHeadsetById,
  addHeadset,
  updateHeadset,
  deleteHeadset,
  getHeadsetBrands,
  getAvailableHeadsets,
  getInventorySummary
};