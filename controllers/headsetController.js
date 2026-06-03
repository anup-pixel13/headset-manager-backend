import db from '../config/db.js';
import {
  successResponse,
  errorResponse,
  paginatedResponse,
  generateReceiptNumber,
  formatDateMySQL,
  validateHeadsetNumberForType,
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

    const pageNum = parseInt(page) || 1;
    const limitNum = Math.min(parseInt(limit) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    const allowedSortColumns = ['headset_number', 'status', 'condition_status', 'created_at', 'purchase_date'];
    const sortColumn = allowedSortColumns.includes(sort_by) ? sort_by : 'headset_number';
    const sortDir = sort_order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let whereConditions = ['1=1'];
    let params = [];

    if (search) {
      whereConditions.push('(h.headset_number LIKE ? OR u.name LIKE ? OR u.employee_id LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    if (headset_type) {
      whereConditions.push('h.headset_type = ?');
      params.push(headset_type);
    }

    if (status) {
      whereConditions.push('h.status = ?');
      params.push(status);
    }

    if (condition) {
      whereConditions.push('h.condition_status = ?');
      params.push(condition);
    }

    if (is_brand_new !== undefined && is_brand_new !== '') {
      whereConditions.push('h.is_brand_new = ?');
      params.push(is_brand_new === 'true' || is_brand_new === '1' ? 1 : 0);
    }

    if (brand_id) {
      whereConditions.push('h.brand_id = ?');
      params.push(brand_id);
    }

    const whereClause = whereConditions.join(' AND ');

    const [countResult] = await db.query(
      `SELECT COUNT(*) as total
       FROM headsets h
       LEFT JOIN headset_assignments ha ON h.id = ha.headset_id AND ha.is_active = TRUE
       LEFT JOIN agents a ON ha.agent_id = a.id
       LEFT JOIN users u ON a.user_id = u.id
       WHERE ${whereClause}`,
      params
    );

    const total = countResult[0].total;

    const [headsets] = await db.query(
      `SELECT 
        h.id,
        h.headset_number,
        h.headset_type,
        h.status,
        h.condition_status,
        h.is_brand_new,
        h.purchase_date,
        h.warranty_expiry,
        h.image_url_1,
        h.image_url_2,
        h.notes,
        h.created_at,
        h.updated_at,

        hb.brand_name,

        ht.deposit_amount AS tier_deposit_amount,
        ht.refund_amount  AS tier_refund_amount,

		ha.id as assignment_id,
		ha.assignment_date,
		ha.assignment_kind as assignment_kind,
		
        u.id as agent_user_id,
        u.name as assigned_to_name,
        u.employee_id as assigned_to_emp_id,
        u.temp_employee_id as assigned_to_temp_id,

        p.name as process_name
       FROM headsets h
       LEFT JOIN headset_brands hb ON h.brand_id = hb.id

       -- ✅ tier join (for correct deposit/refund)
       LEFT JOIN headset_type_tiers ht
         ON ht.headset_type = h.headset_type AND ht.is_active = 1

       LEFT JOIN headset_assignments ha ON h.id = ha.headset_id AND ha.is_active = TRUE
       LEFT JOIN agents a ON ha.agent_id = a.id
       LEFT JOIN users u ON a.user_id = u.id
       LEFT JOIN processes p ON ha.process_id = p.id
       WHERE ${whereClause}
       ORDER BY h.${sortColumn} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const formattedHeadsets = headsets.map((h) => ({
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

      // brand display only
      brand: {
        name: h.brand_name,
      },

      // ✅ tier amounts used everywhere
      tier: {
        depositAmount: h.tier_deposit_amount ?? 0,
        refundAmount: h.tier_refund_amount ?? 0,
      },

	  assignment: h.assignment_id
	    ? {
	        id: h.assignment_id,
	        assignmentDate: h.assignment_date,

	        // ✅ NEW: used by Inventory card to show TEMP/PERM badge
	        assignmentKind: h.assignment_kind,

	        agent: {
	          id: h.agent_user_id,
	          name: h.assigned_to_name,
	          employeeId: h.assigned_to_emp_id || h.assigned_to_temp_id,
	        },
	        process: h.process_name,
	      }
	    : null,

      createdAt: h.created_at,
      updatedAt: h.updated_at,
    }));

    res.json(paginatedResponse(formattedHeadsets, total, pageNum, limitNum));
  } catch (error) {
    console.error('❌ Get headsets error:', error);
    res.status(500).json(errorResponse('Failed to fetch headsets'));
  }
};
export const getHeadsetAssignments = async (req, res) => {
  try {
    const headsetId = Number(req.params.id);
    if (!headsetId) return res.status(400).json(errorResponse('Invalid headset id'));

    const [rows] = await db.query(
      `
      SELECT
        ha.id,
        ha.assignment_kind,
        ha.is_active,
        ha.assignment_date,
        ha.return_date,
        ha.return_condition,
        ha.notes,

        ha.hold_status,
        ha.hold_reason,
        ha.hold_started_at,
        ha.hold_ended_at,

        a.id AS agent_id,
        u.id AS user_id,
        u.name AS agent_name,
        COALESCE(u.employee_id, u.temp_employee_id) AS employee_id,

        p.id AS process_id,
        p.name AS process_name
      FROM headset_assignments ha
      JOIN agents a ON a.id = ha.agent_id
      JOIN users u ON u.id = a.user_id
      LEFT JOIN processes p ON p.id = ha.process_id
      WHERE ha.headset_id = ?
      ORDER BY ha.id DESC
      `,
      [headsetId]
    );

    const data = rows.map((r) => ({
      id: r.id,
      assignmentKind: r.assignment_kind,
      isActive: Number(r.is_active) === 1,
      assignmentDate: r.assignment_date,
      returnDate: r.return_date,
      returnCondition: r.return_condition,
      notes: r.notes || null,
      hold: {
        status: r.hold_status || null,
        reason: r.hold_reason || null,
        startedAt: r.hold_started_at || null,
        endedAt: r.hold_ended_at || null,
      },
      agent: {
        agentId: r.agent_id,
        userId: r.user_id,
        name: r.agent_name,
        employeeId: r.employee_id || null,
      },
      process: r.process_id ? { id: r.process_id, name: r.process_name } : null,
    }));

    return res.json(successResponse({ headsetId, assignments: data }));
  } catch (e) {
    console.error('❌ getHeadsetAssignments:', e);
    return res.status(500).json(errorResponse('Failed to fetch headset assignments'));
  }
};


export const getHeadsetRepairs = async (req, res) => {
  try {
    const headsetId = Number(req.params.id);
    if (!headsetId) return res.status(400).json(errorResponse('Invalid headset id'));

    const [rows] = await db.query(
      `
      SELECT
        rli.id AS lot_item_id,
        rli.lot_id,
        rli.headset_id,
        rli.condition_before,
        rli.condition_after,
        rli.receive_notes,
        rli.added_at,
        rli.sent_at,
        rli.received_at,

        rl.lot_code,
        rl.brand_group,
        rl.status AS lot_status,
        rl.vendor_name,
        rl.notes AS lot_notes,
        rl.sent_at AS lot_sent_at,
        rl.received_at AS lot_received_at,

        u.id AS received_by_user_id,
        u.name AS received_by_name
      FROM repair_lot_items rli
      JOIN repair_lots rl ON rl.id = rli.lot_id
      LEFT JOIN users u ON u.id = rli.received_by
      WHERE rli.headset_id = ?
      ORDER BY rli.id DESC
      `,
      [headsetId]
    );

    const data = rows.map((r) => ({
      lotItemId: r.lot_item_id,
      lot: {
        id: r.lot_id,
        lotCode: r.lot_code,
        brandGroup: r.brand_group,
        status: r.lot_status,
        vendorName: r.vendor_name || null,
        notes: r.lot_notes || null,
        sentAt: r.lot_sent_at || null,
        receivedAt: r.lot_received_at || null,
      },
      conditionBefore: r.condition_before || null,
      conditionAfter: r.condition_after || null,
      receiveNotes: r.receive_notes || null,
      addedAt: r.added_at || null,
      sentAt: r.sent_at || null,
      receivedAt: r.received_at || null,
      receivedBy: r.received_by_user_id ? { id: r.received_by_user_id, name: r.received_by_name } : null,
    }));

    return res.json(successResponse({ headsetId, repairs: data }));
  } catch (e) {
    console.error('❌ getHeadsetRepairs:', e);
    return res.status(500).json(errorResponse('Failed to fetch headset repairs'));
  }
};

// ============================================
// GET SINGLE HEADSET BY ID
// ============================================
export const getHeadsetById = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Use headset_type_tiers for deposit/refund (tier), not brand
    const [headsets] = await db.query(
      `SELECT 
        h.*,

        hb.brand_name,
        hb.description as brand_description,

        ht.deposit_amount AS tier_deposit_amount,
        ht.refund_amount  AS tier_refund_amount
       FROM headsets h
       LEFT JOIN headset_brands hb 
         ON h.brand_id = hb.id
       LEFT JOIN headset_type_tiers ht
         ON ht.headset_type = h.headset_type
        AND ht.is_active = 1
       WHERE h.id = ?
       LIMIT 1`,
      [id]
    );

    if (headsets.length === 0) {
      return res.status(404).json(errorResponse('Headset not found'));
    }

    const headset = headsets[0];

    // Get current assignment if any
    const [assignments] = await db.query(
      `SELECT 
        ha.*,
        u.name as agent_name,
        u.employee_id,
        u.temp_employee_id,
        u.email as agent_email,
        u.phone as agent_phone,
        p.name as process_name,
        p.category as process_category,
        assigned_by_user.name as assigned_by_name,
        verified_by_user.name as verified_by_name
       FROM headset_assignments ha
       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       JOIN processes p ON ha.process_id = p.id
       LEFT JOIN users assigned_by_user ON ha.assigned_by = assigned_by_user.id
       LEFT JOIN users verified_by_user ON ha.verified_by = verified_by_user.id
       WHERE ha.headset_id = ? AND ha.is_active = TRUE
       LIMIT 1`,
      [id]
    );

    // Get assignment history
    const [history] = await db.query(
      `SELECT 
        ha.id,
        ha.assignment_date,
        ha.return_date,
        ha.return_condition,
        ha.is_verified,
        u.name as agent_name,
        u.employee_id,
        p.name as process_name
       FROM headset_assignments ha
       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       JOIN processes p ON ha.process_id = p.id
       WHERE ha.headset_id = ?
       ORDER BY ha.assignment_date DESC
       LIMIT 10`,
      [id]
    );

    // Get repair history
/*    const [repairs] = await db.query(
      `SELECT 
        r.*,
        reported_by_user.name as reported_by_name,
        received_by_user.name as received_by_name
       FROM repairs r
       LEFT JOIN users reported_by_user ON r.reported_by = reported_by_user.id
       LEFT JOIN users received_by_user ON r.received_by = received_by_user.id
       WHERE r.headset_id = ?
       ORDER BY r.sent_for_repair_date DESC
       LIMIT 10`,
      [id]
    );*/

    return res.json(
      successResponse({
        id: headset.id,
        headsetNumber: headset.headset_number,
        headsetType: headset.headset_type,
        status: headset.status,
        condition: headset.condition_status,
        isBrandNew: headset.is_brand_new === 1,
        purchaseDate: headset.purchase_date,
        warrantyExpiry: headset.warranty_expiry,
        images: [headset.image_url_1, headset.image_url_2].filter(Boolean),
		// ✅ FIX: guard against no active assignment (was crashing with
		// "Cannot read properties of undefined (reading 'assignment_kind')")
		assignmentKind: assignments[0]?.assignment_kind ?? null,
        notes: headset.notes,

        // ✅ Brand is for display only
        brand: {
          id: headset.brand_id,
          name: headset.brand_name,
          description: headset.brand_description,
        },

        // ✅ Tier amounts (correct for VOIX non-ENC too)
        tier: {
          depositAmount: headset.tier_deposit_amount ?? 0,
          refundAmount: headset.tier_refund_amount ?? 0,
        },

        currentAssignment:
          assignments.length > 0
            ? {
                id: assignments[0].id,
                assignmentDate: assignments[0].assignment_date,
				assignmentKind: assignments[0].assignment_kind || null,
                isVerified: assignments[0].is_verified === 1,
                verificationDate: assignments[0].verification_date,
                agent: {
                  name: assignments[0].agent_name,
                  employeeId: assignments[0].employee_id || assignments[0].temp_employee_id,
                  email: assignments[0].agent_email,
                  phone: assignments[0].agent_phone,
                },
                process: {
                  name: assignments[0].process_name,
                  category: assignments[0].process_category,
                },
                assignedBy: assignments[0].assigned_by_name,
                verifiedBy: assignments[0].verified_by_name,
              }
            : null,

        assignmentHistory: history.map((h) => ({
          id: h.id,
          agentName: h.agent_name,
          employeeId: h.employee_id,
          process: h.process_name,
          assignmentDate: h.assignment_date,
          returnDate: h.return_date,
          returnCondition: h.return_condition,
          isVerified: h.is_verified === 1,
        })),

  /*      repairHistory: repairs.map((r) => ({
          id: r.id,
          issueType: r.issue_type,
          issueDescription: r.issue_description,
          sentDate: r.sent_for_repair_date,
          returnDate: r.actual_return_date,
          status: r.repair_status,
          cost: r.repair_cost,
          vendor: r.repair_vendor,
          reportedBy: r.reported_by_name,
          receivedBy: r.received_by_name,
        })),
*/
        createdAt: headset.created_at,
        updatedAt: headset.updated_at,
      })
    );
  } catch (error) {
    console.error('❌ Get headset by ID error:', error);
    return res.status(500).json(errorResponse('Failed to fetch headset details'));
  }
};



// POST /api/headsets/:id/mark-damaged
export const markHeadsetDamaged = async (req, res) => {
  try {
    const headsetId = Number(req.params.id);
    const { remarks = null } = req.body || {};

    if (!headsetId) return res.status(400).json(errorResponse('Invalid headset id'));

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [rows] = await conn.query(`SELECT id, status FROM headsets WHERE id = ? LIMIT 1`, [headsetId]);
      if (!rows.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Headset not found'));
      }

      // Mark damaged so it appears in Repairs search (no auto lot creation)
      await conn.query(
        `UPDATE headsets
         SET status = 'damaged',
             condition_status = 'damaged',
             updated_at = NOW()
         WHERE id = ?`,
        [headsetId]
      );

      // Optional audit note: append to latest active assignment notes (if exists) but DO NOT close assignment
      if (remarks) {
        await conn.query(
          `UPDATE headset_assignments
           SET notes = CONCAT(IFNULL(notes,''), ?),
               updated_at = NOW()
           WHERE headset_id = ?
             AND is_active = 1
           ORDER BY id DESC
           LIMIT 1`,
          [` | Inventory: marked damaged. ${remarks}`, headsetId]
        );
      }

      await conn.commit();
      conn.release();
      return res.json(successResponse({ headsetId }, 'Headset marked as damaged'));
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ markHeadsetDamaged:', e);
    return res.status(500).json(errorResponse('Failed to mark headset damaged'));
  }
};

// POST /api/headsets/:id/mark-lost
// Requirement: close active assignment with remark/differentiator
export const markHeadsetLost = async (req, res) => {
  try {
    const headsetId = Number(req.params.id);
    const { remarks = null } = req.body || {};

    if (!headsetId) return res.status(400).json(errorResponse('Invalid headset id'));

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [rows] = await conn.query(`SELECT id, status FROM headsets WHERE id = ? LIMIT 1`, [headsetId]);
      if (!rows.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Headset not found'));
      }

      // 1) Close any active assignment for this headset (if exists)
      const closeNote = remarks ? ` | Inventory: marked lost. ${remarks}` : ' | Inventory: marked lost.';
      await conn.query(
        `UPDATE headset_assignments
         SET is_active = 0,
             return_date = NOW(),
             return_condition = 'lost',
             notes = CONCAT(IFNULL(notes,''), ?),
             updated_at = NOW()
         WHERE headset_id = ?
           AND is_active = 1`,
        [closeNote, headsetId]
      );

      // 2) Mark headset lost
      await conn.query(
        `UPDATE headsets
         SET status = 'lost',
             condition_status = 'lost',
             updated_at = NOW()
         WHERE id = ?`,
        [headsetId]
      );

      await conn.commit();
      conn.release();
      return res.json(successResponse({ headsetId }, 'Headset marked as lost'));
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ markHeadsetLost:', e);
    return res.status(500).json(errorResponse('Failed to mark headset lost'));
  }
};

// POST /api/headsets/:id/retire
// Only allowed if headset has no active assignment
export const retireHeadset = async (req, res) => {
  try {
    const headsetId = Number(req.params.id);
    const { remarks = null } = req.body || {};

    if (!headsetId) return res.status(400).json(errorResponse('Invalid headset id'));

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [rows] = await conn.query(`SELECT id, status FROM headsets WHERE id = ? LIMIT 1`, [headsetId]);
      if (!rows.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Headset not found'));
      }

      const [activeAssign] = await conn.query(
        `SELECT id
         FROM headset_assignments
         WHERE headset_id = ?
           AND is_active = 1
         LIMIT 1`,
        [headsetId]
      );

      if (activeAssign.length) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Cannot retire: headset is currently assigned'));
      }

      await conn.query(
        `UPDATE headsets
         SET status = 'retired',
             updated_at = NOW()
         WHERE id = ?`,
        [headsetId]
      );

      // Optional: store remarks somewhere if you have a notes column on headsets
      // If you do: UPDATE headsets SET notes = CONCAT(IFNULL(notes,''), ?) ...
      if (remarks) {
        // no-op unless you want to add a headset_notes table
      }

      await conn.commit();
      conn.release();
      return res.json(successResponse({ headsetId }, 'Headset retired'));
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ retireHeadset:', e);
    return res.status(500).json(errorResponse('Failed to retire headset'));
  }
};
// ============================================
// ADD NEW HEADSET (SAFE VERSION)
// ============================================
export const addHeadset = async (req, res) => {
  try {
    // For multipart/form-data, text fields come in req.body and files in req.files
    const headset_number = req.body?.headset_number;
    const brand_id = req.body?.brand_id;
    const headset_type = req.body?.headset_type;

    const purchase_date = req.body?.purchase_date || null;
    const warranty_expiry = req.body?.warranty_expiry || null;
    const notes = req.body?.notes || null;

    // ✅ Require 2 images
    const file1 = req.files?.image1?.[0];
    const file2 = req.files?.image2?.[0];
	
	const allowedTypes = ['voix_enc', 'voix_2xx', 'voix_3xx', 'voix_nxx', 'voix_xxx', 'tech', 'ojt', 'yjack'];
	if (!allowedTypes.includes(headset_type)) {
	  return res.status(400).json({
	    success: false,
	    message: `Invalid headset_type. Allowed: ${allowedTypes.join(', ')}`
	  });
	}

    if (!file1 || !file2) {
      return res.status(400).json({
        success: false,
        message: 'Two images are required (image1 and image2).'
      });
    }

    // Validation
    if (!headset_number || !brand_id || !headset_type) {
      return res.status(400).json({
        success: false,
        message: 'Headset number, brand_id, and headset_type are required',
        received: { headset_number, brand_id, headset_type }
      });
    }

	const v = validateHeadsetNumberForType(headset_number, headset_type);
	if (!v.ok) {
	  return res.status(400).json({ success: false, message: v.reason });
	}
	const cleanHeadsetNumber = v.normalized;

    // Check if exists
    const [existing] = await db.query(
      'SELECT id FROM headsets WHERE headset_number = ?',
      [cleanHeadsetNumber]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Headset number ${cleanHeadsetNumber} already exists`
      });
    }

    // ✅ Save image URLs (served via /uploads static)
    // file.filename is stored in uploads/headset-images
    const image_url_1 = `/uploads/headset-images/${file1.filename}`;
    const image_url_2 = `/uploads/headset-images/${file2.filename}`;

    // Insert
    const [result] = await db.query(
      `INSERT INTO headsets (
        headset_number, brand_id, headset_type, status, condition_status,
        is_brand_new, purchase_date, warranty_expiry, image_url_1, image_url_2, notes
      ) VALUES (?, ?, ?, 'available', 'brand_new', TRUE, ?, ?, ?, ?, ?)`,
      [
        cleanHeadsetNumber,
        brand_id,
        headset_type,
        purchase_date,
        warranty_expiry,
        image_url_1,
        image_url_2,
        notes
      ]
    );

    console.log(`✅ Headset added: ${cleanHeadsetNumber} (ID: ${result.insertId})`);

    res.status(201).json({
      success: true,
      message: `Headset ${cleanHeadsetNumber} added successfully`,
      data: {
        id: result.insertId,
        headsetNumber: cleanHeadsetNumber,
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
    const {
      headset_number,
      brand_id,
      headset_type,
      status,
      condition_status,
      is_brand_new,
      purchase_date,
      warranty_expiry,
      image_url_1,
      image_url_2,
      notes
    } = req.body;

    // Check if headset exists
    const [existing] = await db.query('SELECT * FROM headsets WHERE id = ?', [id]);

    if (existing.length === 0) {
      return res.status(404).json(errorResponse('Headset not found'));
    }

    const oldData = existing[0];
	
	const finalType = headset_type !== undefined ? headset_type : oldData.headset_type;
	const finalNumber = headset_number !== undefined ? headset_number : oldData.headset_number;

	const v = validateHeadsetNumberForType(finalNumber, finalType);
	if (!v.ok) return res.status(400).json(errorResponse(v.reason));

    // If changing headset number, check for duplicates
    if (headset_number && headset_number !== oldData.headset_number) {
      const [duplicate] = await db.query(
        'SELECT id FROM headsets WHERE headset_number = ? AND id != ?',
        [headset_number, id]
      );
      if (duplicate.length > 0) {
        return res.status(400).json(errorResponse('Headset number already exists'));
      }
    }

    // Build update query dynamically
    const updates = [];
    const values = [];

	if (headset_number !== undefined) {
	  updates.push('headset_number = ?');
	  values.push(v.normalized);
	}
    if (brand_id !== undefined) {
      updates.push('brand_id = ?');
      values.push(brand_id);
    }
    if (headset_type !== undefined) {
      updates.push('headset_type = ?');
      values.push(headset_type);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }
    if (condition_status !== undefined) {
      updates.push('condition_status = ?');
      values.push(condition_status);
    }
    if (is_brand_new !== undefined) {
      updates.push('is_brand_new = ?');
      values.push(is_brand_new ? 1 : 0);
    }
    if (purchase_date !== undefined) {
      updates.push('purchase_date = ?');
      values.push(purchase_date || null);
    }
    if (warranty_expiry !== undefined) {
      updates.push('warranty_expiry = ?');
      values.push(warranty_expiry || null);
    }
    if (image_url_1 !== undefined) {
      updates.push('image_url_1 = ?');
      values.push(image_url_1 || null);
    }
    if (image_url_2 !== undefined) {
      updates.push('image_url_2 = ?');
      values.push(image_url_2 || null);
    }
    if (notes !== undefined) {
      updates.push('notes = ?');
      values.push(notes || null);
    }

    if (updates.length === 0) {
      return res.status(400).json(errorResponse('No fields to update'));
    }

    updates.push('updated_at = NOW()');
    values.push(id);

    await db.query(
      `UPDATE headsets SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    // Audit log
    await db.query(
      `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, old_values, new_values, action_timestamp)
       VALUES (?, 'headset_updated', 'headsets', ?, ?, ?, NOW())`,
      [
        req.user.id,
        id,
        JSON.stringify({ headset_number: oldData.headset_number, status: oldData.status }),
        JSON.stringify(req.body)
      ]
    );

    console.log(`✅ Headset updated: ID ${id} by ${req.user.name}`);

    res.json(successResponse({ id: parseInt(id) }, 'Headset updated successfully'));

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

    // Check if headset exists
    const [existing] = await db.query('SELECT * FROM headsets WHERE id = ?', [id]);

    if (existing.length === 0) {
      return res.status(404).json(errorResponse('Headset not found'));
    }

    const headset = existing[0];

    // Check if currently assigned
    if (headset.status === 'assigned') {
      return res.status(400).json(errorResponse('Cannot delete an assigned headset. Return it first.'));
    }

    // Soft delete - mark as retired
    await db.query(
      'UPDATE headsets SET status = ?, updated_at = NOW() WHERE id = ?',
      ['retired', id]
    );

    // Audit log
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

    res.json(successResponse({ id: parseInt(id) }, 'Headset retired successfully'));

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

        ht.deposit_amount AS tier_deposit_amount,
        ht.refund_amount  AS tier_refund_amount
      FROM headsets h
      JOIN headset_brands hb ON h.brand_id = hb.id
      JOIN headset_type_tiers ht 
        ON ht.headset_type = h.headset_type AND ht.is_active = 1
      WHERE h.status = 'available'
	  AND (h.condition_status IS NULL OR h.condition_status NOT IN ('damaged','lost','repair'))
      -- ✅ Exclude "reserved originals":
      -- if this headset is the original headset in a permanent assignment that currently has an active temp_replacement child
      AND h.id NOT IN (
        SELECT orig.headset_id
        FROM headset_assignments orig
        JOIN headset_assignments temp
          ON temp.parent_assignment_id = orig.id
         AND temp.assignment_kind = 'temp_replacement'
         AND temp.is_active = 1
        WHERE orig.assignment_kind = 'permanent'
          AND orig.is_active = 1
      )
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

    res.json(
      successResponse(
        headsets.map((h) => ({
          id: h.id,
          headsetNumber: h.headset_number,
          headsetType: h.headset_type,
          condition: h.condition_status,
          isBrandNew: h.is_brand_new === 1,
          brand: h.brand_name,

          // ✅ tier based
          depositAmount: h.tier_deposit_amount ?? 0,
          refundAmount: h.tier_refund_amount ?? 0,
        }))
      )
    );
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
    // Overall summary
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

    // By type
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

    // By brand
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
