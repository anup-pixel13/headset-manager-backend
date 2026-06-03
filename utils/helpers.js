import crypto from 'crypto';

// ============================================
// DATE HELPERS
// ============================================

/**
 * Format date to MySQL DATETIME format
 * @param {Date|string} date
 * @returns {string} YYYY-MM-DD HH:MM:SS
 */
export const formatDateMySQL = (date = new Date()) => {
  const d = new Date(date);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * Format date to display format
 * @param {Date|string} date
 * @returns {string} DD/MM/YYYY
 */
export const formatDateDisplay = (date) => {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
};

/**
 * Format date and time to display format
 * @param {Date|string} date
 * @returns {string} DD/MM/YYYY HH:MM AM/PM
 */
export const formatDateTimeDisplay = (date) => {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
};

/**
 * Get start and end of month
 * @param {number} year
 * @param {number} month (1-12)
 * @returns {{ startDate: string, endDate: string }}
 */
export const getMonthRange = (year, month) => {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);
  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
};

// ============================================
// STRING HELPERS
// ============================================

/**
 * Generate unique ID
 * @param {string} prefix
 * @returns {string}
 */
export const generateId = (prefix = '') => {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
};

/**
 * Generate receipt number
 * @param {string} type - DEP, REF, TRF
 * @returns {string} e.g., DEP-2024-0001
 */
export const generateReceiptNumber = (type = 'DEP') => {
  const year = new Date().getFullYear();
  const random = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
  return `${type}-${year}-${random}`;
};

/**
 * Sanitize string for safe use
 * @param {string} str
 * @returns {string}
 */
export const sanitizeString = (str) => {
  if (!str) return '';
  return str.trim().replace(/[<>]/g, '');
};

/**
 * Capitalize first letter
 * @param {string} str
 * @returns {string}
 */
export const capitalizeFirst = (str) => {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

/**
 * Convert to title case
 * @param {string} str
 * @returns {string}
 */
export const toTitleCase = (str) => {
  if (!str) return '';
  return str
    .split(' ')
    .map((word) => capitalizeFirst(word))
    .join(' ');
};

// ============================================
// VALIDATION HELPERS
// ============================================

/**
 * Validate email format
 * @param {string} email
 * @returns {boolean}
 */
export const isValidEmail = (email) => {
  if (!email) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Validate phone number (10 digits, starts with 6-9)
 * @param {string} phone
 * @returns {boolean}
 */
export const isValidPhone = (phone) => {
  if (!phone) return false;
  const digitsOnly = phone.replace(/\D/g, '');
  return digitsOnly.length === 10 && /^[6-9]/.test(digitsOnly);
};

/**
 * Old (loose) validation — kept for backward compatibility.
 * Prefer validateHeadsetNumberForType() in new code.
 * @param {string} headsetNumber
 * @returns {boolean}
 */
export const isValidHeadsetNumber = (headsetNumber) => {
  if (!headsetNumber) return false;
  // Valid formats: ENC 01, ENC 01*, TECH 05, 302, N22, OJT 01, YJACK 01
  const patterns = [
    /^ENC\s?\d+\*?$/i, // ENC 01, ENC 01*
    /^TECH\s?\d+$/i, // TECH 01
    /^[3]\d{2}$/, // 302, 323
    /^N\d+$/i, // N22, N23
    /^OJT\s?\d+$/i, // OJT 01
    /^YJACK\s?\d+$/i, // YJACK 01
  ];
  return patterns.some((pattern) => pattern.test(headsetNumber.trim()));
};

// ✅ NEW: strict normalization + validation (source of truth in backend)
export const normalizeHeadsetNumber = (value) =>
  String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');

const _toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Type-aware validation (strict)
 * @returns {{ ok: boolean, normalized: string, reason: string }}
 */
export const validateHeadsetNumberForType = (headsetNumber, headsetType) => {
  const normalized = normalizeHeadsetNumber(headsetNumber);

  const allowedTypes = new Set([
    'voix_enc',
    'voix_2xx',
    'voix_3xx',
    'voix_nxx',
    'voix_xxx',
    'tech',
    'ojt',
    'yjack',
  ]);

  if (!allowedTypes.has(headsetType)) {
    return { ok: false, normalized, reason: `Invalid headset_type: ${headsetType}` };
  }

  if (!normalized) {
    return { ok: false, normalized, reason: 'Headset number is required' };
  }

  // voix_enc:
  // ENC 01..9999
  // ENC 01*..9999*
  // ENC R01*..R9999* (R-series requires *)
  if (headsetType === 'voix_enc') {
    const m = normalized.match(/^ENC\s(R)?(\d{2,4})(\*)?$/i);
    if (!m) {
      return { ok: false, normalized, reason: 'Invalid VOIX (ENC). Example: ENC 01, ENC 9999*, ENC R01*' };
    }

    const isR = !!m[1];
    const digits = m[2];
    const hasStar = !!m[3];

    const n = _toInt(digits);
    if (n === null || n < 1 || n > 9999) {
      return { ok: false, normalized, reason: 'ENC number must be between 01 and 9999' };
    }
    if (isR && !hasStar) {
      return { ok: false, normalized, reason: 'ENC R-series must end with * (example: ENC R01*)' };
    }

    return { ok: true, normalized, reason: '' };
  }

  // voix_nxx: N1..N9999
  if (headsetType === 'voix_nxx') {
    const m = normalized.match(/^N(\d{1,4})$/i);
    if (!m) return { ok: false, normalized, reason: 'Invalid N-series. Example: N1, N9999' };

    const n = _toInt(m[1]);
    if (n === null || n < 1 || n > 9999) {
      return { ok: false, normalized, reason: 'N-series must be N1 to N9999' };
    }
    return { ok: true, normalized, reason: '' };
  }

  // voix_xxx: 01..199 OR 400..9999
  if (headsetType === 'voix_xxx') {
    if (!/^\d{1,4}$/.test(normalized)) {
      return { ok: false, normalized, reason: 'Invalid VOIX non-ENC. Use 01–199 or 400–9999' };
    }
    const n = _toInt(normalized);
    if (n === null) return { ok: false, normalized, reason: 'Invalid number' };

    const ok = (n >= 1 && n <= 199) || (n >= 400 && n <= 9999);
    if (!ok) return { ok: false, normalized, reason: 'VOIX non-ENC must be 01–199 or 400–9999' };

    return { ok: true, normalized, reason: '' };
  }

  // voix_2xx: 200..299
  if (headsetType === 'voix_2xx') {
    if (!/^\d{3}$/.test(normalized)) return { ok: false, normalized, reason: '2xx must be 3 digits (200–299)' };
    const n = _toInt(normalized);
    if (n === null || n < 200 || n > 299) return { ok: false, normalized, reason: '2xx must be 200–299' };
    return { ok: true, normalized, reason: '' };
  }

  // voix_3xx: 300..399
  if (headsetType === 'voix_3xx') {
    if (!/^\d{3}$/.test(normalized)) return { ok: false, normalized, reason: '3xx must be 3 digits (300–399)' };
    const n = _toInt(normalized);
    if (n === null || n < 300 || n > 399) return { ok: false, normalized, reason: '3xx must be 300–399' };
    return { ok: true, normalized, reason: '' };
  }

  // tech: TECH 01..9999 (2-4 digits)
  if (headsetType === 'tech') {
    const m = normalized.match(/^TECH\s(\d{2,4})$/i);
    if (!m) return { ok: false, normalized, reason: 'Invalid TECH. Example: TECH 01, TECH 9999' };
    const n = _toInt(m[1]);
    if (n === null || n < 1 || n > 9999) return { ok: false, normalized, reason: 'TECH must be TECH 01 to TECH 9999' };
    return { ok: true, normalized, reason: '' };
  }

  if (headsetType === 'ojt') {
    if (!/^OJT\s\d{2}$/i.test(normalized)) return { ok: false, normalized, reason: 'Invalid OJT. Example: OJT 01' };
    return { ok: true, normalized, reason: '' };
  }

  if (headsetType === 'yjack') {
    if (!/^YJACK\s\d{2}$/i.test(normalized)) return { ok: false, normalized, reason: 'Invalid YJACK. Example: YJACK 01' };
    return { ok: true, normalized, reason: '' };
  }

  return { ok: false, normalized, reason: 'Unsupported headset type' };
};

// ============================================
// RESPONSE HELPERS
// ============================================

export const successResponse = (data, message = 'Success') => ({
  success: true,
  message,
  data,
});

export const errorResponse = (message = 'Error', details = null) => ({
  success: false,
  message,
  ...(details && { details }),
});

export const paginatedResponse = (data, total, page = 1, pageSize = 20) => ({
  success: true,
  data,
  pagination: {
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    hasMore: page * pageSize < total,
  },
});

// ============================================
// FILE HELPERS
// ============================================

export const getFileExtension = (filename) => {
  if (!filename) return '';
  return filename.split('.').pop().toLowerCase();
};

export const generateFileName = (originalName, prefix = 'file') => {
  const ext = getFileExtension(originalName);
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${timestamp}-${random}.${ext}`;
};

export const isAllowedFileType = (mimetype, allowedTypes) => {
  return allowedTypes.includes(mimetype);
};

// ============================================
// AMOUNT HELPERS
// ============================================

export const formatCurrency = (amount) => {
  if (amount === null || amount === undefined) return '₹0';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
};

export const formatCurrencyPdf = (amount) => {
  const n = Number(amount || 0);
  // Avoid ₹ symbol for pdf-lib standard fonts
  return `Rs. ${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n)}`;
};

export const calculateRefund = (depositAmount, maxRefund, condition, damageDeduction = 0) => {
  switch (condition) {
    case 'good':
      return maxRefund;
    case 'fair':
      return Math.max(0, maxRefund - damageDeduction);
    case 'damaged':
      return Math.max(0, maxRefund - damageDeduction);
    case 'lost':
      return 0;
    default:
      return maxRefund;
  }
};

// ============================================
// DEPOSIT AMOUNTS (Constants)
// ============================================

export const DEPOSIT_AMOUNTS = {
  voix: {
    deposit: 1750,
    refund: 1100,
  },
  tech: {
    deposit: 1250,
    refund: 800,
  },
  process_change: {
    deposit: 500,
    refund: 1100,
  },
};

// ============================================
// HEADSET TYPES
// ============================================

export const HEADSET_TYPES = {
  voix_enc: { label: 'Voix ENC', brand: 'voix', premium: true },
  voix_2xx: { label: 'Voix 2xx', brand: 'voix', premium: false },
  voix_3xx: { label: 'Voix 3xx', brand: 'voix', premium: false },
  voix_nxx: { label: 'Voix N-series', brand: 'voix', premium: false },
  voix_xxx: { label: 'Voix Non‑ENC', brand: 'voix', premium: false },
  tech: { label: 'Tech', brand: 'tech', premium: false },
  ojt: { label: 'OJT', brand: 'ojt', premium: false },
  yjack: { label: 'Y-Jack', brand: 'yjack', premium: false },
};

// ============================================
// USER ROLES
// ============================================

export const USER_ROLES = {
  admin: { level: 1, label: 'Administrator' },
  it_staff: { level: 2, label: 'IT Staff' },
  manager: { level: 3, label: 'Manager' },
  tl: { level: 4, label: 'Team Leader' },
  trainer: { level: 5, label: 'Trainer' },
  agent: { level: 6, label: 'Agent' },
};

export const hasPermission = (userRole, requiredRole) => {
  const userLevel = USER_ROLES[userRole]?.level || 999;
  const requiredLevel = USER_ROLES[requiredRole]?.level || 1;
  return userLevel <= requiredLevel;
};

export default {
  formatDateMySQL,
  formatDateDisplay,
  formatDateTimeDisplay,
  getMonthRange,
  generateId,
  generateReceiptNumber,
  sanitizeString,
  capitalizeFirst,
  toTitleCase,
  isValidEmail,
  isValidPhone,
  isValidHeadsetNumber,
  normalizeHeadsetNumber,
  validateHeadsetNumberForType,
  successResponse,
  errorResponse,
  paginatedResponse,
  getFileExtension,
  generateFileName,
  isAllowedFileType,
  formatCurrency,
  calculateRefund,
  DEPOSIT_AMOUNTS,
  HEADSET_TYPES,
  USER_ROLES,
  hasPermission,
};