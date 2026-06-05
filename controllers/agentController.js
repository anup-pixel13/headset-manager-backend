import db from '../config/database.js';
import {
  successResponse,
  errorResponse,
  paginatedResponse,
  sanitizeString
} from '../utils/helpers.js';
import crypto from 'crypto';

const passwordHash = `DISABLED_${crypto.randomBytes(10).toString('hex')}`;

// ============================================
// GET ALL AGENTS (with filters & pagination)
// ============================================
export const getAllAgents = async (req, res) => {
  try {
	const {
	  search,
	  status,
	  user_is_active,
	  process_id,
	  manager_id,
	  tl_id,
	  has_headset,
	  pending_employee_id,
	  created_from,
	  created_to,
	  page = 1,
	  limit = 20,
	  sort_by = 'name',
	  sort_order = 'ASC'
	} = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    // Validate sort columns (note: sort uses u.<column> below)
    const allowedSortColumns = ['name', 'employee_id', 'status', 'created_at', 'floor_join_date'];
    const sortColumn = allowedSortColumns.includes(sort_by) ? sort_by : 'name';
    const sortDir = String(sort_order).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    // Build WHERE clause
    const whereConditions = ['1=1'];
    const params = [];

    if (search) {
      whereConditions.push(`(
        u.name LIKE ? OR 
        u.employee_id LIKE ? OR 
        u.temp_employee_id LIKE ? OR
        u.email LIKE ? OR
        u.phone LIKE ?
      )`);
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (status) {
      whereConditions.push('a.status = ?');
      params.push(status);
    }

    // ✅ NEW: filter by users.is_active (login enabled)
    if (user_is_active !== undefined && user_is_active !== '') {
      whereConditions.push('u.is_active = ?');
      params.push(user_is_active === 'true' || user_is_active === '1' ? 1 : 0);
    }

    if (process_id) {
      whereConditions.push('a.process_id = ?');
      params.push(process_id);
    }

    if (manager_id) {
      whereConditions.push('a.manager_id = ?');
      params.push(manager_id);
    }

    if (tl_id) {
      whereConditions.push('a.tl_id = ?');
      params.push(tl_id);
    }

    if (pending_employee_id === 'true') {
      whereConditions.push('u.permanent_id_pending = 1');
    }
	
	if (created_from) {
	  whereConditions.push('DATE(u.joining_date) >= ?');
	  params.push(created_from);
	}

	if (created_to) {
	  whereConditions.push('DATE(u.joining_date) <= ?');
	  params.push(created_to);
	}

    // Filter by has_headset
    if (has_headset === 'true') {
      whereConditions.push('ha.id IS NOT NULL');
    } else if (has_headset === 'false') {
      whereConditions.push('ha.id IS NULL');
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count
	const [countResult] = await db.query(
	  `SELECT COUNT(DISTINCT a.id) as total
	   FROM agents a
	   JOIN users u ON a.user_id = u.id
	   LEFT JOIN (
	     SELECT
	       agent_id,
	       MAX(CASE WHEN assignment_kind = 'temp_replacement' AND is_active = 1 THEN 1 ELSE 0 END) AS has_temp_replacement,
	       MAX(CASE WHEN assignment_kind = 'permanent' AND is_active = 1 AND hold_status = 'on_hold' THEN 1 ELSE 0 END) AS has_permanent_on_hold,
	       MAX(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS has_any_active
	     FROM headset_assignments
	     GROUP BY agent_id
	   ) ha_state ON ha_state.agent_id = a.id
	   WHERE ${whereClause.replace(/ha\.id IS NOT NULL/g, 'COALESCE(ha_state.has_any_active, 0) = 1').replace(/ha\.id IS NULL/g, 'COALESCE(ha_state.has_any_active, 0) = 0')}`,
	  params
	);
    const total = countResult?.[0]?.total ?? 0;

    // Get agents
	const [agents] = await db.query(
	  `SELECT 
	    a.id as agent_id,
	    a.status as agent_status,
	    a.training_start_date,
	    a.training_end_date,
	    a.ojt_start_date,
	    a.ojt_end_date,
	    a.floor_join_date,
	    a.resignation_date,

	    u.id as user_id,
	    u.employee_id,
	    u.temp_employee_id,
	    u.name,
	    u.email,
	    u.phone,
	    u.role,
	    u.is_active as user_is_active,
	    u.permanent_id_pending,
	    u.joining_date,

	    p.id as process_id,
	    p.name as process_name,
	    p.category as process_category,

	    mgr.name as manager_name,
	    tl.name as tl_name,
	    trainer.name as trainer_name,

	    ah.assignment_id,
	    ah.assignment_kind,
	    ah.hold_status,
	    ah.headset_number,
	    ah.headset_type,

	    COALESCE(ha_state.has_temp_replacement, 0) as has_temp_replacement,
	    COALESCE(ha_state.has_permanent_on_hold, 0) as has_permanent_on_hold

	   FROM agents a
	   JOIN users u ON a.user_id = u.id
	   LEFT JOIN processes p ON a.process_id = p.id
	   LEFT JOIN users mgr ON a.manager_id = mgr.id
	   LEFT JOIN users tl ON a.tl_id = tl.id
	   LEFT JOIN users trainer ON a.trainer_id = trainer.id

	   LEFT JOIN (
	     SELECT
	       x.agent_id,
	       x.id as assignment_id,
	       x.assignment_kind,
	       x.hold_status,
	       h.headset_number,
	       h.headset_type
	     FROM headset_assignments x
	     JOIN headsets h ON h.id = x.headset_id
	     JOIN (
	       SELECT
	         agent_id,
	         COALESCE(
	           MAX(CASE WHEN assignment_kind = 'temp_replacement' AND is_active = 1 THEN id END),
	           MAX(CASE WHEN assignment_kind = 'permanent' AND is_active = 1 THEN id END)
	         ) as picked_assignment_id
	       FROM headset_assignments
	       GROUP BY agent_id
	     ) pick ON pick.picked_assignment_id = x.id
	   ) ah ON ah.agent_id = a.id

	   LEFT JOIN (
	     SELECT
	       agent_id,
	       MAX(CASE WHEN assignment_kind = 'temp_replacement' AND is_active = 1 THEN 1 ELSE 0 END) AS has_temp_replacement,
	       MAX(CASE WHEN assignment_kind = 'permanent' AND is_active = 1 AND hold_status = 'on_hold' THEN 1 ELSE 0 END) AS has_permanent_on_hold,
	       MAX(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS has_any_active
	     FROM headset_assignments
	     GROUP BY agent_id
	   ) ha_state ON ha_state.agent_id = a.id

	   WHERE ${
	     whereClause
	       .replace(/ha\.id IS NOT NULL/g, 'COALESCE(ha_state.has_any_active, 0) = 1')
	       .replace(/ha\.id IS NULL/g, 'COALESCE(ha_state.has_any_active, 0) = 0')
	   }
	   ORDER BY u.${sortColumn} ${sortDir}
	   LIMIT ? OFFSET ?`,
	  [...params, limitNum, offset]
	);

    // Format response
    const formattedAgents = agents.map(a => ({
      id: a.agent_id,
      userId: a.user_id,
      employeeId: a.employee_id || a.temp_employee_id,
      isTemporaryId: !a.employee_id && !!a.temp_employee_id,
      permanentIdPending: a.permanent_id_pending === 1,
      name: a.name,
      email: a.email,
      phone: a.phone,
      role: a.role,

      // ✅ BOTH status signals returned
      status: a.agent_status,
      userIsActive: a.user_is_active === 1,

      joiningDate: a.joining_date,
      trainingStartDate: a.training_start_date,
      trainingEndDate: a.training_end_date,
      ojtStartDate: a.ojt_start_date,
      ojtEndDate: a.ojt_end_date,
      floorJoinDate: a.floor_join_date,
      resignationDate: a.resignation_date,

      process: a.process_id ? {
        id: a.process_id,
        name: a.process_name,
        category: a.process_category
      } : null,

      manager: a.manager_name,
      teamLeader: a.tl_name,
      trainer: a.trainer_name,

	  headset: a.assignment_id ? {
	    assignmentId: a.assignment_id,
	    headsetNumber: a.headset_number,
	    headsetType: a.headset_type,
	    assignmentKind: a.assignment_kind || null,
	    holdStatus: a.hold_status || null,
	  } : null,

	  repairReplacementFlow:
	    Number(a.has_temp_replacement) === 1 &&
	    Number(a.has_permanent_on_hold) === 1,
    }));

    return res.json(paginatedResponse(formattedAgents, total, pageNum, limitNum));
  } catch (error) {
    console.error('❌ Get agents error:', error);
    return res.status(500).json(errorResponse('Failed to fetch agents'));
  }
};

// ============================================
// GET DEASSIGN FORM DATA
// GET /api/agents/:id/deassign-form
// ============================================
export const getDeassignFormData = async (req, res) => {
  try {
    const { id } = req.params;

    // Agent + current active assignment + tier refund
    const [rows] = await db.query(
      `SELECT
        a.id AS agent_id,
        a.status AS agent_status,
        u.id AS user_id,
        u.role AS user_role,
        u.name AS agent_name,
        COALESCE(u.employee_id, u.temp_employee_id) AS employee_id,
        u.is_active AS user_is_active,

        ha.id AS assignment_id,
        ha.assignment_date,
        ha.is_verified,
        ha.is_active AS assignment_is_active,
        ha.process_id,

        h.id AS headset_id,
        h.headset_number,
        h.headset_type,
        h.status AS headset_status,
        h.condition_status AS headset_condition,

        ht.refund_amount AS tier_refund_amount,
        ht.deposit_amount AS tier_deposit_amount,

        d.id AS deposit_id,
        d.deposit_amount AS paid_deposit,
        d.refund_status,
        d.receipt_number

      FROM agents a
      JOIN users u ON a.user_id = u.id

      LEFT JOIN headset_assignments ha
        ON ha.agent_id = a.id AND ha.is_active = 1

      LEFT JOIN headsets h
        ON h.id = ha.headset_id

      LEFT JOIN headset_type_tiers ht
        ON ht.headset_type = h.headset_type AND ht.is_active = 1

      LEFT JOIN deposits d
        ON d.assignment_id = ha.id
       AND d.deposit_type IN ('voix','tech')

      WHERE a.id = ?
      LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json(errorResponse('Agent not found'));
    }

    const r = rows[0];

    // Safety: this endpoint should only be used for agent users (not admin)
    if (r.user_role && r.user_role !== 'agent') {
      return res.status(400).json(errorResponse('Only agent users can be de-assigned'));
    }

    // ✅ NEW: refund basis rule
    // If an agent EVER had an ENC headset (any stage in lifecycle), refund should be 1100 and deposit paid 1750.
    // We compute this by finding any assignment where headset_type='voix_enc'.
    // If found, we use the earliest such assignment as the "basis".
    const [encRows] = await db.query(
      `SELECT
         ha.id AS assignment_id,
         ha.assignment_date,

         h.id AS headset_id,
         h.headset_number,
         h.headset_type,

         ht.refund_amount AS tier_refund_amount,
         ht.deposit_amount AS tier_deposit_amount,

         d.id AS deposit_id,
         d.deposit_amount AS paid_deposit,
         d.refund_status,
         d.receipt_number
       FROM headset_assignments ha
       JOIN headsets h ON h.id = ha.headset_id
       LEFT JOIN headset_type_tiers ht
         ON ht.headset_type = h.headset_type AND ht.is_active = 1
       LEFT JOIN deposits d
         ON d.assignment_id = ha.id
        AND d.deposit_type IN ('voix','tech')
		WHERE ha.agent_id = ?
		  AND h.headset_type = 'voix_enc'
		  AND COALESCE(ha.assignment_kind, 'permanent') = 'permanent'
       ORDER BY ha.assignment_date ASC
       LIMIT 1`,
      [id]
    );

    const hasEverEnc = encRows.length > 0;
    const enc = encRows[0] || null;

    const data = {
      agent: {
        id: r.agent_id,
        userId: r.user_id,
        name: r.agent_name,
        employeeId: r.employee_id,
        userIsActive: r.user_is_active === 1,
        status: r.agent_status,
      },
      current: r.assignment_id
        ? {
            assignmentId: r.assignment_id,
            assignmentDate: r.assignment_date,
            isVerified: r.is_verified === 1,
            processId: r.process_id,
            headset: {
              id: r.headset_id,
              headsetNumber: r.headset_number,
              headsetType: r.headset_type,
              status: r.headset_status,
              condition: r.headset_condition,
            },
            deposit: r.deposit_id
              ? {
                  id: r.deposit_id,
                  paidDeposit: r.paid_deposit,
                  refundStatus: r.refund_status,
                  receiptNumber: r.receipt_number,
                }
              : null,
            tier: {
              depositAmount: r.tier_deposit_amount ?? null,
              refundAmount: r.tier_refund_amount ?? null,
            },
          }
        : null,

      // ✅ NEW: return refund basis for UI (always visible)
      refundBasis: hasEverEnc
        ? {
            kind: 'ever_enc',
            assignmentId: enc.assignment_id,
            assignmentDate: enc.assignment_date,
            headset: {
              id: enc.headset_id,
              headsetNumber: enc.headset_number,
              headsetType: enc.headset_type,
            },
            deposit: enc.deposit_id
              ? {
                  id: enc.deposit_id,
                  paidDeposit: enc.paid_deposit,
                  refundStatus: enc.refund_status,
                  receiptNumber: enc.receipt_number,
                }
              : null,
            tier: {
              depositAmount: enc.tier_deposit_amount ?? null,
              refundAmount: enc.tier_refund_amount ?? null,
            },
          }
        : null,

      defaults: {
        // If agent ever had ENC, expected refund should be the ENC tier refund.
        refundAmount: hasEverEnc ? (enc?.tier_refund_amount ?? 1100) : (r.tier_refund_amount ?? 0),
      },

      // UI options
      reasons: ['abscond', 'resign', 'terminated'],

      // Important: these must match your DB enum after you alter it
      returnConditions: ['good', 'satisfactory', 'decent', 'fair', 'bad', 'repair', 'damaged', 'lost'],
    };

    return res.json(successResponse(data));
  } catch (error) {
    console.error('❌ Get deassign form data error:', error);
    return res.status(500).json(errorResponse('Failed to load de-assign form data'));
  }
};

// ============================================
// GET SINGLE AGENT BY ID
// ============================================
export const getAgentById = async (req, res) => {
  try {
    const { id } = req.params;

    const [agents] = await db.query(
      `SELECT 
        a.*,
        u.id as user_id,
        u.employee_id,
        u.temp_employee_id,
        u.name,
        u.email,
        u.phone,
        u.role,
        u.permanent_id_pending,
        u.joining_date,
        u.is_active,
        p.id as process_id,
        p.name as process_name,
        p.category as process_category,
        p.deposit_amount,
        p.refund_amount,
        mgr.id as manager_id,
        mgr.name as manager_name,
        tl.id as tl_id,
        tl.name as tl_name,
        trainer.id as trainer_id,
        trainer.name as trainer_name
       FROM agents a
       JOIN users u ON a.user_id = u.id
       LEFT JOIN processes p ON a.process_id = p.id
       LEFT JOIN users mgr ON a.manager_id = mgr.id
       LEFT JOIN users tl ON a.tl_id = tl.id
       LEFT JOIN users trainer ON a.trainer_id = trainer.id
       WHERE a.id = ?`,
      [id]
    );

    if (agents.length === 0) {
      return res.status(404).json(errorResponse('Agent not found'));
    }

    const agent = agents[0];

    // Get current headset assignment
    const [assignments] = await db.query(
      `SELECT 
        ha.*,
        h.headset_number,
        h.headset_type,
        h.condition_status,
        hb.brand_name,
        hb.deposit_amount,
        hb.refund_amount,
        d.id as deposit_id,
        d.deposit_amount as paid_deposit,
        d.refund_status,
        d.receipt_number
       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN headset_brands hb ON h.brand_id = hb.id
       LEFT JOIN deposits d ON ha.id = d.assignment_id
       WHERE ha.agent_id = ? AND ha.is_active = 1`,
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
        h.headset_number,
        h.headset_type,
        p.name as process_name,
        d.deposit_amount,
        d.refund_amount,
        d.refund_status
       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN processes p ON ha.process_id = p.id
       LEFT JOIN deposits d ON ha.id = d.assignment_id
       WHERE ha.agent_id = ?
       ORDER BY ha.assignment_date DESC
       LIMIT 10`,
      [id]
    );

    // Get deposit history
    const [deposits] = await db.query(
      `SELECT 
        d.*,
        h.headset_number
       FROM deposits d
       JOIN headsets h ON d.headset_id = h.id
       WHERE d.agent_id = ?
       ORDER BY d.deposit_date DESC
       LIMIT 10`,
      [id]
    );

    return res.json(successResponse({
      id: agent.id,
      userId: agent.user_id,
      employeeId: agent.employee_id || agent.temp_employee_id,
      isTemporaryId: !agent.employee_id && !!agent.temp_employee_id,
      permanentIdPending: agent.permanent_id_pending === 1,
      name: agent.name,
      email: agent.email,
      phone: agent.phone,
      role: agent.role,

      // users.is_active (login flag)
      isActive: agent.is_active === 1,

      // agents.status (lifecycle)
      status: agent.status,

      joiningDate: agent.joining_date,
      training: {
        startDate: agent.training_start_date,
        endDate: agent.training_end_date
      },
      ojt: {
        startDate: agent.ojt_start_date,
        endDate: agent.ojt_end_date
      },
      floorJoinDate: agent.floor_join_date,
      resignationDate: agent.resignation_date,
      process: agent.process_id ? {
        id: agent.process_id,
        name: agent.process_name,
        category: agent.process_category,
        depositAmount: agent.deposit_amount,
        refundAmount: agent.refund_amount
      } : null,
      manager: agent.manager_id ? {
        id: agent.manager_id,
        name: agent.manager_name
      } : null,
      teamLeader: agent.tl_id ? {
        id: agent.tl_id,
        name: agent.tl_name
      } : null,
      trainer: agent.trainer_id ? {
        id: agent.trainer_id,
        name: agent.trainer_name
      } : null,
      currentHeadset: assignments.length > 0 ? {
        assignmentId: assignments[0].id,
        headsetNumber: assignments[0].headset_number,
        headsetType: assignments[0].headset_type,
        condition: assignments[0].condition_status,
        brand: assignments[0].brand_name,
        assignmentDate: assignments[0].assignment_date,
        isVerified: assignments[0].is_verified === 1,
        deposit: {
          id: assignments[0].deposit_id,
          amount: assignments[0].paid_deposit,
          refundStatus: assignments[0].refund_status,
          receiptNumber: assignments[0].receipt_number
        }
      } : null,
      assignmentHistory: history.map(h => ({
        id: h.id,
        headsetNumber: h.headset_number,
        headsetType: h.headset_type,
        process: h.process_name,
        assignmentDate: h.assignment_date,
        returnDate: h.return_date,
        returnCondition: h.return_condition,
        isVerified: h.is_verified === 1,
        depositAmount: h.deposit_amount,
        refundAmount: h.refund_amount,
        refundStatus: h.refund_status
      })),
      depositHistory: deposits.map(d => ({
        id: d.id,
        headsetNumber: d.headset_number,
        type: d.deposit_type,
        amount: d.deposit_amount,
        refundAmount: d.refund_amount,
        refundStatus: d.refund_status,
        depositDate: d.deposit_date,
        refundDate: d.refund_date,
        receiptNumber: d.receipt_number,
        paymentMode: d.payment_mode
      }))
    }));
  } catch (error) {
    console.error('❌ Get agent by ID error:', error);
    return res.status(500).json(errorResponse('Failed to fetch agent details'));
  }
};

// ============================================
// GET AGENTS FOR DROPDOWN (Simple list)
// ============================================
export const getAgentsForDropdown = async (req, res) => {
  try {
    const { status, has_headset, process_id, include_inactive } = req.query;

	let query = `
	  SELECT 
	    a.id,
	    u.name,
	    COALESCE(u.employee_id, u.temp_employee_id) as employee_id,
	    a.status,
	    p.name as process_name,
	    COALESCE(ha2.has_active_assignment, 0) as has_active_assignment
	  FROM agents a
	  JOIN users u ON a.user_id = u.id
	  LEFT JOIN processes p ON a.process_id = p.id
	  LEFT JOIN (
	    SELECT agent_id, 1 as has_active_assignment
	    FROM headset_assignments
	   WHERE is_active = 1 AND assignment_kind = 'permanent'
	    GROUP BY agent_id
	  ) ha2 ON ha2.agent_id = a.id
	  WHERE 1=1
	`;

    const params = [];

    // Default dropdown shows only active logins unless include_inactive=true
    if (include_inactive !== 'true') {
      query += ' AND u.is_active = 1';
    }

    if (status) {
      query += ' AND a.status = ?';
      params.push(status);
    }

    if (process_id) {
      query += ' AND a.process_id = ?';
      params.push(process_id);
    }

	if (has_headset === 'false') {
	  query += ' AND COALESCE(ha2.has_active_assignment, 0) = 0';
	} else if (has_headset === 'true') {
	  query += ' AND COALESCE(ha2.has_active_assignment, 0) = 1';
	}

    query += ' ORDER BY u.name';

    const [agents] = await db.query(query, params);

    return res.json(successResponse(agents.map(a => ({
      id: a.id,
      name: a.name,
      employeeId: a.employee_id,
      status: a.status,
      process: a.process_name,
     hasHeadset: Number(a.has_active_assignment) === 1
    }))));
  } catch (error) {
    console.error('❌ Get agents dropdown error:', error);
    return res.status(500).json(errorResponse('Failed to fetch agents'));
  }
};

// ============================================
// GET AGENTS WITH PENDING EMPLOYEE ID
// ============================================
export const getPendingEmployeeIds = async (req, res) => {
  try {
    const [agents] = await db.query(`
      SELECT 
        a.id as agent_id,
        u.id as user_id,
        u.temp_employee_id,
        u.name,
        u.email,
        u.phone,
        u.joining_date,
        a.status as agent_status,
        a.training_start_date,
        p.name as process_name,
        tl.name as tl_name,
        mgr.name as manager_name
      FROM agents a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN processes p ON a.process_id = p.id
      LEFT JOIN users tl ON a.tl_id = tl.id
      LEFT JOIN users mgr ON a.manager_id = mgr.id
      WHERE u.permanent_id_pending = 1 AND u.is_active = 1
      ORDER BY u.joining_date ASC
    `);

    return res.json(successResponse({
      count: agents.length,
      agents: agents.map(a => ({
        agentId: a.agent_id,
        userId: a.user_id,
        tempEmployeeId: a.temp_employee_id,
        name: a.name,
        email: a.email,
        phone: a.phone,
        joiningDate: a.joining_date,
        status: a.agent_status,
        trainingStartDate: a.training_start_date,
        process: a.process_name,
        teamLeader: a.tl_name,
        manager: a.manager_name
      }))
    }));
  } catch (error) {
    console.error('❌ Get pending employee IDs error:', error);
    return res.status(500).json(errorResponse('Failed to fetch pending employee IDs'));
  }
};

// ============================================
// UPDATE PERMANENT EMPLOYEE ID
// ============================================
export const updateEmployeeId = async (req, res) => {
  try {
    const { id } = req.params; // user_id
    const { employee_id } = req.body;

    if (!employee_id) {
      return res.status(400).json(errorResponse('Employee ID is required'));
    }

    const cleanEmployeeId = sanitizeString(employee_id).toUpperCase();
    if (!/^AIPL\d{1,5}$/.test(cleanEmployeeId)) {
      return res
        .status(400)
        .json(errorResponse('Permanent Employee ID must be in format AIPL12345 (AIPL + 1 to 5 digits)'));
    }

    await db.query(
      'CALL sp_update_employee_id(?, ?, ?, @success, @message)',
      [id, cleanEmployeeId, req.user.id]
    );

    const [[output]] = await db.query('SELECT @success as success, @message as message');

    if (!output.success) {
      return res.status(400).json(errorResponse(output.message));
    }

    console.log(`✅ Employee ID updated: ${cleanEmployeeId} by ${req.user.name}`);

    return res.json(
      successResponse(
        {
          userId: parseInt(id, 10),
          employeeId: cleanEmployeeId
        },
        output.message
      )
    );
  } catch (error) {
    console.error('❌ Update employee ID error:', error);
    return res.status(500).json(errorResponse('Failed to update employee ID'));
  }
};
// ============================================
// GET PROCESSES (For dropdown)
// ============================================
export const getProcesses = async (req, res) => {
  try {
    const { category, headset_brand } = req.query;

    let query = 'SELECT * FROM processes WHERE is_active = 1';
    const params = [];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    if (headset_brand) {
      query += ' AND headset_brand = ?';
      params.push(headset_brand);
    }

    query += ' ORDER BY name';

    const [processes] = await db.query(query, params);

    return res.json(successResponse(processes.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      depositAmount: p.deposit_amount,
      refundAmount: p.refund_amount,
      headsetBrand: p.headset_brand
    }))));
  } catch (error) {
    console.error('❌ Get processes error:', error);
    return res.status(500).json(errorResponse('Failed to fetch processes'));
  }
};

// ============================================
// GET MANAGERS/TLs/TRAINERS (For dropdown)
// ============================================
export const getStaffByRole = async (req, res) => {
  try {
    const { role } = req.params;

    const allowedRoles = ['manager', 'tl', 'trainer'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json(errorResponse('Invalid role'));
    }

    const [staff] = await db.query(
      `SELECT id, employee_id, name, email, phone
       FROM users
       WHERE role = ? AND is_active = 1
       ORDER BY name`,
      [role]
    );

    return res.json(successResponse(staff));
  } catch (error) {
    console.error('❌ Get staff by role error:', error);
    return res.status(500).json(errorResponse('Failed to fetch staff'));
  }
};

// ============================================
// CREATE AGENT (Admin only)
// Creates user + agent row
// POST /api/agents
// body: { name, employee_id?, temp_employee_id?, process_id, email?, phone?, status? }
// ============================================
export const createAgent = async (req, res) => {
  let conn;
  try {
    const {
      name,
      employee_id,
      temp_employee_id,
      process_id,
      email,
      phone,
      status = 'active',
    } = req.body || {};

    if (!name || !process_id) {
      return res.status(400).json(errorResponse('name and process_id are required'));
    }

    const cleanName = sanitizeString(name);
    const cleanEmail = email ? sanitizeString(email).toLowerCase() : null;
    const cleanPhone = phone ? sanitizeString(phone) : null;

    const rawEmpId = employee_id ? sanitizeString(employee_id).toUpperCase() : '';
    const rawTempId = temp_employee_id ? sanitizeString(temp_employee_id).toUpperCase() : '';

    const isPermanent = (v) => /^AIPL\d{1,5}$/i.test(String(v || '').trim());
    const isTemp = (v) => /^TRG\d{1,5}$/i.test(String(v || '').trim());

    // ✅ Normalize:
    // - If someone accidentally entered permanent id in temp field, treat it as employee_id
    let empId = rawEmpId || null;
    let tempId = rawTempId || null;

    if (!empId && tempId && isPermanent(tempId)) {
      empId = tempId;
      tempId = null;
    }

    const hasEmp = !!empId;
    const hasTemp = !!tempId;

    if ((hasEmp && hasTemp) || (!hasEmp && !hasTemp)) {
      return res.status(400).json(errorResponse('Provide only one of employee_id or temp_employee_id'));
    }

    // ✅ Validate format (as per your requirement)
    if (empId && !isPermanent(empId)) {
      return res.status(400).json(errorResponse('Permanent Employee ID must be in format AIPL12345 (AIPL + 1 to 5 digits)'));
    }
    if (tempId && !isTemp(tempId)) {
      return res.status(400).json(errorResponse('Temp Employee ID must be in format TRG12345 (TRG + 1 to 5 digits)'));
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    // ✅ Duplicate check: employee_id / temp_employee_id cross-check (existing logic)
    if (empId) {
      const [dupe] = await conn.query(
        'SELECT id FROM users WHERE employee_id = ? OR temp_employee_id = ? LIMIT 1',
        [empId, empId]
      );
      if (dupe.length > 0) {
        await conn.rollback();
        return res.status(409).json(errorResponse(`Employee ID ${empId} already exists`));
      }
    }

    if (tempId) {
      const [dupe] = await conn.query(
        'SELECT id FROM users WHERE temp_employee_id = ? OR employee_id = ? LIMIT 1',
        [tempId, tempId]
      );
      if (dupe.length > 0) {
        await conn.rollback();
        return res.status(409).json(errorResponse(`Temp Employee ID ${tempId} already exists`));
      }
    }

    // ✅ Duplicate check: email (so we can return a clean message before insert)
    if (cleanEmail) {
      const [dupeEmail] = await conn.query('SELECT id FROM users WHERE email = ? LIMIT 1', [cleanEmail]);
      if (dupeEmail.length > 0) {
        await conn.rollback();
        return res.status(409).json(errorResponse('Email already registered'));
      }
    }

    // ✅ permanent_id_pending must be 0 when permanent employee_id exists
    const permanentPending = empId ? 0 : 1;

    const [userResult] = await conn.query(
      `INSERT INTO users (
        name,
        employee_id,
        temp_employee_id,
        email,
        password_hash,
        role,
        phone,
        is_active,
        permanent_id_pending
      ) VALUES (?, ?, ?, ?, ?, 'agent', ?, 1, ?)`,
      [cleanName, empId, tempId, cleanEmail, passwordHash, cleanPhone, permanentPending]
    );

    const userId = userResult.insertId;

    const [agentResult] = await conn.query(
      `INSERT INTO agents (
        user_id,
        process_id,
        status,
        created_at
      ) VALUES (?, ?, ?, NOW())`,
      [userId, process_id, status]
    );

    const agentId = agentResult.insertId;

    // Audit log (optional)
    try {
      await conn.query(
        `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, old_values, new_values, action_timestamp)
         VALUES (?, 'agent_created', 'agents', ?, ?, ?, NOW())`,
        [
          req.user.id,
          agentId,
          JSON.stringify({}),
          JSON.stringify({
            name: cleanName,
            employee_id: empId,
            temp_employee_id: tempId,
            process_id,
            email: cleanEmail,
            phone: cleanPhone,
            status,
          }),
        ]
      );
    } catch (e) {
      // ignore
    }

    await conn.commit();

    return res.status(201).json(
      successResponse(
        {
          agentId,
          userId,
          name: cleanName,
          employeeId: empId || tempId,
          permanentIdPending: permanentPending === 1,
          processId: Number(process_id),
          status,
        },
        'Agent created successfully'
      )
    );
  } catch (error) {
    if (conn) await conn.rollback();
    console.error('❌ Create agent error:', error);

    // ✅ Friendly duplicate-key mapping (covers cases not caught by pre-checks)
    if (error?.code === 'ER_DUP_ENTRY') {
      const msg = String(error?.sqlMessage || error?.message || '');

      if (msg.includes('users.email')) {
        return res.status(409).json(errorResponse('Email already registered'));
      }
      if (msg.includes('users.employee_id')) {
        return res.status(409).json(errorResponse('Permanent Employee ID already exists'));
      }
      if (msg.includes('users.temp_employee_id')) {
        return res.status(409).json(errorResponse('Temp Employee ID already exists'));
      }

      return res.status(409).json(errorResponse('Duplicate entry already exists'));
    }

    return res.status(500).json(errorResponse('Failed to create agent'));
  } finally {
    if (conn) conn.release();
  }
};
// ============================================
// DEASSIGN + INACTIVATE AGENT (Transactional)
// POST /api/agents/:id/deassign
// body: { reason, reason_date, headset_received, return_condition?, refund_eligible, refund_amount?, remarks? }
// ============================================
export const deassignAgent = async (req, res) => {
  let conn;
  try {
    const { id } = req.params; // agent_id
    const {
      reason,
      reason_date,
      headset_received,
      return_condition,
      refund_eligible,
      refund_amount,
      remarks,
    } = req.body || {};

    // ✅ normalize reason to avoid Postman/user typos
    const rawReason = String(reason || '').trim().toLowerCase();
    const reasonMap = {
      abscond: 'abscond',
      absconded: 'abscond',
      resign: 'resign',
      resigned: 'resign',
      terminate: 'terminated',
      terminated: 'terminated',
    };
    const normalizedReason = reasonMap[rawReason];
    if (!normalizedReason) {
      return res.status(400).json(errorResponse('Invalid reason'));
    }

    if (!reason_date) {
      return res.status(400).json(errorResponse('reason_date is required (YYYY-MM-DD)'));
    }

    const headsetReceived = headset_received === true || headset_received === 1 || headset_received === 'true';
    const refundEligible = refund_eligible === true || refund_eligible === 1 || refund_eligible === 'true';

    const allowedReturnConditions = new Set([
      'good',
      'satisfactory',
      'decent',
      'fair',
      'bad',
      'repair',
      'damaged',
      'lost',
    ]);

    const finalReturnCondition = headsetReceived
      ? String(return_condition || '').trim().toLowerCase()
      : 'lost';

    if (!allowedReturnConditions.has(finalReturnCondition)) {
      return res.status(400).json(errorResponse('Invalid return_condition'));
    }

    const parsedRefundAmount =
      refundEligible
        ? (refund_amount !== undefined && refund_amount !== null && refund_amount !== ''
          ? Number(refund_amount)
          : null)
        : null;

    if (refundEligible && (parsedRefundAmount === null || Number.isNaN(parsedRefundAmount))) {
      return res.status(400).json(errorResponse('refund_amount is required when refund_eligible is true'));
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    // 1) Fetch agent + user (include role for safety)
    const [agentRows] = await conn.query(
      `SELECT a.id AS agent_id, a.user_id, a.status AS agent_status,
              u.is_active AS user_is_active, u.role AS user_role
       FROM agents a
       JOIN users u ON a.user_id = u.id
       WHERE a.id = ?
       LIMIT 1`,
      [id]
    );

    if (!agentRows.length) {
      await conn.rollback();
      return res.status(404).json(errorResponse('Agent not found'));
    }

    const agent = agentRows[0];

    // Safety: never deassign non-agent users (prevents admin row mistakes)
    if (agent.user_role && agent.user_role !== 'agent') {
      await conn.rollback();
      return res.status(400).json(errorResponse('Only agent users can be de-assigned'));
    }

    // 2) Fetch current active assignment
    const [assignRows] = await conn.query(
      `SELECT
        ha.id AS assignment_id,
        ha.headset_id,
        h.status AS headset_status,
        h.headset_type,
        ht.refund_amount AS tier_refund_amount
       FROM headset_assignments ha
       JOIN headsets h ON h.id = ha.headset_id
       LEFT JOIN headset_type_tiers ht
         ON ht.headset_type = h.headset_type AND ht.is_active = 1
       WHERE ha.agent_id = ? AND ha.is_active = 1
       ORDER BY ha.assignment_date DESC
       LIMIT 1`,
      [id]
    );

    const activeAssignment = assignRows[0] || null;

    if (!activeAssignment) {
      await conn.rollback();
      return res.status(400).json(errorResponse('Agent has no active headset assignment to de-assign'));
    }

    // ✅ NEW: Determine refund basis for backend enforcement
    // Rule: if the agent ever had ENC (voix_enc), then refund eligibility/eligible_amount should be based on ENC tier.
    // This keeps backend consistent with the UI (refundBasis).
    const [encRows] = await conn.query(
      `SELECT
         ht.refund_amount AS tier_refund_amount
       FROM headset_assignments ha
       JOIN headsets h ON h.id = ha.headset_id
       LEFT JOIN headset_type_tiers ht
         ON ht.headset_type = h.headset_type AND ht.is_active = 1
		 WHERE ha.agent_id = ?
		   AND h.headset_type = 'voix_enc'
		   AND COALESCE(ha.assignment_kind, 'permanent') = 'permanent'
       ORDER BY ha.assignment_date ASC
       LIMIT 1`,
      [id]
    );

    const encTierRefundAmount = encRows?.[0]?.tier_refund_amount ?? null;

    // 3) Mark assignment inactive + return info
    await conn.query(
      `UPDATE headset_assignments
       SET is_active = 0,
           return_date = NOW(),
           return_condition = ?,
           return_verified_by = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [finalReturnCondition, req.user.id, activeAssignment.assignment_id]
    );

    // 4) Update headset status based on rules
    let newHeadsetStatus = 'available';
    if (!headsetReceived) {
      newHeadsetStatus = 'lost';
    } else if (finalReturnCondition === 'repair' || finalReturnCondition === 'bad' || finalReturnCondition === 'damaged') {
      newHeadsetStatus = 'repair';
    } else {
      newHeadsetStatus = 'available';
    }

    await conn.query(
      `UPDATE headsets
       SET status = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [newHeadsetStatus, activeAssignment.headset_id]
    );

    // 5) Insert agent_deassignments
    const [deassignResult] = await conn.query(
      `INSERT INTO agent_deassignments (
        agent_id,
        assignment_id,
        reason,
        reason_date,
        headset_received,
        return_condition,
        refund_eligible,
        refund_amount,
        remarks,
        created_by,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id,
        activeAssignment.assignment_id,
        normalizedReason,
        reason_date,
        headsetReceived ? 1 : 0,
        finalReturnCondition,
        refundEligible ? 1 : 0,
        refundEligible ? parsedRefundAmount : null,
        remarks || null,
        req.user.id,
      ]
    );

    const deassignmentId = deassignResult.insertId;

    // 6) Insert refund_requests row
    const refundStatus = refundEligible ? 'in_progress' : 'not_eligible';

    // ✅ eligible_amount must follow the same ENC-history rule
    const eligibleAmount = refundEligible
      ? (encTierRefundAmount ?? activeAssignment.tier_refund_amount ?? parsedRefundAmount ?? 0)
      : null;

    const [refundRes] = await conn.query(
      `INSERT INTO refund_requests (
        deassignment_id,
        agent_id,
        assignment_id,
        status,
        eligible_amount,
        approved_amount,
        remarks,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        deassignmentId,
        id,
        activeAssignment.assignment_id,
        refundStatus,
        eligibleAmount,
        refundEligible ? parsedRefundAmount : null,
        remarks || null,
      ]
    );

    const refundRequestId = refundRes.insertId;

    // 7) Mark agent + user inactive (both)
    await conn.query(`UPDATE agents SET status = 'inactive', updated_at = NOW() WHERE id = ?`, [id]);
    await conn.query(`UPDATE users SET is_active = 0, updated_at = NOW() WHERE id = ?`, [agent.user_id]);

    await conn.commit();

    return res.json(
      successResponse(
        {
          agentId: Number(id),
          deassignmentId,
          refundRequestId,
          message: 'Agent de-assigned and marked inactive successfully',
        },
        'Agent de-assigned successfully'
      )
    );
  } catch (error) {
    if (conn) await conn.rollback();
    console.error('❌ Deassign agent error:', error);
    return res.status(500).json(errorResponse('Failed to de-assign agent'));
  } finally {
    if (conn) conn.release();
  }
};

export default {
  getAllAgents,
  getAgentById,
  getAgentsForDropdown,
  getPendingEmployeeIds,
  updateEmployeeId,
  getProcesses,
  getStaffByRole,
  createAgent,
  getDeassignFormData,
  deassignAgent
};
