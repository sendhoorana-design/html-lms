const express = require('express');
const bcrypt = require('bcryptjs');
const { mongoose } = require('../db');
const User = require('../models/User');
const Exam = require('../models/Exam');
const ExamAssignment = require('../models/ExamAssignment');
const Violation = require('../models/Violation');
const { authRequired, requireRole, requireSuperAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { runChecks } = require('../utils/grader');
const Feedback = require('../models/Feedback');
const FeedbackSettings = require('../models/FeedbackSettings');
const { getFeedbackSettings, FEEDBACK_CATEGORIES } = require('../utils/feedbackSettings');
const Challenge = require('../models/Challenge');
const ChallengeProgress = require('../models/ChallengeProgress');
const { sanitizeChallenge } = require('../utils/challenges');
const starterChallenges = require('../data/starterChallenges');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

// Every admin route below needs to know whether the caller is the main/super admin (sees and
// manages everything) or a regular sub-admin (scoped to their own managed students and
// exams they can see per the rules further down). Fetched fresh per-request rather than trusted
// from the JWT, same reasoning as requireSuperAdmin.
router.use(asyncHandler(async (req, res, next) => {
  const me = await User.findById(req.user.id).select('is_super_admin').lean();
  req.isSuperAdmin = !!(me && me.is_super_admin);
  next();
}));

const oid = (id) => new mongoose.Types.ObjectId(id);

// Ids of every super admin account — sub-admins can see exams created by any of these (i.e.
// the main admin's exams) plus their own, but not other sub-admins' exams.
async function getSuperAdminIds() {
  const admins = await User.find({ role: 'admin', is_super_admin: true }).select('_id').lean();
  return admins.map((a) => a._id.toString());
}

// ---------- Students ----------

router.get('/students', asyncHandler(async (req, res) => {
  // Sub-admins only ever see the students the main admin has handed to them; the main admin
  // sees everyone.
  const filter = { role: 'student' };
  if (!req.isSuperAdmin) filter.managing_admin = req.user.id;

  const students = await User.find(filter).sort({ created_at: -1 }).lean();
  res.json(students.map((s) => ({
    id: s._id.toString(),
    username: s.username,
    full_name: s.full_name,
    section: s.section || '',
    managing_admin: s.managing_admin ? s.managing_admin.toString() : null,
    must_change_password: !!s.must_change_password,
    created_at: s.created_at
  })));
}));

// Creating, bulk-importing, and removing student accounts is a main-admin-only action — a
// sub-admin's students must come from the main admin (see /students/:id/manager below), not be
// self-created.
router.post('/students', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { username, password, full_name, section } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const existing = await User.findOne({ username });
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const user = await User.create({
    username,
    password_hash: hash,
    role: 'student',
    full_name: full_name || username,
    section: (section || '').trim()
  });
  res.status(201).json({ id: user._id.toString(), username: user.username, full_name: user.full_name, section: user.section });
}));

// Bulk-create students from a CSV the admin uploaded. The file itself is parsed in the
// browser (public/js/admin.js) and posted here as plain rows — keeps the server simple and
// avoids adding a multipart-upload dependency for what's ultimately just short text rows.
router.post('/students/import', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { students } = req.body;
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: 'No rows to import' });
  }
  if (students.length > 2000) {
    return res.status(400).json({ error: 'Too many rows in one import (max 2000)' });
  }

  const results = { created: [], skipped: [], errors: [] };

  for (let i = 0; i < students.length; i++) {
    const row = students[i] || {};
    const rowNum = i + 2; // +1 for 0-index, +1 for the header row
    const username = (row.username || '').trim();
    const password = (row.password || '').toString();
    const full_name = (row.full_name || '').trim() || username;
    const section = (row.section || '').trim();

    if (!username || !password) {
      results.errors.push({ row: rowNum, username, error: 'Missing username or password' });
      continue;
    }
    if (password.length < 4) {
      results.errors.push({ row: rowNum, username, error: 'Password too short (min 4 characters)' });
      continue;
    }

    try {
      const existing = await User.findOne({ username });
      if (existing) {
        results.skipped.push({ row: rowNum, username, reason: 'Username already exists' });
        continue;
      }
      const hash = bcrypt.hashSync(password, 10);
      const user = await User.create({
        username,
        password_hash: hash,
        role: 'student',
        full_name,
        section,
        must_change_password: true
      });
      results.created.push({ row: rowNum, username, id: user._id.toString() });
    } catch (e) {
      results.errors.push({ row: rowNum, username, error: e.message });
    }
  }

  res.json(results);
}));

// Set/change a student's class/section — mainly for students who were created (or imported)
// before this field existed, or moved to a different section afterward. A sub-admin can only
// touch students already managed by them.
router.put('/students/:id/section', asyncHandler(async (req, res) => {
  const section = (req.body.section || '').trim();
  const filter = { _id: req.params.id, role: 'student' };
  if (!req.isSuperAdmin) filter.managing_admin = req.user.id;
  const result = await User.updateOne(filter, { $set: { section } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, section });
}));

// Force a student to set a new password next time they log in — for a compromised or
// forgotten password, not just freshly-imported accounts. Same ownership scoping as above.
// Note: this alone doesn't help a student who has actually forgotten their password, since
// logging in at all still requires the *current* password — see reset-password below for that.
router.post('/students/:id/force-password-change', asyncHandler(async (req, res) => {
  const filter = { _id: req.params.id, role: 'student' };
  if (!req.isSuperAdmin) filter.managing_admin = req.user.id;
  const result = await User.updateOne(filter, { $set: { must_change_password: true } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

// Reset a student's password to a known default and force them to change it on next login —
// for an actually forgotten/locked-out password, where force-password-change above can't help
// since it still requires knowing the current password to log in at all. Same ownership scoping.
const DEFAULT_RESET_PASSWORD = 'Welcome@123';
router.post('/students/:id/reset-password', asyncHandler(async (req, res) => {
  const filter = { _id: req.params.id, role: 'student' };
  if (!req.isSuperAdmin) filter.managing_admin = req.user.id;
  const hash = bcrypt.hashSync(DEFAULT_RESET_PASSWORD, 10);
  const result = await User.updateOne(filter, { $set: { password_hash: hash, must_change_password: true } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, default_password: DEFAULT_RESET_PASSWORD });
}));

// Removing student accounts is main-admin-only, same reasoning as create/import above.
router.delete('/students/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const id = req.params.id;
  const assignments = await ExamAssignment.find({ student: id }).select('_id').lean();
  const assignmentIds = assignments.map((a) => a._id);
  await Violation.deleteMany({ assignment: { $in: assignmentIds } });
  await ExamAssignment.deleteMany({ student: id });
  await User.deleteOne({ _id: id, role: 'student' });
  res.json({ ok: true });
}));

// Bulk remove students at once — e.g. clearing out a whole class, or every student, at the end
// of a term. Same cascade as the single-student delete above, just batched. The set of ids to
// remove is decided client-side (respecting whatever class filter is active there), not here.
router.post('/students/bulk-delete', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { student_ids } = req.body;
  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return res.status(400).json({ error: 'student_ids array required' });
  }
  const assignments = await ExamAssignment.find({ student: { $in: student_ids } }).select('_id').lean();
  const assignmentIds = assignments.map((a) => a._id);
  await Violation.deleteMany({ assignment: { $in: assignmentIds } });
  await ExamAssignment.deleteMany({ student: { $in: student_ids } });
  const result = await User.deleteMany({ _id: { $in: student_ids }, role: 'student' });
  res.json({ ok: true, deleted: result.deletedCount });
}));

// Assigns (or unassigns, with a null/empty admin_id) which sub-admin manages a student — this is
// the main admin's way of handing students to a sub-admin. Main-admin-only.
router.put('/students/:id/manager', requireSuperAdmin, asyncHandler(async (req, res) => {
  const adminId = (req.body.admin_id || '').trim();
  let managing_admin = null;
  if (adminId) {
    const adminUser = await User.findOne({ _id: adminId, role: 'admin', admin_status: 'approved' }).select('_id').lean();
    if (!adminUser) return res.status(400).json({ error: 'Invalid admin_id' });
    managing_admin = adminId;
  }
  const result = await User.updateOne({ _id: req.params.id, role: 'student' }, { $set: { managing_admin } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, managing_admin });
}));

// Bulk version of the above — e.g. hand a whole (filtered) class over to a sub-admin in one go.
router.post('/students/bulk-assign-manager', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { student_ids, admin_id } = req.body;
  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return res.status(400).json({ error: 'student_ids array required' });
  }
  let managing_admin = null;
  if (admin_id) {
    const adminUser = await User.findOne({ _id: admin_id, role: 'admin', admin_status: 'approved' }).select('_id').lean();
    if (!adminUser) return res.status(400).json({ error: 'Invalid admin_id' });
    managing_admin = admin_id;
  }
  const result = await User.updateMany({ _id: { $in: student_ids }, role: 'student' }, { $set: { managing_admin } });
  res.json({ ok: true, updated: result.modifiedCount });
}));

// ---------- Admin accounts (main/super admin only) ----------

// Every admin account (approved sub-admins, pending signup requests, and rejected ones), for
// the "Admin Requests" screen.
router.get('/admins', requireSuperAdmin, asyncHandler(async (req, res) => {
  const admins = await User.find({ role: 'admin' }).sort({ created_at: -1 }).lean();
  res.json(admins.map((a) => ({
    id: a._id.toString(),
    username: a.username,
    full_name: a.full_name,
    is_super_admin: !!a.is_super_admin,
    admin_status: a.admin_status || 'approved',
    created_at: a.created_at
  })));
}));

router.post('/admins/:id/approve', requireSuperAdmin, asyncHandler(async (req, res) => {
  const result = await User.updateOne({ _id: req.params.id, role: 'admin' }, { $set: { admin_status: 'approved' } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

router.post('/admins/:id/reject', requireSuperAdmin, asyncHandler(async (req, res) => {
  const result = await User.updateOne({ _id: req.params.id, role: 'admin' }, { $set: { admin_status: 'rejected' } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

// Removes a sub-admin account entirely (e.g. someone who's left, or was rejected and doesn't
// need to stay on the list). Their managed students are unassigned, not deleted, so the main
// admin can hand them to someone else. The main admin account itself can never be removed here.
router.delete('/admins/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const target = await User.findOne({ _id: req.params.id, role: 'admin' });
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.is_super_admin) return res.status(400).json({ error: 'Cannot remove the main admin' });
  await User.updateMany({ managing_admin: target._id }, { $set: { managing_admin: null } });
  await User.deleteOne({ _id: target._id });
  res.json({ ok: true });
}));

// ---------- Exams ----------

router.get('/exams', asyncHandler(async (req, res) => {
  // A sub-admin can assign the main admin's exams or their own, but not another sub-admin's —
  // see the "assign test created by main admin or create test" rule this whole feature is for.
  let filter = {};
  if (!req.isSuperAdmin) {
    const superIds = await getSuperAdminIds();
    filter = { $or: [{ created_by: { $in: superIds } }, { created_by: req.user.id }] };
  }
  const exams = await Exam.find(filter).sort({ created_at: -1 }).lean();
  res.json(exams.map((e) => ({
    id: e._id.toString(),
    title: e.title,
    instructions: e.instructions,
    starter_code: e.starter_code,
    time_limit_minutes: e.time_limit_minutes,
    violation_limit: e.violation_limit,
    proctoring_enabled: e.proctoring_enabled !== false,
    multi_file_enabled: !!e.multi_file_enabled,
    checks: e.checks || [],
    created_by: e.created_by ? e.created_by.toString() : null,
    created_at: e.created_at
  })));
}));

// A check is only kept if it has a label, a valid type, and whatever field that type actually
// needs — silently drops anything malformed rather than rejecting the whole exam creation over
// one bad row in the admin's checks UI.
function sanitizeChecks(rawChecks) {
  if (!Array.isArray(rawChecks)) return [];
  const allowedTypes = ['selector_exists', 'text_contains', 'html_contains'];
  return rawChecks
    .filter((c) => c && typeof c === 'object' && c.label && allowedTypes.includes(c.type))
    .map((c) => ({
      label: String(c.label).slice(0, 200),
      type: c.type,
      selector: c.type === 'selector_exists' ? String(c.selector || '').slice(0, 300) : '',
      min_count: c.type === 'selector_exists' ? Math.max(1, parseInt(c.min_count, 10) || 1) : 1,
      text: c.type === 'text_contains' ? String(c.text || '').slice(0, 500) : '',
      case_sensitive: c.type === 'text_contains' ? !!c.case_sensitive : false,
      pattern: c.type === 'html_contains' ? String(c.pattern || '').slice(0, 500) : ''
    }))
    .filter((c) => (c.type === 'selector_exists' && c.selector) || (c.type === 'text_contains' && c.text) || (c.type === 'html_contains' && c.pattern));
}

router.post('/exams', asyncHandler(async (req, res) => {
  const { title, instructions, starter_code, time_limit_minutes, violation_limit, proctoring_enabled, multi_file_enabled, checks } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const doc = {
    title,
    instructions: instructions || '',
    time_limit_minutes: time_limit_minutes || 60,
    // 0 is a deliberate "no limit — never auto-lock" value from the admin UI, distinct from
    // "not provided" (undefined/null), which should still fall back to the default of 5.
    violation_limit: violation_limit === 0 ? 0 : (violation_limit || 5),
    proctoring_enabled: proctoring_enabled !== false,
    multi_file_enabled: !!multi_file_enabled,
    checks: sanitizeChecks(checks),
    created_by: req.user.id
  };
  if (starter_code) doc.starter_code = starter_code;

  const exam = await Exam.create(doc);
  res.status(201).json({ id: exam._id.toString() });
}));

// Update an exam's checks (e.g. after seeing real submissions come in and wanting to adjust).
// A sub-admin may only edit an exam they created themselves, not the main admin's or another
// sub-admin's.
router.put('/exams/:id/checks', asyncHandler(async (req, res) => {
  const checks = sanitizeChecks(req.body.checks);
  const filter = { _id: req.params.id };
  if (!req.isSuperAdmin) filter.created_by = req.user.id;
  const result = await Exam.updateOne(filter, { $set: { checks } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found, or you do not have permission to edit this exam' });
  res.json({ ok: true, checks });
}));

// Full edit of a previously created exam. Existing assignments aren't touched — a student who
// already started keeps their in-progress code as-is (starter_code is only ever used to seed a
// still-empty assignment, see student.js), and checks changes simply apply the next time a
// submission is (re-)graded. Same ownership rule as the checks-only update above.
router.put('/exams/:id', asyncHandler(async (req, res) => {
  const { title, instructions, starter_code, time_limit_minutes, violation_limit, proctoring_enabled, multi_file_enabled, checks } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const update = {
    title,
    instructions: instructions || '',
    starter_code: starter_code || '',
    time_limit_minutes: time_limit_minutes || 60,
    violation_limit: violation_limit === 0 ? 0 : (violation_limit || 5),
    proctoring_enabled: proctoring_enabled !== false,
    multi_file_enabled: !!multi_file_enabled,
    checks: sanitizeChecks(checks)
  };

  const filter = { _id: req.params.id };
  if (!req.isSuperAdmin) filter.created_by = req.user.id;
  const result = await Exam.updateOne(filter, { $set: update });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found, or you do not have permission to edit this exam' });
  res.json({ ok: true });
}));

router.delete('/exams/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const filter = { _id: id };
  if (!req.isSuperAdmin) filter.created_by = req.user.id;
  const exam = await Exam.findOne(filter).select('_id').lean();
  if (!exam) return res.status(404).json({ error: 'Not found, or you do not have permission to delete this exam' });

  const assignments = await ExamAssignment.find({ exam: id }).select('_id').lean();
  const assignmentIds = assignments.map((a) => a._id);
  await Violation.deleteMany({ assignment: { $in: assignmentIds } });
  await ExamAssignment.deleteMany({ exam: id });
  await Exam.deleteOne({ _id: id });
  res.json({ ok: true });
}));

// Assign an exam to one or more students. A sub-admin can only assign to students the main
// admin has handed to them, and can only assign exams they're allowed to see (the main admin's,
// or their own) — both enforced here even though the UI already only offers valid choices, since
// this endpoint could otherwise be called directly with arbitrary ids.
router.post('/exams/:id/assign', asyncHandler(async (req, res) => {
  const examId = req.params.id;
  const { student_ids } = req.body;
  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return res.status(400).json({ error: 'student_ids array required' });
  }

  let allowedIds = student_ids;
  if (!req.isSuperAdmin) {
    const superIds = await getSuperAdminIds();
    const exam = await Exam.findById(examId).select('created_by').lean();
    if (!exam) return res.status(404).json({ error: 'Exam not found' });
    const creatorId = exam.created_by ? exam.created_by.toString() : null;
    if (creatorId !== req.user.id && !superIds.includes(creatorId)) {
      return res.status(403).json({ error: 'You do not have permission to assign this exam' });
    }

    const managed = await User.find({ _id: { $in: student_ids }, role: 'student', managing_admin: req.user.id })
      .select('_id').lean();
    allowedIds = managed.map((s) => s._id.toString());
    if (allowedIds.length === 0) {
      return res.status(403).json({ error: 'None of the selected students are assigned to you' });
    }
  }

  for (const sid of allowedIds) {
    await ExamAssignment.updateOne(
      { exam: examId, student: sid },
      { $setOnInsert: { exam: examId, student: sid, status: 'not_started', code: '' } },
      { upsert: true }
    );
  }
  res.json({ ok: true, assigned: allowedIds.length, skipped: student_ids.length - allowedIds.length });
}));

router.get('/exams/:id/assignments', asyncHandler(async (req, res) => {
  const examId = req.params.id;
  const assignments = await ExamAssignment.find({ exam: examId }).populate('student', 'username full_name managing_admin').lean();

  const counts = await Violation.aggregate([
    { $match: { exam: oid(examId) } },
    { $group: { _id: '$assignment', count: { $sum: 1 } } }
  ]);
  const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));

  const rows = assignments
    .filter((a) => a.student) // guard against orphaned refs
    // A sub-admin only monitors their own students' submissions, even for an exam that's
    // shared/visible more broadly.
    .filter((a) => req.isSuperAdmin || (a.student.managing_admin && a.student.managing_admin.toString() === req.user.id))
    .map((a) => ({
      id: a._id.toString(),
      exam_id: a.exam.toString(),
      student_id: a.student._id.toString(),
      username: a.student.username,
      full_name: a.student.full_name,
      status: a.status,
      started_at: a.started_at,
      submitted_at: a.submitted_at,
      last_seen_at: a.last_seen_at,
      violation_count: countMap.get(a._id.toString()) || 0,
      score: typeof a.score === 'number' ? a.score : null
    }))
    .sort((x, y) => (x.full_name || '').localeCompare(y.full_name || ''));

  res.json(rows);
}));

// ---------- Live monitor ----------

router.get('/monitor', asyncHandler(async (req, res) => {
  const assignments = await ExamAssignment.find({ status: { $in: ['in_progress', 'locked'] } })
    .populate('student', 'username full_name managing_admin')
    .populate('exam', 'title violation_limit')
    .lean();

  const ids = assignments.map((a) => a._id);
  const counts = await Violation.aggregate([
    { $match: { assignment: { $in: ids } } },
    { $group: { _id: '$assignment', count: { $sum: 1 } } }
  ]);
  const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));

  const rows = assignments
    .filter((a) => a.student && a.exam)
    // Same scoping as the submissions list: a sub-admin's Live Monitor only shows their own
    // students, not every exam session in progress.
    .filter((a) => req.isSuperAdmin || (a.student.managing_admin && a.student.managing_admin.toString() === req.user.id))
    .map((a) => ({
      assignment_id: a._id.toString(),
      status: a.status,
      started_at: a.started_at,
      submitted_at: a.submitted_at,
      last_seen_at: a.last_seen_at,
      student_id: a.student._id.toString(),
      username: a.student.username,
      full_name: a.student.full_name,
      exam_id: a.exam._id.toString(),
      exam_title: a.exam.title,
      // The per-student override (if set) is what's actually enforced — show that instead of the
      // exam's default so the ratio in Live Monitor matches what will really happen.
      violation_limit: (a.violation_limit_override !== null && a.violation_limit_override !== undefined)
        ? a.violation_limit_override
        : a.exam.violation_limit,
      violation_count: countMap.get(a._id.toString()) || 0,
      score: typeof a.score === 'number' ? a.score : null
    }))
    .sort((x, y) => (y.violation_count - x.violation_count) || String(y.last_seen_at).localeCompare(String(x.last_seen_at)));

  res.json(rows);
}));

// Shared by the detail/unlock/continue/run-tests routes below: loads the assignment with its
// student populated, and enforces that a sub-admin can only touch assignments belonging to
// their own managed students. Returns null (after sending a response) if access should be
// denied, so callers can just `if (!a) return;`.
async function loadOwnedAssignment(req, res, populate) {
  const a = await ExamAssignment.findById(req.params.id).populate('student', populate ? `username full_name managing_admin ${populate}` : 'username full_name managing_admin');
  if (!a || !a.student) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (!req.isSuperAdmin && (!a.student.managing_admin || a.student.managing_admin.toString() !== req.user.id)) {
    res.status(403).json({ error: 'This student is not assigned to you' });
    return null;
  }
  return a;
}

router.get('/assignments/:id', asyncHandler(async (req, res) => {
  const a = await ExamAssignment.findById(req.params.id)
    .populate('student', 'username full_name managing_admin')
    .populate('exam', 'title instructions violation_limit checks')
    .lean();
  if (!a || !a.student || !a.exam) return res.status(404).json({ error: 'Not found' });
  if (!req.isSuperAdmin && (!a.student.managing_admin || a.student.managing_admin.toString() !== req.user.id)) {
    return res.status(403).json({ error: 'This student is not assigned to you' });
  }

  const violations = await Violation.find({ assignment: a._id }).sort({ created_at: -1 }).lean();
  const fileMap = {};
  (a.files || []).forEach((f) => { fileMap[f.name] = f.content; });

  res.json({
    assignment: {
      id: a._id.toString(),
      exam_id: a.exam._id.toString(),
      student_id: a.student._id.toString(),
      status: a.status,
      started_at: a.started_at,
      submitted_at: a.submitted_at,
      last_seen_at: a.last_seen_at,
      username: a.student.username,
      full_name: a.student.full_name,
      exam_title: a.exam.title,
      instructions: a.exam.instructions,
      violation_limit: a.exam.violation_limit,
      violation_limit_override: a.violation_limit_override,
      checks: a.exam.checks || []
    },
    code: a.code || '',
    files: fileMap,
    test_results: a.test_results || [],
    score: typeof a.score === 'number' ? a.score : null,
    violations: violations.map((v) => ({
      id: v._id.toString(),
      type: v.type,
      detail: v.detail,
      created_at: v.created_at
    }))
  });
}));

router.post('/assignments/:id/unlock', asyncHandler(async (req, res) => {
  const a = await loadOwnedAssignment(req, res);
  if (!a) return;
  await ExamAssignment.updateOne({ _id: a._id }, { $set: { status: 'in_progress' } });
  res.json({ ok: true });
}));

// Unlock a set of assignments picked by checkbox in Live Monitor (across any exam/student), in
// one action. Silently skips anything not actually locked, or not owned by this admin — the UI
// only offers valid choices, but this is re-checked here in case the endpoint is called directly.
router.post('/assignments/unlock-bulk', asyncHandler(async (req, res) => {
  const { assignment_ids } = req.body;
  if (!Array.isArray(assignment_ids) || assignment_ids.length === 0) {
    return res.status(400).json({ error: 'assignment_ids array required' });
  }
  const candidates = await ExamAssignment.find({ _id: { $in: assignment_ids }, status: 'locked' })
    .populate('student', 'managing_admin')
    .lean();
  const targetIds = candidates
    .filter((a) => a.student && (req.isSuperAdmin || (a.student.managing_admin && a.student.managing_admin.toString() === req.user.id)))
    .map((a) => a._id);
  if (targetIds.length === 0) return res.json({ ok: true, unlocked: 0 });
  await ExamAssignment.updateMany({ _id: { $in: targetIds } }, { $set: { status: 'in_progress' } });
  res.json({ ok: true, unlocked: targetIds.length });
}));

// Unlock every currently-locked assignment for one exam in a single action, instead of opening
// each student's detail view individually. Same ownership scoping as everything else here: a
// sub-admin only affects their own managed students, even if other students are locked too.
router.post('/exams/:id/unlock-all', asyncHandler(async (req, res) => {
  const examId = req.params.id;
  const locked = await ExamAssignment.find({ exam: examId, status: 'locked' }).populate('student', 'managing_admin').lean();
  const targetIds = locked
    .filter((a) => a.student && (req.isSuperAdmin || (a.student.managing_admin && a.student.managing_admin.toString() === req.user.id)))
    .map((a) => a._id);
  if (targetIds.length === 0) return res.json({ ok: true, unlocked: 0 });
  await ExamAssignment.updateMany({ _id: { $in: targetIds } }, { $set: { status: 'in_progress' } });
  res.json({ ok: true, unlocked: targetIds.length });
}));

// Per-student override of how many violations this one student can rack up before auto-lock —
// takes precedence over the exam's own violation_limit. Pass null to clear the override and go
// back to the exam's default, or 0 to mean "never auto-lock this student", or any positive
// number for a custom limit just for them.
router.put('/assignments/:id/violation-limit', asyncHandler(async (req, res) => {
  const a = await loadOwnedAssignment(req, res);
  if (!a) return;
  let { violation_limit_override } = req.body;
  if (violation_limit_override !== null && violation_limit_override !== undefined) {
    violation_limit_override = parseInt(violation_limit_override, 10);
    if (Number.isNaN(violation_limit_override) || violation_limit_override < 0) {
      return res.status(400).json({ error: 'violation_limit_override must be null, 0, or a positive number' });
    }
  } else {
    violation_limit_override = null;
  }
  await ExamAssignment.updateOne({ _id: a._id }, { $set: { violation_limit_override } });
  res.json({ ok: true, violation_limit_override });
}));

// Reopen an already-submitted exam so the student can keep working — e.g. they submitted early
// by mistake, or ran out of time unfairly. Resets started_at to now so they get a fresh full
// time limit rather than immediately hitting an already-expired one; their existing code and
// any prior test results/score are left as-is until they submit again.
router.post('/assignments/:id/continue', asyncHandler(async (req, res) => {
  const a = await loadOwnedAssignment(req, res);
  if (!a) return;
  const result = await ExamAssignment.updateOne(
    { _id: a._id, status: 'submitted' },
    { $set: { status: 'in_progress', started_at: new Date() }, $unset: { submitted_at: '' } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found, or not currently submitted' });
  res.json({ ok: true });
}));

// Re-run auto-grading on demand — useful after editing an exam's checks, or for a submission
// made before checks existed.
router.post('/assignments/:id/run-tests', asyncHandler(async (req, res) => {
  const a = await loadOwnedAssignment(req, res);
  if (!a) return;
  const assignment = await ExamAssignment.findById(a._id).populate('exam', 'checks');
  if (!assignment || !assignment.exam) return res.status(404).json({ error: 'Not found' });

  const { results, score } = runChecks(assignment.code, assignment.exam.checks || []);
  assignment.test_results = results;
  assignment.score = score;
  await assignment.save();

  res.json({ ok: true, test_results: results, score });
}));

// ---------- Student feedback ----------

// Which categories are currently open to students. Any admin can read this; only the main admin
// can change it (the setting is global, shared by every admin's students).
router.get('/feedback/settings', asyncHandler(async (req, res) => {
  res.json(await getFeedbackSettings());
}));

router.put('/feedback/settings', requireSuperAdmin, asyncHandler(async (req, res) => {
  const update = {};
  FEEDBACK_CATEGORIES.forEach((c) => {
    if (typeof req.body[c] === 'boolean') update[`${c}_enabled`] = req.body[c];
  });
  if (Object.keys(update).length) {
    await FeedbackSettings.updateOne({ key: 'feedback' }, { $set: update }, { upsert: true });
  }
  res.json(await getFeedbackSettings());
}));

// Submitted feedback, newest first. Feedback is anonymous — there is no student name or id in it
// to show. The main admin sees everything; a sub-admin sees feedback from their own group of
// students only. Optional ?category=software|theory|practical.
router.get('/feedback', asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.category) {
    if (!FEEDBACK_CATEGORIES.includes(req.query.category)) return res.status(400).json({ error: 'Invalid category' });
    filter.category = req.query.category;
  }
  if (!req.isSuperAdmin) filter.managing_admin = req.user.id;
  const items = await Feedback.find(filter).sort({ created_at: -1 }).limit(2000).lean();
  res.json(items.map((f) => ({
    id: f._id.toString(),
    category: f.category,
    rating: f.rating,
    comments: f.comments || '',
    date: f.created_at ? new Date(f.created_at).toISOString().slice(0, 10) : ''
  })));
}));


// ---------- Student presence (Live Monitor: active / idle / offline) ----------

const OFFLINE_AFTER_MS = 90 * 1000; // students ping every ~30s; 3 missed pings = offline

// Every student who has at least one exam assigned ("allotted") with their current presence:
//   active  - pinged recently and used the page within the idle window
//   idle    - pinged recently, but no mouse/keyboard/touch activity for `idle` seconds
//   offline - no ping for 90s (closed the tab / logged out / lost connection)
// ?idle=<seconds> lets the admin choose the idle window (default 120, clamped 30s..1h).
router.get('/presence', asyncHandler(async (req, res) => {
  let idleSec = parseInt(req.query.idle, 10);
  if (Number.isNaN(idleSec)) idleSec = 120;
  idleSec = Math.min(3600, Math.max(30, idleSec));

  const assigned = await ExamAssignment.distinct('student');
  const filter = { role: 'student', _id: { $in: assigned } };
  if (!req.isSuperAdmin) filter.managing_admin = req.user.id;
  const students = await User.find(filter).select('username full_name section last_seen_at last_active_at').lean();

  const live = await ExamAssignment.find({ student: { $in: students.map((x) => x._id) }, status: 'in_progress' })
    .populate('exam', 'title').lean();
  const examOf = new Map();
  live.forEach((a) => { if (a.exam) examOf.set(a.student.toString(), a.exam.title); });

  const now = Date.now();
  const rows = students.map((st) => {
    const seen = st.last_seen_at ? new Date(st.last_seen_at).getTime() : 0;
    const act = st.last_active_at ? new Date(st.last_active_at).getTime() : 0;
    let status = 'offline';
    if (seen && now - seen <= OFFLINE_AFTER_MS) status = (act && now - act <= idleSec * 1000) ? 'active' : 'idle';
    return {
      id: st._id.toString(),
      username: st.username,
      full_name: st.full_name,
      section: st.section || '',
      status,
      last_seen_at: st.last_seen_at || null,
      last_active_at: st.last_active_at || null,
      exam_title: examOf.get(st._id.toString()) || ''
    };
  }).sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));

  const counts = { active: 0, idle: 0, offline: 0 };
  rows.forEach((r) => { counts[r.status] += 1; });
  res.json({ idle_after_seconds: idleSec, counts, students: rows });
}));

// ---------- Challenges ----------

// Full challenge list including answer keys (admin eyes only), with how many students solved each.
router.get('/challenges', asyncHandler(async (req, res) => {
  const list = await Challenge.find({}).sort({ order_no: 1, _id: 1 }).lean();
  const solved = await ChallengeProgress.aggregate([
    { $match: { completed: true } },
    { $group: { _id: '$challenge', n: { $sum: 1 } } }
  ]);
  const solvedMap = new Map(solved.map((x) => [x._id.toString(), x.n]));
  res.json(list.map((c) => ({
    id: c._id.toString(), title: c.title, topic: c.topic, type: c.type, difficulty: c.difficulty,
    points: c.points, prompt: c.prompt, code: c.code, data: c.data, explanation: c.explanation,
    active: c.active !== false, order_no: c.order_no || 0, solved_by: solvedMap.get(c._id.toString()) || 0
  })));
}));

router.post('/challenges', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { doc, error } = sanitizeChallenge(req.body);
  if (error) return res.status(400).json({ error });
  doc.created_by = req.user.id;
  const created = await Challenge.create(doc);
  res.status(201).json({ id: created._id.toString() });
}));

router.put('/challenges/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { doc, error } = sanitizeChallenge(req.body);
  if (error) return res.status(400).json({ error });
  const r = await Challenge.updateOne({ _id: req.params.id }, { $set: doc });
  if (!r.matchedCount && !r.n) return res.status(404).json({ error: 'Challenge not found' });
  res.json({ ok: true });
}));

// Quick on/off without opening the editor.
router.put('/challenges/:id/active', requireSuperAdmin, asyncHandler(async (req, res) => {
  const r = await Challenge.updateOne({ _id: req.params.id }, { $set: { active: !!req.body.active } });
  if (!r.matchedCount && !r.n) return res.status(404).json({ error: 'Challenge not found' });
  res.json({ ok: true });
}));

router.delete('/challenges/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  await ChallengeProgress.deleteMany({ challenge: req.params.id });
  await Challenge.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

// Loads the built-in lab-manual challenge bank. Existing titles are skipped, so running it twice
// (or after editing some) never duplicates or overwrites anything.
router.post('/challenges/seed-starter', requireSuperAdmin, asyncHandler(async (req, res) => {
  const existing = new Set((await Challenge.find({}).select('title').lean()).map((c) => c.title));
  const last = await Challenge.findOne({}).sort({ order_no: -1 }).select('order_no').lean();
  let order = last && last.order_no ? last.order_no : 0;
  let added = 0;
  let skipped = 0;
  for (const raw of starterChallenges) {
    if (existing.has(raw.title)) { skipped += 1; continue; }
    const { doc, error } = sanitizeChallenge(raw);
    if (error) { skipped += 1; continue; }
    order += 1;
    doc.order_no = order;
    doc.created_by = req.user.id;
    await Challenge.create(doc);
    added += 1;
  }
  res.json({ ok: true, added, skipped });
}));

// Points per student (only the students this admin may see), highest first.
router.get('/challenges/points', asyncHandler(async (req, res) => {
  const filter = { role: 'student' };
  if (!req.isSuperAdmin) filter.managing_admin = req.user.id;
  const students = await User.find(filter).select('username full_name section').lean();
  const ids = students.map((x) => x._id);
  const totals = await ChallengeProgress.aggregate([
    { $match: { student: { $in: ids }, completed: true } },
    { $group: { _id: '$student', pts: { $sum: '$points' }, done: { $sum: 1 }, last: { $max: '$completed_at' } } }
  ]);
  const map = new Map(totals.map((t) => [t._id.toString(), t]));
  const totalChallenges = await Challenge.countDocuments({ active: true });
  const rows = students.map((st) => {
    const t = map.get(st._id.toString());
    return {
      id: st._id.toString(), username: st.username, full_name: st.full_name, section: st.section || '',
      points: t ? t.pts : 0, completed: t ? t.done : 0, last_completed_at: t ? t.last : null
    };
  }).sort((a, b) => (b.points - a.points) || String(a.full_name).localeCompare(String(b.full_name)));
  let rank = 0; let prev = null;
  rows.forEach((r, i) => { if (r.points !== prev) { rank = i + 1; prev = r.points; } r.rank = r.points > 0 ? rank : null; });
  res.json({ total_challenges: totalChallenges, students: rows });
}));

module.exports = router;
