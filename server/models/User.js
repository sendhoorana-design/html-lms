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

  // ---- Admin-role-only fields ----
  // The main/super admin (the seeded "admin" account, or anyone else later promoted directly in
  // the database) can approve new admin signups and assign students to sub-admins. Regular
  // approved admins cannot do either.
  is_super_admin: { type: Boolean, default: false },
  // Only meaningful for role: 'admin'. New signups start "pending" and can't log in until a
  // super admin approves them. Defaults to "approved" so admins created directly (the seed
  // script, or any admin created before this field existed) keep working without a migration.
  admin_status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },

  // ---- Student-role-only field ----
  // Which sub-admin manages this student, assigned by the super admin — a sub-admin can only
  // see/assign exams to/monitor students where this points at them. Null = unassigned (only the
  // super admin can see/manage it until a super admin hands it to a sub-admin).
  managing_admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
