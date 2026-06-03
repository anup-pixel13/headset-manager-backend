import db from '../config/database.js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  successResponse,
  errorResponse,
  formatCurrencyPdf,
  formatDateDisplay,
  formatDateTimeDisplay,
  generateFileName
} from '../utils/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// UPLOAD_ROOT should be the folder that CONTAINS: headset-images/, signatures/, pdfs/
const UPLOAD_ROOT = process.env.UPLOAD_ROOT
  ? path.resolve(process.env.UPLOAD_ROOT)
  : path.join(__dirname, '..', 'uploads');
  
  const sanitizeFilePart = (s) =>
    String(s || '')
      .trim()
      .replace(/\s+/g, ' ')
      // Windows-illegal filename chars + control chars
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      // Windows also hates trailing dots/spaces
      .replace(/[. ]+$/g, '')
      .slice(0, 80);

// PDF storage directory
const PDF_DIR = path.join(UPLOAD_ROOT, 'pdfs');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// ============================================
// Helpers (UPDATED: system_settings + pdf_templates)
// ============================================

const getSystemSettingsMap = async () => {
  const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings');
  const map = {};
  for (const r of rows) map[r.setting_key] = r.setting_value;
  return map;
};

// DB overrides ENV overrides defaults (as you requested)
const getCompanyInfo = async () => {
  const settings = await getSystemSettingsMap();

  return {
    name:
      settings.company_name ||
      process.env.COMPANY_NAME ||
      'Amii Business Support Solution Pvt Ltd.',
    address:
      settings.company_address ||
      process.env.COMPANY_ADDRESS ||
      'Tower No 4, 6th floor, 601, Railway Station Complex, CBD Belapur, Navi Mumbai, Maharashtra 400614',
    phone: settings.company_phone || process.env.COMPANY_PHONE || '+91 63547 98551',
    email: settings.company_email || process.env.COMPANY_EMAIL || 'info@abss.co.in'
  };
};

const getPdfTemplateByType = async (templateType) => {
  const [rows] = await db.query(
    `SELECT *
     FROM pdf_templates
     WHERE template_type = ? AND is_active = TRUE
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [templateType]
  );
  return rows?.[0] || null;
};

const parseBulletJson = (value, fallbackArray = []) => {
  if (!value) return fallbackArray;
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallbackArray;
  } catch {
    return fallbackArray;
  }
};

const headsetTypeLabel = (t) => {
  const v = String(t || '').trim();
  switch (v) {
    case 'voix_enc':
      return 'VOIX (ENC)';
    case 'voix_nxx':
      return 'VOIX (N-series)';
    case 'voix_3xx':
      return 'VOIX (3xx numeric)';
    case 'tech':
      return 'TECH';
    case 'ojt':
      return 'OJT';
    case 'yjack':
      return 'Y-JACK';
    default:
      return v ? v.toUpperCase() : 'N/A';
  }
};

const isPermanentEmployeeId = (employeeId) =>
  /^AIPL\d{1,5}$/i.test(String(employeeId || '').trim());

// Strict signature completion: Agent + AdminExec + IT + (Manager or TL)
const isAssignmentCompleteForPdf = async (dbConn, assignmentId) => {
  const [rows] = await dbConn.query(
    `
    SELECT 
      MAX(s.signer_role = 'agent')      AS has_agent,
      MAX(s.signer_role = 'admin_exec') AS has_admin_exec,
      MAX(s.signer_role = 'it_staff')   AS has_it_staff,
      MAX(s.signer_role = 'manager')    AS has_manager,
      MAX(s.signer_role = 'tl')         AS has_tl
    FROM signatures s
    WHERE s.assignment_id = ?
    `,
    [assignmentId]
  );

  const r = rows?.[0] || {};
  const hasAgent = !!r.has_agent;
  const hasAdmin = !!r.has_admin_exec;
  const hasIt = !!r.has_it_staff;
  const hasApprover = !!r.has_manager || !!r.has_tl;

  return {
    ok: hasAgent && hasAdmin && hasIt && hasApprover,
    status: {
      agent: hasAgent,
      admin_exec: hasAdmin,
      it_staff: hasIt,
      manager: !!r.has_manager,
      tl: !!r.has_tl
    }
  };
};

const getLatestSignatureByRole = async (connectionOrDb, { assignmentId, depositId, role }) => {
  const where = [];
  const params = [];

  if (assignmentId) {
    where.push('s.assignment_id = ?');
    params.push(assignmentId);
  }
  if (depositId) {
    where.push('s.deposit_id = ?');
    params.push(depositId);
  }

  if (where.length === 0) return null;

  params.push(role);

  const [rows] = await connectionOrDb.query(
    `
    SELECT 
      s.id,
      s.signature_path,
      s.signed_at,
      COALESCE(s.signer_name, u.name) as signer_name
    FROM signatures s
    LEFT JOIN users u ON s.signer_id = u.id
    WHERE (${where.join(' OR ')}) AND s.signer_role = ?
    ORDER BY s.signed_at DESC
    LIMIT 1
    `,
    params
  );

  return rows.length ? rows[0] : null;
};

// Picks the latest approver signature among Manager/TL (whoever signed last)
const resolveApprover = async (dbConn, { assignmentId, depositId }) => {
  const where = [];
  const params = [];

  if (assignmentId) {
    where.push('s.assignment_id = ?');
    params.push(assignmentId);
  }
  if (depositId) {
    where.push('s.deposit_id = ?');
    params.push(depositId);
  }

  if (where.length === 0) return null;

  const [rows] = await dbConn.query(
    `
    SELECT 
      s.id,
      s.signer_role,
      s.signature_path,
      s.signed_at,
      COALESCE(s.signer_name, u.name) as signer_name
    FROM signatures s
    LEFT JOIN users u ON s.signer_id = u.id
    WHERE (${where.join(' OR ')})
      AND s.signer_role IN ('manager', 'tl')
    ORDER BY s.signed_at DESC
    LIMIT 1
    `,
    params
  );

  if (!rows.length) return null;

  const r = rows[0];
  return {
    role: r.signer_role,
    label: r.signer_role === 'tl' ? 'Team Leader (TL)' : 'Manager',
    ...r,
  };
};

// Embed from signature_path (file saved under UPLOAD_ROOT/signatures)
const tryEmbedSignatureFromPath = async (pdfDoc, signaturePath) => {
  try {
    if (!signaturePath || typeof signaturePath !== 'string') return null;

    // Expected DB/web path: "/uploads/signatures/<file>"
    const match = signaturePath.replace(/\\/g, '/').match(/^\/?uploads\/signatures\/(.+)$/);
    if (!match) return null;

    const filename = match[1];
    const abs = path.join(UPLOAD_ROOT, 'signatures', filename);

    if (!fs.existsSync(abs)) return null;

    const bytes = fs.readFileSync(abs);
    const lower = abs.toLowerCase();

    if (lower.endsWith('.png')) return await pdfDoc.embedPng(bytes);
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return await pdfDoc.embedJpg(bytes);

    return null;
  } catch (e) {
    console.error('❌ tryEmbedSignatureFromPath failed:', e);
    return null;
  }
};

const drawSignatureImageInsideBox = (page, img, x, y, boxW, boxH) => {
  if (!img) return;

  const pad = 6;
  const maxW = boxW - pad * 2;
  const maxH = boxH - pad * 2;

  const scale = Math.min(maxW / img.width, maxH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;

  page.drawImage(img, {
    x: x + pad + (maxW - w) / 2,
    y: y + pad + (maxH - h) / 2,
    width: w,
    height: h
  });
};

// safe YYYY-MM-DD
const toISODate = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return 'unknown-date';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// ============================================
// GENERATE DEPOSIT FORM PDF (STRICT)
// ============================================
export const generateDepositForm = async (req, res) => {
  try {
    const { assignment_id } = req.params;

    // ✅ If this assignment has a process-change deposit, pull old/new context for PDF.
    const [pcRows] = await db.query(
      `
      SELECT
        t.id AS transfer_id,
        t.transfer_date,
        fp.name AS from_process_name,
        tp.name AS to_process_name,

        t.old_headset_number,
        t.new_headset_number,

        dpc.id AS process_change_deposit_id,
        dpc.process_change_fee,
        dpc.deposit_amount AS process_change_amount,
        dpc.receipt_number AS process_change_receipt,

        -- old/base deposit: infer from OLD headset number saved on process_change deposit
        dold.deposit_amount AS old_base_deposit_amount,
        dold.refund_eligible_amount AS old_refund_eligible_amount,

        -- new/base deposit: base deposit for THIS assignment
        dnew.deposit_amount AS new_base_deposit_amount,
        dnew.refund_eligible_amount AS new_refund_eligible_amount
      FROM deposits dpc
      LEFT JOIN transfers t
        ON t.deposit_id = dpc.id
       AND t.transfer_type = 'agent_process_change'
      LEFT JOIN processes fp ON fp.id = t.from_process_id
      LEFT JOIN processes tp ON tp.id = t.to_process_id

      LEFT JOIN (
        SELECT d1.*
        FROM deposits d1
        JOIN (
          SELECT agent_id, headset_number, MAX(id) AS max_id
          FROM deposits
          WHERE deposit_type IN ('voix','tech')
          GROUP BY agent_id, headset_number
        ) mx ON mx.agent_id = d1.agent_id AND mx.headset_number = d1.headset_number AND mx.max_id = d1.id
      ) dold
        ON dold.agent_id = dpc.agent_id
       AND dold.headset_number = dpc.old_headset_number

      LEFT JOIN (
        SELECT d1.*
        FROM deposits d1
        JOIN (
          SELECT assignment_id, MAX(id) AS max_id
          FROM deposits
          WHERE deposit_type IN ('voix','tech')
          GROUP BY assignment_id
        ) mx ON mx.assignment_id = d1.assignment_id AND mx.max_id = d1.id
      ) dnew
        ON dnew.assignment_id = dpc.assignment_id

      WHERE dpc.assignment_id = ?
        AND dpc.deposit_type = 'process_change'
      ORDER BY dpc.id DESC
      LIMIT 1
      `,
      [assignment_id]
    );

    const processChange = pcRows?.[0] || null;
    const isProcessChange = !!processChange?.process_change_deposit_id;

    const [assignments] = await db.query(
      `SELECT 
        ha.*,
        h.id as headset_id,
        h.headset_number,
        h.headset_type,
        hb.brand_name,
        hb.deposit_amount as brand_deposit,
        hb.refund_amount as brand_refund,
        a.id as agent_id,
        u.name as agent_name,
        u.employee_id,
        u.temp_employee_id,
        u.email as agent_email,
        u.phone as agent_phone,
        p.name as process_name,
        d.id as deposit_id,
        d.deposit_amount,
        d.refund_eligible_amount,
        d.receipt_number,
        d.payment_mode,
        d.deposit_date,
        assigned_by.name as assigned_by_name
       FROM headset_assignments ha
       JOIN headsets h ON ha.headset_id = h.id
       JOIN headset_brands hb ON h.brand_id = hb.id
       JOIN agents a ON ha.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       JOIN processes p ON ha.process_id = p.id
       LEFT JOIN (
         SELECT d1.*
         FROM deposits d1
         JOIN (
           SELECT assignment_id, MAX(id) AS max_id
           FROM deposits
           WHERE deposit_type IN ('voix','tech')
           GROUP BY assignment_id
         ) mx ON mx.assignment_id = d1.assignment_id AND mx.max_id = d1.id
       ) d ON d.assignment_id = ha.id
       LEFT JOIN users assigned_by ON ha.assigned_by = assigned_by.id
       WHERE ha.id = ?`,
      [assignment_id]
    );

    if (assignments.length === 0) {
      return res.status(404).json(errorResponse('Assignment not found'));
    }

    const data = assignments[0];

    // Gate 1: permanent employee ID must exist
    const resolvedEmpId = (data.employee_id || data.temp_employee_id || '').toString().trim();
	if (!isPermanentEmployeeId(resolvedEmpId)) {
	  return res.status(400).json(
	    errorResponse('PDF not available until Permanent Employee ID is updated.', {
	      employeeId: resolvedEmpId || null,
	      requiredFormat: 'AIPL1 to AIPL99999'
	    })
	  );
	}

    // Gate 2: strict signatures
    const gate = await isAssignmentCompleteForPdf(db, assignment_id);
    if (!gate.ok) {
      return res.status(400).json(
        errorResponse(
          'PDF not available until all signatures are collected (Agent + Admin Exec + IT Staff + Manager/TL).',
          { signatureStatus: gate.status }
        )
      );
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const company = await getCompanyInfo();

    const isVoix = String(data.headset_type || '').startsWith('voix');
    const formType = isVoix ? 'VOIX HEADSET DEPOSIT FORM' : 'TECH HEADSET DEPOSIT FORM';

    const tpl = await getPdfTemplateByType(isVoix ? 'voix_deposit' : 'tech_deposit');
    const fallbackTerms = [
      '1. The headset remains the property of the company.',
      '2. Employee is responsible for the headset during assignment period.',
      '3. Any damage or loss will result in deduction from the refund amount.',
      `4. Refund of ${formatCurrencyPdf(data.refund_eligible_amount)} will be processed upon return in good condition.`,
      '5. Headset must be returned upon resignation/termination.',
      '6. Unauthorized repair or modification is not allowed.'
    ];

    const templateTerms = parseBulletJson(tpl?.policy_text, []);
    const terms = templateTerms.length ? templateTerms : fallbackTerms;

    const pdfDoc = await PDFDocument.create();

    let page = pdfDoc.addPage([595, 842]); // A4
    let { width, height } = page.getSize();

    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const PAGE_TOP = height - 50;
    const PAGE_BOTTOM = 70;
    const FOOTER_Y = 35;

    let y = PAGE_TOP;

    const drawFooter = () => {
      page.drawText(`Generated on: ${formatDateTimeDisplay(new Date())}`, {
        x: 50,
        y: FOOTER_Y,
        size: 8,
        font: fontRegular,
        color: rgb(0.5, 0.5, 0.5)
      });

      page.drawText('This is a computer-generated document.', {
        x: width - 220,
        y: FOOTER_Y,
        size: 8,
        font: fontRegular,
        color: rgb(0.5, 0.5, 0.5)
      });
    };

    const newPage = () => {
      drawFooter();
      page = pdfDoc.addPage([595, 842]);
      ({ width, height } = page.getSize());
      y = PAGE_TOP;
    };

    const ensureSpace = (needed) => {
      if (y - needed < PAGE_BOTTOM) {
        newPage();
      }
    };

    const drawField = (label, value, yPos, valueX = 180) => {
      page.drawText(label, { x: 50, y: yPos, size: 10, font: fontBold });
      page.drawText(`: ${value || 'N/A'}`, { x: valueX, y: yPos, size: 10, font: fontRegular });
    };

    const drawSectionTitle = (title, lineEndX = 200) => {
      ensureSpace(28);
      page.drawText(title, {
        x: 50,
        y,
        size: 11,
        font: fontBold,
        color: rgb(0, 0, 0.5)
      });
      y -= 5;
      page.drawLine({
        start: { x: 50, y },
        end: { x: lineEndX, y },
        thickness: 0.5,
        color: rgb(0, 0, 0.5)
      });
      y -= 20;
    };

    const drawFieldRow = (label, value, valueX = 180) => {
      ensureSpace(18);
      drawField(label, value, y, valueX);
      y -= 18;
    };

    const drawParagraph = (text, size = 9) => {
      ensureSpace(16);
      page.drawText(String(text), {
        x: 50,
        y,
        size,
        font: fontRegular,
        color: rgb(0.2, 0.2, 0.2)
      });
      y -= 14;
    };

    // Header
    page.drawText(company.name, {
      x: 50,
      y,
      size: 16,
      font: fontBold,
      color: rgb(0, 0, 0.5)
    });

    y -= 20;
    page.drawText(company.address, {
      x: 50,
      y,
      size: 8,
      font: fontRegular,
      color: rgb(0.3, 0.3, 0.3)
    });

    y -= 12;
    page.drawText(`Phone: ${company.phone} | Email: ${company.email}`, {
      x: 50,
      y,
      size: 8,
      font: fontRegular,
      color: rgb(0.3, 0.3, 0.3)
    });

    y -= 15;
    page.drawLine({
      start: { x: 50, y },
      end: { x: width - 50, y },
      thickness: 1,
      color: rgb(0, 0, 0.5)
    });

    // Title
    y -= 26;
    page.drawText(formType, {
      x: 50,
      y,
      size: 14,
      font: fontBold,
      color: rgb(0, 0, 0)
    });

    page.drawText(`Date: ${formatDateDisplay(data.deposit_date || new Date())}`, {
      x: width - 200,
      y,
      size: 10,
      font: fontRegular
    });

    y -= 15;
    page.drawText(`Receipt No: ${data.receipt_number || 'N/A'}`, {
      x: width - 200,
      y,
      size: 10,
      font: fontRegular
    });

    // Employee Details
    y -= 22;
    drawSectionTitle('EMPLOYEE DETAILS', 200);
    drawFieldRow('Employee Name', data.agent_name);
    drawFieldRow('Employee ID', resolvedEmpId);
    drawFieldRow('Phone', data.agent_phone);
    drawFieldRow('Email', data.agent_email);
    drawFieldRow('Process', data.process_name);

    // Headset Details
    y -= 14;
    drawSectionTitle('HEADSET DETAILS', 200);
    drawFieldRow('Headset Number', data.headset_number);
    drawFieldRow('Headset Type', headsetTypeLabel(data.headset_type));
    drawFieldRow('Brand', data.brand_name);
    drawFieldRow('Assignment Date', formatDateDisplay(data.assignment_date));

    // Deposit Details
    y -= 14;
    drawSectionTitle('DEPOSIT DETAILS', 200);
    drawFieldRow('Deposit Amount', formatCurrencyPdf(data.deposit_amount));
    drawFieldRow('Refund Eligible', formatCurrencyPdf(data.refund_eligible_amount));

    // ✅ Keep process change summary ONLY for process-change PDFs
    if (isProcessChange) {
      y -= 14;
      drawSectionTitle('PROCESS CHANGE SUMMARY', 260);

      drawFieldRow('Old Process', processChange.from_process_name || '—');
      drawFieldRow('New Process', processChange.to_process_name || data.process_name || '—');
      drawFieldRow('Old Headset', processChange.old_headset_number || '—');
      drawFieldRow('Current Headset', processChange.new_headset_number || data.headset_number || '—');
      drawFieldRow(
        'Original Refund Eligible',
        formatCurrencyPdf(processChange.old_refund_eligible_amount)
      );
      drawFieldRow(
        'Current Refund Eligible',
        formatCurrencyPdf(processChange.new_refund_eligible_amount ?? data.refund_eligible_amount)
      );

      const fee = Number(processChange.process_change_fee || 0);
      drawFieldRow('Process Change Adjustment', formatCurrencyPdf(fee));

      drawParagraph(
        'Note: Final exit refund is based on the ORIGINAL headset tier (Original Refund Eligible).',
        8
      );
    }

    // Terms
    y -= 14;
    drawSectionTitle('TERMS AND CONDITIONS', 250);
    for (const term of terms) {
      drawParagraph(term, 9);
    }

    // Signatures
    y -= 10;
    ensureSpace(190);

    page.drawText('SIGNATURES', {
      x: 50,
      y,
      size: 11,
      font: fontBold,
      color: rgb(0, 0, 0.5)
    });

    y -= 8;
    page.drawLine({
      start: { x: 50, y },
      end: { x: 150, y },
      thickness: 0.5,
      color: rgb(0, 0, 0.5)
    });

    const approver = await resolveApprover(db, { assignmentId: assignment_id, depositId: data.deposit_id });
    const agentSig = await getLatestSignatureByRole(db, { assignmentId: assignment_id, depositId: data.deposit_id, role: 'agent' });
    const adminSig = await getLatestSignatureByRole(db, { assignmentId: assignment_id, depositId: data.deposit_id, role: 'admin_exec' });
    const itSig = await getLatestSignatureByRole(db, { assignmentId: assignment_id, depositId: data.deposit_id, role: 'it_staff' });

    const agentImg = await tryEmbedSignatureFromPath(pdfDoc, agentSig?.signature_path);
    const approverImg = await tryEmbedSignatureFromPath(pdfDoc, approver?.signature_path);
    const adminImg = await tryEmbedSignatureFromPath(pdfDoc, adminSig?.signature_path);
    const itImg = await tryEmbedSignatureFromPath(pdfDoc, itSig?.signature_path);

    const boxW = 240;
    const boxH = 44;
    const gapX = 15;
    const gapRow = 58;

    const xLeft = 50;
    const xRight = xLeft + boxW + gapX;

    const row1Y = y - 52;
    const row2Y = row1Y - (boxH + gapRow);

    const drawSigBox = (x, yBox, title, sig, imgObj) => {
      page.drawRectangle({
        x,
        y: yBox,
        width: boxW,
        height: boxH,
        borderColor: rgb(0, 0, 0),
        borderWidth: 0.5
      });

      drawSignatureImageInsideBox(page, imgObj, x, yBox, boxW, boxH);

      page.drawText(title, { x, y: yBox - 14, size: 9, font: fontRegular });

      if (sig?.signer_name) {
        page.drawText(`Name: ${sig.signer_name}`, {
          x,
          y: yBox - 26,
          size: 8,
          font: fontRegular,
          color: rgb(0.2, 0.2, 0.2)
        });
      }

      if (sig?.signed_at) {
        page.drawText(`Signed: ${formatDateTimeDisplay(sig.signed_at)}`, {
          x,
          y: yBox - 38,
          size: 8,
          font: fontRegular,
          color: rgb(0.2, 0.2, 0.2)
        });
      }
    };

    drawSigBox(xLeft, row1Y, 'Employee / Agent Signature', agentSig, agentImg);
    drawSigBox(
      xRight,
      row1Y,
      approver?.label === 'Team Leader (TL)' ? 'Team Leader Signature' : 'Manager Signature',
      approver,
      approverImg
    );
    drawSigBox(xLeft, row2Y, 'Admin Executive Signature', adminSig, adminImg);
    drawSigBox(xRight, row2Y, 'IT Staff Signature', itSig, itImg);

    y = row2Y - 54;

    drawFooter();

    const pdfBytes = await pdfDoc.save();

    const safeBase = [
      sanitizeFilePart(data.agent_name),
      sanitizeFilePart(data.headset_number),
      sanitizeFilePart(data.process_name),
      sanitizeFilePart(toISODate(data.deposit_date || new Date()))
    ]
      .filter(Boolean)
      .join('_');

    let fileName = generateFileName(safeBase, 'pdf');
    if (!fileName.toLowerCase().endsWith('.pdf')) fileName += '.pdf';

    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

    const filePath = path.join(PDF_DIR, fileName);
    fs.writeFileSync(filePath, pdfBytes);

    await db.query(
      `INSERT INTO pdf_documents (
        document_type, assignment_id, deposit_id, agent_id, headset_id,
        file_path, file_name, generated_at, generated_by, is_signed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, FALSE)`,
      [
        isVoix ? 'voix_deposit_form' : 'tech_deposit_form',
        assignment_id,
        data.deposit_id,
        data.agent_id,
        data.headset_id,
        `/uploads/pdfs/${fileName}`,
        fileName,
        req.user.id
      ]
    );

    return res.json(
      successResponse(
        {
          fileName,
          filePath: `/uploads/pdfs/${fileName}`,
          viewUrl: `${baseUrl}/uploads/pdfs/${fileName}`,
          downloadUrl: `${baseUrl}/uploads/pdfs/${fileName}?download=1`
        },
        'Deposit form PDF generated successfully'
      )
    );
  } catch (error) {
    console.error('❌ Generate deposit form error:', error);
    return res.status(500).json(errorResponse('Failed to generate deposit form'));
  }
};

// ============================================
// STORE SIGNATURE (legacy endpoint - unchanged)
// Note: this endpoint uses signature_data; your main flow uses signature_path.
// ============================================
export const storeSignature = async (req, res) => {
  try {
    const { assignment_id, deposit_id, signer_role, signature_data } = req.body;

    if (!signature_data) return res.status(400).json(errorResponse('Signature data is required'));
    if (signature_data.length < 100) return res.status(400).json(errorResponse('Invalid signature data'));

    const validRoles = ['agent', 'tl', 'manager', 'it_staff', 'admin_exec', 'trainer'];
    if (!validRoles.includes(signer_role)) {
      return res.status(400).json(errorResponse(`Invalid signer role. Must be one of: ${validRoles.join(', ')}`));
    }

    const [result] = await db.query(
      `INSERT INTO signatures (
        assignment_id, deposit_id, signer_id, signer_role,
        signature_data, signed_at, ip_address, device_info
      ) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)`,
      [
        assignment_id || null,
        deposit_id || null,
        req.user.id,
        signer_role,
        signature_data,
        req.ip || 'unknown',
        req.get('User-Agent') || 'Unknown'
      ]
    );

    await db.query(
      `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, ip_address, action_timestamp)
       VALUES (?, 'signature_captured', 'signatures', ?, ?, ?, NOW())`,
      [req.user.id, result.insertId, JSON.stringify({ signer_role, assignment_id, deposit_id }), req.ip || 'unknown']
    );

    return res.status(201).json(successResponse({ id: result.insertId, signerRole: signer_role }, 'Signature stored successfully'));
  } catch (error) {
    console.error('❌ Store signature error:', error);
    return res.status(500).json(errorResponse('Failed to store signature'));
  }
};

// ============================================
// GET PDF DOCUMENTS (unchanged)
// ============================================
export const getPdfDocuments = async (req, res) => {
  try {
    const { document_type, agent_id, start_date, end_date, page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    let whereConditions = ['1=1'];
    let params = [];

    if (document_type) {
      whereConditions.push('pd.document_type = ?');
      params.push(document_type);
    }

    if (agent_id) {
      whereConditions.push('pd.agent_id = ?');
      params.push(agent_id);
    }

    if (start_date) {
      whereConditions.push('DATE(pd.generated_at) >= ?');
      params.push(start_date);
    }

    if (end_date) {
      whereConditions.push('DATE(pd.generated_at) <= ?');
      params.push(end_date);
    }

    const whereClause = whereConditions.join(' AND ');

    const [countResult] = await db.query(`SELECT COUNT(*) as total FROM pdf_documents pd WHERE ${whereClause}`, params);
    const total = countResult?.[0]?.total ?? 0;

    const [documents] = await db.query(
      `SELECT 
        pd.*,
        u.name as agent_name,
        h.headset_number,
        gen_by.name as generated_by_name
       FROM pdf_documents pd
       LEFT JOIN agents a ON pd.agent_id = a.id
       LEFT JOIN users u ON a.user_id = u.id
       LEFT JOIN headsets h ON pd.headset_id = h.id
       LEFT JOIN users gen_by ON pd.generated_by = gen_by.id
       WHERE ${whereClause}
       ORDER BY pd.generated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    return res.json({
      success: true,
      data: documents.map(d => ({
        id: d.id,
        documentType: d.document_type,
        fileName: d.file_name,
        filePath: d.file_path,
        agentName: d.agent_name,
        headsetNumber: d.headset_number,
        isSigned: d.is_signed === 1,
        generatedAt: d.generated_at,
        generatedBy: d.generated_by_name
      })),
      pagination: {
        total,
        page: pageNum,
        pageSize: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('❌ Get PDF documents error:', error);
    return res.status(500).json(errorResponse('Failed to fetch PDF documents'));
  }
};

// ============================================
// GENERATE PROCESS CHANGE FORM (UPDATED terms + company info + type label)
// ============================================
export const generateProcessChangeForm = async (req, res) => {
  try {
    const { deposit_id } = req.params;

    const [deposits] = await db.query(
      `SELECT 
        d.*,
        h.id as headset_id,
        h.headset_number,
        h.headset_type,
        hb.brand_name,
        a.id as agent_id,
        u.name as agent_name,
        u.employee_id,
        u.temp_employee_id,
        u.email as agent_email,
        u.phone as agent_phone,
        ha.assignment_date,
        ha.id as assignment_id,
        from_p.name as from_process_name,
        from_p.category as from_category,
        to_p.name as to_process_name,
        to_p.category as to_category,
        t.transfer_date,
        t.transfer_type
       FROM deposits d
       JOIN headsets h ON d.headset_id = h.id
       JOIN headset_brands hb ON h.brand_id = hb.id
       JOIN agents a ON d.agent_id = a.id
       JOIN users u ON a.user_id = u.id
       LEFT JOIN headset_assignments ha ON d.assignment_id = ha.id
       LEFT JOIN transfers t 
         ON t.deposit_id = d.id
        AND t.transfer_type = 'agent_process_change'
       LEFT JOIN processes from_p ON t.from_process_id = from_p.id
       LEFT JOIN processes to_p ON t.to_process_id = to_p.id
       WHERE d.id = ? AND d.deposit_type = 'process_change'`,
      [deposit_id]
    );

    if (deposits.length === 0) {
      return res.status(404).json(errorResponse('Process change deposit not found'));
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const data = deposits[0];
    const company = await getCompanyInfo();

    const tpl = await getPdfTemplateByType('enc_exchange');
    const fallbackTerms2 = [
      '1. This additional deposit is collected for process change / ENC exchange.',
      `2. Additional amount: ${formatCurrencyPdf(data.deposit_amount)} is non-refundable except`,
      `   the refund-eligible portion of ${formatCurrencyPdf(data.refund_eligible_amount)}.`,
      '3. Headset remains the property of the company.',
      '4. Employee remains responsible for the headset in the new process.',
      '5. Damage / loss will be deducted from the refund amount.'
    ];
    const templateTerms2 = parseBulletJson(tpl?.policy_text, []);
    const terms2 = templateTerms2.length ? templateTerms2 : fallbackTerms2;

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();

    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    let y = height - 50;

    // Header
    page.drawText(company.name, { x: 50, y, size: 16, font: fontBold, color: rgb(0, 0, 0.5) });
    y -= 20;
    page.drawText(company.address, { x: 50, y, size: 8, font: fontRegular, color: rgb(0.3, 0.3, 0.3) });
    y -= 12;
    page.drawText(`Phone: ${company.phone} | Email: ${company.email}`, {
      x: 50,
      y,
      size: 8,
      font: fontRegular,
      color: rgb(0.3, 0.3, 0.3)
    });

    y -= 15;
    page.drawLine({
      start: { x: 50, y },
      end: { x: width - 50, y },
      thickness: 1,
      color: rgb(0, 0, 0.5)
    });

    // Title
    y -= 26;
    page.drawText('PROCESS CHANGE / ENC EXCHANGE FORM', { x: 50, y, size: 14, font: fontBold });

    page.drawText(`Date: ${formatDateDisplay(data.deposit_date || new Date())}`, {
      x: width - 200,
      y,
      size: 10,
      font: fontRegular
    });

    y -= 15;
    page.drawText(`Receipt No: ${data.receipt_number || 'N/A'}`, {
      x: width - 200,
      y,
      size: 10,
      font: fontRegular
    });

    const drawField = (label, value, yPos) => {
      page.drawText(label, { x: 50, y: yPos, size: 10, font: fontBold });
      page.drawText(`: ${value || 'N/A'}`, { x: 200, y: yPos, size: 10, font: fontRegular });
    };

    // Employee Details
    y -= 30;
    page.drawText('EMPLOYEE DETAILS', { x: 50, y, size: 11, font: fontBold, color: rgb(0, 0, 0.5) });
    y -= 5;
    page.drawLine({ start: { x: 50, y }, end: { x: 200, y }, thickness: 0.5, color: rgb(0, 0, 0.5) });

    y -= 20;
    drawField('Employee Name', data.agent_name, y);
    y -= 18;
    drawField('Employee ID', data.employee_id || data.temp_employee_id || 'Pending', y);
    y -= 18;
    drawField('Phone', data.agent_phone, y);
    y -= 18;
    drawField('Email', data.agent_email, y);

    // Process Change Details
    y -= 28;
    page.drawText('PROCESS CHANGE DETAILS', { x: 50, y, size: 11, font: fontBold, color: rgb(0, 0, 0.5) });
    y -= 5;
    page.drawLine({ start: { x: 50, y }, end: { x: 250, y }, thickness: 0.5, color: rgb(0, 0, 0.5) });

    y -= 20;
    drawField('From Process', data.from_process_name, y);
    y -= 18;
    drawField('From Category', data.from_category, y);
    y -= 18;
    drawField('To Process', data.to_process_name, y);
    y -= 18;
    drawField('To Category', data.to_category, y);
    y -= 18;
    drawField('Transfer Date', formatDateDisplay(data.transfer_date || data.deposit_date), y);

    // Headset Details
    y -= 28;
    page.drawText('HEADSET DETAILS', { x: 50, y, size: 11, font: fontBold, color: rgb(0, 0, 0.5) });
    y -= 5;
    page.drawLine({ start: { x: 50, y }, end: { x: 200, y }, thickness: 0.5, color: rgb(0, 0, 0.5) });

    y -= 20;
    drawField('Headset Number', data.headset_number, y);
    y -= 18;
    drawField('Headset Type', headsetTypeLabel(data.headset_type), y);
    y -= 18;
    drawField('Brand', data.brand_name, y);

    // Additional Deposit
    y -= 28;
    page.drawText('ADDITIONAL DEPOSIT', { x: 50, y, size: 11, font: fontBold, color: rgb(0, 0, 0.5) });
    y -= 5;
    page.drawLine({ start: { x: 50, y }, end: { x: 200, y }, thickness: 0.5, color: rgb(0, 0, 0.5) });

    y -= 20;
    drawField('Additional Deposit', formatCurrencyPdf(data.deposit_amount), y);
    y -= 18;
    drawField('Refund Eligible', formatCurrencyPdf(data.refund_eligible_amount), y);

    // Terms
    y -= 28;
    page.drawText('TERMS AND CONDITIONS', { x: 50, y, size: 11, font: fontBold, color: rgb(0, 0, 0.5) });
    y -= 5;
    page.drawLine({ start: { x: 50, y }, end: { x: 250, y }, thickness: 0.5, color: rgb(0, 0, 0.5) });

    y -= 16;
    for (const term of terms2) {
      page.drawText(String(term), { x: 50, y, size: 9, font: fontRegular });
      y -= 12;
    }

    // Footer
    const footerY = 35;
    page.drawText(`Generated on: ${formatDateTimeDisplay(new Date())}`, {
      x: 50,
      y: footerY,
      size: 8,
      font: fontRegular,
      color: rgb(0.5, 0.5, 0.5)
    });
    page.drawText('This is a computer-generated document.', {
      x: width - 220,
      y: footerY,
      size: 8,
      font: fontRegular,
      color: rgb(0.5, 0.5, 0.5)
    });

    // Save
    const pdfBytes = await pdfDoc.save();

    let fileName = generateFileName(
      `process-change-${data.headset_number}_${toISODate(data.deposit_date || new Date())}`,
      'pdf'
    );
    if (!fileName.toLowerCase().endsWith('.pdf')) fileName += '.pdf';

    const filePath = path.join(PDF_DIR, fileName);
    fs.writeFileSync(filePath, pdfBytes);

    await db.query(
      `INSERT INTO pdf_documents (
        document_type, assignment_id, deposit_id, agent_id, headset_id,
        file_path, file_name, generated_at, generated_by, is_signed
      ) VALUES ('process_change_form', ?, ?, ?, ?, ?, ?, NOW(), ?, FALSE)`,
      [
        data.assignment_id || null,
        deposit_id,
        data.agent_id || null,
        data.headset_id || null,
        `/uploads/pdfs/${fileName}`,
        fileName,
        req.user.id
      ]
    );

    return res.json(
      successResponse(
        {
          fileName,
          filePath: `/uploads/pdfs/${fileName}`,
          viewUrl: `${baseUrl}/uploads/pdfs/${fileName}`,
          downloadUrl: `${baseUrl}/uploads/pdfs/${fileName}?download=1`
        },
        'Process change form PDF generated successfully'
      )
    );
  } catch (error) {
    console.error('❌ Generate process change form error:', error);
    return res.status(500).json(errorResponse('Failed to generate process change form'));
  }
};

export default {
  generateDepositForm,
  storeSignature,
  getPdfDocuments,
  generateProcessChangeForm
};