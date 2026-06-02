import db from '../config/database.js';

class Assignment {
  static async list({
    search,
    is_verified,
    is_active,
    process_id,
    headset_type,
    start_date,
    end_date,
    page = 1,
    limit = 20,
    sort_by = 'assignment_date',
    sort_order = 'DESC',
  } = {}) {
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    const allowedSortColumns = ['assignment_date', 'return_date', 'headset_number', 'agent_name'];
    const sortColumn = allowedSortColumns.includes(sort_by) ? sort_by : 'assignment_date';
    const sortDir = String(sort_order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let whereConditions = ['1=1'];
    let params = [];

    if (search) {
      whereConditions.push(`(
        h.headset_number LIKE ? OR 
        u.name LIKE ? OR 
        u.employee_id LIKE ? OR 
        u.temp_employee_id LIKE ?
      )`);
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (is_verified !== undefined && is_verified !== '') {
      whereConditions.push('ha.is_verified = ?');
      params.push(is_verified === 'true' || is_verified === '1' ? 1 : 0);
    }

    if (is_active !== undefined && is_active !== '') {
      whereConditions.push('ha.is_active = ?');
      params.push(is_active === 'true' || is_active === '1' ? 1 : 0);
    }

    if (process_id) {
      whereConditions.push('ha.process_id = ?');
      params.push(process_id);
    }

    if (headset_type) {
      whereConditions.push('h.headset_type = ?');
      params.push(headset_type);
    }

    if (start_date) {
      whereConditions.push('DATE(ha.assignment_date) >= ?');
      params.push(start_date);
    }

    if (end_date) {
      whereConditions.push('DATE(ha.assignment_date) <= ?');
      params.push(end_date);
    }

    const whereClause = whereConditions.join(' AND ');

    const [countResult] = await db.query(
      `SELECT COUNT(*) as total
       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       WHERE ${whereClause}`,
      params
    );

    const total = countResult?.[0]?.total ?? 0;

    let orderByField = 'ha.assignment_date';
    if (sortColumn === 'headset_number') orderByField = 'h.headset_number';
    if (sortColumn === 'agent_name') orderByField = 'u.name';
    if (sortColumn === 'return_date') orderByField = 'ha.return_date';

    const [rows] = await db.query(
      `SELECT 
        ha.id,
        ha.assignment_date,
        ha.verification_date,
        ha.return_date,
        ha.return_condition,
        ha.is_verified,
        ha.is_active,
        ha.notes,

        -- ✅ HOLD / KIND
        ha.hold_status,
        ha.hold_reason,
        ha.hold_started_at,
        ha.hold_ended_at,
        ha.assignment_kind,
        ha.parent_assignment_id,

        h.id as headset_id,
        h.headset_number,
        h.headset_type,
        h.condition_status as headset_condition,

        hb.brand_name,

        -- ✅ Tier amounts (source of truth)
        ht.deposit_amount AS tier_deposit_amount,
        ht.refund_amount  AS tier_refund_amount,

        a.id as agent_id,
        u.name as agent_name,
        u.employee_id,
        u.temp_employee_id,
        u.email as agent_email,
        u.phone as agent_phone,

        p.id as process_id,
        p.name as process_name,
        p.category as process_category,

        assigned_by.name as assigned_by_name,
        verified_by.name as verified_by_name,

        d.id as deposit_id,
        d.deposit_amount as paid_deposit,
        d.refund_status,
        d.receipt_number,

        ss.has_agent,
        ss.has_admin_exec,
        ss.has_it_staff,
        ss.has_manager,
        ss.has_tl,

        pd.file_path     AS pdf_file_path,
        pd.file_name     AS pdf_file_name,
        pd.generated_at  AS pdf_generated_at,
        pd.document_type AS pdf_document_type,

        -- ✅ parent/original headset (for temp_replacement rows)
        pha.id AS parent_assignment_id2,
        ph.id AS parent_headset_id,
        ph.headset_number AS parent_headset_number,
        ph.headset_type AS parent_headset_type,
        ph.condition_status AS parent_headset_condition,
        ph.status AS parent_headset_status

       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN headset_brands hb ON h.brand_id = hb.id

       -- ✅ Tier amounts (source of truth)
       LEFT JOIN headset_type_tiers ht
         ON ht.headset_type = h.headset_type AND ht.is_active = 1

       -- ✅ parent/original headset joins (for temp_replacement rows)
       LEFT JOIN headset_assignments pha ON pha.id = ha.parent_assignment_id
       LEFT JOIN headsets ph ON ph.id = pha.headset_id

       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       JOIN processes p ON ha.process_id = p.id
       LEFT JOIN users assigned_by ON ha.assigned_by = assigned_by.id
       LEFT JOIN users verified_by ON ha.verified_by = verified_by.id
       LEFT JOIN deposits d 
         ON ha.id = d.assignment_id
        AND d.deposit_type IN ('voix', 'tech')
       LEFT JOIN (
         SELECT assignment_id,
           MAX(signer_role = 'agent')      AS has_agent,
           MAX(signer_role = 'admin_exec') AS has_admin_exec,
           MAX(signer_role = 'it_staff')   AS has_it_staff,
           MAX(signer_role = 'manager')    AS has_manager,
           MAX(signer_role = 'tl')         AS has_tl
         FROM signatures
         GROUP BY assignment_id
       ) ss ON ss.assignment_id = ha.id

       LEFT JOIN (
         SELECT p1.assignment_id, p1.file_path, p1.file_name, p1.generated_at, p1.document_type
         FROM pdf_documents p1
         JOIN (
           SELECT assignment_id, MAX(generated_at) AS max_generated_at
           FROM pdf_documents
           WHERE document_type IN ('voix_deposit_form', 'tech_deposit_form')
           GROUP BY assignment_id
         ) latest
           ON latest.assignment_id = p1.assignment_id
          AND latest.max_generated_at = p1.generated_at
       ) pd ON pd.assignment_id = ha.id

       WHERE ${whereClause}
       ORDER BY ${orderByField} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    return { total, pageNum, limitNum, rows };
  }

  static async getById(id) {
    const [rows] = await db.query(
      `SELECT 
        ha.*,
        ha.manager_name AS ha_manager_name,
        ha.tl_name AS ha_tl_name,

        h.headset_number,
        h.headset_type,
        h.condition_status as headset_condition,
        h.image_url_1,
        h.image_url_2,
        hb.brand_name,

        ht.deposit_amount AS tier_deposit,
        ht.refund_amount  AS tier_refund,

        a.id as agent_id,
        u.name as agent_name,
        u.employee_id,
        u.temp_employee_id,
        u.email as agent_email,
        u.phone as agent_phone,
        p.name as process_name,
        p.category as process_category,
        assigned_by.name as assigned_by_name,
        verified_by.name as verified_by_name,
        return_by.name as return_verified_by_name,
        mgr.name as manager_name,
        tl.name as tl_name
       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN headset_brands hb ON h.brand_id = hb.id

       LEFT JOIN headset_type_tiers ht
         ON ht.headset_type = h.headset_type AND ht.is_active = 1

       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       JOIN processes p ON ha.process_id = p.id
       LEFT JOIN users assigned_by ON ha.assigned_by = assigned_by.id
       LEFT JOIN users verified_by ON ha.verified_by = verified_by.id
       LEFT JOIN users return_by ON ha.return_verified_by = return_by.id
       LEFT JOIN users mgr ON a.manager_id = mgr.id
       LEFT JOIN users tl ON a.tl_id = tl.id
       WHERE ha.id = ?
       LIMIT 1`,
      [id]
    );
    return rows?.[0] || null;
  }

  static async getDepositByAssignmentId(id) {
    const [rows] = await db.query(
      `SELECT *
       FROM deposits
       WHERE assignment_id = ?
         AND deposit_type IN ('voix','tech')
       ORDER BY id DESC
       LIMIT 1`,
      [id]
    );
    return rows?.[0] || null;
  }

  static async getSignaturesByAssignmentId(id) {
    const [rows] = await db.query(
      `SELECT s.*, u.name as signer_user_name
       FROM signatures s
       LEFT JOIN users u ON s.signer_id = u.id
       WHERE s.assignment_id = ?`,
      [id]
    );
    return rows;
  }

  static async getDocumentsByAssignmentId(id) {
    const [rows] = await db.query('SELECT * FROM pdf_documents WHERE assignment_id = ?', [id]);
    return rows;
  }

  static async getPendingVerifications() {
    const [rows] = await db.query(`
      SELECT 
        ha.id,
        ha.assignment_date,
        h.headset_number,
        h.headset_type,
        u.name as agent_name,
        COALESCE(u.employee_id, u.temp_employee_id) as emp_id,
        p.name as process_name,
        assigned_by.name as assigned_by_name
      FROM headset_assignments ha
      JOIN headsets h ON ha.headset_id = h.id
      JOIN agents a ON ha.agent_id = a.id
      JOIN users u ON a.user_id = u.id
      JOIN processes p ON ha.process_id = p.id
      LEFT JOIN users assigned_by ON ha.assigned_by = assigned_by.id
	  WHERE ha.is_active = 1
	    AND ha.is_verified = 0
	    AND (ha.assignment_kind IS NULL OR ha.assignment_kind <> 'temp_replacement')
      ORDER BY ha.assignment_date ASC
    `);
    return rows;
  }

  static async getPendingSignatures() {
    const [rows] = await db.query(
      `SELECT 
        ha.id as assignment_id,
        ha.assignment_date,
        ha.is_active,
        ha.tl_name,
        ha.manager_name,
        h.headset_number,
        u.name as agent_name,
        COALESCE(u.employee_id, u.temp_employee_id) as employee_id,
        MAX(CASE WHEN s.signer_role='agent' AND s.signature_path IS NOT NULL THEN 1 ELSE 0 END) as has_agent,
        MAX(CASE WHEN s.signer_role='admin_exec' AND s.signature_path IS NOT NULL THEN 1 ELSE 0 END) as has_admin_exec,
        MAX(CASE WHEN s.signer_role='it_staff' AND s.signature_path IS NOT NULL THEN 1 ELSE 0 END) as has_it,
        MAX(CASE WHEN s.signer_role='manager' AND s.signature_path IS NOT NULL THEN 1 ELSE 0 END) as has_manager,
        MAX(CASE WHEN s.signer_role='tl' AND s.signature_path IS NOT NULL THEN 1 ELSE 0 END) as has_tl
      FROM headset_assignments ha
      JOIN headsets h ON ha.headset_id = h.id
      JOIN agents a ON ha.agent_id = a.id
      JOIN users u ON a.user_id = u.id
      LEFT JOIN signatures s ON s.assignment_id = ha.id
	  WHERE ha.is_active = 1
	    AND (ha.assignment_kind IS NULL OR ha.assignment_kind <> 'temp_replacement')
      GROUP BY ha.id
      HAVING has_agent = 0 OR has_admin_exec = 0 OR has_it = 0 OR (has_manager = 0 AND has_tl = 0)
      ORDER BY ha.assignment_date DESC`
    );
    return rows;
  }

  static async getDetailsForSign(assignmentId) {
    const [rows] = await db.query(
      `SELECT 
        ha.id,
        ha.assignment_date,
        ha.tl_name,
        ha.manager_name,
        ha.process_id,
        h.headset_number,
        h.headset_type,
        u.name as agent_name,
        COALESCE(u.employee_id, u.temp_employee_id) as employee_id
      FROM headset_assignments ha
      JOIN headsets h ON ha.headset_id = h.id
      JOIN agents a ON ha.agent_id = a.id
      JOIN users u ON a.user_id = u.id
	  WHERE ha.id = ?
	    AND (ha.assignment_kind IS NULL OR ha.assignment_kind <> 'temp_replacement')
      LIMIT 1`,
      [assignmentId]
    );
    return rows?.[0] || null;
  }

  static async getSignaturesStatus(assignmentId) {
    const [rows] = await db.query(
      `SELECT signer_role, signer_name, signature_path, signed_at
       FROM signatures
       WHERE assignment_id = ?
         AND signature_path IS NOT NULL
         AND TRIM(signature_path) <> ''`,
      [assignmentId]
    );
    return rows;
  }

  static async getAssignmentNames(assignmentId) {
    const [rows] = await db.query(
      `SELECT id, tl_name, manager_name
       FROM headset_assignments
       WHERE id = ?
       LIMIT 1`,
      [assignmentId]
    );
    return rows?.[0] || null;
  }

  static async upsertSignature({
    assignmentId,
    signer_role,
    signer_id,
    signer_name,
    signature_path,
    ip_address = null,
    device_info = null,
  }) {
    const [existing] = await db.query(
      `SELECT id FROM signatures WHERE assignment_id = ? AND signer_role = ? LIMIT 1`,
      [assignmentId, signer_role]
    );

    if (existing.length > 0) {
      await db.query(
        `UPDATE signatures
         SET signer_id = ?, signer_name = ?, signature_path = ?, signed_at = NOW(),
             ip_address = ?, device_info = ?
         WHERE assignment_id = ? AND signer_role = ?`,
        [signer_id, signer_name, signature_path, ip_address, device_info, assignmentId, signer_role]
      );
      return { mode: 'updated' };
    }

    await db.query(
      `INSERT INTO signatures (
        assignment_id,
        signer_id,
        signer_name,
        signer_role,
        signature_path,
        signed_at,
        ip_address,
        device_info,
        created_at
      ) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, NOW())`,
      [assignmentId, signer_id, signer_name, signer_role, signature_path, ip_address, device_info]
    );
    return { mode: 'inserted' };
  }
}

export default Assignment;