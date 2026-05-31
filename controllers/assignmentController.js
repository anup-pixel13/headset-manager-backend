// controllers/assignmentController.js
import db from '../config/database.js';
import Assignment from '../models/Assignment.js';
import {
  successResponse,
  errorResponse,
  paginatedResponse,
  generateReceiptNumber,
} from '../utils/helpers.js';

// ============================================
// Helpers
// ============================================
const isPermanentEmployeeId = (employeeId) =>
  /^AIPL\d{4,5}$/i.test(String(employeeId || '').trim());

const buildBaseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// ✅ Headset reservation rule:
// Block assigning a headset if it is the ORIGINAL headset of an active permanent assignment
// that currently has an active temp_replacement child (parent_assignment_id).
const getHeadsetReservationLock = async (conn, headsetId) => {
  const [rows] = await conn.query(
    `
    SELECT
      orig.id AS original_assignment_id,
      orig.agent_id AS original_agent_id,
      temp.id AS temp_assignment_id,
      temp.agent_id AS temp_agent_id
    FROM headset_assignments orig
    JOIN headset_assignments temp
      ON temp.parent_assignment_id = orig.id
     AND temp.assignment_kind = 'temp_replacement'
     AND temp.is_active = 1
    WHERE orig.headset_id = ?
      AND orig.assignment_kind = 'permanent'
      AND orig.is_active = 1
    LIMIT 1
    `,
    [headsetId]
  );

  if (!rows.length) return { reserved: false };

  return {
    reserved: true,
    originalAssignmentId: rows[0].original_assignment_id,
    originalAgentId: rows[0].original_agent_id,
    tempAssignmentId: rows[0].temp_assignment_id,
    tempAgentId: rows[0].temp_agent_id,
  };
};

// ============================================
// GET ACTIVE ASSIGNMENT BY AGENT
// ============================================
export const getActiveAssignmentByAgent = async (req, res) => {
  try {
    const agentId = req.params.agentId;

    if (!agentId) return res.status(400).json(errorResponse('agentId is required'));

    const [rows] = await db.query(
      `SELECT
        ha.id as assignment_id,
        ha.assignment_date,
        ha.tl_name,
        ha.manager_name,

        h.id as headset_id,
        h.headset_number,
        h.headset_type,

        hb.brand_name,

        ht.deposit_amount AS tier_deposit_amount,
        ht.refund_amount  AS tier_refund_amount,

        p.id as process_id,
        p.name as process_name,
        p.category as process_category
      FROM headset_assignments ha
      JOIN headsets h ON ha.headset_id = h.id
      JOIN headset_brands hb ON h.brand_id = hb.id
      LEFT JOIN headset_type_tiers ht
        ON ht.headset_type = h.headset_type AND ht.is_active = 1
      JOIN processes p ON ha.process_id = p.id
      WHERE ha.agent_id = ?
        AND ha.is_active = 1
        AND (ha.assignment_kind IS NULL OR ha.assignment_kind <> 'temp_replacement')
      ORDER BY ha.assignment_date DESC
      LIMIT 1`,
      [agentId]
    );

    if (!rows.length) {
      return res.status(404).json(errorResponse('No active assignment found for this agent'));
    }

    const a = rows[0];

    if (a.tier_deposit_amount === null || a.tier_refund_amount === null) {
      return res.status(400).json(
        errorResponse(
          `Tier not configured for headset_type "${a.headset_type}". Please configure headset_type_tiers first.`
        )
      );
    }

    return res.json(
      successResponse({
        id: a.assignment_id,
        assignmentDate: a.assignment_date,
        tlName: a.tl_name,
        managerName: a.manager_name,
        headset: {
          id: a.headset_id,
          number: a.headset_number,
          type: a.headset_type,
          brand: a.brand_name,
          depositAmount: Number(a.tier_deposit_amount || 0),
          refundAmount: Number(a.tier_refund_amount || 0),
        },
        process: {
          id: a.process_id,
          name: a.process_name,
          category: a.process_category,
        },
      })
    );
  } catch (error) {
    console.error('❌ getActiveAssignmentByAgent error:', error);
    return res.status(500).json(errorResponse('Failed to fetch active assignment for agent'));
  }
};

// ============================================
// GET ALL ASSIGNMENTS (with filters)
// ============================================
export const getAllAssignments = async (req, res) => {
  try {
    const { total, pageNum, limitNum, rows } = await Assignment.list(req.query);
    const baseUrl = buildBaseUrl(req);

    const formattedAssignments = rows.map((a) => {
      const hasAgent = !!a.has_agent;
      const hasAdminExec = !!a.has_admin_exec;
      const hasIt = !!a.has_it_staff;
      const hasApprover = !!a.has_manager || !!a.has_tl;

      const resolvedEmpId = (a.employee_id || a.temp_employee_id || '').toString().trim();
      const hasPermanentEmployeeId = isPermanentEmployeeId(resolvedEmpId);

      const isCompleteForPdf = hasAgent && hasAdminExec && hasIt && hasApprover;
      const canGenerateDepositPdf = hasPermanentEmployeeId && isCompleteForPdf;

      const depositPdf = a.pdf_file_path
        ? {
            fileName: a.pdf_file_name,
            filePath: a.pdf_file_path,
            viewUrl: `${baseUrl}${a.pdf_file_path}`,
            downloadUrl: `${baseUrl}${a.pdf_file_path}?download=1`,
            generatedAt: a.pdf_generated_at,
            documentType: a.pdf_document_type,
          }
        : null;

      return {
        id: a.id,
        assignmentDate: a.assignment_date,
        verificationDate: a.verification_date,
        returnDate: a.return_date,
        returnCondition: a.return_condition,
        isVerified: a.is_verified === 1,
        isActive: a.is_active === 1,
        notes: a.notes,

        // ✅ hold fields
        holdStatus: a.hold_status || null,
        holdReason: a.hold_reason || null,
        holdStartedAt: a.hold_started_at || null,
        holdEndedAt: a.hold_ended_at || null,

        assignmentKind: a.assignment_kind || null,
        parentAssignmentId: a.parent_assignment_id || null,

        signatureStatus: {
          agent: hasAgent,
          admin_exec: hasAdminExec,
          it_staff: hasIt,
          manager: !!a.has_manager,
          tl: !!a.has_tl,
        },

        isCompleteForPdf,
        hasPermanentEmployeeId,
        canGenerateDepositPdf,
        depositPdf,

        tier: {
          depositAmount: a.tier_deposit_amount !== null ? Number(a.tier_deposit_amount) : null,
          refundAmount: a.tier_refund_amount !== null ? Number(a.tier_refund_amount) : null,
        },

        headset: {
          id: a.headset_id,
          number: a.headset_number,
          type: a.headset_type,
          condition: a.headset_condition,
          brand: a.brand_name,
        },

        systemRemark:
          a.assignment_kind === 'temp_replacement' && (a.parent_headset_number || a.parent_assignment_id)
            ? `Temp replacement for repair. Original headset ${
                a.parent_headset_number || '(unknown)'
              } is in repair. Refund is based on original.`
            : null,

        originalHeadset: a.parent_headset_id
          ? {
              id: a.parent_headset_id,
              number: a.parent_headset_number,
              type: a.parent_headset_type,
              condition: a.parent_headset_condition,
              status: a.parent_headset_status,
              parentAssignmentId: a.parent_assignment_id2 || a.parent_assignment_id || null,
            }
          : null,

        agent: {
          id: a.agent_id,
          name: a.agent_name,
          employeeId: resolvedEmpId || null,
          email: a.agent_email,
          phone: a.agent_phone,
        },
        process: {
          id: a.process_id,
          name: a.process_name,
          category: a.process_category,
        },

        deposit: a.deposit_id
          ? {
              id: a.deposit_id,
              amount: a.paid_deposit,
              refundStatus: a.refund_status,
              receiptNumber: a.receipt_number,
            }
          : null,

        assignedBy: a.assigned_by_name,
        verifiedBy: a.verified_by_name,
      };
    });

    return res.json(paginatedResponse(formattedAssignments, total, pageNum, limitNum));
  } catch (error) {
    console.error('❌ Get assignments error:', error);
    return res.status(500).json(errorResponse('Failed to fetch assignments'));
  }
};

// ============================================
// GET SINGLE ASSIGNMENT BY ID
// ============================================
export const getAssignmentById = async (req, res) => {
  try {
    const { id } = req.params;

    const a = await Assignment.getById(id);
    if (!a) return res.status(404).json(errorResponse('Assignment not found'));

    const deposit = await Assignment.getDepositByAssignmentId(id);
    const signatures = await Assignment.getSignaturesByAssignmentId(id);
    const documents = await Assignment.getDocumentsByAssignmentId(id);

    const resolvedEmpId = (a.employee_id || a.temp_employee_id || '').toString().trim();
    const hasPermanentEmployeeId = isPermanentEmployeeId(resolvedEmpId);

    return res.json(
      successResponse({
        id: a.id,
        assignmentDate: a.assignment_date,
        verificationDate: a.verification_date,
        returnDate: a.return_date,
        returnCondition: a.return_condition,
        isVerified: a.is_verified === 1,
        isActive: a.is_active === 1,
        notes: a.notes,

        hasPermanentEmployeeId,

        headset: {
          id: a.headset_id,
          number: a.headset_number,
          type: a.headset_type,
          condition: a.headset_condition,
          brand: a.brand_name,
          images: [a.image_url_1, a.image_url_2].filter(Boolean),
          depositAmount: a.tier_deposit,
          refundAmount: a.tier_refund,
        },
        agent: {
          id: a.agent_id,
          name: a.agent_name,
          employeeId: resolvedEmpId || null,
          email: a.agent_email,
          phone: a.agent_phone,
          manager: a.manager_name,
          teamLeader: a.tl_name,
        },
        process: {
          name: a.process_name,
          category: a.process_category,
        },
        deposit: deposit
          ? {
              id: deposit.id,
              type: deposit.deposit_type,
              amount: deposit.deposit_amount,
              refundEligible: deposit.refund_eligible_amount,
              refundAmount: deposit.refund_amount,
              refundStatus: deposit.refund_status,
              depositDate: deposit.deposit_date,
              refundDate: deposit.refund_date,
              receiptNumber: deposit.receipt_number,
              paymentMode: deposit.payment_mode,
              damageDeduction: deposit.damage_deduction,
            }
          : null,
        signatures: signatures.map((s) => ({
          id: s.id,
          signerName: s.signer_name || s.signer_user_name,
          signerRole: s.signer_role,
          signedAt: s.signed_at,
          signaturePath: s.signature_path || null,
        })),
        documents: documents.map((d) => ({
          id: d.id,
          type: d.document_type,
          fileName: d.file_name,
          filePath: d.file_path,
          isSigned: d.is_signed === 1,
          generatedAt: d.generated_at,
        })),
        assignedBy: a.assigned_by_name,
        verifiedBy: a.verified_by_name,
        returnVerifiedBy: a.return_verified_by_name,
        createdAt: a.created_at,
      })
    );
  } catch (error) {
    console.error('❌ Get assignment by ID error:', error);
    return res.status(500).json(errorResponse('Failed to fetch assignment details'));
  }
};

// ============================================
// ASSIGN HEADSET TO AGENT
// ============================================
export const assignHeadset = async (req, res) => {
  try {
    const {
      headset_id,
      agent_id,
      process_id,
      deposit_amount,
      payment_mode = 'cash',
      receipt_number,
      notes,
    } = req.body;

    console.log('📝 Assign headset request:', req.body);

    if (!headset_id || !agent_id || !process_id) {
      return res.status(400).json(errorResponse('Headset ID, Agent ID, and Process ID are required'));
    }

    if (!deposit_amount || deposit_amount <= 0) {
      return res.status(400).json(errorResponse('Valid deposit amount is required'));
    }

    const [headset] = await db.query(
      'SELECT id, headset_number, status, headset_type, brand_id FROM headsets WHERE id = ?',
      [headset_id]
    );

    if (headset.length === 0) {
      return res.status(404).json(errorResponse('Headset not found'));
    }

    if (headset[0].status !== 'available') {
      return res
        .status(400)
        .json(errorResponse(`Headset ${headset[0].headset_number} is not available (status: ${headset[0].status})`));
    }

    // ✅ BLOCK: headset reserved for original owner (active temp replacement exists)
    const lock = await getHeadsetReservationLock(db, headset_id);
    if (lock.reserved) {
      return res.status(400).json(
        errorResponse(
          `Headset ${headset[0].headset_number} is reserved (original headset for an active temp replacement). ` +
            `Original Assignment #${lock.originalAssignmentId}, Temp Assignment #${lock.tempAssignmentId}.`
        )
      );
    }

    // ✅ Tier lookup (block if missing)
    const [tierRows] = await db.query(
      `SELECT deposit_amount, refund_amount
       FROM headset_type_tiers
       WHERE headset_type = ?
         AND is_active = 1
       LIMIT 1`,
      [headset[0].headset_type]
    );

    if (tierRows.length === 0) {
      return res.status(400).json(
        errorResponse(
          `Tier not configured for headset_type "${headset[0].headset_type}". Please configure headset_type_tiers first.`
        )
      );
    }

    const refundEligible = Number(tierRows[0].refund_amount || 0);

    const [agent] = await db.query(
      `SELECT a.id, u.name, u.employee_id, u.temp_employee_id
       FROM agents a JOIN users u ON a.user_id = u.id
       WHERE a.id = ?`,
      [agent_id]
    );

    if (agent.length === 0) {
      return res.status(404).json(errorResponse('Agent not found'));
    }

    const [existingAssignment] = await db.query(
      `SELECT id FROM headset_assignments
       WHERE agent_id = ?
         AND is_active = 1
         AND (assignment_kind IS NULL OR assignment_kind <> 'temp_replacement')`,
      [agent_id]
    );

    if (existingAssignment.length > 0) {
      return res.status(400).json(errorResponse(`Agent ${agent[0].name} already has an active headset assignment`));
    }

    const depositType = headset[0].headset_type.startsWith('voix') ? 'voix' : 'tech';
    const finalReceiptNumber = receipt_number || generateReceiptNumber('DEP');

    const tl_name = (req.body?.tl_name || '').toString().trim();
    const manager_name = (req.body?.manager_name || '').toString().trim();

    if (!tl_name || !manager_name) {
      return res.status(400).json({
        success: false,
        message: 'tl_name and manager_name are required',
      });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      const [assignmentResult] = await connection.query(
        `INSERT INTO headset_assignments (
          headset_id,
          agent_id,
          process_id,
          assigned_by,
          assignment_date,
          is_verified,
          is_active,
          notes,
          tl_name,
          manager_name
        ) VALUES (?, ?, ?, ?, NOW(), FALSE, TRUE, ?, ?, ?)`,
        [headset_id, agent_id, process_id, req.user.id, notes || null, tl_name, manager_name]
      );

      const assignmentId = assignmentResult.insertId;

      await connection.query('UPDATE headsets SET status = ?, is_brand_new = FALSE, updated_at = NOW() WHERE id = ?', [
        'assigned',
        headset_id,
      ]);

      const [template] = await connection.query(
        'SELECT id FROM pdf_templates WHERE template_type = ? AND is_active = 1 LIMIT 1',
        [depositType === 'voix' ? 'voix_deposit' : 'tech_deposit']
      );

      const [depositResult] = await connection.query(
        `INSERT INTO deposits (
          assignment_id, agent_id, headset_id, headset_number, deposit_type,
          deposit_amount, refund_eligible_amount, deposit_date, refund_status,
          receipt_number, payment_mode, processed_by, pdf_template_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'pending', ?, ?, ?, ?)`,
        [
          assignmentId,
          agent_id,
          headset_id,
          headset[0].headset_number,
          depositType,
          deposit_amount,
          refundEligible,
          finalReceiptNumber,
          payment_mode,
          req.user.id,
          template[0]?.id || null,
        ]
      );

      const depositId = depositResult.insertId;

      await connection.query(
        `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, action_timestamp)
         VALUES (?, 'assignment_created', 'headset_assignments', ?, ?, NOW())`,
        [
          req.user.id,
          assignmentId,
          JSON.stringify({
            headset_number: headset[0].headset_number,
            agent_name: agent[0].name,
            deposit_amount: deposit_amount,
          }),
        ]
      );

      await connection.commit();
      connection.release();

      return res.status(201).json(
        successResponse(
          {
            assignmentId,
            depositId,
            headsetNumber: headset[0].headset_number,
            agentName: agent[0].name,
            depositAmount: deposit_amount,
            receiptNumber: finalReceiptNumber,
          },
          `Headset ${headset[0].headset_number} assigned to ${agent[0].name}`
        )
      );
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (error) {
    console.error('❌ Assign headset error:', error);
    return res.status(500).json(errorResponse('Failed to assign headset'));
  }
};

// ============================================
// VERIFY ASSIGNMENT
// ============================================
export const verifyAssignment = async (req, res) => {
  try {
    const { id } = req.params;

    const [assignments] = await db.query(
      `SELECT ha.*, h.headset_number, u.name as agent_name
       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       WHERE ha.id = ?`,
      [id]
    );

    if (assignments.length === 0) return res.status(404).json(errorResponse('Assignment not found'));

    const assignment = assignments[0];

    if (assignment.is_verified === 1) return res.status(400).json(errorResponse('Assignment already verified'));
    if (assignment.is_active !== 1) return res.status(400).json(errorResponse('Cannot verify inactive assignment'));

    await db.query(
      `UPDATE headset_assignments 
       SET is_verified = TRUE, verified_by = ?, verification_date = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [req.user.id, id]
    );

    await db.query(
      `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, action_timestamp)
       VALUES (?, 'assignment_verified', 'headset_assignments', ?, ?, NOW())`,
      [
        req.user.id,
        id,
        JSON.stringify({
          headset_number: assignment.headset_number,
          agent_name: assignment.agent_name,
        }),
      ]
    );

    return res.json(
      successResponse(
        {
          id: parseInt(id, 10),
          headsetNumber: assignment.headset_number,
          agentName: assignment.agent_name,
        },
        'Assignment verified successfully'
      )
    );
  } catch (error) {
    console.error('❌ Verify assignment error:', error);
    return res.status(500).json(errorResponse('Failed to verify assignment'));
  }
};

// ============================================
// RETURN HEADSET
// ============================================
export const returnHeadset = async (req, res) => {
  try {
    const { id } = req.params;
    const { return_condition, notes } = req.body;

    if (!return_condition) return res.status(400).json(errorResponse('Return condition is required'));

    const validConditions = ['good', 'fair', 'damaged', 'lost'];
    if (!validConditions.includes(return_condition)) {
      return res.status(400).json(errorResponse(`Invalid return condition. Must be one of: ${validConditions.join(', ')}`));
    }

    const [assignments] = await db.query(
      `SELECT ha.*, h.headset_number, h.id as headset_id, u.name as agent_name
       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       WHERE ha.id = ?`,
      [id]
    );

    if (assignments.length === 0) return res.status(404).json(errorResponse('Assignment not found'));

    const assignment = assignments[0];
    if (assignment.is_active !== 1) return res.status(400).json(errorResponse('Assignment already closed'));

    let newHeadsetStatus = 'available';
    let newCondition = return_condition;
    if (return_condition === 'damaged') newHeadsetStatus = 'damaged';
    if (return_condition === 'lost') newHeadsetStatus = 'lost';

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      await connection.query(
        `UPDATE headset_assignments 
         SET is_active = FALSE, return_date = NOW(), return_condition = ?,
             return_verified_by = ?, notes = CONCAT(IFNULL(notes, ''), ?), updated_at = NOW()
         WHERE id = ?`,
        [return_condition, req.user.id, notes ? ` | Return: ${notes}` : '', id]
      );

      await connection.query('UPDATE headsets SET status = ?, condition_status = ?, updated_at = NOW() WHERE id = ?', [
        newHeadsetStatus,
        newCondition,
        assignment.headset_id,
      ]);

      await connection.query(
        `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, action_timestamp)
         VALUES (?, 'assignment_returned', 'headset_assignments', ?, ?, NOW())`,
        [
          req.user.id,
          id,
          JSON.stringify({
            headset_number: assignment.headset_number,
            agent_name: assignment.agent_name,
            condition: return_condition,
          }),
        ]
      );

      await connection.commit();
      connection.release();

      return res.json(
        successResponse(
          {
            id: parseInt(id, 10),
            headsetNumber: assignment.headset_number,
            agentName: assignment.agent_name,
            returnCondition: return_condition,
            headsetStatus: newHeadsetStatus,
          },
          `Headset ${assignment.headset_number} returned successfully`
        )
      );
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (error) {
    console.error('❌ Return headset error:', error);
    return res.status(500).json(errorResponse('Failed to return headset'));
  }
};

// ============================================
// GET PENDING VERIFICATIONS
// ============================================
export const getPendingVerifications = async (req, res) => {
  try {
    const rows = await Assignment.getPendingVerifications();
    return res.json(
      successResponse({
        count: rows.length,
        assignments: rows.map((a) => ({
          id: a.id,
          assignmentDate: a.assignment_date,
          headsetNumber: a.headset_number,
          headsetType: a.headset_type,
          agentName: a.agent_name,
          employeeId: a.emp_id,
          process: a.process_name,
          assignedBy: a.assigned_by_name,
        })),
      })
    );
  } catch (error) {
    console.error('❌ Get pending verifications error:', error);
    return res.status(500).json(errorResponse('Failed to fetch pending verifications'));
  }
};

export const getPendingPermanentIds = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
        ha.id as assignment_id,
        ha.assignment_date,
        ha.tl_name,
        ha.manager_name,

        a.id as agent_id,
        u.id as user_id,
        u.name as agent_name,
        u.employee_id,
        u.temp_employee_id,
        u.permanent_id_pending,

        h.headset_number,
        h.headset_type,

        p.name as process_name
      FROM headset_assignments ha
      JOIN agents a ON ha.agent_id = a.id
      JOIN users u ON a.user_id = u.id
      JOIN headsets h ON ha.headset_id = h.id
      JOIN processes p ON ha.process_id = p.id
      WHERE ha.is_active = 1
        AND u.is_active = 1
        AND (
          COALESCE(NULLIF(TRIM(u.employee_id), ''), NULLIF(TRIM(u.temp_employee_id), '')) IS NULL
          OR COALESCE(NULLIF(TRIM(u.employee_id), ''), NULLIF(TRIM(u.temp_employee_id), '')) NOT REGEXP '^AIPL[0-9]{4,5}$'
        )
      ORDER BY ha.assignment_date DESC`
    );

    return res.json(
      successResponse({
        total: rows.length,
        assignments: rows.map((r) => ({
          id: r.assignment_id,
          assignmentId: r.assignment_id,
          assignmentDate: r.assignment_date,

          agentId: r.agent_id,
          userId: r.user_id,

          agentName: r.agent_name,
          employeeId: r.employee_id || r.temp_employee_id,
          tempEmployeeId: r.temp_employee_id,

          process: r.process_name,
          headsetNumber: r.headset_number,
          headsetType: r.headset_type,
          tlName: r.tl_name,
          managerName: r.manager_name,
        })),
      })
    );
  } catch (e) {
    console.error('❌ getPendingPermanentIds error:', e);
    return res.status(500).json(errorResponse('Failed to fetch pending permanent IDs'));
  }
};

// ============================================
// SIGNATURES
// ============================================
export const addAssignmentSignature = async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const signer_role = (req.body?.signer_role || '').toString();
    const signer_name = (req.body?.signer_name || '').toString().trim();

    if (!assignmentId) return res.status(400).json(errorResponse('assignment id is required'));
    if (!signer_role) return res.status(400).json(errorResponse('signer_role is required'));
    if (!req.file) return res.status(400).json(errorResponse('Signature file is required (field name: signature)'));

    const allowedRoles = ['agent', 'admin_exec', 'it_staff', 'manager', 'tl'];
    if (!allowedRoles.includes(signer_role)) {
      return res.status(400).json(errorResponse(`Invalid signer_role. Allowed: ${allowedRoles.join(', ')}`));
    }

    const assignment = await Assignment.getAssignmentNames(assignmentId);
    if (!assignment) return res.status(404).json(errorResponse('Assignment not found'));

    if (['agent', 'manager', 'tl'].includes(signer_role) && !signer_name) {
      return res.status(400).json(errorResponse('signer_name is required for agent/manager/tl signatures'));
    }

    if (signer_role === 'manager' && signer_name !== assignment.manager_name) {
      return res.status(400).json(errorResponse(`Manager name mismatch. Must be exactly: "${assignment.manager_name}"`));
    }
    if (signer_role === 'tl' && signer_name !== assignment.tl_name) {
      return res.status(400).json(errorResponse(`TL name mismatch. Must be exactly: "${assignment.tl_name}"`));
    }

    const signature_path = `/uploads/signatures/${req.file.filename}`;
    const signer_id = ['admin_exec', 'it_staff'].includes(signer_role) ? req.user.id : null;

    const finalSignerName =
      ['admin_exec', 'it_staff'].includes(signer_role)
        ? signer_name || req.user.name || (signer_role === 'admin_exec' ? 'Admin Executive' : 'IT Staff')
        : signer_name;

    await Assignment.upsertSignature({
      assignmentId,
      signer_role,
      signer_id,
      signer_name: finalSignerName,
      signature_path,
      ip_address: req.ip || null,
      device_info: req.headers['user-agent'] || null,
    });

    return res.json(successResponse({ assignmentId, signer_role, signature_path }, 'Signature saved'));
  } catch (error) {
    console.error('❌ addAssignmentSignature error:', error);
    return res.status(500).json(errorResponse('Failed to save signature'));
  }
};

export const getAssignmentSignatureStatus = async (req, res) => {
  try {
    const assignmentId = req.params.id;

    const rows = await Assignment.getSignaturesStatus(assignmentId);

    const has = (role) =>
      rows.some(
        (r) =>
          r.signer_role === role &&
          r.signature_path !== null &&
          r.signature_path !== undefined &&
          String(r.signature_path).trim() !== ''
      );

    const status = {
      agent: has('agent'),
      admin_exec: has('admin_exec'),
      it_staff: has('it_staff'),
      manager: has('manager'),
      tl: has('tl'),
    };

    const managerOrTl = status.manager || status.tl;

    return res.json(
      successResponse({
        signatures: rows,
        required: { agent: true, admin_exec: true, it_staff: true, managerOrTl: true },
        status,
        isCompleteForPdf: status.agent && status.admin_exec && status.it_staff && managerOrTl,
      })
    );
  } catch (error) {
    console.error('❌ getAssignmentSignatureStatus error:', error);
    return res.status(500).json(errorResponse('Failed to load signature status'));
  }
};

export const getPendingSignatures = async (req, res) => {
  try {
    const rows = await Assignment.getPendingSignatures();

    return res.json(
      successResponse({
        total: rows.length,
        assignments: rows.map((r) => ({
          id: r.assignment_id,
          assignmentDate: r.assignment_date,
          headsetNumber: r.headset_number,
          agentName: r.agent_name,
          employeeId: r.employee_id,
          tlName: r.tl_name,
          managerName: r.manager_name,
          missing: {
            agent: r.has_agent === 0,
            admin_exec: r.has_admin_exec === 0,
            it_staff: r.has_it === 0,
            managerOrTl: r.has_manager === 0 && r.has_tl === 0,
          },
        })),
      })
    );
  } catch (error) {
    console.error('❌ getPendingSignatures error:', error);
    return res.status(500).json(errorResponse('Failed to fetch pending signatures'));
  }
};

export const getAssignmentDetails = async (req, res) => {
  try {
    const assignmentId = req.params.id;

    const row = await Assignment.getDetailsForSign(assignmentId);
    if (!row) return res.status(404).json(errorResponse('Assignment not found'));

    return res.json(successResponse(row));
  } catch (error) {
    console.error('❌ getAssignmentDetails error:', error);
    return res.status(500).json(errorResponse('Failed to load assignment details'));
  }
};