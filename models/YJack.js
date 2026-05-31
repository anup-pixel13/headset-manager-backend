import db from '../config/database.js';

class YJack {
  static async list({ search = '', page = 1, limit = 20 } = {}) {
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    const where = [`h.headset_type = 'yjack'`];
    const params = [];

    if (search) {
      where.push(`(h.headset_number LIKE ? OR ya.trainer_name LIKE ?)`);
      const t = `%${search}%`;
      params.push(t, t);
    }

    const whereClause = where.join(' AND ');

    // total (based on yjack headsets)
    const [countRows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM headsets h
      LEFT JOIN (
        SELECT y1.*
        FROM yjack_assignments y1
        JOIN (
          SELECT headset_id, MAX(assigned_at) AS max_assigned_at
          FROM yjack_assignments
          GROUP BY headset_id
        ) last ON last.headset_id = y1.headset_id AND last.max_assigned_at = y1.assigned_at
      ) ya ON ya.headset_id = h.id
      WHERE ${whereClause}
      `,
      params
    );
    const total = countRows?.[0]?.total ?? 0;

    // list with latest assignment per yjack
    const [rows] = await db.query(
      `
      SELECT
        h.id AS headset_id,
        h.headset_number,
        h.status AS headset_status,
        ya.id AS yjack_assignment_id,
        ya.trainer_name,
        ya.assigned_at,
        ya.unassigned_at,
        ya.is_active
      FROM headsets h
      LEFT JOIN (
        SELECT y1.*
        FROM yjack_assignments y1
        JOIN (
          SELECT headset_id, MAX(assigned_at) AS max_assigned_at
          FROM yjack_assignments
          GROUP BY headset_id
        ) last ON last.headset_id = y1.headset_id AND last.max_assigned_at = y1.assigned_at
      ) ya ON ya.headset_id = h.id
      WHERE ${whereClause}
      ORDER BY h.headset_number ASC
      LIMIT ? OFFSET ?
      `,
      [...params, limitNum, offset]
    );

    return { total, pageNum, limitNum, rows };
  }

  static async assign({ headset_id, trainer_name, assigned_by = null, notes = null }) {
    const cleanTrainer = String(trainer_name || '').trim();
    if (!cleanTrainer) {
      const err = new Error('trainer_name is required');
      err.statusCode = 400;
      throw err;
    }

    const [hRows] = await db.query(
      `SELECT id, headset_number, headset_type, status FROM headsets WHERE id = ? LIMIT 1`,
      [headset_id]
    );
    const h = hRows?.[0];
    if (!h) {
      const err = new Error('Y-Jack not found');
      err.statusCode = 404;
      throw err;
    }
    if (h.headset_type !== 'yjack') {
      const err = new Error('Only headsets of type yjack can be assigned here');
      err.statusCode = 400;
      throw err;
    }

    const [active] = await db.query(
      `SELECT id FROM yjack_assignments WHERE headset_id = ? AND is_active = 1 LIMIT 1`,
      [headset_id]
    );
    if (active.length) {
      const err = new Error(`Y-Jack ${h.headset_number} is already assigned`);
      err.statusCode = 400;
      throw err;
    }

    const conn = await db.getConnection();
    await conn.beginTransaction();
    try {
      const [result] = await conn.query(
        `INSERT INTO yjack_assignments (
          headset_id, trainer_name, assigned_by, assigned_at, notes, is_active
        ) VALUES (?, ?, ?, NOW(), ?, 1)`,
        [headset_id, cleanTrainer, assigned_by, notes]
      );

      // Keep headsets.status consistent in inventory
      await conn.query(
        `UPDATE headsets SET status = 'assigned', updated_at = NOW() WHERE id = ?`,
        [headset_id]
      );

      await conn.commit();
      conn.release();

      return { yjackAssignmentId: result.insertId };
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  }

  static async unassign({ headset_id, unassigned_by = null, notes = null }) {
    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [active] = await conn.query(
        `SELECT id FROM yjack_assignments WHERE headset_id = ? AND is_active = 1 LIMIT 1`,
        [headset_id]
      );

      if (!active.length) {
        const err = new Error('No active Y-Jack assignment found');
        err.statusCode = 400;
        throw err;
      }

      const yjackAssignmentId = active[0].id;

      await conn.query(
        `UPDATE yjack_assignments
         SET is_active = 0,
             unassigned_at = NOW(),
             unassigned_by = ?,
             notes = CONCAT(IFNULL(notes, ''), ?),
             updated_at = NOW()
         WHERE id = ?`,
        [unassigned_by, notes ? ` | Unassign: ${notes}` : '', yjackAssignmentId]
      );

      await conn.query(
        `UPDATE headsets SET status = 'available', updated_at = NOW() WHERE id = ?`,
        [headset_id]
      );

      await conn.commit();
      conn.release();

      return { yjackAssignmentId };
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  }
}

export default YJack;