const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authRequired } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = await User.findOne({ username });
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Admin accounts created via self-signup can't log in until the main admin approves them.
  if (user.role === 'admin' && user.admin_status !== 'approved') {
    if (user.admin_status === 'rejected') {
      return res.status(403).json({ error: 'Your admin signup request was rejected. Contact the main admin.' });
    }
    return res.status(403).json({ error: 'Your admin account is pending approval from the main admin.' });
  }

  const token = jwt.sign(
    {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      is_super_admin: !!user.is_super_admin
    },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  });

  res.json({
    id: user._id.toString(),
    username: user.username,
    role: user.role,
    full_name: user.full_name,
    is_super_admin: !!user.is_super_admin,
    must_change_password: !!user.must_change_password
  });
}));

// Public self-signup for admin accounts. Creates the account in a "pending" state — it cannot
// log in (see /login above) until the main/super admin approves it from the Admin Requests tab.
router.post('/admin-signup', asyncHandler(async (req, res) => {
  const { username, password, full_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = await User.findOne({ username });
  if (existing) return res.status(409).json({ error: 'That username is already taken' });

  const hash = bcrypt.hashSync(password, 10);
  await User.create({
    username,
    password_hash: hash,
    role: 'admin',
    full_name: full_name || username,
    is_super_admin: false,
    admin_status: 'pending'
  });

  res.status(201).json({ ok: true, message: 'Request submitted. You can log in once the main admin approves your account.' });
}));

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// Re-reads the user from the database rather than trusting the JWT payload as-is, so a flag
// like must_change_password (which an admin can flip mid-session) is always current instead
// of stuck at whatever it was when the token was issued.
router.get('/me', authRequired, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).lean();
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    id: user._id.toString(),
    username: user.username,
    role: user.role,
    full_name: user.full_name,
    is_super_admin: !!user.is_super_admin,
    must_change_password: !!user.must_change_password
  });
}));

module.exports = router;
