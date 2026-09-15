const { mongoose } = require('../db');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password_hash: { type: String, required: true },
  role: { type: String, required: true, enum: ['admin', 'student'] },
  full_name: { type: String, default: '' },
  // Free-text class/section label (e.g. "CSE A", "CSE-D 2026-2027") — students only. Lets exams
  // be assigned to a whole class at once instead of picking students off a flat list.
  section: { type: String, default: '', trim: true },
  // True right after a CSV import, or whenever an admin forces it — the student must set a new
  // password before they can do anything else.
  must_change_password: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
