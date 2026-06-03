import db from '../config/db.js';

// Session duration from env or default 30 minutes
const SESSION_DURATION_MS = (parseInt(process.env.SESSION_DURATION_MINUTES) || 30) * 60 * 1000;

/**
 * Middleware to verify user session token
 * Protects routes requiring authentication
 */
export const verifySession = async (req, res, next) => {
  try {
    const sessionToken = req.headers['x-session-token'];

    if (!sessionToken) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. No session token provided.',
        isAuthenticated: false
      });
    }

    // Get session from database with user info
    const [sessions] = await db.query(
      `SELECT s.*, u.name, u.employee_id, u.temp_employee_id, u.role, u.email
       FROM user_sessions s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.session_token = ? AND s.expires_at > NOW() AND u.is_active = TRUE`,
      [sessionToken]
    );

    if (sessions.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Session expired or invalid. Please login again.',
        isAuthenticated: false
      });
    }

    const session = sessions[0];

    // Check for inactivity timeout
    const lastActivity = new Date(session.last_activity);
    const now = new Date();
    const inactiveMs = now - lastActivity;

    if (inactiveMs > SESSION_DURATION_MS) {
      // Session expired due to inactivity - delete it
      await db.query('DELETE FROM user_sessions WHERE session_token = ?', [sessionToken]);

      console.log(`⏱️ Session expired due to inactivity for user_id: ${session.user_id}`);

      return res.status(401).json({
        success: false,
        message: 'Session expired due to inactivity. Please login again.',
        isAuthenticated: false,
        reason: 'inactivity'
      });
    }

    // Update last_activity and expires_at on each authenticated request
  //  const newExpiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  // ✅ Read-only auth check. Only update last_activity.
  // expires_at is extended only by /api/auth/refresh-session (real user activity).
  await db.query(
    'UPDATE user_sessions SET last_activity = NOW() WHERE session_token = ?',
    [sessionToken]
  );

    // Attach user info to request for use in controllers
    req.user = {
      id: session.user_id,
      name: session.name,
      employeeId: session.employee_id || session.temp_employee_id,
      role: session.role,
      email: session.email
    };

    console.log(`🔐 User "${session.name}" (${session.role}) authenticated for ${req.method} ${req.path}`);

    next();
  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Authentication verification failed',
      isAuthenticated: false
    });
  }
};

/**
 * Middleware to check if user has required role(s)
 * Use after verifySession middleware
 * @param {string[]} allowedRoles - Array of allowed roles
 */
export const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      console.log(`⛔ Access denied for "${req.user.name}" (${req.user.role}) to ${req.method} ${req.path}`);
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
        requiredRoles: allowedRoles,
        yourRole: req.user.role
      });
    }

    next();
  };
};

/**
 * Middleware for IT Staff and Admin only routes
 */
export const requireITStaff = requireRole(['admin', 'it_staff']);

/**
 * Middleware for Admin only routes
 */
export const requireAdmin = requireRole(['admin']);

/**
 * Middleware for Manager and above
 */
export const requireManager = requireRole(['admin', 'it_staff', 'manager']);

/**
 * Middleware for TL and above
 */
export const requireTL = requireRole(['admin', 'it_staff', 'manager', 'tl']);

/**
 * Middleware for Trainer and above
 */
export const requireTrainer = requireRole(['admin', 'it_staff', 'manager', 'tl', 'trainer']);

/**
 * Optional: Verify request is from allowed IP range
 * For local network restriction (192.168.x.x)
 */
export const verifyIPRange = (req, res, next) => {
  const clientIP = req.ip || req.connection?.remoteAddress || '';
  const allowedRanges = (process.env.ALLOWED_IP_RANGES || '').split(',').map(r => r.trim());

  // Skip IP check in development
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  // Check if IP is in allowed range
  const isAllowed = allowedRanges.some(range => {
    if (!range) return false;
    const [subnet, mask] = range.split('/');
    if (!subnet) return false;

    // Simple check for 192.168.x.x pattern
    if (clientIP.includes('192.168.') || clientIP.includes('127.0.0.1') || clientIP.includes('::1')) {
      return true;
    }
    return clientIP.startsWith(subnet.split('/')[0].replace('.0', '.'));
  });

  if (!isAllowed && allowedRanges.length > 0 && allowedRanges[0] !== '') {
    console.log(`⛔ IP ${clientIP} not in allowed range`);
    return res.status(403).json({
      success: false,
      message: 'Access denied. Your IP is not in the allowed range.',
      yourIP: clientIP
    });
  }

  next();
};

export default verifySession;