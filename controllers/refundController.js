// controllers/refundController.js
import db from '../config/database.js';
import { successResponse, errorResponse, paginatedResponse } from '../utils/helpers.js';

// ============================================
// LIST REFUND REQUESTS (dashboard style)
// GET /api/refunds?status=in_progress|processed|not_eligible&search=&start_date=&end_date=&page=&limit=&sort_by=&sort_order=
// ============================================
export const listRefundRequests = async (req, res) => {
  try {
    const {
      status,
      search,
      start_date,
      end_date,
      page = 1,
      limit = 20,
      sort_by = 'created_at',
      sort_order = 'DESC',
    } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    const allowedSortColumns = [
      'created_at',
      'processed_at',
      'reason_date',
      'agent_name',
      'headset_number',
      'eligible_amount',
      'approved_amount',
      'status',
    ];
    const sortColumn = allowedSortColumns.includes(sort_by) ? sort_by : 'created_at';
    const sortDir = String(sort_order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const where = ['1=1'];
    const params = [];

    if (status) {
      where.push('rr.status = ?');
      params.push(status);
    }

    if (search) {
      where.push(`(
        u.name LIKE ? OR
        u.employee_id LIKE ? OR
        u.temp_employee_id LIKE ? OR
        u.email LIKE ? OR
        h.headset_number LIKE ? OR
        ad.reason LIKE ? OR
        th.headset_number LIKE ?
      )`);
      const term = `%${search}%`;
      params.push(term, term, term, term, term, term, term);
    }

    if (start_date) {
      where.push('DATE(rr.created_at) >= ?');
      params.push(start_date);
    }
    if (end_date) {
      where.push('DATE(rr.created_at) <= ?');
      params.push(end_date);
    }

    const whereClause = where.join(' AND ');

    // count (must include same joins used in main query when search uses th.headset_number)
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM refund_requests rr
       JOIN agent_deassignments ad ON ad.id = rr.deassignment_id
       JOIN agents a ON a.id = rr.agent_id
       JOIN users u ON u.id = a.user_id
       JOIN headset_assignments ha ON ha.id = rr.assignment_id
       JOIN headsets h ON h.id = ha.headset_id

       -- ✅ latest temp replacement for this permanent assignment
       LEFT JOIN (
         SELECT t1.*
         FROM headset_assignments t1
         JOIN (
           SELECT parent_assignment_id, MAX(id) AS max_id
           FROM headset_assignments
           WHERE assignment_kind = 'temp_replacement'
             AND parent_assignment_id IS NOT NULL
           GROUP BY parent_assignment_id
         ) mx ON mx.parent_assignment_id = t1.parent_assignment_id AND mx.max_id = t1.id
       ) ta ON ta.parent_assignment_id = ha.id
       LEFT JOIN headsets th ON th.id = ta.headset_id

       WHERE ${whereClause}`,
      params
    );

    const total = countRows?.[0]?.total ?? 0;

    // map sort column -> SQL field
    let orderField = 'rr.created_at';
    if (sortColumn === 'processed_at') orderField = 'rr.processed_at';
    if (sortColumn === 'reason_date') orderField = 'ad.reason_date';
    if (sortColumn === 'agent_name') orderField = 'u.name';
    if (sortColumn === 'headset_number') orderField = 'h.headset_number';
    if (sortColumn === 'eligible_amount') orderField = 'rr.eligible_amount';
    if (sortColumn === 'approved_amount') orderField = 'rr.approved_amount';
    if (sortColumn === 'status') orderField = 'rr.status';

    const [rows] = await db.query(
      `SELECT
        rr.id,
        rr.status,
        rr.eligible_amount,
        rr.approved_amount,
        rr.remarks,
        rr.created_at,
        rr.updated_at,
        rr.processed_at,

        ad.id AS deassignment_id,
        ad.reason,
        ad.reason_date,
        ad.headset_received,
        ad.return_condition,
        ad.refund_eligible,
        ad.refund_amount AS form_refund_amount,

        a.id AS agent_id,
        a.status AS agent_status,

        u.id AS user_id,
        u.name AS agent_name,
        COALESCE(u.employee_id, u.temp_employee_id) AS employee_id,
        u.email AS agent_email,
        u.phone AS agent_phone,
        u.is_active AS user_is_active,

        ha.id AS assignment_id,
        ha.assignment_date,
        ha.return_date,

        h.id AS headset_id,
        h.headset_number,
        h.headset_type,
        h.status AS headset_status,

        -- ✅ temp headset (latest temp replacement for this permanent assignment)
        ta.id AS temp_assignment_id,
        th.headset_number AS temp_headset_number,
        th.headset_type AS temp_headset_type,
        th.status AS temp_headset_status,

        pb.name AS processed_by_name
      FROM refund_requests rr
      JOIN agent_deassignments ad ON ad.id = rr.deassignment_id
      JOIN agents a ON a.id = rr.agent_id
      JOIN users u ON u.id = a.user_id
      JOIN headset_assignments ha ON ha.id = rr.assignment_id
      JOIN headsets h ON h.id = ha.headset_id

      LEFT JOIN (
        SELECT t1.*
        FROM headset_assignments t1
        JOIN (
          SELECT parent_assignment_id, MAX(id) AS max_id
          FROM headset_assignments
          WHERE assignment_kind = 'temp_replacement'
            AND parent_assignment_id IS NOT NULL
          GROUP BY parent_assignment_id
        ) mx ON mx.parent_assignment_id = t1.parent_assignment_id AND mx.max_id = t1.id
      ) ta ON ta.parent_assignment_id = ha.id
      LEFT JOIN headsets th ON th.id = ta.headset_id

      LEFT JOIN users pb ON pb.id = rr.processed_by
      WHERE ${whereClause}
      ORDER BY ${orderField} ${sortDir}
      LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    return res.json(paginatedResponse(rows, total, pageNum, limitNum));
  } catch (error) {
    console.error('❌ List refund requests error:', error);
    return res.status(500).json(errorResponse('Failed to fetch refund requests'));
  }
};

// ============================================
// PROCESS A REFUND REQUEST (mark processed)
// POST /api/refunds/:id/process
// body: { approved_amount, remarks? }
// ============================================
export const processRefundRequest = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { approved_amount, remarks } = req.body || {};

    const amt =
      approved_amount !== undefined && approved_amount !== null && approved_amount !== ''
        ? Number(approved_amount)
        : null;

    if (amt === null || Number.isNaN(amt) || amt < 0) {
      return res.status(400).json(errorResponse('approved_amount must be a number >= 0'));
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [existing] = await conn.query(`SELECT id, status FROM refund_requests WHERE id = ? LIMIT 1`, [id]);

    if (!existing.length) {
      await conn.rollback();
      return res.status(404).json(errorResponse('Refund request not found'));
    }

    if (existing[0].status === 'processed') {
      await conn.rollback();
      return res.status(400).json(errorResponse('Refund request already processed'));
    }

    if (existing[0].status === 'not_eligible') {
      await conn.rollback();
      return res.status(400).json(errorResponse('This refund request is marked not eligible'));
    }

    await conn.query(
      `UPDATE refund_requests
       SET status = 'processed',
           approved_amount = ?,
           processed_by = ?,
           processed_at = NOW(),
           remarks = COALESCE(?, remarks),
           updated_at = NOW()
       WHERE id = ?`,
      [amt, req.user.id, remarks || null, id]
    );

    await conn.commit();

    return res.json(successResponse({ id: Number(id), status: 'processed', approved_amount: amt }, 'Refund processed'));
  } catch (error) {
    if (conn) await conn.rollback();
    console.error('❌ Process refund error:', error);
    return res.status(500).json(errorResponse('Failed to process refund'));
  } finally {
    if (conn) conn.release();
  }
};
// ============================================
// MARK REFUND NOT ELIGIBLE (reversible)
// POST /api/refunds/:id/not-eligible
// body: { remarks? }
// ============================================
export const markRefundNotEligible = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { remarks } = req.body || {};

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [existing] = await conn.query(
      `SELECT id, status FROM refund_requests WHERE id = ? LIMIT 1`,
      [id]
    );

    if (!existing.length) {
      await conn.rollback();
      return res.status(404).json(errorResponse('Refund request not found'));
    }

    if (existing[0].status === 'processed') {
      await conn.rollback();
      return res.status(400).json(errorResponse('Refund request already processed; cannot mark not eligible'));
    }

    // Set not eligible + force approved_amount = 0 so there is no payout ambiguity
    await conn.query(
      `UPDATE refund_requests
       SET status = 'not_eligible',
           approved_amount = 0,
           processed_by = ?,
           processed_at = NOW(),
           remarks = COALESCE(?, remarks),
           updated_at = NOW()
       WHERE id = ?`,
      [req.user.id, remarks || null, id]
    );

    await conn.commit();

    return res.json(
      successResponse(
        { id: Number(id), status: 'not_eligible', approved_amount: 0 },
        'Refund marked as not eligible'
      )
    );
  } catch (error) {
    if (conn) await conn.rollback();
    console.error('❌ markRefundNotEligible error:', error);
    return res.status(500).json(errorResponse('Failed to mark refund not eligible'));
  } finally {
    if (conn) conn.release();
  }
};

// ============================================
// REOPEN REFUND (reversible)
// POST /api/refunds/:id/reopen
// body: { remarks? }
// ============================================
export const reopenRefundRequest = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { remarks } = req.body || {};

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [existing] = await conn.query(
      `SELECT id, status FROM refund_requests WHERE id = ? LIMIT 1`,
      [id]
    );

    if (!existing.length) {
      await conn.rollback();
      return res.status(404).json(errorResponse('Refund request not found'));
    }

    if (existing[0].status === 'processed') {
      await conn.rollback();
      return res.status(400).json(errorResponse('Refund request already processed; cannot reopen'));
    }

    if (existing[0].status !== 'not_eligible') {
      await conn.rollback();
      return res.status(400).json(errorResponse('Only not_eligible refunds can be reopened'));
    }

    await conn.query(
      `UPDATE refund_requests
       SET status = 'in_progress',
           approved_amount = NULL,
           processed_by = NULL,
           processed_at = NULL,
           remarks = COALESCE(?, remarks),
           updated_at = NOW()
       WHERE id = ?`,
      [remarks || null, id]
    );

    await conn.commit();

    return res.json(successResponse({ id: Number(id), status: 'in_progress' }, 'Refund reopened to in progress'));
  } catch (error) {
    if (conn) await conn.rollback();
    console.error('❌ reopenRefundRequest error:', error);
    return res.status(500).json(errorResponse('Failed to reopen refund'));
  } finally {
    if (conn) conn.release();
  }
};
export default {
  listRefundRequests,
  processRefundRequest,
  markRefundNotEligible,
  reopenRefundRequest,
};