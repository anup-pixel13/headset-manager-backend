import db from '../config/database.js';
import { successResponse, errorResponse, paginatedResponse } from '../utils/helpers.js';

// --------------------------------------------
// helpers
// --------------------------------------------
const normalizeBrandGroup = (v) => String(v || '').trim().toLowerCase();

const getBrandGroupFromHeadsetType = (headsetType) => {
  const t = String(headsetType || '').trim().toLowerCase();
  return t.startsWith('voix') ? 'voix' : 'tech';
};

const assertLotEditable = (lot) => {
  if (!lot) return 'Repair lot not found';
  if (lot.status !== 'draft') return `Lot cannot be edited when status is "${lot.status}"`;
  return '';
};

const isAllowedCondition = (c) => {
  const v = String(c || '').toLowerCase();
  return ['brand_new', 'good', 'fair', 'damaged', 'lost'].includes(v);
};

// ✅ Simple lot_code generator (works with your retry loop)
const buildLotCode = async (_conn) => {
  const year = new Date().getFullYear();
  const rnd = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
  return `RLOT-${year}-${rnd}`;
};

// ✅ Refund eligible amount helper (uses deposits.refund_eligible_amount if present)
const getOriginalRefundEligibleAmount = async (conn, assignmentId) => {
  const [rows] = await conn.query(
    `SELECT refund_eligible_amount
     FROM deposits
     WHERE assignment_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [assignmentId]
  );

  if (rows?.length && rows[0].refund_eligible_amount !== null && rows[0].refund_eligible_amount !== undefined) {
    return Number(rows[0].refund_eligible_amount || 0);
  }
  return 0;
};

// --------------------------------------------
// LOT RECEIVE
// --------------------------------------------

// POST /api/repairs/lots/:id/receive
// body: { items: [{ headset_id, condition_after, receive_notes }] }
export const receiveRepairLotItems = async (req, res) => {
  try {
    const lotId = Number(req.params.id);
    const { items = [] } = req.body;

    if (!lotId) return res.status(400).json(errorResponse('Invalid lot id'));
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json(errorResponse('items[] is required'));
    }

    for (const it of items) {
      if (!it?.headset_id) return res.status(400).json(errorResponse('Each item must include headset_id'));
      if (!isAllowedCondition(it?.condition_after)) {
        return res
          .status(400)
          .json(errorResponse('condition_after must be one of brand_new, good, fair, damaged, lost'));
      }
    }

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [lots] = await conn.query('SELECT * FROM repair_lots WHERE id = ? LIMIT 1', [lotId]);
      if (!lots.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Repair lot not found'));
      }

      const lot = lots[0];
      if (!['sent', 'partially_received'].includes(lot.status)) {
        await conn.rollback();
        conn.release();
        return res
          .status(400)
          .json(errorResponse(`Lot must be sent/partially_received to receive items (current: ${lot.status})`));
      }

      for (const it of items) {
        const headsetId = Number(it.headset_id);
        const condAfter = String(it.condition_after).toLowerCase();
        const notes = it.receive_notes ? String(it.receive_notes) : null;

        const [lotItemRows] = await conn.query(
          `SELECT id, received_at
           FROM repair_lot_items
           WHERE lot_id = ? AND headset_id = ?
           LIMIT 1`,
          [lotId, headsetId]
        );

        if (!lotItemRows.length) {
          await conn.rollback();
          conn.release();
          return res.status(400).json(errorResponse(`Headset ${headsetId} is not part of this lot`));
        }

        // idempotent: already received => skip
        if (lotItemRows[0].received_at) continue;

        await conn.query(
          `UPDATE repair_lot_items
           SET received_at = NOW(),
               condition_after = ?,
               receive_notes = ?,
               received_by = ?
           WHERE lot_id = ? AND headset_id = ?`,
          [condAfter, notes, req.user.id, lotId, headsetId]
        );

        // Update headset status/condition
        const [hsNow] = await conn.query('SELECT status FROM headsets WHERE id = ? LIMIT 1', [headsetId]);
        const currentStatus = hsNow?.[0]?.status;

        if (currentStatus === 'assigned') {
          await conn.query(
            `UPDATE headsets
             SET condition_status = ?,
                 updated_at = NOW()
             WHERE id = ?`,
            [condAfter, headsetId]
          );
        } else {
          await conn.query(
            `UPDATE headsets
             SET status = 'available',
                 condition_status = ?,
                 updated_at = NOW()
             WHERE id = ?`,
            [condAfter, headsetId]
          );
        }
      }

      // recompute completion from DB truth
      const [cntRows] = await conn.query(
        `SELECT
           COUNT(*) AS totalCount,
           SUM(CASE WHEN received_at IS NOT NULL THEN 1 ELSE 0 END) AS receivedCount
         FROM repair_lot_items
         WHERE lot_id = ?`,
        [lotId]
      );

      const totalCount = Number(cntRows?.[0]?.totalCount || 0);
      const receivedCount = Number(cntRows?.[0]?.receivedCount || 0);

      if (totalCount > 0 && receivedCount === totalCount) {
        await conn.query(
          `UPDATE repair_lots
           SET status = 'received',
               received_at = COALESCE(received_at, NOW()),
               updated_by = ?
           WHERE id = ?`,
          [req.user.id, lotId]
        );
      } else {
        await conn.query(
          `UPDATE repair_lots
           SET status = 'partially_received',
               updated_by = ?
           WHERE id = ?`,
          [req.user.id, lotId]
        );
      }

      await conn.commit();
      conn.release();

      return res.json(successResponse({ lotId, receivedCount, totalCount }, 'Items received updated'));
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ receiveRepairLotItems:', e);
    return res.status(500).json(errorResponse('Failed to receive lot items'));
  }
};

// --------------------------------------------
// LOTS
// --------------------------------------------

// POST /api/repairs/lots
export const createRepairLot = async (req, res) => {
  try {
    const { brand_group, vendor_name = null, notes = null } = req.body;

    const bg = normalizeBrandGroup(brand_group);
    if (!['voix', 'tech'].includes(bg)) {
      return res.status(400).json(errorResponse('brand_group must be voix or tech'));
    }

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      // generate a unique lot code (retry a few times)
      let lotCode = null;
      for (let i = 0; i < 5; i++) {
        const candidate = await buildLotCode(conn);
        const [exists] = await conn.query('SELECT id FROM repair_lots WHERE lot_code = ? LIMIT 1', [candidate]);
        if (!exists.length) {
          lotCode = candidate;
          break;
        }
      }
      if (!lotCode) {
        await conn.rollback();
        conn.release();
        return res.status(500).json(errorResponse('Failed to generate lot_code'));
      }

      const [r] = await conn.query(
        `INSERT INTO repair_lots (lot_code, brand_group, status, vendor_name, notes, created_by, updated_by)
         VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
        [lotCode, bg, vendor_name, notes, req.user.id, req.user.id]
      );

      await conn.commit();
      conn.release();

      return res.status(201).json(successResponse({ id: r.insertId, lotCode }, 'Repair lot created'));
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ createRepairLot:', e);
    return res.status(500).json(errorResponse('Failed to create repair lot'));
  }
};

// GET /api/repairs/lots
// controllers/repairController.js (or wherever listRepairLots is)
export const listRepairLots = async (req, res) => {
  try {
    const { search = '', brand_group = '', status = '', page = 1, limit = 20, sort_order = 'DESC' } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    const where = ['1=1'];
    const params = [];

    if (search) {
      where.push(`(rl.lot_code LIKE ? OR rl.vendor_name LIKE ? OR rl.notes LIKE ?)`);
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    if (brand_group) {
      where.push(`rl.brand_group = ?`);
      params.push(brand_group);
    }

    // ✅ exact status match (no special "receive" status anymore)
    if (status) {
      where.push(`rl.status = ?`);
      params.push(status);
    }

    const whereSql = where.join(' AND ');
    const sortDir = String(sort_order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM repair_lots rl
       WHERE ${whereSql}`,
      params
    );
    const total = countRows?.[0]?.total ?? 0;

    const [rows] = await db.query(
      `SELECT
         rl.*,
         COALESCE(t.total_items, 0) AS total_items,
         COALESCE(t.received_items, 0) AS received_items
       FROM repair_lots rl
       LEFT JOIN (
         SELECT
           lot_id,
           COUNT(*) AS total_items,
           SUM(CASE WHEN received_at IS NOT NULL THEN 1 ELSE 0 END) AS received_items
         FROM repair_lot_items
         GROUP BY lot_id
       ) t ON t.lot_id = rl.id
       WHERE ${whereSql}
       ORDER BY rl.id ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const data = rows.map((r) => ({
      id: r.id,
      lotCode: r.lot_code,
      brandGroup: r.brand_group,
      status: r.status,
      vendorName: r.vendor_name,
      notes: r.notes,
      sentAt: r.sent_at,
      receivedAt: r.received_at,
      itemsTotal: Number(r.total_items || 0),
      itemsReceived: Number(r.received_items || 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return res.json(paginatedResponse(data, total, pageNum, limitNum));
  } catch (e) {
    console.error('❌ listRepairLots:', e);
    return res.status(500).json(errorResponse('Failed to list repair lots'));
  }
};
// GET /api/repairs/lots/:id
export const getRepairLotById = async (req, res) => {
  try {
    const id = Number(req.params.id);

    const [lots] = await db.query('SELECT * FROM repair_lots WHERE id = ? LIMIT 1', [id]);
    if (!lots.length) return res.status(404).json(errorResponse('Repair lot not found'));

    const lot = lots[0];

    const [items] = await db.query(
      `SELECT
         rli.*,
         h.headset_number,
         h.headset_type,
         h.status as headset_status,
         h.condition_status as headset_condition
       FROM repair_lot_items rli
       JOIN headsets h ON h.id = rli.headset_id
       WHERE rli.lot_id = ?
       ORDER BY rli.id DESC`,
      [id]
    );

    const data = {
      id: lot.id,
      lotCode: lot.lot_code,
      brandGroup: lot.brand_group,
      status: lot.status,
      vendorName: lot.vendor_name,
      notes: lot.notes,
      sentAt: lot.sent_at,
      receivedAt: lot.received_at,
      items: items.map((x) => ({
        id: x.id,
        headsetId: x.headset_id,
        headsetNumber: x.headset_number,
        headsetType: x.headset_type,
        headsetStatus: x.headset_status,
        headsetCondition: x.headset_condition,
        conditionBefore: x.condition_before,
        conditionAfter: x.condition_after,
        addedAt: x.added_at,
        sentAt: x.sent_at,
        receivedAt: x.received_at,
        receiveNotes: x.receive_notes,
      })),
    };

    return res.json(successResponse(data));
  } catch (e) {
    console.error('❌ getRepairLotById:', e);
    return res.status(500).json(errorResponse('Failed to get repair lot'));
  }
};

// POST /api/repairs/lots/:id/items
export const addItemsToRepairLot = async (req, res) => {
  try {
    const lotId = Number(req.params.id);
    const { headset_id, headset_ids } = req.body;

    const ids = Array.isArray(headset_ids) ? headset_ids : headset_id ? [headset_id] : [];
    const headsetIds = ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);

    if (!headsetIds.length) return res.status(400).json(errorResponse('headset_id or headset_ids is required'));

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [lots] = await conn.query('SELECT * FROM repair_lots WHERE id = ? LIMIT 1', [lotId]);
      if (!lots.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Repair lot not found'));
      }
      const lot = lots[0];

      const editableErr = assertLotEditable(lot);
      if (editableErr) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse(editableErr));
      }

      const [hsRows] = await conn.query(
        `SELECT id, headset_number, headset_type, status, condition_status
         FROM headsets
         WHERE id IN (${headsetIds.map(() => '?').join(',')})`,
        headsetIds
      );

      if (hsRows.length !== headsetIds.length) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('One or more headset_ids not found'));
      }

      for (const hs of hsRows) {
        const bg = getBrandGroupFromHeadsetType(hs.headset_type);
        if (bg !== lot.brand_group) {
          await conn.rollback();
          conn.release();
          return res.status(400).json(
            errorResponse(
              `Headset ${hs.headset_number} brand group (${bg}) does not match lot brand group (${lot.brand_group})`
            )
          );
        }

        if (!['damaged', 'repair'].includes(hs.status)) {
          await conn.rollback();
          conn.release();
          return res.status(400).json(
            errorResponse(
              `Headset ${hs.headset_number} must have status damaged/repair to add to a lot (current: ${hs.status})`
            )
          );
        }
		// block if headset already exists in another lot that is not fully received
		const [existsRows] = await conn.query(
		  `
		  SELECT rli.lot_id, rl.lot_code, rl.status
		  FROM repair_lot_items rli
		  JOIN repair_lots rl ON rl.id = rli.lot_id
		  WHERE rli.headset_id = ?
		    AND rl.status IN ('draft', 'sent', 'partially_received')
		  LIMIT 1
		  `,
		  [hs.id]
		);

		if (existsRows.length) {
		  await conn.rollback();
		  conn.release();
		  return res.status(400).json(
		    errorResponse(
		      `Headset ${hs.headset_number} is already in lot ${existsRows[0].lot_code} (status: ${existsRows[0].status}).`
		    )
		  );
		}

        await conn.query(
          `INSERT INTO repair_lot_items (lot_id, headset_id, condition_before)
           VALUES (?, ?, ?)`,
          [lotId, hs.id, hs.condition_status || null]
        );
      }

      await conn.query('UPDATE repair_lots SET updated_by = ? WHERE id = ?', [req.user.id, lotId]);

      await conn.commit();
      conn.release();

      return res.status(201).json(successResponse({ lotId, added: hsRows.length }, 'Items added to lot'));
    } catch (e) {
      await conn.rollback();
      conn.release();

      if (String(e?.code) === 'ER_DUP_ENTRY') {
        return res.status(400).json(errorResponse('One or more headsets already exist in this lot'));
      }
      throw e;
    }
  } catch (e) {
    console.error('❌ addItemsToRepairLot:', e);
    return res.status(500).json(errorResponse('Failed to add items to lot'));
  }
};

// GET /api/repairs/replacements
export const getTempReplacements = async (req, res) => {
  try {
    const { status = 'active', search = '', page = 1, limit = 20, sort_order = 'DESC' } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = Math.min(parseInt(limit) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    const wantActive = String(status).toLowerCase() !== 'inactive';

    const where = [
      `ha.assignment_kind = 'temp_replacement'`,
      wantActive ? `ha.is_active = 1` : `ha.is_active = 0`,
    ];
    const params = [];

    if (search) {
      where.push(`(
        u.name LIKE ? OR
        u.employee_id LIKE ? OR
        u.temp_employee_id LIKE ? OR
        h.headset_number LIKE ? OR
        ph.headset_number LIKE ?
      )`);
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    const whereSql = where.join(' AND ');
    const sortDir = String(sort_order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM headset_assignments ha
       JOIN agents a ON a.id = ha.agent_id
       JOIN users u ON u.id = a.user_id
       JOIN headsets h ON h.id = ha.headset_id
       LEFT JOIN headset_assignments parent ON parent.id = ha.parent_assignment_id
       LEFT JOIN headsets ph ON ph.id = parent.headset_id
       WHERE ${whereSql}`,
      params
    );

    const total = countRows?.[0]?.total ?? 0;

    const [rows] = await db.query(
      `SELECT
         ha.id AS temp_assignment_id,
         ha.agent_id,
         ha.headset_id AS temp_headset_id,
         ha.process_id,
         ha.assignment_date,
         ha.return_date,
         ha.return_condition,
         ha.notes,
         ha.parent_assignment_id,
         ha.is_active,

         u.id AS user_id,
         u.name AS agent_name,
         u.employee_id,
         u.temp_employee_id,
         u.is_active AS user_is_active,

         h.headset_number AS temp_headset_number,
         h.headset_type AS temp_headset_type,
         h.status AS temp_headset_status,

         p.name AS process_name,

         parent.headset_id AS original_headset_id,
         ph.headset_number AS original_headset_number,
         ph.headset_type AS original_headset_type,
         ph.status AS original_headset_status,

         parent.hold_status AS original_hold_status,
         parent.hold_started_at,
         parent.hold_ended_at,

         rli_latest.received_at AS original_repair_received_at,
         rl_latest.lot_code AS original_repair_lot_code,
         rl_latest.status AS original_repair_lot_status,

         CASE
           WHEN ha.is_active = 1
            AND ha.parent_assignment_id IS NOT NULL
            AND rli_latest.received_at IS NOT NULL
           THEN 1 ELSE 0
         END AS ready_for_rehandover

       FROM headset_assignments ha
       JOIN agents a ON a.id = ha.agent_id
       JOIN users u ON u.id = a.user_id
       JOIN headsets h ON h.id = ha.headset_id
       LEFT JOIN processes p ON p.id = ha.process_id
       LEFT JOIN headset_assignments parent ON parent.id = ha.parent_assignment_id
       LEFT JOIN headsets ph ON ph.id = parent.headset_id

       LEFT JOIN (
         SELECT rli1.*
         FROM repair_lot_items rli1
         JOIN (
           SELECT headset_id, MAX(id) AS max_id
           FROM repair_lot_items
           GROUP BY headset_id
         ) mx ON mx.headset_id = rli1.headset_id AND mx.max_id = rli1.id
       ) rli_latest
         ON rli_latest.headset_id = parent.headset_id
        AND (
          parent.hold_started_at IS NULL
          OR rli_latest.added_at >= parent.hold_started_at
        )

       LEFT JOIN repair_lots rl_latest ON rl_latest.id = rli_latest.lot_id

       WHERE ${whereSql}
       ORDER BY ha.id ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const data = rows.map((r) => {
      const readyForRehandover = Number(r.ready_for_rehandover) === 1;

      return {
        tempAssignmentId: r.temp_assignment_id,
        parentAssignmentId: r.parent_assignment_id,

        agent: {
          agentId: r.agent_id,
          userId: r.user_id,
          name: r.agent_name,
          employeeId: r.employee_id || r.temp_employee_id || null,
          userIsActive: Number(r.user_is_active) === 1,
        },

        process: {
          id: r.process_id,
          name: r.process_name || null,
        },

        tempHeadset: {
          id: r.temp_headset_id,
          number: r.temp_headset_number,
          type: r.temp_headset_type,
          status: r.temp_headset_status,
        },

        originalHeadset: r.original_headset_id
          ? {
              id: r.original_headset_id,
              number: r.original_headset_number,
              type: r.original_headset_type,
              status: r.original_headset_status,
            }
          : null,

        originalHold: {
          status: r.original_hold_status || null,
          holdStartedAt: r.hold_started_at || null,
          holdEndedAt: r.hold_ended_at || null,
        },

        originalRepair: {
          receivedAt: r.original_repair_received_at || null,
          lotCode: r.original_repair_lot_code || null,
          lotStatus: r.original_repair_lot_status || null,
        },

        readyForRehandover,
        assignmentDate: r.assignment_date,
        returnDate: r.return_date,
        returnCondition: r.return_condition,
        notes: r.notes,
        isActive: Number(r.is_active) === 1,
      };
    });

    return res.json(paginatedResponse(data, total, pageNum, limitNum));
  } catch (e) {
    console.error('❌ getTempReplacements:', e);
    return res.status(500).json(errorResponse('Failed to fetch temp replacements'));
  }
};

export const returnOriginalRepairedHeadsetToInventory = async (req, res) => {
  try {
    const { parent_assignment_id, condition_after = null, notes = null } = req.body || {};
    const parentAssignmentId = Number(parent_assignment_id);

    if (!parentAssignmentId) {
      return res.status(400).json(errorResponse('parent_assignment_id is required'));
    }

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [permRows] = await conn.query(
        `SELECT
           ha.id,
           ha.agent_id,
           ha.headset_id,
           ha.assignment_kind,
           ha.is_active,
           ha.return_date,
           h.headset_number,
           h.status AS headset_status,
           h.condition_status
         FROM headset_assignments ha
         JOIN headsets h ON h.id = ha.headset_id
         WHERE ha.id = ?
           AND ha.assignment_kind = 'permanent'
         LIMIT 1`,
        [parentAssignmentId]
      );

      if (!permRows.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Permanent assignment not found'));
      }

      const perm = permRows[0];

      const [tempRows] = await conn.query(
        `SELECT id, is_active, return_date
         FROM headset_assignments
         WHERE parent_assignment_id = ?
           AND assignment_kind = 'temp_replacement'
         ORDER BY id DESC
         LIMIT 1`,
        [parentAssignmentId]
      );

      const temp = tempRows?.[0] || null;
      if (temp && Number(temp.is_active) === 1) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Cannot return original to inventory while temp replacement is still active'));
      }

      const [repairRows] = await conn.query(
        `SELECT
           rli.received_at,
           rli.condition_after,
           rl.lot_code,
           rl.status AS lot_status
         FROM repair_lot_items rli
         JOIN repair_lots rl ON rl.id = rli.lot_id
         WHERE rli.headset_id = ?
         ORDER BY rli.id DESC
         LIMIT 1`,
        [perm.headset_id]
      );

      const repair = repairRows?.[0] || null;

      if (!repair || !repair.received_at) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Original headset is not received from repair lot yet'));
      }

      const finalCondition = String(condition_after || repair.condition_after || perm.condition_status || 'good')
        .trim()
        .toLowerCase();

      if (!['brand_new', 'good', 'fair', 'damaged', 'lost'].includes(finalCondition)) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Invalid condition_after'));
      }

      await conn.query(
        `UPDATE headsets
         SET status = 'available',
             condition_status = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [finalCondition, perm.headset_id]
      );

      if (notes) {
        await conn.query(
          `UPDATE headset_assignments
           SET notes = CONCAT(IFNULL(notes,''), ?),
               updated_at = NOW()
           WHERE id = ?`,
          [` | Original returned to inventory after repair. ${notes}`, parentAssignmentId]
        );
      }

      await conn.commit();
      conn.release();

      return res.json(
        successResponse(
          {
            parentAssignmentId,
            headsetId: perm.headset_id,
            headsetNumber: perm.headset_number,
            conditionAfter: finalCondition,
          },
          'Original repaired headset returned to inventory'
        )
      );
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ returnOriginalRepairedHeadsetToInventory:', e);
    return res.status(500).json(errorResponse('Failed to return original repaired headset to inventory'));
  }
};

// DELETE /api/repairs/lots/:id/items/:itemId
export const removeRepairLotItem = async (req, res) => {
  try {
    const lotId = Number(req.params.id);
    const itemId = Number(req.params.itemId);

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [lots] = await conn.query('SELECT * FROM repair_lots WHERE id = ? LIMIT 1', [lotId]);
      if (!lots.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Repair lot not found'));
      }
      const lot = lots[0];

      const editableErr = assertLotEditable(lot);
      if (editableErr) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse(editableErr));
      }

      const [items] = await conn.query('SELECT * FROM repair_lot_items WHERE id = ? AND lot_id = ? LIMIT 1', [
        itemId,
        lotId,
      ]);
      if (!items.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Lot item not found'));
      }

      await conn.query('DELETE FROM repair_lot_items WHERE id = ? AND lot_id = ?', [itemId, lotId]);
      await conn.query('UPDATE repair_lots SET updated_by = ? WHERE id = ?', [req.user.id, lotId]);

      await conn.commit();
      conn.release();

      return res.json(successResponse({ lotId, itemId }, 'Item removed from lot'));
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ removeRepairLotItem:', e);
    return res.status(500).json(errorResponse('Failed to remove lot item'));
  }
};

// POST /api/repairs/lots/:id/send
export const sendRepairLot = async (req, res) => {
  try {
    const lotId = Number(req.params.id);

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [lots] = await conn.query('SELECT * FROM repair_lots WHERE id = ? LIMIT 1', [lotId]);
      if (!lots.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Repair lot not found'));
      }
      const lot = lots[0];

      const editableErr = assertLotEditable(lot);
      if (editableErr) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse(editableErr));
      }

      const [items] = await conn.query('SELECT headset_id FROM repair_lot_items WHERE lot_id = ?', [lotId]);
      if (!items.length) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Cannot send an empty lot'));
      }

      await conn.query(
        `UPDATE repair_lots
         SET status = 'sent', sent_at = NOW(), updated_by = ?
         WHERE id = ?`,
        [req.user.id, lotId]
      );

      await conn.query('UPDATE repair_lot_items SET sent_at = NOW() WHERE lot_id = ?', [lotId]);

      const headsetIds = items.map((x) => x.headset_id);
      await conn.query(
        `UPDATE headsets
         SET status = 'repair', updated_at = NOW()
         WHERE id IN (${headsetIds.map(() => '?').join(',')})`,
        headsetIds
      );

      await conn.commit();
      conn.release();

      return res.json(successResponse({ lotId, count: headsetIds.length }, 'Lot marked as sent for repair'));
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ sendRepairLot:', e);
    return res.status(500).json(errorResponse('Failed to send repair lot'));
  }
};

// --------------------------------------------
// TEMP REPLACEMENT WORKFLOW
// --------------------------------------------

// POST /api/repairs/start-replacement
export const startRepairReplacement = async (req, res) => {
  try {
    const { agent_id, temp_headset_id, notes = null, old_condition = 'damaged' } = req.body;

    const agentId = Number(agent_id);
    const tempHeadsetId = Number(temp_headset_id);

    if (!agentId || !tempHeadsetId) {
      return res.status(400).json(errorResponse('agent_id and temp_headset_id are required'));
    }

    const oldCond = String(old_condition || 'damaged').trim().toLowerCase();
    if (!['good', 'fair', 'damaged', 'lost', 'brand_new'].includes(oldCond)) {
      return res.status(400).json(errorResponse('old_condition is invalid'));
    }

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [permRows] = await conn.query(
        `SELECT ha.*
         FROM headset_assignments ha
         WHERE ha.agent_id = ?
           AND ha.is_active = 1
           AND ha.assignment_kind = 'permanent'
           AND ha.hold_status = 'none'
         ORDER BY ha.id DESC
         LIMIT 1`,
        [agentId]
      );

      if (!permRows.length) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('No active permanent assignment found (or already on hold)'));
      }

      const perm = permRows[0];

      const [oldHsRows] = await conn.query(
        `SELECT id, headset_number, headset_type, status, condition_status
         FROM headsets WHERE id = ? LIMIT 1`,
        [perm.headset_id]
      );
      if (!oldHsRows.length) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Old headset not found'));
      }
      const oldHs = oldHsRows[0];

      const [tempRows] = await conn.query(
        `SELECT id, headset_number, headset_type, status
         FROM headsets WHERE id = ? LIMIT 1`,
        [tempHeadsetId]
      );
      if (!tempRows.length) {
        await conn.rollback();
        conn.release();
        return res.status(404).json(errorResponse('Temp headset not found'));
      }
      const tempHs = tempRows[0];

      if (tempHs.status !== 'available') {
        await conn.rollback();
        conn.release();
        return res
          .status(400)
          .json(errorResponse(`Temp headset ${tempHs.headset_number} is not available (status: ${tempHs.status})`));
      }

      await conn.query(
        `UPDATE headset_assignments
         SET hold_status='on_hold',
             hold_reason='repair',
             hold_started_at=NOW(),
             hold_ended_at=NULL,
             updated_at=NOW()
         WHERE id = ?`,
        [perm.id]
      );

      const [tmpRes] = await conn.query(
        `INSERT INTO headset_assignments (
           headset_id, agent_id, process_id, assigned_by, assignment_date,
           is_verified, is_active, notes, tl_name, manager_name,
           assignment_kind, parent_assignment_id
         ) VALUES (?, ?, ?, ?, NOW(), FALSE, TRUE, ?, ?, ?, 'temp_replacement', ?)`,
        [
          tempHeadsetId,
          agentId,
          perm.process_id,
          req.user.id,
          notes ? `Temp replacement for repair. ${notes}` : 'Temp replacement for repair.',
          perm.tl_name || 'N/A',
          perm.manager_name || 'N/A',
          perm.id,
        ]
      );

      await conn.query(
        `UPDATE headsets
         SET status='damaged',
             condition_status=?,
             updated_at=NOW()
         WHERE id = ?`,
        [oldCond, oldHs.id]
      );

      await conn.query(
        `UPDATE headsets
         SET status='assigned',
             is_brand_new=FALSE,
             updated_at=NOW()
         WHERE id = ?`,
        [tempHeadsetId]
      );

      await conn.commit();
      conn.release();

      return res.status(201).json(
        successResponse(
          {
            permanentAssignmentId: perm.id,
            tempAssignmentId: tmpRes.insertId,
            oldHeadset: { id: oldHs.id, number: oldHs.headset_number },
            tempHeadset: { id: tempHs.id, number: tempHs.headset_number },
          },
          'Temporary replacement started; permanent assignment put on hold'
        )
      );
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ startRepairReplacement:', e);
    return res.status(500).json(errorResponse('Failed to start repair replacement'));
  }
};

// POST /api/repairs/re-handover
export const rehandoverRepairedHeadset = async (req, res) => {
  try {
    const { agent_id, parent_assignment_id, condition_after = 'good', notes = null } = req.body;

    const condAfter = String(condition_after || '').trim().toLowerCase();
    if (!['good', 'fair'].includes(condAfter)) {
      return res.status(400).json(errorResponse('condition_after must be good or fair'));
    }

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      let tempAssign = null;

      if (parent_assignment_id) {
        const [tmp] = await conn.query(
          `SELECT *
           FROM headset_assignments
           WHERE parent_assignment_id = ?
             AND assignment_kind='temp_replacement'
             AND is_active=1
           ORDER BY id DESC
           LIMIT 1`,
          [Number(parent_assignment_id)]
        );
        tempAssign = tmp?.[0] || null;
      } else if (agent_id) {
        const [tmp] = await conn.query(
          `SELECT *
           FROM headset_assignments
           WHERE agent_id = ?
             AND assignment_kind='temp_replacement'
             AND is_active=1
           ORDER BY id DESC
           LIMIT 1`,
          [Number(agent_id)]
        );
        tempAssign = tmp?.[0] || null;
      } else {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('agent_id or parent_assignment_id is required'));
      }

      if (!tempAssign) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('No active temp replacement assignment found'));
      }

      if (!tempAssign.parent_assignment_id) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Temp assignment missing parent_assignment_id'));
      }

      const [permRows] = await conn.query(
        `SELECT *
         FROM headset_assignments
         WHERE id = ?
           AND assignment_kind='permanent'
           AND is_active=1
         LIMIT 1`,
        [tempAssign.parent_assignment_id]
      );
      if (!permRows.length) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Parent permanent assignment not found'));
      }
      const perm = permRows[0];

      if (perm.hold_status !== 'on_hold') {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Permanent assignment is not on hold'));
      }

      const [latestItemRows] = await conn.query(
        `SELECT rli.received_at
         FROM repair_lot_items rli
         WHERE rli.headset_id = ?
         ORDER BY rli.id DESC
         LIMIT 1`,
        [perm.headset_id]
      );

      const latestItem = latestItemRows?.[0] || null;
      if (!latestItem || !latestItem.received_at) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(
          errorResponse(
            'Cannot rehandover. Repaired headset is not marked received from repair lot yet. Please receive it in Lots first.'
          )
        );
      }

      await conn.query(
        `UPDATE headset_assignments
         SET is_active=0,
             return_date=NOW(),
             return_condition='good',
             notes = CONCAT(IFNULL(notes,''), ?),
             updated_at=NOW()
         WHERE id = ?`,
        [notes ? ` | Rehandover: ${notes}` : ' | Rehandover', tempAssign.id]
      );

      await conn.query(
        `UPDATE headsets
         SET status='available', updated_at=NOW()
         WHERE id = ?`,
        [tempAssign.headset_id]
      );

      await conn.query(
        `UPDATE headset_assignments
         SET hold_status='none',
             hold_reason=NULL,
             hold_ended_at=NOW(),
             updated_at=NOW()
         WHERE id = ?`,
        [perm.id]
      );

      await conn.query(
        `UPDATE headsets
         SET status='assigned',
             condition_status=?,
             updated_at=NOW()
         WHERE id = ?`,
        [condAfter, perm.headset_id]
      );

      await conn.commit();
      conn.release();

      return res.json(
        successResponse(
          {
            permanentAssignmentId: perm.id,
            tempAssignmentId: tempAssign.id,
            repairedHeadsetId: perm.headset_id,
            tempHeadsetId: tempAssign.headset_id,
          },
          'Rehandover completed (temp closed, permanent unheld)'
        )
      );
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ rehandoverRepairedHeadset:', e);
    return res.status(500).json(errorResponse('Failed to rehandover repaired headset'));
  }
};

// --------------------------------------------
// TEMP REPLACEMENT: AGENT EXIT WORKFLOW (Agenda A)
// --------------------------------------------

// POST /api/repairs/close-replacement-agent-exit
// body:
// {
//   parent_assignment_id?: number,
//   agent_id?: number,
//   temp_headset_received: boolean,
//   temp_return_condition: "good"|"fair"|"damaged"|"lost",
//   notes?: string,
//   reason?: "abscond"|"resign"|"terminated" (optional; default terminated)
// }
export const closeReplacementAgentExit = async (req, res) => {
  try {
    const {
      parent_assignment_id,
      agent_id,
      temp_headset_received,
      temp_return_condition,
      notes = null,
      reason: reasonRaw = 'terminated',
    } = req.body;

    const parentAssignmentId = parent_assignment_id ? Number(parent_assignment_id) : null;
    const agentId = agent_id ? Number(agent_id) : null;

    const received = String(temp_headset_received) === 'true' || temp_headset_received === true;

    const retCond = String(temp_return_condition || '').trim().toLowerCase();
    const allowed = ['good', 'fair', 'damaged', 'lost'];

    if (!allowed.includes(retCond)) {
      return res.status(400).json(errorResponse(`temp_return_condition must be one of: ${allowed.join(', ')}`));
    }

    if (!received && retCond !== 'lost') {
      return res.status(400).json(
        errorResponse(`If temp_headset_received is false, temp_return_condition must be "lost".`)
      );
    }

    if (!parentAssignmentId && !agentId) {
      return res.status(400).json(errorResponse('parent_assignment_id or agent_id is required'));
    }

    const reason = String(reasonRaw || '').trim().toLowerCase();
    if (!['abscond', 'resign', 'terminated'].includes(reason)) {
      return res.status(400).json(errorResponse('reason must be abscond, resign, or terminated'));
    }

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      // 1) Find active temp replacement assignment
      let tempAssign = null;

      if (parentAssignmentId) {
        const [tmp] = await conn.query(
          `SELECT *
           FROM headset_assignments
           WHERE parent_assignment_id = ?
             AND assignment_kind='temp_replacement'
             AND is_active=1
           ORDER BY id DESC
           LIMIT 1`,
          [parentAssignmentId]
        );
        tempAssign = tmp?.[0] || null;
      } else {
        const [tmp] = await conn.query(
          `SELECT *
           FROM headset_assignments
           WHERE agent_id = ?
             AND assignment_kind='temp_replacement'
             AND is_active=1
           ORDER BY id DESC
           LIMIT 1`,
          [agentId]
        );
        tempAssign = tmp?.[0] || null;
      }

      if (!tempAssign) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('No active temp replacement assignment found'));
      }

      if (!tempAssign.parent_assignment_id) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Temp assignment missing parent_assignment_id'));
      }

      // 2) Load parent permanent assignment
      const [permRows] = await conn.query(
        `SELECT *
         FROM headset_assignments
         WHERE id = ?
           AND assignment_kind='permanent'
         LIMIT 1`,
        [tempAssign.parent_assignment_id]
      );

      const perm = permRows?.[0] || null;
      if (!perm) {
        await conn.rollback();
        conn.release();
        return res.status(400).json(errorResponse('Parent permanent assignment not found'));
      }

      // 3) Close temp assignment (agent exit)
      const closeNote = notes ? ` | AgentExit: ${notes}` : ` | AgentExit: ${reason}`;

      await conn.query(
        `UPDATE headset_assignments
         SET is_active=0,
             return_date=NOW(),
             return_condition=?,
             notes = CONCAT(IFNULL(notes,''), ?),
             updated_at=NOW()
         WHERE id = ?`,
        [retCond, closeNote, tempAssign.id]
      );

      // 4) Update temp headset inventory status
      let newTempStatus = 'available';
      if (retCond === 'damaged') newTempStatus = 'damaged';
      if (retCond === 'lost') newTempStatus = 'lost';

      await conn.query(
        `UPDATE headsets
         SET status = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [newTempStatus, tempAssign.headset_id]
      );

      // 5) Close permanent assignment + clear hold
      await conn.query(
        `UPDATE headset_assignments
         SET is_active=0,
             return_date=NOW(),
             return_condition='repair',
             hold_status='none',
             hold_reason=NULL,
             hold_ended_at=NOW(),
             notes = CONCAT(IFNULL(notes,''), ?),
             updated_at=NOW()
         WHERE id = ?`,
        [closeNote, perm.id]
      );

      // 6) Create deassignment + refund request (refund pipeline)
      const refundEligibleAmount = await getOriginalRefundEligibleAmount(conn, perm.id);

      const [deRes] = await conn.query(
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
         ) VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, NOW())`,
        [
          perm.agent_id,
          perm.id,
          reason, // ✅ enum safe: abscond|resign|terminated
          received ? 1 : 0,
          retCond, // ✅ enum safe: good|fair|damaged|lost
          1,
          refundEligibleAmount,
          notes ? `Agent exit: ${notes}` : 'Agent exit: temp replacement closed',
          req.user.id,
        ]
      );

      const deassignmentId = deRes.insertId;

      await conn.query(
        `INSERT INTO refund_requests (
           deassignment_id,
           agent_id,
           assignment_id,
           status,
           eligible_amount,
           remarks,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, 'in_progress', ?, ?, NOW(), NOW())`,
        [
          deassignmentId,
          perm.agent_id,
          perm.id,
          refundEligibleAmount,
          notes ? `Agent exit: ${notes}` : 'Agent exit: temp replacement closed',
        ]
      );
	  
	  // 7) Mark agent as exited (so dashboards/filters stop treating them as active)
	  const newAgentStatus = reason === 'resign' ? 'resigned' : 'terminated';

	  await conn.query(
	    `UPDATE agents
	     SET status = ?
	     WHERE id = ?`,
	    [newAgentStatus, perm.agent_id]
	  );
	  await conn.query(
	    `UPDATE users
	     SET is_active = 0
	     WHERE id = (
	       SELECT user_id FROM agents WHERE id = ?
	     )`,
	    [perm.agent_id]
	  );
      await conn.commit();
      conn.release();

      return res.json(
        successResponse(
          {
            parentAssignmentId: perm.id,
            tempAssignmentId: tempAssign.id,
            tempHeadsetId: tempAssign.headset_id,
            tempHeadsetNewStatus: newTempStatus,
            permanentHeadsetId: perm.headset_id,
            refundEligibleAmount,
            deassignmentId,
          },
          'Replacement closed for agent exit. Temp resolved; permanent assignment closed; refund request created.'
        )
      );
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    console.error('❌ closeReplacementAgentExit:', e);
    return res.status(500).json(errorResponse('Failed to close replacement for agent exit'));
  }
};

export default {
  createRepairLot,
  listRepairLots,
  getRepairLotById,
  addItemsToRepairLot,
  removeRepairLotItem,
  sendRepairLot,
  receiveRepairLotItems,
  startRepairReplacement,
  rehandoverRepairedHeadset,
  getTempReplacements,
  closeReplacementAgentExit,
  returnOriginalRepairedHeadsetToInventory,
};