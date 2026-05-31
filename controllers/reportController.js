import db from '../config/database.js';
import {
  successResponse,
  errorResponse,
  formatCurrency,
  formatDateDisplay,
  getMonthRange
} from '../utils/helpers.js';

// ============================================
// GET MONTHLY REPORT
// ============================================
export const getMonthlyReport = async (req, res) => {
  try {
    const { year, month } = req.query;

    if (!year || !month) {
      return res.status(400).json(errorResponse('Year and month are required'));
    }

    const { startDate, endDate } = getMonthRange(parseInt(year), parseInt(month));

    // Monthly Assignments
    const [assignments] = await db.query(
      `SELECT 
        ha.id,
        ha.assignment_date,
        ha.is_verified,
        h.headset_number,
        h.headset_type,
        u.name as agent_name,
        COALESCE(u.employee_id, u.temp_employee_id) as emp_id,
        p.name as process_name,
        d.deposit_amount,
        d.receipt_number
       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       JOIN processes p ON ha.process_id = p.id
       LEFT JOIN deposits d ON ha.id = d.assignment_id
       WHERE DATE(ha.assignment_date) BETWEEN ? AND ?
       ORDER BY ha.assignment_date`,
      [startDate, endDate]
    );

    // Monthly Returns
    const [returns] = await db.query(
      `SELECT 
        ha.id,
        ha.return_date,
        ha.return_condition,
        h.headset_number,
        u.name as agent_name,
        d.refund_amount,
        d.refund_status
       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       LEFT JOIN deposits d ON ha.id = d.assignment_id
       WHERE ha.return_date IS NOT NULL 
         AND DATE(ha.return_date) BETWEEN ? AND ?
       ORDER BY ha.return_date`,
      [startDate, endDate]
    );

    // Monthly Repairs
    const [repairs] = await db.query(
      `SELECT 
        r.id,
        r.sent_for_repair_date,
        r.actual_return_date,
        r.repair_status,
        r.repair_cost,
        r.issue_type,
        h.headset_number
       FROM repairs r
       JOIN headsets h ON r.headset_id = h.id
       WHERE DATE(r.sent_for_repair_date) BETWEEN ? AND ?
       ORDER BY r.sent_for_repair_date`,
      [startDate, endDate]
    );

    // Monthly Transfers
    const [transfers] = await db.query(
      `SELECT 
        t.id,
        t.transfer_type,
        t.transfer_date,
        t.additional_deposit,
        h.headset_number,
        from_u.name as from_agent,
        to_u.name as to_agent,
        agent_u.name as agent_name,
        from_p.name as from_process,
        to_p.name as to_process
       FROM transfers t
       LEFT JOIN headsets h ON t.headset_id = h.id
       LEFT JOIN agents from_a ON t.from_agent_id = from_a.id
       LEFT JOIN users from_u ON from_a.user_id = from_u.id
       LEFT JOIN agents to_a ON t.to_agent_id = to_a.id
       LEFT JOIN users to_u ON to_a.user_id = to_u.id
       LEFT JOIN agents agent_a ON t.agent_id = agent_a.id
       LEFT JOIN users agent_u ON agent_a.user_id = agent_u.id
       LEFT JOIN processes from_p ON t.from_process_id = from_p.id
       LEFT JOIN processes to_p ON t.to_process_id = to_p.id
       WHERE DATE(t.transfer_date) BETWEEN ? AND ?
       ORDER BY t.transfer_date`,
      [startDate, endDate]
    );

    // Summary
    const [summary] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM headset_assignments WHERE DATE(assignment_date) BETWEEN ? AND ?) as new_assignments,
        (SELECT COUNT(*) FROM headset_assignments WHERE return_date IS NOT NULL AND DATE(return_date) BETWEEN ? AND ?) as returns,
        (SELECT COALESCE(SUM(deposit_amount), 0) FROM deposits WHERE DATE(deposit_date) BETWEEN ? AND ?) as deposits_collected,
        (SELECT COALESCE(SUM(refund_amount), 0) FROM deposits WHERE DATE(refund_date) BETWEEN ? AND ?) as refunds_processed,
        (SELECT COUNT(*) FROM repairs WHERE DATE(sent_for_repair_date) BETWEEN ? AND ?) as repairs_initiated,
        (SELECT COALESCE(SUM(repair_cost), 0) FROM repairs WHERE DATE(actual_return_date) BETWEEN ? AND ?) as repair_costs,
        (SELECT COUNT(*) FROM transfers WHERE DATE(transfer_date) BETWEEN ? AND ?) as transfers
    `, [
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate
    ]);

    res.json(successResponse({
      period: {
        year: parseInt(year),
        month: parseInt(month),
        startDate,
        endDate
      },
      summary: {
        newAssignments: summary[0].new_assignments || 0,
        returns: summary[0].returns || 0,
        depositsCollected: parseFloat(summary[0].deposits_collected) || 0,
        depositsCollectedFormatted: formatCurrency(summary[0].deposits_collected || 0),
        refundsProcessed: parseFloat(summary[0].refunds_processed) || 0,
        refundsProcessedFormatted: formatCurrency(summary[0].refunds_processed || 0),
        netDeposits: parseFloat(summary[0].deposits_collected) - parseFloat(summary[0].refunds_processed),
        netDepositsFormatted: formatCurrency((parseFloat(summary[0].deposits_collected) || 0) - (parseFloat(summary[0].refunds_processed) || 0)),
        repairsInitiated: summary[0].repairs_initiated || 0,
        repairCosts: parseFloat(summary[0].repair_costs) || 0,
        repairCostsFormatted: formatCurrency(summary[0].repair_costs || 0),
        transfers: summary[0].transfers || 0
      },
      assignments: assignments.map(a => ({
        id: a.id,
        date: a.assignment_date,
        headsetNumber: a.headset_number,
        headsetType: a.headset_type,
        agentName: a.agent_name,
        employeeId: a.emp_id,
        process: a.process_name,
        depositAmount: a.deposit_amount,
        receiptNumber: a.receipt_number,
        isVerified: a.is_verified === 1
      })),
      returns: returns.map(r => ({
        id: r.id,
        date: r.return_date,
        headsetNumber: r.headset_number,
        agentName: r.agent_name,
        condition: r.return_condition,
        refundAmount: r.refund_amount,
        refundStatus: r.refund_status
      })),
      repairs: repairs.map(r => ({
        id: r.id,
        sentDate: r.sent_for_repair_date,
        returnDate: r.actual_return_date,
        headsetNumber: r.headset_number,
        issueType: r.issue_type,
        status: r.repair_status,
        cost: r.repair_cost
      })),
      transfers: transfers.map(t => ({
        id: t.id,
        date: t.transfer_date,
        type: t.transfer_type,
        headsetNumber: t.headset_number,
        fromAgent: t.from_agent,
        toAgent: t.to_agent,
        agent: t.agent_name,
        fromProcess: t.from_process,
        toProcess: t.to_process,
        additionalDeposit: t.additional_deposit
      }))
    }));

  } catch (error) {
    console.error('❌ Get monthly report error:', error);
    res.status(500).json(errorResponse('Failed to generate monthly report'));
  }
};

// ============================================
// GET INVENTORY REPORT
// ============================================
export const getInventoryReport = async (req, res) => {
  try {
    // Overall inventory
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
        SUM(status = 'repair') as in_repair,
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
    `);

    // By condition
    const [byCondition] = await db.query(`
      SELECT 
        condition_status,
        COUNT(*) as count
      FROM headsets
      GROUP BY condition_status
    `);

    // Recently added (last 30 days)
    const [recentlyAdded] = await db.query(`
      SELECT id, headset_number, headset_type, status, created_at
      FROM headsets
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      ORDER BY created_at DESC
      LIMIT 10
    `);

    // Long-term assigned (> 1 year)
    const [longTermAssigned] = await db.query(`
      SELECT 
        h.headset_number,
        h.headset_type,
        ha.assignment_date,
        DATEDIFF(NOW(), ha.assignment_date) as days_assigned,
        u.name as agent_name,
        p.name as process_name
      FROM headset_assignments ha
      JOIN headsets h ON ha.headset_id = h.id
      JOIN agents a ON ha.agent_id = a.id
      JOIN users u ON a.user_id = u.id
      JOIN processes p ON ha.process_id = p.id
      WHERE ha.is_active = 1 
        AND ha.assignment_date < DATE_SUB(NOW(), INTERVAL 365 DAY)
      ORDER BY ha.assignment_date ASC
      LIMIT 20
    `);

    res.json(successResponse({
      generatedAt: new Date().toISOString(),
      overall: overall[0],
      byType: byType.map(t => ({
        type: t.headset_type,
        total: t.total,
        available: t.available,
        assigned: t.assigned,
        inRepair: t.in_repair,
        brandNew: t.brand_new
      })),
      byBrand: byBrand.map(b => ({
        brand: b.brand_name,
        total: b.total,
        available: b.available,
        assigned: b.assigned
      })),
      byCondition: byCondition.map(c => ({
        condition: c.condition_status,
        count: c.count
      })),
      recentlyAdded: recentlyAdded.map(h => ({
        id: h.id,
        headsetNumber: h.headset_number,
        type: h.headset_type,
        status: h.status,
        addedOn: h.created_at
      })),
      longTermAssigned: longTermAssigned.map(a => ({
        headsetNumber: a.headset_number,
        type: a.headset_type,
        agentName: a.agent_name,
        process: a.process_name,
        assignedDate: a.assignment_date,
        daysAssigned: a.days_assigned
      }))
    }));

  } catch (error) {
    console.error('❌ Get inventory report error:', error);
    res.status(500).json(errorResponse('Failed to generate inventory report'));
  }
};

// ============================================
// GET DEPOSIT REPORT
// ============================================
export const getDepositReport = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let dateFilter = '';
    const params = [];

    if (start_date) {
      dateFilter += ' AND DATE(d.deposit_date) >= ?';
      params.push(start_date);
    }
    if (end_date) {
      dateFilter += ' AND DATE(d.deposit_date) <= ?';
      params.push(end_date);
    }

    // Summary
    const [summary] = await db.query(`
      SELECT 
        COUNT(*) as total_deposits,
        COALESCE(SUM(deposit_amount), 0) as total_collected,
        COALESCE(SUM(refund_amount), 0) as total_refunded,
        COALESCE(SUM(CASE WHEN refund_status = 'pending' THEN deposit_amount ELSE 0 END), 0) as pending,
        SUM(deposit_type = 'voix') as voix_count,
        COALESCE(SUM(CASE WHEN deposit_type = 'voix' THEN deposit_amount ELSE 0 END), 0) as voix_amount,
        SUM(deposit_type = 'tech') as tech_count,
        COALESCE(SUM(CASE WHEN deposit_type = 'tech' THEN deposit_amount ELSE 0 END), 0) as tech_amount,
        SUM(deposit_type = 'process_change') as pc_count,
        COALESCE(SUM(CASE WHEN deposit_type = 'process_change' THEN deposit_amount ELSE 0 END), 0) as pc_amount,
        SUM(refund_status = 'full_refund') as full_refunds,
        SUM(refund_status = 'partial_refund') as partial_refunds,
        SUM(refund_status = 'forfeited') as forfeited
      FROM deposits d
      WHERE 1=1 ${dateFilter}
    `, params);

    // By month (last 12 months)
    const [byMonth] = await db.query(`
      SELECT 
        DATE_FORMAT(deposit_date, '%Y-%m') as month,
        COUNT(*) as deposits,
        COALESCE(SUM(deposit_amount), 0) as collected,
        COALESCE(SUM(refund_amount), 0) as refunded
      FROM deposits
      WHERE deposit_date >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(deposit_date, '%Y-%m')
      ORDER BY month DESC
    `);

    // By payment mode
    const [byPaymentMode] = await db.query(`
      SELECT 
        payment_mode,
        COUNT(*) as count,
        COALESCE(SUM(deposit_amount), 0) as amount
      FROM deposits d
      WHERE 1=1 ${dateFilter}
      GROUP BY payment_mode
    `, params);

    // Detailed list
    const [details] = await db.query(`
      SELECT 
        d.id,
        d.headset_number,
        d.deposit_type,
        d.deposit_amount,
        d.refund_amount,
        d.refund_status,
        d.deposit_date,
        d.refund_date,
        d.receipt_number,
        d.payment_mode,
        u.name as agent_name,
        COALESCE(u.employee_id, u.temp_employee_id) as emp_id
      FROM deposits d
      JOIN agents a ON d.agent_id = a.id
      JOIN users u ON a.user_id = u.id
      WHERE 1=1 ${dateFilter}
      ORDER BY d.deposit_date DESC
      LIMIT 100
    `, params);

    const s = summary[0];

    res.json(successResponse({
      period: {
        startDate: start_date || 'All time',
        endDate: end_date || 'All time'
      },
      summary: {
        totalDeposits: s.total_deposits,
        totalCollected: parseFloat(s.total_collected),
        totalCollectedFormatted: formatCurrency(s.total_collected),
        totalRefunded: parseFloat(s.total_refunded),
        totalRefundedFormatted: formatCurrency(s.total_refunded),
        pendingAmount: parseFloat(s.pending),
        pendingAmountFormatted: formatCurrency(s.pending),
        netHolding: parseFloat(s.total_collected) - parseFloat(s.total_refunded),
        netHoldingFormatted: formatCurrency(parseFloat(s.total_collected) - parseFloat(s.total_refunded))
      },
      byType: {
        voix: { count: s.voix_count, amount: parseFloat(s.voix_amount), amountFormatted: formatCurrency(s.voix_amount) },
        tech: { count: s.tech_count, amount: parseFloat(s.tech_amount), amountFormatted: formatCurrency(s.tech_amount) },
        processChange: { count: s.pc_count, amount: parseFloat(s.pc_amount), amountFormatted: formatCurrency(s.pc_amount) }
      },
      refundStats: {
        fullRefunds: s.full_refunds,
        partialRefunds: s.partial_refunds,
        forfeited: s.forfeited
      },
      byMonth: byMonth.map(m => ({
        month: m.month,
        deposits: m.deposits,
        collected: parseFloat(m.collected),
        collectedFormatted: formatCurrency(m.collected),
        refunded: parseFloat(m.refunded),
        refundedFormatted: formatCurrency(m.refunded)
      })),
      byPaymentMode: byPaymentMode.map(p => ({
        mode: p.payment_mode,
        count: p.count,
        amount: parseFloat(p.amount),
        amountFormatted: formatCurrency(p.amount)
      })),
      details: details.map(d => ({
        id: d.id,
        headsetNumber: d.headset_number,
        depositType: d.deposit_type,
        depositAmount: d.deposit_amount,
        refundAmount: d.refund_amount,
        refundStatus: d.refund_status,
        depositDate: d.deposit_date,
        refundDate: d.refund_date,
        receiptNumber: d.receipt_number,
        paymentMode: d.payment_mode,
        agentName: d.agent_name,
        employeeId: d.emp_id
      }))
    }));

  } catch (error) {
    console.error('❌ Get deposit report error:', error);
    res.status(500).json(errorResponse('Failed to generate deposit report'));
  }
};

// ============================================
// GET AGENT REPORT
// ============================================
export const getAgentReport = async (req, res) => {
  try {
    // Agents by status
    const [byStatus] = await db.query(`
      SELECT 
        a.status,
        COUNT(*) as count
      FROM agents a
      JOIN users u ON a.user_id = u.id
      WHERE u.is_active = 1
      GROUP BY a.status
    `);

    // Agents by process
    const [byProcess] = await db.query(`
      SELECT 
        p.name as process_name,
        p.category,
        COUNT(*) as agent_count,
        SUM(ha.id IS NOT NULL) as with_headset
      FROM agents a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN processes p ON a.process_id = p.id
      LEFT JOIN headset_assignments ha ON a.id = ha.agent_id AND ha.is_active = 1
      WHERE u.is_active = 1
      GROUP BY p.id, p.name, p.category
      ORDER BY agent_count DESC
    `);

    // Agents without headset
    const [withoutHeadset] = await db.query(`
      SELECT 
        a.id,
        u.name,
        COALESCE(u.employee_id, u.temp_employee_id) as emp_id,
        a.status,
        p.name as process_name
      FROM agents a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN processes p ON a.process_id = p.id
      LEFT JOIN headset_assignments ha ON a.id = ha.agent_id AND ha.is_active = 1
      WHERE u.is_active = 1 
        AND a.status = 'active'
        AND ha.id IS NULL
      ORDER BY u.name
      LIMIT 50
    `);

    // Pending employee IDs
    const [pendingIds] = await db.query(`
      SELECT 
        a.id,
        u.temp_employee_id,
        u.name,
        u.joining_date,
        a.status,
        p.name as process_name
      FROM agents a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN processes p ON a.process_id = p.id
      WHERE u.permanent_id_pending = 1 AND u.is_active = 1
      ORDER BY u.joining_date ASC
    `);

    res.json(successResponse({
      generatedAt: new Date().toISOString(),
      byStatus: byStatus.map(s => ({
        status: s.status,
        count: s.count
      })),
      byProcess: byProcess.map(p => ({
        process: p.process_name || 'Unassigned',
        category: p.category,
        agentCount: p.agent_count,
        withHeadset: p.with_headset
      })),
      withoutHeadset: {
        count: withoutHeadset.length,
        agents: withoutHeadset.map(a => ({
          id: a.id,
          name: a.name,
          employeeId: a.emp_id,
          status: a.status,
          process: a.process_name
        }))
      },
      pendingEmployeeIds: {
        count: pendingIds.length,
        agents: pendingIds.map(a => ({
          id: a.id,
          tempId: a.temp_employee_id,
          name: a.name,
          joiningDate: a.joining_date,
          status: a.status,
          process: a.process_name
        }))
      }
    }));

  } catch (error) {
    console.error('❌ Get agent report error:', error);
    res.status(500).json(errorResponse('Failed to generate agent report'));
  }
};

export default {
  getMonthlyReport,
  getInventoryReport,
  getDepositReport,
  getAgentReport
};