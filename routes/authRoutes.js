import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import db from '../config/database.js';

const router = express.Router();

// Session duration from env or default 30 minutes
const SESSION_DURATION_MS = (parseInt(process.env.SESSION_DURATION_MINUTES) || 30) * 60 * 1000;

// ============================================
// LOGIN
// ============================================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    // Get user by employee_id, temp_employee_id, or email
    const [users] = await db.query(
      `SELECT * FROM users 
       WHERE (employee_id = ? OR temp_employee_id = ? OR email = ?) 
       AND is_active = TRUE`,
      [username, username, username]
    );

    if (users.length === 0) {
      console.log(`❌ Login failed: User not found - ${username}`);
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = users[0];

    // Check password
    let isValidPassword = false;

    if (user.password_hash.startsWith('$2b$') || user.password_hash.startsWith('$2a$')) {
      // Bcrypt hashed password
      isValidPassword = await bcrypt.compare(password, user.password_hash);
    } else {
      // Plain text (for initial setup only - should hash in production)
      isValidPassword = (password === user.password_hash);
    }

    if (!isValidPassword) {
      console.log(`❌ Login failed: Invalid password for - ${username}`);
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Generate secure session token
    const sessionToken = crypto.randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    // Delete any existing sessions for this user
    await db.query('DELETE FROM user_sessions WHERE user_id = ?', [user.id]);

    // Create new session
    await db.query(
      `INSERT INTO user_sessions (user_id, session_token, expires_at, last_activity, ip_address, user_agent) 
       VALUES (?, ?, ?, NOW(), ?, ?)`,
      [
        user.id,
        sessionToken,
        expiresAt,
        req.ip || req.connection?.remoteAddress || 'unknown',
        req.get('User-Agent') || 'Unknown'
      ]
    );

    // Log audit
    await db.query(
      `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, ip_address, action_timestamp)
       VALUES (?, 'login', 'users', ?, ?, ?, NOW())`,
      [
        user.id,
        user.id,
        JSON.stringify({ username: user.employee_id || user.temp_employee_id }),
        req.ip || 'unknown'
      ]
    );

    console.log(`✅ User "${user.name}" (${user.role}) logged in successfully`);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        sessionToken,
        expiresAt: expiresAt.toISOString(),
        sessionDurationMinutes: SESSION_DURATION_MS / 60000,
        user: {
          id: user.id,
          name: user.name,
          employeeId: user.employee_id || user.temp_employee_id,
          email: user.email,
          role: user.role,
          phone: user.phone
        }
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
});

// ============================================
// VERIFY SESSION
// ============================================
router.get('/verify-session', async (req, res) => {
  try {
    const sessionToken = req.headers['x-session-token'];

    if (!sessionToken) {
      return res.status(401).json({
        success: false,
        message: 'No session token provided',
        isAuthenticated: false
      });
    }

    // Get session with user info
    const [sessions] = await db.query(
      `SELECT s.*, u.name, u.employee_id, u.temp_employee_id, u.email, u.role, u.phone
       FROM user_sessions s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.session_token = ? AND s.expires_at > NOW() AND u.is_active = TRUE`,
      [sessionToken]
    );

    if (sessions.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Session expired or invalid',
        isAuthenticated: false
      });
    }

    const session = sessions[0];

    // Check inactivity timeout
    const lastActivity = new Date(session.last_activity);
    const now = new Date();
    const inactiveMs = now - lastActivity;

    if (inactiveMs > SESSION_DURATION_MS) {
      await db.query('DELETE FROM user_sessions WHERE session_token = ?', [sessionToken]);

      console.log(`⏱️ Session expired due to inactivity for user_id: ${session.user_id}`);

      return res.status(401).json({
        success: false,
        message: 'Session expired due to inactivity',
        isAuthenticated: false,
        reason: 'inactivity'
      });
    }

    // Extend session
    //const newExpiresAt = new Date(Date.now() + SESSION_DURATION_MS);

	// ✅ Read-only check. Only update last_activity, do NOT extend expires_at.
	// expires_at is only extended via /refresh-session (real user activity).
	await db.query(
	  'UPDATE user_sessions SET last_activity = NOW() WHERE session_token = ?',
	  [sessionToken]
	);

	res.json({
	  success: true,
	  isAuthenticated: true,
	  data: {
	    user: {
	      id: session.user_id,
	      name: session.name,
	      employeeId: session.employee_id || session.temp_employee_id,
	      email: session.email,
	      role: session.role,
	      phone: session.phone
	    },
	    expiresAt: session.expires_at, // ✅ return existing expires_at
	    sessionDurationMinutes: SESSION_DURATION_MS / 60000
	  }
	});
  } catch (error) {
    console.error('❌ Session verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Session verification failed',
      isAuthenticated: false
    });
  }
});

// ============================================
// REFRESH SESSION
// ============================================
router.post('/refresh-session', async (req, res) => {
  try {
    const sessionToken = req.headers['x-session-token'];

    if (!sessionToken) {
      return res.status(401).json({
        success: false,
        message: 'No session token provided'
      });
    }

    // Validate session
    const [sessions] = await db.query(
      'SELECT * FROM user_sessions WHERE session_token = ? AND expires_at > NOW()',
      [sessionToken]
    );

    if (sessions.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Session expired or invalid'
      });
    }

    // Extend session
    const newExpiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await db.query(
      'UPDATE user_sessions SET last_activity = NOW(), expires_at = ? WHERE session_token = ?',
      [newExpiresAt, sessionToken]
    );

    console.log(`🔄 Session refreshed for user_id: ${sessions[0].user_id}`);

    res.json({
      success: true,
      message: 'Session refreshed',
      data: {
        expiresAt: newExpiresAt.toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Session refresh error:', error);
    res.status(500).json({
      success: false,
      message: 'Session refresh failed'
    });
  }
});

// ============================================
// LOGOUT
// ============================================
router.post('/logout', async (req, res) => {
  try {
    const sessionToken = req.headers['x-session-token'];

    if (sessionToken) {
      // Get user_id before deleting for audit log
      const [sessions] = await db.query(
        'SELECT user_id FROM user_sessions WHERE session_token = ?',
        [sessionToken]
      );

      if (sessions.length > 0) {
        const userId = sessions[0].user_id;

        // Delete session
        await db.query('DELETE FROM user_sessions WHERE session_token = ?', [sessionToken]);

        // Log audit
        await db.query(
          `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, ip_address, action_timestamp)
           VALUES (?, 'logout', 'users', ?, '{}', ?, NOW())`,
          [userId, userId, req.ip || 'unknown']
        );

        console.log(`✅ User logged out successfully (user_id: ${userId})`);
      }
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('❌ Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Logout failed'
    });
  }
});

// ============================================
// CHANGE PASSWORD
// ============================================
router.post('/change-password', async (req, res) => {
  try {
    const sessionToken = req.headers['x-session-token'];
    const { currentPassword, newPassword } = req.body;

    if (!sessionToken) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters'
      });
    }

    // Get session and user
    const [sessions] = await db.query(
      `SELECT s.user_id, u.password_hash, u.name
       FROM user_sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.session_token = ? AND s.expires_at > NOW()`,
      [sessionToken]
    );

    if (sessions.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Session expired or invalid'
      });
    }

    const { user_id, password_hash, name } = sessions[0];

    // Verify current password
    let isValidPassword = false;
    if (password_hash.startsWith('$2b$') || password_hash.startsWith('$2a$')) {
      isValidPassword = await bcrypt.compare(currentPassword, password_hash);
    } else {
      isValidPassword = (currentPassword === password_hash);
    }

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await db.query(
      'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?',
      [newPasswordHash, user_id]
    );

    // Log audit
    await db.query(
      `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, new_values, ip_address, action_timestamp)
       VALUES (?, 'user_updated', 'users', ?, '{"field": "password"}', ?, NOW())`,
      [user_id, user_id, req.ip || 'unknown']
    );

    console.log(`✅ Password changed for user: ${name}`);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('❌ Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Password change failed'
    });
  }
});

// ============================================
// CLEANUP EXPIRED SESSIONS (Maintenance)
// ============================================
router.delete('/cleanup-sessions', async (req, res) => {
  try {
    const [result] = await db.query('DELETE FROM user_sessions WHERE expires_at < NOW()');

    console.log(`🧹 Cleaned up ${result.affectedRows} expired sessions`);

    res.json({
      success: true,
      message: `Cleaned up ${result.affectedRows} expired sessions`
    });
  } catch (error) {
    console.error('❌ Session cleanup error:', error);
    res.status(500).json({
      success: false,
      message: 'Session cleanup failed'
    });
  }
});

export default router;