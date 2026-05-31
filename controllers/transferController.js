import db from '../config/database.js';
import {
  successResponse,
  errorResponse,
  paginatedResponse,
  formatCurrency,
  generateReceiptNumber
} from '../utils/helpers.js';

// ============================================
// GET ALL TRANSFERS (with filters)
// ============================================
export const getAllTransfers = async (req, res) => {
  try {
    const {
      search,
      transfer_type,
      start_date,
      end_date,
      page = 1,
      limit = 20,
      sort_order = 'DESC'
    } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = Math.min(parseInt(limit) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    let whereConditions = ['1=1'];
    let params = [];

    if (search) {
      whereConditions.push(`(
        h.headset_number LIKE ? OR 
        from_user.name LIKE ? OR 
        to_user.name LIKE ? OR
        agent_user.name LIKE ?
      )`);
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (transfer_type) {
      whereConditions.push('t.transfer_type = ?');
      params.push(transfer_type);
    }

    if (start_date) {
      whereConditions.push('DATE(t.transfer_date) >= ?');
      params.push(start_date);
    }

    if (end_date) {
      whereConditions.push('DATE(t.transfer_date) <= ?');
      params.push(end_date);
    }

    const whereClause = whereConditions.join(' AND ');

    const [countResult] = await db.query(
      `SELECT COUNT(*) as total
       FROM transfers t
       LEFT JOIN headsets h ON t.headset_id = h.id
       LEFT JOIN agents from_agent ON t.from_agent_id = from_agent.id
       LEFT JOIN users from_user ON from_agent.user_id = from_user.id
       LEFT JOIN agents to_agent ON t.to_agent_id = to_agent.id
       LEFT JOIN users to_user ON to_agent.user_id = to_user.id
       LEFT JOIN agents agent ON t.agent_id = agent.id
       LEFT JOIN users agent_user ON agent.user_id = agent_user.id
       WHERE ${whereClause}`,
      params
    );

    const total = countResult[0].total;

    const [transfers] = await db.query(
      `SELECT 
        t.*,
        h.headset_number,
        h.headset_type,
        from_user.name as from_agent_name,
        to_user.name as to_agent_name,
        agent_user.name as agent_name,
        from_p.name as from_process_name,
        to_p.name as to_process_name,
        approved_by.name as approved_by_name,
        processed_by.name as processed_by_name
       FROM transfers t
       LEFT JOIN headsets h ON t.headset_id = h.id
       LEFT JOIN agents from_agent ON t.from_agent_id = from_agent.id
       LEFT JOIN users from_user ON from_agent.user_id = from_user.id
       LEFT JOIN agents to_agent ON t.to_agent_id = to_agent.id
       LEFT JOIN users to_user ON to_agent.user_id = to_user.id
       LEFT JOIN agents agent ON t.agent_id = agent.id
       LEFT JOIN users agent_user ON agent.user_id = agent_user.id
       LEFT JOIN processes from_p ON t.from_process_id = from_p.id
       LEFT JOIN processes to_p ON t.to_process_id = to_p.id
       LEFT JOIN users approved_by ON t.approved_by = approved_by.id
       LEFT JOIN users processed_by ON t.processed_by = processed_by.id
       WHERE ${whereClause}
       ORDER BY t.transfer_date ${sort_order === 'ASC' ? 'ASC' : 'DESC'}
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const formattedTransfers = transfers.map(t => ({
      id: t.id,
      transferType: t.transfer_type,
      transferDate: t.transfer_date,
      headset: t.headset_number
        ? { id: t.headset_id, number: t.headset_number, type: t.headset_type }
        : null,
      fromAgent: t.from_agent_name,
      toAgent: t.to_agent_name,
      agent: t.agent_name,
      fromProcess: t.from_process_name,
      toProcess: t.to_process_name,
      oldHeadset: t.old_headset_number,
      newHeadset: t.new_headset_number,
      additionalDeposit: t.additional_deposit,
      additionalDepositFormatted: formatCurrency(t.additional_deposit || 0),
      reason: t.reason,
      approvedBy: t.approved_by_name,
      processedBy: t.processed_by_name,
      notes: t.notes,
      depositId: t.deposit_id || null
    }));

    res.json(paginatedResponse(formattedTransfers, total, pageNum, limitNum));
  } catch (error) {
    console.error('❌ Get transfers error:', error);
    res.status(500).json(errorResponse('Failed to fetch transfers'));
  }
};

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
// TRANSFER HEADSET BETWEEN AGENTS
// ============================================
export const transferHeadset = async (req, res) => {
  try {
    const {
      headset_id,
      from_agent_id,
      to_agent_id,
      to_process_id,
      reason,
      notes
    } = req.body;

    console.log('📝 Transfer headset request:', req.body);

    if (!headset_id || !from_agent_id || !to_agent_id || !to_process_id) {
      return res.status(400).json(errorResponse('Headset ID, from agent, to agent, and process are required'));
    }

    if (from_agent_id === to_agent_id) {
      return res.status(400).json(errorResponse('From and To agents cannot be the same'));
    }

    const [headset] = await db.query(
      'SELECT id, headset_number, status FROM headsets WHERE id = ?',
      [headset_id]
    );

    if (headset.length === 0) return res.status(404).json(errorResponse('Headset not found'));

    const [currentAssignment] = await db.query(
      `SELECT ha.*, p.id as process_id
       FROM headset_assignments ha
       JOIN processes p ON ha.process_id = p.id
       WHERE ha.headset_id = ? AND ha.agent_id = ? AND ha.is_active = 1`,
      [headset_id, from_agent_id]
    );

    if (currentAssignment.length === 0) {
      return res.status(400).json(errorResponse('No active assignment found for this headset and agent'));
    }

    const [fromAgent] = await db.query(
      'SELECT a.id, u.name FROM agents a JOIN users u ON a.user_id = u.id WHERE a.id = ?',
      [from_agent_id]
    );

    const [toAgent] = await db.query(
      'SELECT a.id, u.name FROM agents a JOIN users u ON a.user_id = u.id WHERE a.id = ?',
      [to_agent_id]
    );

    if (fromAgent.length === 0 || toAgent.length === 0) {
      return res.status(404).json(errorResponse('Agent not found'));
    }

    const [existingAssignment] = await db.query(
      'SELECT id FROM headset_assignments WHERE agent_id = ? AND is_active = 1',
      [to_agent_id]
    );

    if (existingAssignment.length > 0) {
      return res.status(400).json(errorResponse(`${toAgent[0].name} already has an active headset`));
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      await connection.query(
        `UPDATE headset_assignments 
         SET is_active = FALSE, return_date = NOW(), return_condition = 'good',
             notes = CONCAT(IFNULL(notes, ''), ?), updated_at = NOW()
         WHERE id = ?`,
        [` | Transferred to: ${toAgent[0].name}`, currentAssignment[0].id]
      );

      const [newAssignment] = await connection.query(
        `INSERT INTO headset_assignments (
          headset_id, agent_id, process_id, assigned_by, assignment_date, is_verified, is_active, notes,
          tl_name, manager_name
        ) VALUES (?, ?, ?, ?, NOW(), FALSE, TRUE, ?, ?, ?)`,
        [
          headset_id,
          to_agent_id,
          to_process_id,
          req.user.id,
          `Transferred from: ${fromAgent[0].name}. ${reason ? `Reason: ${reason}` : ''}`,
          'N/A',
          'N/A'
        ]
      );

      const newAssignmentId = newAssignment.insertId;

      const [transferResult] = await connection.query(
        `INSERT INTO transfers (
          transfer_type, headset_id, from_agent_id, to_agent_id,
          from_process_id, to_process_id, transfer_date, reason,
          approved_by, processed_by, notes
        ) VALUES ('headset_transfer', ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?)`,
        [
          headset_id,
          from_agent_id,
          to_agent_id,
          currentAssignment[0].process_id,
          to_process_id,
          reason || null,
          req.user.id,
          req.user.id,
          notes || null
        ]
      );

      await connection.query(
        `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, action_timestamp)
         VALUES (?, 'transfer_created', 'transfers', ?, ?, NOW())`,
        [
          req.user.id,
          transferResult.insertId,
          JSON.stringify({
            headset_number: headset[0].headset_number,
            from_agent: fromAgent[0].name,
            to_agent: toAgent[0].name
          })
        ]
      );

      await connection.commit();
      connection.release();

      res.status(201).json(successResponse({
        transferId: transferResult.insertId,
        newAssignmentId: newAssignmentId,
        headsetNumber: headset[0].headset_number,
        fromAgent: fromAgent[0].name,
        toAgent: toAgent[0].name
      }, `Headset ${headset[0].headset_number} transferred from ${fromAgent[0].name} to ${toAgent[0].name}`));
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (error) {
    console.error('❌ Transfer headset error:', error);
    res.status(500).json(errorResponse('Failed to transfer headset'));
  }
};

// ============================================
// Helpers for Process Change v2
// ============================================
const isVoixEncType = (headsetType) => String(headsetType || '').trim() === 'voix_enc';

const getTierFromHeadsetType = (headsetType) => {
  // Tier B (premium) is VOIX ENC only
  // Tier A (standard) is everything else
  return isVoixEncType(headsetType) ? 'premium_1750' : 'standard_1250';
};

const getRefundEligibleFromBrand = async (conn, brandId) => {
  const [rows] = await conn.query('SELECT refund_amount FROM headset_brands WHERE id = ? LIMIT 1', [brandId]);
  return Number(rows?.[0]?.refund_amount ?? 0);
};

const getActiveAssignmentForAgent = async (conn, agentId) => {
  const [rows] = await conn.query(
    `SELECT 
      ha.id as assignment_id,
      ha.headset_id,
      ha.process_id,
      ha.tl_name,
      ha.manager_name,

      h.headset_number,
      h.headset_type,
      h.brand_id
     FROM headset_assignments ha
     JOIN headsets h ON ha.headset_id = h.id
     WHERE ha.agent_id = ? AND ha.is_active = 1
     LIMIT 1`,
    [agentId]
  );
  return rows?.[0] || null;
};

// Helper: compute released old headset status for v2 when headset changes
const computeOldHeadsetReleaseStatus = ({ oldReceived, oldReturnCondition }) => {
  if (!oldReceived) return 'lost';
  const c = String(oldReturnCondition || '').trim().toLowerCase();
  if (c === 'damaged') return 'repair';
  if (c === 'fair' || c === 'good') return 'available';
  // fallback: treat unknown as repair-safe
  return 'repair';
};

// ============================================
// PROCESS CHANGE v2 (Option 2 + two-row deposits + negative allowed)
// Endpoint: POST /api/transfers/process-change-v2
// ============================================
export const processChangeV2 = async (req, res) => {
  try {
    const {
      agent_id,
      to_process_id,
      new_headset_id, // optional

      deposit_amount, // REQUIRED (editable)
      payment_mode = 'salary_deduction',
      receipt_number,
      notes,

      old_headset_received = true,
      old_return_condition,

      tl_name,
      manager_name,
    } = req.body;

    if (!agent_id || !to_process_id) {
      return res.status(400).json(errorResponse('agent_id and to_process_id are required'));
    }

    const baseDepositOverride = Number(deposit_amount);
    if (!Number.isFinite(baseDepositOverride) || baseDepositOverride <= 0) {
      return res.status(400).json(errorResponse('deposit_amount must be a valid positive number'));
    }

    const finalTlName = (tl_name || '').toString().trim();
    const finalManagerName = (manager_name || '').toString().trim();
    if (!finalTlName || !finalManagerName) {
      return res.status(400).json(errorResponse('tl_name and manager_name are required for the new assignment'));
    }

    const validConditions = ['good', 'fair', 'damaged', 'lost'];

    const oldReceived = old_headset_received === true || old_headset_received === 'true' || old_headset_received === 1 || old_headset_received === '1';

    let finalOldReturnCondition = old_return_condition ? String(old_return_condition).trim().toLowerCase() : '';

    if (!oldReceived) {
      finalOldReturnCondition = 'lost';
    } else {
      if (!finalOldReturnCondition) {
        return res.status(400).json(errorResponse('old_return_condition is required when old_headset_received is true'));
      }
      if (!validConditions.includes(finalOldReturnCondition)) {
        return res
          .status(400)
          .json(errorResponse(`Invalid old_return_condition. Must be one of: ${validConditions.join(', ')}`));
      }
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // Agent
      const [agentRows] = await connection.query(
        `SELECT a.id, u.name
         FROM agents a
         JOIN users u ON a.user_id = u.id
         WHERE a.id = ?
         LIMIT 1`,
        [agent_id]
      );
      if (!agentRows.length) {
        await connection.rollback();
        connection.release();
        return res.status(404).json(errorResponse('Agent not found'));
      }
      const agent = agentRows[0];

      // Validate to_process
      const [toProcessRows] = await connection.query(
        'SELECT id, name, category FROM processes WHERE id = ? LIMIT 1',
        [to_process_id]
      );
      if (!toProcessRows.length) {
        await connection.rollback();
        connection.release();
        return res.status(404).json(errorResponse('Target process not found'));
      }
      const toProcess = toProcessRows[0];

      // ✅ IMPORTANT: keep agent.process_id in sync so Agents page shows latest process
      await connection.query(
        'UPDATE agents SET process_id = ?, updated_at = NOW() WHERE id = ?',
        [to_process_id, agent_id]
      );

      // Current active assignment
      const current = await getActiveAssignmentForAgent(connection, agent_id);
      if (!current) {
        await connection.rollback();
        connection.release();
        return res.status(400).json(errorResponse('Agent has no active assignment to process-change'));
      }

      const fromAssignmentId = current.assignment_id;
      const fromProcessId = current.process_id;

      // Old headset details
      const oldHeadsetId = current.headset_id;
      const oldHeadsetNumber = current.headset_number;
      const oldHeadsetType = current.headset_type;

      // Baseline old deposit from ACTUAL old base deposit (B)
      const [oldBaseDepositRows] = await connection.query(
        `SELECT deposit_amount
         FROM deposits
         WHERE assignment_id = ?
           AND deposit_type IN ('voix', 'tech')
         ORDER BY id DESC
         LIMIT 1`,
        [fromAssignmentId]
      );

      if (!oldBaseDepositRows.length) {
        await connection.rollback();
        connection.release();
        return res.status(400).json(
          errorResponse(
            `Old base deposit not found for assignment #${fromAssignmentId}. Cannot compute adjustment.`
          )
        );
      }

      const oldDepositAmount = Number(oldBaseDepositRows[0].deposit_amount || 0);

      // New headset (optional)
      const effectiveNewHeadsetId = new_headset_id ? Number(new_headset_id) : oldHeadsetId;

      const [newHeadsetRows] = await connection.query(
        `SELECT id, headset_number, headset_type, status, brand_id
         FROM headsets
         WHERE id = ?
         LIMIT 1`,
        [effectiveNewHeadsetId]
      );
      if (!newHeadsetRows.length) {
        await connection.rollback();
        connection.release();
        return res.status(404).json(errorResponse('New headset not found'));
      }

      const newHeadset = newHeadsetRows[0];
      const changingHeadset = Number(effectiveNewHeadsetId) !== Number(oldHeadsetId);

      // ✅ BLOCK: do not allow assigning a headset that is reserved as an original headset
      // for an active temp replacement chain.
      const lock = await getHeadsetReservationLock(connection, effectiveNewHeadsetId);
      if (lock.reserved) {
        await connection.rollback();
        connection.release();
        return res.status(400).json(
          errorResponse(
            `Headset ${newHeadset.headset_number} is reserved (original headset for an active temp replacement). ` +
            `Original Assignment #${lock.originalAssignmentId}, Temp Assignment #${lock.tempAssignmentId}.`
          )
        );
      }

      if (changingHeadset && newHeadset.status !== 'available') {
        await connection.rollback();
        connection.release();
        return res
          .status(400)
          .json(errorResponse(`New headset ${newHeadset.headset_number} is not available (status: ${newHeadset.status})`));
      }

      // ✅ Tier lookup for NEW headset (block if missing)
      const [newTierRows] = await connection.query(
        `SELECT deposit_amount, refund_amount
         FROM headset_type_tiers
         WHERE headset_type = ?
           AND is_active = 1
         LIMIT 1`,
        [newHeadset.headset_type]
      );

      if (!newTierRows.length) {
        await connection.rollback();
        connection.release();
        return res.status(400).json(
          errorResponse(
            `Tier not configured for new headset_type "${newHeadset.headset_type}". Please configure headset_type_tiers first.`
          )
        );
      }

      const baseRefundEligible = Number(newTierRows[0].refund_amount || 0);

      // Base deposit uses OVERRIDE from UI (editable)
      const baseDepositAmount = baseDepositOverride;

      // Base deposit type derived from headset type
      const baseDepositType = String(newHeadset.headset_type || '').startsWith('voix') ? 'voix' : 'tech';

      // Adjustment = new(override) - old(actual base deposit)
      const adjustmentFee = Number(baseDepositAmount) - Number(oldDepositAmount); // negative allowed

      // Invalidate old assignment
      await connection.query(
        `UPDATE headset_assignments
         SET is_active = 0,
             return_date = NOW(),
             return_condition = ?,
             notes = CONCAT(IFNULL(notes, ''), ?),
             updated_at = NOW()
         WHERE id = ?`,
        [
          finalOldReturnCondition,
          ` | Invalidated: process change to "${toProcess.name}"` +
            (changingHeadset ? `, headset replaced to ${newHeadset.headset_number}` : '') +
            (!oldReceived ? ' (Old headset not received)' : ''),
          fromAssignmentId,
        ]
      );

      // Headset status updates
      if (changingHeadset) {
        // ✅ release old headset back to pool (or repair/lost)
        const oldStatus = computeOldHeadsetReleaseStatus({ oldReceived, oldReturnCondition: finalOldReturnCondition });
        await connection.query(
          'UPDATE headsets SET status = ?, updated_at = NOW() WHERE id = ?',
          [oldStatus, oldHeadsetId]
        );

        // assign new headset
        await connection.query(
          'UPDATE headsets SET status = ?, is_brand_new = FALSE, updated_at = NOW() WHERE id = ?',
          ['assigned', effectiveNewHeadsetId]
        );
      } else {
        await connection.query(
          'UPDATE headsets SET status = ?, updated_at = NOW() WHERE id = ?',
          ['assigned', oldHeadsetId]
        );
      }

      // Create NEW assignment
      const [newAssignRes] = await connection.query(
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
        [
          effectiveNewHeadsetId,
          agent_id,
          to_process_id,
          req.user.id,
          notes ? `Process change v2. ${notes}` : 'Process change v2.',
          finalTlName,
          finalManagerName,
        ]
      );

      const newAssignmentId = newAssignRes.insertId;

      // Base deposit row for NEW assignment
      const baseReceipt = generateReceiptNumber('DEP');

      const [tplRows] = await connection.query(
        'SELECT id FROM pdf_templates WHERE template_type = ? AND is_active = 1 LIMIT 1',
        [baseDepositType === 'voix' ? 'voix_deposit' : 'tech_deposit']
      );
      const baseTemplateId = tplRows?.[0]?.id || null;

      const [baseDepositRes] = await connection.query(
        `INSERT INTO deposits (
          assignment_id, agent_id, headset_id, headset_number, deposit_type,
          deposit_amount, refund_eligible_amount, deposit_date, refund_status,
          receipt_number, payment_mode, processed_by, pdf_template_id, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'pending', ?, 'salary_deduction', ?, ?, ?)`,
        [
          newAssignmentId,
          agent_id,
          effectiveNewHeadsetId,
          newHeadset.headset_number,
          baseDepositType,
          baseDepositAmount,
          baseRefundEligible,
          baseReceipt,
          req.user.id,
          baseTemplateId,
          notes || null,
        ]
      );

      const baseDepositId = baseDepositRes.insertId;

      // Transfer history + optional adjustment deposit
      let adjustmentDepositId = null;
      let transferId = null;

      if (adjustmentFee !== 0) {
        const adjReceipt = receipt_number || generateReceiptNumber('PCH');

        const [encTpl] = await connection.query(
          'SELECT id FROM pdf_templates WHERE template_type = ? AND is_active = 1 LIMIT 1',
          ['enc_exchange']
        );
        const encTemplateId = encTpl?.[0]?.id || null;

        const absAdj = Math.abs(adjustmentFee);

        const [adjDepositRes] = await connection.query(
          `INSERT INTO deposits (
            assignment_id, agent_id, headset_id, headset_number,
            old_headset_id, old_headset_number,
            deposit_type, deposit_amount, refund_eligible_amount,
            deposit_date, refund_status, process_change_fee,
            receipt_number, payment_mode, processed_by, notes, pdf_template_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'process_change', ?, ?, NOW(), 'pending', ?, ?, ?, ?, ?, ?)`,
          [
            newAssignmentId,
            agent_id,
            effectiveNewHeadsetId,
            newHeadset.headset_number,
            oldHeadsetId,
            oldHeadsetNumber,
            absAdj,
            baseRefundEligible,
            adjustmentFee, // negative allowed
            adjReceipt,
            payment_mode,
            req.user.id,
            notes || null,
            encTemplateId,
          ]
        );

        adjustmentDepositId = adjDepositRes.insertId;

        const [transferRes] = await connection.query(
          `INSERT INTO transfers (
            transfer_type, headset_id, agent_id,
            from_process_id, to_process_id,
            old_headset_id, old_headset_number, new_headset_number,
            transfer_date, reason, additional_deposit,
            approved_by, processed_by, notes, deposit_id
          ) VALUES ('agent_process_change', ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?)`,
          [
            effectiveNewHeadsetId,
            agent_id,
            fromProcessId,
            to_process_id,
            oldHeadsetId,
            oldHeadsetNumber,
            newHeadset.headset_number,
            `Process change v2`,
            adjustmentFee,
            req.user.id,
            req.user.id,
            notes || null,
            adjustmentDepositId,
          ]
        );

        transferId = transferRes.insertId;
      } else {
        const [transferRes] = await connection.query(
          `INSERT INTO transfers (
            transfer_type, headset_id, agent_id,
            from_process_id, to_process_id,
            old_headset_id, old_headset_number, new_headset_number,
            transfer_date, reason, additional_deposit,
            approved_by, processed_by, notes, deposit_id
          ) VALUES ('agent_process_change', ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 0, ?, ?, ?, NULL)`,
          [
            effectiveNewHeadsetId,
            agent_id,
            fromProcessId,
            to_process_id,
            oldHeadsetId,
            oldHeadsetNumber,
            newHeadset.headset_number,
            `Process change v2`,
            req.user.id,
            req.user.id,
            notes || null,
          ]
        );

        transferId = transferRes.insertId;
      }

      // Audit log
      await connection.query(
        `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, action_timestamp)
         VALUES (?, 'transfer_created', 'headset_assignments', ?, ?, NOW())`,
        [
          req.user.id,
          newAssignmentId,
          JSON.stringify({
            kind: 'process_change_v2',
            agent_id,
            fromAssignmentId,
            newAssignmentId,
            from_process_id: fromProcessId,
            to_process_id,
            old_headset_id: oldHeadsetId,
            new_headset_id: effectiveNewHeadsetId,
            baseDepositAmount,
            oldDepositAmount,
            adjustmentFee,
            baseRefundEligible,
            oldHeadsetType,
            newHeadsetType: newHeadset.headset_type,
          }),
        ]
      );

      await connection.commit();
      connection.release();

      return res.status(201).json(
        successResponse(
          {
            agentId: agent_id,
            agentName: agent.name,

            fromAssignmentId,
            newAssignmentId,

            fromProcessId,
            toProcessId: to_process_id,
            toProcessName: toProcess.name,

            oldHeadset: { id: oldHeadsetId, number: oldHeadsetNumber, type: oldHeadsetType },
            newHeadset: { id: effectiveNewHeadsetId, number: newHeadset.headset_number, type: newHeadset.headset_type },

            baseDeposit: {
              id: baseDepositId,
              type: baseDepositType,
              depositAmount: baseDepositAmount,
              refundEligibleAmount: baseRefundEligible,
              receiptNumber: baseReceipt,
            },

            adjustment: {
              fee: adjustmentFee,
              feeFormatted: formatCurrency(adjustmentFee),
              absFee: Math.abs(adjustmentFee),
              absFeeFormatted: formatCurrency(Math.abs(adjustmentFee)),
              depositId: adjustmentDepositId,
              paymentMode: adjustmentDepositId ? payment_mode : null,
            },

            transferId,
          },
          `Process change completed for ${agent.name} (New Assignment #${newAssignmentId})`
        )
      );
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (error) {
    console.error('❌ Process change v2 error:', error);
    return res.status(500).json(errorResponse('Failed to process change (v2)'));
  }
};

// ============================================
// Existing Process Change (legacy) - kept as-is
// ============================================
export const processChange = async (req, res) => {
  try {
    const {
      agent_id,
      from_process_id,
      to_process_id,
      old_headset_id,
      new_headset_id,
      additional_deposit = 500,
      payment_mode = 'cash',
      receipt_number,
      notes
    } = req.body;

    console.log('📝 Process change request:', req.body);

    if (!agent_id || !from_process_id || !to_process_id || !old_headset_id || !new_headset_id) {
      return res.status(400).json(errorResponse('All fields are required'));
    }

    if (old_headset_id === new_headset_id) {
      return res.status(400).json(errorResponse('Old and new headset cannot be the same'));
    }

    const [agent] = await db.query(
      `SELECT a.id, u.name, u.employee_id, u.temp_employee_id
       FROM agents a JOIN users u ON a.user_id = u.id WHERE a.id = ?`,
      [agent_id]
    );

    if (agent.length === 0) {
      return res.status(404).json(errorResponse('Agent not found'));
    }

    const [fromProcess] = await db.query('SELECT * FROM processes WHERE id = ?', [from_process_id]);
    const [toProcess] = await db.query('SELECT * FROM processes WHERE id = ?', [to_process_id]);

    if (fromProcess.length === 0 || toProcess.length === 0) {
      return res.status(404).json(errorResponse('Process not found'));
    }

    const [oldHeadset] = await db.query('SELECT * FROM headsets WHERE id = ?', [old_headset_id]);
    if (oldHeadset.length === 0) {
      return res.status(404).json(errorResponse('Old headset not found'));
    }

    const [newHeadset] = await db.query('SELECT * FROM headsets WHERE id = ?', [new_headset_id]);
    if (newHeadset.length === 0) {
      return res.status(404).json(errorResponse('New headset not found'));
    }

    if (newHeadset[0].status !== 'available') {
      return res.status(400).json(errorResponse(`New headset ${newHeadset[0].headset_number} is not available`));
    }

    const [currentAssignment] = await db.query(
      'SELECT id FROM headset_assignments WHERE agent_id = ? AND headset_id = ? AND is_active = 1',
      [agent_id, old_headset_id]
    );

    if (currentAssignment.length === 0) {
      return res.status(400).json(errorResponse('No active assignment found for old headset'));
    }

    if (fromProcess[0].category === 'standard' && toProcess[0].category === 'premium' && additional_deposit < 500) {
      return res.status(400).json(errorResponse('Process change from standard to premium requires Rs 500 deposit'));
    }

    const [newBrand] = await db.query('SELECT refund_amount FROM headset_brands WHERE id = ?', [newHeadset[0].brand_id]);
    const refundEligible = newBrand[0]?.refund_amount || 1100;

    const finalReceiptNumber = receipt_number || generateReceiptNumber('PCH');

    const [template] = await db.query(
      'SELECT id FROM pdf_templates WHERE template_type = ? AND is_active = 1 LIMIT 1',
      ['enc_exchange']
    );

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // ✅ IMPORTANT: keep agent.process_id in sync so Agents page shows latest process
      await connection.query(
        'UPDATE agents SET process_id = ?, updated_at = NOW() WHERE id = ?',
        [to_process_id, agent_id]
      );

      await connection.query(
        `UPDATE headset_assignments 
         SET is_active = FALSE, return_date = NOW(), return_condition = 'good',
             notes = CONCAT(IFNULL(notes, ''), ?), updated_at = NOW()
         WHERE id = ?`,
        [` | Process change: ${newHeadset[0].headset_number}`, currentAssignment[0].id]
      );

      await connection.query(
        'UPDATE headsets SET status = ?, updated_at = NOW() WHERE id = ?',
        ['available', old_headset_id]
      );

      const [newAssignment] = await connection.query(
        `INSERT INTO headset_assignments (
          headset_id, agent_id, process_id, assigned_by, assignment_date, is_verified, is_active, notes,
          tl_name, manager_name
        ) VALUES (?, ?, ?, ?, NOW(), FALSE, TRUE, ?, ?, ?)`,
        [
          new_headset_id,
          agent_id,
          to_process_id,
          req.user.id,
          `Process change from ${fromProcess[0].name}. Old headset: ${oldHeadset[0].headset_number}`,
          'N/A',
          'N/A'
        ]
      );

      const newAssignmentId = newAssignment.insertId;

      await connection.query(
        'UPDATE headsets SET status = ?, is_brand_new = FALSE, updated_at = NOW() WHERE id = ?',
        ['assigned', new_headset_id]
      );

      const [depositResult] = await connection.query(
        `INSERT INTO deposits (
          assignment_id, agent_id, headset_id, headset_number,
          old_headset_id, old_headset_number,
          deposit_type, deposit_amount, refund_eligible_amount,
          deposit_date, refund_status, process_change_fee,
          receipt_number, payment_mode, processed_by, notes, pdf_template_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'process_change', ?, ?, NOW(), 'pending', ?, ?, ?, ?, ?, ?)`,
        [
          newAssignmentId,
          agent_id,
          new_headset_id,
          newHeadset[0].headset_number,
          old_headset_id,
          oldHeadset[0].headset_number,
          additional_deposit,
          refundEligible,
          additional_deposit,
          finalReceiptNumber,
          payment_mode,
          req.user.id,
          notes || null,
          template[0]?.id || null
        ]
      );

      const [transferResult] = await connection.query(
        `INSERT INTO transfers (
          transfer_type, agent_id, headset_id, from_process_id, to_process_id,
          old_headset_id, old_headset_number, new_headset_number,
          transfer_date, reason, additional_deposit, approved_by, processed_by, notes
        ) VALUES ('agent_process_change', ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
        [
          agent_id,
          new_headset_id,
          from_process_id,
          to_process_id,
          old_headset_id,
          oldHeadset[0].headset_number,
          newHeadset[0].headset_number,
          `${fromProcess[0].name} -> ${toProcess[0].name}`,
          additional_deposit,
          req.user.id,
          req.user.id,
          notes || null
        ]
      );

      await connection.query(
        'UPDATE transfers SET deposit_id = ? WHERE id = ?',
        [depositResult.insertId, transferResult.insertId]
      );

      await connection.query(
        `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, action_timestamp)
         VALUES (?, 'transfer_created', 'transfers', ?, ?, NOW())`,
        [
          req.user.id,
          transferResult.insertId,
          JSON.stringify({
            agent_name: agent[0].name,
            from_process: fromProcess[0].name,
            to_process: toProcess[0].name,
            old_headset: oldHeadset[0].headset_number,
            new_headset: newHeadset[0].headset_number,
            deposit: additional_deposit
          })
        ]
      );

      await connection.commit();
      connection.release();

      res.status(201).json(successResponse({
        transferId: transferResult.insertId,
        depositId: depositResult.insertId,
        newAssignmentId: newAssignmentId,
        agentName: agent[0].name,
        fromProcess: fromProcess[0].name,
        toProcess: toProcess[0].name,
        oldHeadset: oldHeadset[0].headset_number,
        newHeadset: newHeadset[0].headset_number,
        additionalDeposit: additional_deposit,
        receiptNumber: finalReceiptNumber
      }, `Process change completed for ${agent[0].name}`));
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (error) {
    console.error('❌ Process change error:', error);
    res.status(500).json(errorResponse('Failed to process change'));
  }
};

export default {
  getAllTransfers,
  transferHeadset,
  processChange,
  processChangeV2
};
