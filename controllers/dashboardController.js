import db from '../config/database.js';
import Assignment from '../models/Assignment.js';
import { successResponse, errorResponse, formatCurrency } from '../utils/helpers.js';

// ============================================
// HELPER: Safely parse JSON
// ============================================
const safeJsonParse = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
};

// ============================================
// GET DASHBOARD STATS (Date Filtered)
// ============================================
export const getDashboardStats = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    // Validate dates if provided
    const startDate = start_date || null;
    const endDate = end_date || null;

    // ============================================
    // 1. INVENTORY SUMMARY
    // ============================================
    const [inventorySummary] = await db.query(`
      SELECT 
        COUNT(*) as total_headsets,
        SUM(status = 'available') as available,
        SUM(status = 'assigned') as assigned,
        SUM(status = 'repair') as in_repair,
        SUM(status = 'damaged') as damaged,
        SUM(status = 'lost') as lost,
        SUM(status = 'retired') as retired,
        SUM(is_brand_new = 1) as brand_new
      FROM headsets
    `);

    // ============================================
    // 2. INVENTORY BY TYPE
    // ============================================
    const [inventoryByType] = await db.query(`
      SELECT 
        headset_type,
        COUNT(*) as total,
        SUM(status = 'available') as available,
        SUM(status = 'assigned') as assigned,
        SUM(status = 'repair') as in_repair,
        SUM(is_brand_new = 1) as brand_new
      FROM headsets
      GROUP BY headset_type
      ORDER BY headset_type
    `);

    // ============================================
    // 3. DEPOSITS SUMMARY (Date Filtered)
    // ============================================
    let depositsQuery = `
      SELECT 
        COUNT(*) as total_deposits,
        COALESCE(SUM(deposit_amount), 0) as total_collected,
        COALESCE(SUM(refund_amount), 0) as total_refunded,
        COALESCE(SUM(CASE WHEN refund_status = 'pending' THEN deposit_amount ELSE 0 END), 0) as pending_deposits,
        SUM(refund_status = 'full_refund') as full_refunds,
        SUM(refund_status = 'partial_refund') as partial_refunds,
        SUM(refund_status = 'forfeited') as forfeited,
        SUM(deposit_type = 'voix') as voix_deposits,
        SUM(deposit_type = 'tech') as tech_deposits,
        SUM(deposit_type = 'process_change') as process_change_deposits
      FROM deposits
      WHERE 1=1
    `;
    const depositsParams = [];

    if (startDate) {
      depositsQuery += ' AND DATE(deposit_date) >= ?';
      depositsParams.push(startDate);
    }
    if (endDate) {
      depositsQuery += ' AND DATE(deposit_date) <= ?';
      depositsParams.push(endDate);
    }

    const [depositsSummary] = await db.query(depositsQuery, depositsParams);

    // ============================================
    // 4. ASSIGNMENTS SUMMARY (Date Filtered)
    // ============================================
    let assignmentsQuery = `
      SELECT 
        COUNT(*) as total_assignments,
        SUM(is_verified = 1) as verified,
        SUM(is_verified = 0 AND is_active = 1) as pending_verification,
        SUM(is_active = 1) as active_assignments,
        SUM(return_date IS NOT NULL) as returned
      FROM headset_assignments
      WHERE 1=1
    `;
    const assignmentsParams = [];

    if (startDate) {
      assignmentsQuery += ' AND DATE(assignment_date) >= ?';
      assignmentsParams.push(startDate);
    }
    if (endDate) {
      assignmentsQuery += ' AND DATE(assignment_date) <= ?';
      assignmentsParams.push(endDate);
    }

    const [assignmentsSummary] = await db.query(assignmentsQuery, assignmentsParams);

    // ============================================
    // 5. REPAIRS SUMMARY (Date Filtered)
    // ============================================
    let repairsQuery = `
      SELECT 
        COUNT(*) as total_repairs,
        SUM(repair_status = 'pending') as pending,
        SUM(repair_status = 'in_repair') as in_repair,
        SUM(repair_status = 'repaired') as repaired,
        SUM(repair_status = 'unrepairable') as unrepairable,
        SUM(repair_status = 'replaced') as replaced,
        COALESCE(SUM(repair_cost), 0) as total_repair_cost
      FROM repairs
      WHERE 1=1
    `;
    const repairsParams = [];

    if (startDate) {
      repairsQuery += ' AND DATE(sent_for_repair_date) >= ?';
      repairsParams.push(startDate);
    }
    if (endDate) {
      repairsQuery += ' AND DATE(sent_for_repair_date) <= ?';
      repairsParams.push(endDate);
    }

    const [repairsSummary] = await db.query(repairsQuery, repairsParams);

	// ============================================
	// 6. PENDING EMPLOYEE IDS (only ACTIVE agents)
	// ============================================
	const [pendingIds] = await db.query(`
	  SELECT COUNT(*) AS count
	  FROM agents a
	  JOIN users u ON u.id = a.user_id
	  WHERE u.permanent_id_pending = 1
	    AND u.is_active = 1
	    AND a.status = 'active'
	`);

    // ============================================
    // 7. TRAINING/OJT HEADSETS IN USE
    // ============================================
    const [ojtInUse] = await db.query(`
      SELECT COUNT(*) as count
      FROM training_headset_logs
      WHERE status = 'issued'
    `);

    // ============================================
    // 8. Y-JACK HEADSETS IN USE
    // ============================================
    const [yjackInUse] = await db.query(`
      SELECT COUNT(*) as count
      FROM yjack_headset_logs
      WHERE status = 'issued'
    `);

    // ============================================
    // 9. RECENT ACTIVITIES (Last 10)
    // ============================================
    const [recentActivities] = await db.query(`
      SELECT 
        al.id,
        al.action_type,
        al.entity_type,
        al.entity_id,
        al.new_values,
        al.action_timestamp,
        u.name as user_name,
        u.role as user_role
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.action_timestamp DESC
      LIMIT 10
    `);

    // ============================================
    // 10. UPCOMING REPAIR RETURNS
    // ============================================
    const [upcomingRepairs] = await db.query(`
      SELECT 
        r.id,
        r.expected_return_date,
        r.repair_status,
        r.repair_vendor,
        h.headset_number,
        h.headset_type
      FROM repairs r
      JOIN headsets h ON r.headset_id = h.id
      WHERE r.repair_status IN ('pending', 'in_repair')
        AND r.expected_return_date IS NOT NULL
      ORDER BY r.expected_return_date ASC
      LIMIT 5
    `);

    // ============================================
    // 11. PENDING SIGNATURES (count only)
    // ============================================
    const pendingSignRows = await Assignment.getPendingSignatures();

    // ============================================
    // BUILD RESPONSE
    // ============================================
    return res.json(
      successResponse({
        dateRange: {
          startDate: startDate || 'All time',
          endDate: endDate || 'All time',
        },
        inventory: {
          total: inventorySummary?.[0]?.total_headsets || 0,
          available: inventorySummary?.[0]?.available || 0,
          assigned: inventorySummary?.[0]?.assigned || 0,
          inRepair: inventorySummary?.[0]?.in_repair || 0,
          damaged: inventorySummary?.[0]?.damaged || 0,
          lost: inventorySummary?.[0]?.lost || 0,
          retired: inventorySummary?.[0]?.retired || 0,
          brandNew: inventorySummary?.[0]?.brand_new || 0,
        },
        inventoryByType: inventoryByType.map((t) => ({
          type: t.headset_type,
          total: t.total || 0,
          available: t.available || 0,
          assigned: t.assigned || 0,
          inRepair: t.in_repair || 0,
          brandNew: t.brand_new || 0,
        })),
        deposits: {
          totalDeposits: depositsSummary?.[0]?.total_deposits || 0,
          totalCollected: parseFloat(depositsSummary?.[0]?.total_collected) || 0,
          totalCollectedFormatted: formatCurrency(depositsSummary?.[0]?.total_collected || 0),
          totalRefunded: parseFloat(depositsSummary?.[0]?.total_refunded) || 0,
          totalRefundedFormatted: formatCurrency(depositsSummary?.[0]?.total_refunded || 0),
          pendingDeposits: parseFloat(depositsSummary?.[0]?.pending_deposits) || 0,
          pendingDepositsFormatted: formatCurrency(depositsSummary?.[0]?.pending_deposits || 0),
          fullRefunds: depositsSummary?.[0]?.full_refunds || 0,
          partialRefunds: depositsSummary?.[0]?.partial_refunds || 0,
          forfeited: depositsSummary?.[0]?.forfeited || 0,
          byType: {
            voix: depositsSummary?.[0]?.voix_deposits || 0,
            tech: depositsSummary?.[0]?.tech_deposits || 0,
            processChange: depositsSummary?.[0]?.process_change_deposits || 0,
          },
        },
        assignments: {
          total: assignmentsSummary?.[0]?.total_assignments || 0,
          verified: assignmentsSummary?.[0]?.verified || 0,
          // Keeping this in summary for now since it's already part of your SQL,
          // but you can remove later if you want.
          pendingVerification: assignmentsSummary?.[0]?.pending_verification || 0,
          active: assignmentsSummary?.[0]?.active_assignments || 0,
          returned: assignmentsSummary?.[0]?.returned || 0,
        },
        repairs: {
          total: repairsSummary?.[0]?.total_repairs || 0,
          pending: repairsSummary?.[0]?.pending || 0,
          inRepair: repairsSummary?.[0]?.in_repair || 0,
          repaired: repairsSummary?.[0]?.repaired || 0,
          unrepairable: repairsSummary?.[0]?.unrepairable || 0,
          replaced: repairsSummary?.[0]?.replaced || 0,
          totalCost: parseFloat(repairsSummary?.[0]?.total_repair_cost) || 0,
          totalCostFormatted: formatCurrency(repairsSummary?.[0]?.total_repair_cost || 0),
        },
        alerts: {
          pendingEmployeeIds: pendingIds?.[0]?.count || 0,
          pendingSignatures: pendingSignRows.length,
          ojtHeadsetsInUse: ojtInUse?.[0]?.count || 0,
          yjackHeadsetsInUse: yjackInUse?.[0]?.count || 0,
        },
        recentActivities: recentActivities.map((a) => ({
          id: a.id,
          action: a.action_type,
          entityType: a.entity_type,
          entityId: a.entity_id,
          details: safeJsonParse(a.new_values),
          timestamp: a.action_timestamp,
          user: a.user_name,
          userRole: a.user_role,
        })),
        upcomingRepairs: upcomingRepairs.map((r) => ({
          id: r.id,
          headsetNumber: r.headset_number,
          headsetType: r.headset_type,
          expectedDate: r.expected_return_date,
          status: r.repair_status,
          vendor: r.repair_vendor,
        })),
      })
    );
  } catch (error) {
    console.error('❌ Get dashboard stats error:', error);
    return res.status(500).json(errorResponse('Failed to fetch dashboard stats'));
  }
};

// ============================================
// GET QUICK STATS (Lightweight for header)
// ============================================
export const getQuickStats = async (req, res) => {
  try {
    const [stats] = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM headsets WHERE status = 'available') as available_headsets,
        (SELECT COUNT(*) FROM headsets WHERE status = 'assigned') as assigned_headsets,
        (SELECT COUNT(*) FROM headsets WHERE status = 'repair') as in_repair,
        (SELECT COUNT(*) FROM headset_assignments WHERE is_active = 1 AND is_verified = 0) as pending_verification,
		(SELECT COUNT(*)
		 FROM agents a
		 JOIN users u ON u.id = a.user_id
		 WHERE u.permanent_id_pending = 1
		   AND u.is_active = 1
		   AND a.status = 'active'
		) as pending_employee_ids,
		        (SELECT COUNT(*) FROM notifications WHERE is_read = 0) as unread_notifications
    `);

    return res.json(successResponse(stats[0]));
  } catch (error) {
    console.error('❌ Get quick stats error:', error);
    return res.status(500).json(errorResponse('Failed to fetch quick stats'));
  }
};

// ============================================
// GET NOTIFICATIONS
// ============================================
export const getNotifications = async (req, res) => {
  try {
    const { unread_only, limit = 20 } = req.query;
    const userId = req.user.id;

    let query = `
      SELECT 
        n.*
      FROM notifications n
      WHERE n.user_id = ?
    `;
    const params = [userId];

    if (unread_only === 'true') {
      query += ' AND n.is_read = 0';
    }

    query += ' ORDER BY n.created_at DESC LIMIT ?';
    params.push(parseInt(limit, 10));

    const [notifications] = await db.query(query, params);

    const [unreadCount] = await db.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    );

    return res.json(
      successResponse({
        notifications: notifications.map((n) => ({
          id: n.id,
          type: n.notification_type,
          title: n.title,
          message: n.message,
          referenceType: n.reference_type,
          referenceId: n.reference_id,
          isRead: n.is_read === 1,
          createdAt: n.created_at,
          readAt: n.read_at,
        })),
        unreadCount: unreadCount[0].count,
      })
    );
  } catch (error) {
    console.error('❌ Get notifications error:', error);
    return res.status(500).json(errorResponse('Failed to fetch notifications'));
  }
};

// ============================================
// MARK NOTIFICATION AS READ
// ============================================
export const markNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    await db.query('UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND user_id = ?', [id, userId]);

    return res.json(successResponse({ id: parseInt(id, 10) }, 'Notification marked as read'));
  } catch (error) {
    console.error('❌ Mark notification read error:', error);
    return res.status(500).json(errorResponse('Failed to update notification'));
  }
};

// ============================================
// MARK ALL NOTIFICATIONS AS READ
// ============================================
export const markAllNotificationsRead = async (req, res) => {
  try {
    const userId = req.user.id;

    const [result] = await db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0',
      [userId]
    );

    return res.json(successResponse({ updated: result.affectedRows }, `${result.affectedRows} notifications marked as read`));
  } catch (error) {
    console.error('❌ Mark all notifications read error:', error);
    return res.status(500).json(errorResponse('Failed to update notifications'));
  }
};

export default {
  getDashboardStats,
  getQuickStats,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};