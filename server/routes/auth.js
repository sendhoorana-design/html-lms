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

  const token = jwt.sign(
    { id: user._id.toString(), username: user.username, role: user.role, full_name: user.full_name },
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
    must_change_password: !!user.must_change_password
  });
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
    must_change_password: !!user.must_change_password
  });
}));

module.exports = router;
