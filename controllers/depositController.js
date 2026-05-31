import db from '../config/database.js';
import {
  successResponse,
  errorResponse,
  paginatedResponse,
  formatCurrency,
  calculateRefund
} from '../utils/helpers.js';

// ============================================
// GET ALL DEPOSITS (with filters)
// ============================================
export const getAllDeposits = async (req, res) => {
  try {
    const {
      search,
      deposit_type,
      refund_status,
      payment_mode,
      start_date,
      end_date,
      page = 1,
      limit = 20,
      sort_by = 'deposit_date',
      sort_order = 'DESC'
    } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = Math.min(parseInt(limit) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    // Build WHERE clause
    let whereConditions = ['1=1'];
    let params = [];

    if (search) {
      whereConditions.push(`(
        d.headset_number LIKE ? OR 
        d.receipt_number LIKE ? OR
        u.name LIKE ? OR 
        u.employee_id LIKE ?
      )`);
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (deposit_type) {
      whereConditions.push('d.deposit_type = ?');
      params.push(deposit_type);
    }

    if (refund_status) {
      whereConditions.push('d.refund_status = ?');
      params.push(refund_status);
    }

    if (payment_mode) {
      whereConditions.push('d.payment_mode = ?');
      params.push(payment_mode);
    }

    if (start_date) {
      whereConditions.push('DATE(d.deposit_date) >= ?');
      params.push(start_date);
    }

    if (end_date) {
      whereConditions.push('DATE(d.deposit_date) <= ?');
      params.push(end_date);
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total
       FROM deposits d
       JOIN agents a ON d.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       WHERE ${whereClause}`,
      params
    );

    const total = countResult[0].total;

    // Get deposits
    const [deposits] = await db.query(
      `SELECT 
        d.*,
        u.name as agent_name,
        u.employee_id,
        u.temp_employee_id,
        h.headset_type,
        p.name as process_name,
        processed_by.name as processed_by_name
       FROM deposits d
       JOIN agents a ON d.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       JOIN headsets h ON d.headset_id = h.id
       LEFT JOIN headset_assignments ha ON d.assignment_id = ha.id
       LEFT JOIN processes p ON ha.process_id = p.id
       LEFT JOIN users processed_by ON d.processed_by = processed_by.id
       WHERE ${whereClause}
       ORDER BY d.${sort_by === 'deposit_date' ? 'deposit_date' : 'deposit_date'} ${sort_order === 'ASC' ? 'ASC' : 'DESC'}
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    // Format response
    const formattedDeposits = deposits.map(d => ({
      id: d.id,
      headsetNumber: d.headset_number,
      headsetType: d.headset_type,
      depositType: d.deposit_type,
      depositAmount: d.deposit_amount,
      depositAmountFormatted: formatCurrency(d.deposit_amount),
      refundEligible: d.refund_eligible_amount,
      refundEligibleFormatted: formatCurrency(d.refund_eligible_amount),
      refundAmount: d.refund_amount,
      refundAmountFormatted: formatCurrency(d.refund_amount),
      refundStatus: d.refund_status,
      damageDeduction: d.damage_deduction,
      depositDate: d.deposit_date,
      refundDate: d.refund_date,
      receiptNumber: d.receipt_number,
      paymentMode: d.payment_mode,
      agent: {
        id: d.agent_id,
        name: d.agent_name,
        employeeId: d.employee_id || d.temp_employee_id
      },
      process: d.process_name,
      processedBy: d.processed_by_name,
      oldHeadset: d.old_headset_number ? {
        id: d.old_headset_id,
        number: d.old_headset_number
      } : null
    }));

    res.json(paginatedResponse(formattedDeposits, total, pageNum, limitNum));

  } catch (error) {
    console.error('❌ Get deposits error:', error);
    res.status(500).json(errorResponse('Failed to fetch deposits'));
  }
};

// ============================================
// GET DEPOSIT BY ID
// ============================================
export const getDepositById = async (req, res) => {
  try {
    const { id } = req.params;

    const [deposits] = await db.query(
      `SELECT 
        d.*,
        u.name as agent_name,
        u.employee_id,
        u.temp_employee_id,
        u.email as agent_email,
        u.phone as agent_phone,
        h.headset_type,
        h.condition_status as headset_condition,
        p.name as process_name,
        p.category as process_category,
        processed_by.name as processed_by_name,
        pt.template_name,
        pt.template_type
       FROM deposits d
       JOIN agents a ON d.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       JOIN headsets h ON d.headset_id = h.id
       LEFT JOIN headset_assignments ha ON d.assignment_id = ha.id
       LEFT JOIN processes p ON ha.process_id = p.id
       LEFT JOIN users processed_by ON d.processed_by = processed_by.id
       LEFT JOIN pdf_templates pt ON d.pdf_template_id = pt.id
       WHERE d.id = ?`,
      [id]
    );

    if (deposits.length === 0) {
      return res.status(404).json(errorResponse('Deposit not found'));
    }

    const d = deposits[0];

    res.json(successResponse({
      id: d.id,
      assignmentId: d.assignment_id,
      headset: {
        id: d.headset_id,
        number: d.headset_number,
        type: d.headset_type,
        condition: d.headset_condition
      },
      agent: {
        id: d.agent_id,
        name: d.agent_name,
        employeeId: d.employee_id || d.temp_employee_id,
        email: d.agent_email,
        phone: d.agent_phone
      },
      depositType: d.deposit_type,
      depositAmount: d.deposit_amount,
      depositAmountFormatted: formatCurrency(d.deposit_amount),
      refundEligible: d.refund_eligible_amount,
      refundEligibleFormatted: formatCurrency(d.refund_eligible_amount),
      refundAmount: d.refund_amount,
      refundAmountFormatted: formatCurrency(d.refund_amount),
      refundStatus: d.refund_status,
      damageDeduction: d.damage_deduction,
      processChangeFee: d.process_change_fee,
      depositDate: d.deposit_date,
      refundDate: d.refund_date,
      receiptNumber: d.receipt_number,
      paymentMode: d.payment_mode,
      process: d.process_name,
      processCategory: d.process_category,
      processedBy: d.processed_by_name,
      template: d.template_name,
      oldHeadset: d.old_headset_number ? {
        id: d.old_headset_id,
        number: d.old_headset_number
      } : null,
      notes: d.notes,
      createdAt: d.created_at,
      updatedAt: d.updated_at
    }));

  } catch (error) {
    console.error('❌ Get deposit by ID error:', error);
    res.status(500).json(errorResponse('Failed to fetch deposit details'));
  }
};

// ============================================
// PROCESS REFUND
// ============================================
export const processRefund = async (req, res) => {
  try {
    const { id } = req.params;
    const { return_condition, damage_deduction = 0, notes } = req.body;

    if (!return_condition) {
      return res.status(400).json(errorResponse('Return condition is required'));
    }

    const validConditions = ['good', 'fair', 'damaged', 'lost'];
    if (!validConditions.includes(return_condition)) {
      return res.status(400).json(errorResponse(`Invalid return condition. Must be one of: ${validConditions.join(', ')}`));
    }

    // Get deposit
    const [deposits] = await db.query(
      `SELECT d.*, u.name as agent_name, h.headset_number
       FROM deposits d
       JOIN agents a ON d.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       JOIN headsets h ON d.headset_id = h.id
       WHERE d.id = ?`,
      [id]
    );

    if (deposits.length === 0) {
      return res.status(404).json(errorResponse('Deposit not found'));
    }

    const deposit = deposits[0];

    if (deposit.refund_status !== 'pending') {
      return res.status(400).json(errorResponse(`Refund already processed (status: ${deposit.refund_status})`));
    }

    // Calculate refund
    const refundAmount = calculateRefund(
      deposit.deposit_amount,
      deposit.refund_eligible_amount,
      return_condition,
      parseFloat(damage_deduction) || 0
    );

    // Determine refund status
    let refundStatus = 'full_refund';
    if (return_condition === 'lost') {
      refundStatus = 'forfeited';
    } else if (refundAmount === 0) {
      refundStatus = 'no_refund';
    } else if (refundAmount < deposit.refund_eligible_amount) {
      refundStatus = 'partial_refund';
    }

    // Update deposit
    await db.query(
      `UPDATE deposits 
       SET refund_amount = ?, refund_date = NOW(), refund_status = ?,
           damage_deduction = ?, processed_by = ?,
           notes = CONCAT(IFNULL(notes, ''), ?), updated_at = NOW()
       WHERE id = ?`,
      [
        refundAmount,
        refundStatus,
        damage_deduction,
        req.user.id,
        notes ? ` | Refund: ${notes}` : '',
        id
      ]
    );

    // Audit log
    await db.query(
      `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, action_timestamp)
       VALUES (?, 'deposit_refunded', 'deposits', ?, ?, NOW())`,
      [
        req.user.id,
        id,
        JSON.stringify({
          agent_name: deposit.agent_name,
          headset_number: deposit.headset_number,
          refund_amount: refundAmount,
          refund_status: refundStatus
        })
      ]
    );

    console.log(`✅ Refund processed: ${formatCurrency(refundAmount)} for ${deposit.agent_name} (${refundStatus}) by ${req.user.name}`);

    res.json(successResponse({
      id: parseInt(id),
      agentName: deposit.agent_name,
      headsetNumber: deposit.headset_number,
      depositAmount: deposit.deposit_amount,
      refundAmount: refundAmount,
      refundAmountFormatted: formatCurrency(refundAmount),
      damageDeduction: damage_deduction,
      refundStatus: refundStatus,
      returnCondition: return_condition
    }, `Refund of ${formatCurrency(refundAmount)} processed for ${deposit.agent_name}`));

  } catch (error) {
    console.error('❌ Process refund error:', error);
    res.status(500).json(errorResponse('Failed to process refund'));
  }
};

// ============================================
// GET PENDING REFUNDS
// ============================================
export const getPendingRefunds = async (req, res) => {
  try {
    const [deposits] = await db.query(`
      SELECT 
        d.id,
        d.headset_number,
        d.deposit_type,
        d.deposit_amount,
        d.refund_eligible_amount,
        d.deposit_date,
        d.receipt_number,
        u.name as agent_name,
        COALESCE(u.employee_id, u.temp_employee_id) as emp_id,
        h.headset_type,
        p.name as process_name,
        ha.return_date,
        ha.return_condition
      FROM deposits d
      JOIN agents a ON d.agent_id = a.id
      JOIN users u ON a.user_id = u.id
      JOIN headsets h ON d.headset_id = h.id
      JOIN headset_assignments ha ON d.assignment_id = ha.id
      LEFT JOIN processes p ON ha.process_id = p.id
      WHERE d.refund_status = 'pending' AND ha.is_active = 0
      ORDER BY ha.return_date ASC
    `);

    res.json(successResponse({
      count: deposits.length,
      totalPending: deposits.reduce((sum, d) => sum + parseFloat(d.refund_eligible_amount), 0),
      totalPendingFormatted: formatCurrency(deposits.reduce((sum, d) => sum + parseFloat(d.refund_eligible_amount), 0)),
      deposits: deposits.map(d => ({
        id: d.id,
        headsetNumber: d.headset_number,
        headsetType: d.headset_type,
        depositType: d.deposit_type,
        depositAmount: d.deposit_amount,
        depositAmountFormatted: formatCurrency(d.deposit_amount),
        refundEligible: d.refund_eligible_amount,
        refundEligibleFormatted: formatCurrency(d.refund_eligible_amount),
        depositDate: d.deposit_date,
        receiptNumber: d.receipt_number,
        returnDate: d.return_date,
        returnCondition: d.return_condition,
        agentName: d.agent_name,
        employeeId: d.emp_id,
        process: d.process_name
      }))
    }));

  } catch (error) {
    console.error('❌ Get pending refunds error:', error);
    res.status(500).json(errorResponse('Failed to fetch pending refunds'));
  }
};

// ============================================
// GET DEPOSIT SUMMARY
// ============================================
export const getDepositSummary = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let dateFilter = '';
    const params = [];

    if (start_date) {
      dateFilter += ' AND DATE(deposit_date) >= ?';
      params.push(start_date);
    }
    if (end_date) {
      dateFilter += ' AND DATE(deposit_date) <= ?';
      params.push(end_date);
    }

    const [summary] = await db.query(`
      SELECT 
        COUNT(*) as total_deposits,
        COALESCE(SUM(deposit_amount), 0) as total_collected,
        COALESCE(SUM(refund_amount), 0) as total_refunded,
        COALESCE(SUM(CASE WHEN refund_status = 'pending' THEN deposit_amount ELSE 0 END), 0) as pending_amount,
        SUM(deposit_type = 'voix') as voix_count,
        COALESCE(SUM(CASE WHEN deposit_type = 'voix' THEN deposit_amount ELSE 0 END), 0) as voix_amount,
        SUM(deposit_type = 'tech') as tech_count,
        COALESCE(SUM(CASE WHEN deposit_type = 'tech' THEN deposit_amount ELSE 0 END), 0) as tech_amount,
        SUM(deposit_type = 'process_change') as process_change_count,
        COALESCE(SUM(CASE WHEN deposit_type = 'process_change' THEN deposit_amount ELSE 0 END), 0) as process_change_amount,
        SUM(refund_status = 'full_refund') as full_refund_count,
        SUM(refund_status = 'partial_refund') as partial_refund_count,
        SUM(refund_status = 'forfeited') as forfeited_count
      FROM deposits
      WHERE 1=1 ${dateFilter}
    `, params);

    const s = summary[0];

    res.json(successResponse({
      totalDeposits: s.total_deposits || 0,
      totalCollected: parseFloat(s.total_collected) || 0,
      totalCollectedFormatted: formatCurrency(s.total_collected || 0),
      totalRefunded: parseFloat(s.total_refunded) || 0,
      totalRefundedFormatted: formatCurrency(s.total_refunded || 0),
      pendingAmount: parseFloat(s.pending_amount) || 0,
      pendingAmountFormatted: formatCurrency(s.pending_amount || 0),
      netHolding: parseFloat(s.total_collected) - parseFloat(s.total_refunded),
      netHoldingFormatted: formatCurrency((parseFloat(s.total_collected) || 0) - (parseFloat(s.total_refunded) || 0)),
      byType: {
        voix: {
          count: s.voix_count || 0,
          amount: parseFloat(s.voix_amount) || 0,
          amountFormatted: formatCurrency(s.voix_amount || 0)
        },
        tech: {
          count: s.tech_count || 0,
          amount: parseFloat(s.tech_amount) || 0,
          amountFormatted: formatCurrency(s.tech_amount || 0)
        },
        processChange: {
          count: s.process_change_count || 0,
          amount: parseFloat(s.process_change_amount) || 0,
          amountFormatted: formatCurrency(s.process_change_amount || 0)
        }
      },
      refundStats: {
        fullRefunds: s.full_refund_count || 0,
        partialRefunds: s.partial_refund_count || 0,
        forfeited: s.forfeited_count || 0
      }
    }));

  } catch (error) {
    console.error('❌ Get deposit summary error:', error);
    res.status(500).json(errorResponse('Failed to fetch deposit summary'));
  }
};

export default {
  getAllDeposits,
  getDepositById,
  processRefund,
  getPendingRefunds,
  getDepositSummary
};