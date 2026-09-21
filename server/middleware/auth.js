const jwt = require('jsonwebtoken');
require('dotenv').config();

function authRequired(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// Gates the main/super-admin-only actions (approving admin signups, assigning students to
// sub-admins, bulk student create/import/delete). Does a fresh DB lookup rather than trusting
// the JWT's is_super_admin flag, same reasoning as /api/auth/me re-reading must_change_password
// — a flag that controls access shouldn't be able to go stale for the lifetime of a token.
async function requireSuperAdmin(req, res, next) {
  try {
    const User = require('../models/User');
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const user = await User.findById(req.user.id).select('is_super_admin role').lean();
    if (!user || user.role !== 'admin' || !user.is_super_admin) {
      return res.status(403).json({ error: 'Only the main admin can do this' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: 'Failed to verify admin permissions' });
  }
}

module.exports = { authRequired, requireRole, requireSuperAdmin };
