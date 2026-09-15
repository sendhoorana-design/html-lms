const express = require('express');
const bcrypt = require('bcryptjs');
const { mongoose } = require('../db');
const User = require('../models/User');
const Exam = require('../models/Exam');
const ExamAssignment = require('../models/ExamAssignment');
const Violation = require('../models/Violation');
const { authRequired, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { runChecks } = require('../utils/grader');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

const oid = (id) => new mongoose.Types.ObjectId(id);

// ---------- Students ----------

router.get('/students', asyncHandler(async (req, res) => {
  const students = await User.find({ role: 'student' }).sort({ created_at: -1 }).lean();
  res.json(students.map((s) => ({
    id: s._id.toString(),
    username: s.username,
    full_name: s.full_name,
    section: s.section || '',
    must_change_password: !!s.must_change_password,
    created_at: s.created_at
  })));
}));

router.post('/students', asyncHandler(async (req, res) => {
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
router.post('/students/import', asyncHandler(async (req, res) => {
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
// before this field existed, or moved to a different section afterward.
router.put('/students/:id/section', asyncHandler(async (req, res) => {
  const section = (req.body.section || '').trim();
  const result = await User.updateOne({ _id: req.params.id, role: 'student' }, { $set: { section } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, section });
}));

// Force a student to set a new password next time they log in — for a compromised or
// forgotten password, not just freshly-imported accounts.
router.post('/students/:id/force-password-change', asyncHandler(async (req, res) => {
  const result = await User.updateOne(
    { _id: req.params.id, role: 'student' },
    { $set: { must_change_password: true } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

router.delete('/students/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const assignments = await ExamAssignment.find({ student: id }).select('_id').lean();
  const assignmentIds = assignments.map((a) => a._id);
  await Violation.deleteMany({ assignment: { $in: assignmentIds } });
  await ExamAssignment.deleteMany({ student: id });
  await User.deleteOne({ _id: id, role: 'student' });
  res.json({ ok: true });
}));

// ---------- Exams ----------

router.get('/exams', asyncHandler(async (req, res) => {
  const exams = await Exam.find().sort({ created_at: -1 }).lean();
  res.json(exams.map((e) => ({
    id: e._id.toString(),
    title: e.title,
    instructions: e.instructions,
    starter_code: e.starter_code,
    time_limit_minutes: e.time_limit_minutes,
    violation_limit: e.violation_limit,
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
  const { title, instructions, starter_code, time_limit_minutes, violation_limit, checks } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const doc = {
    title,
    instructions: instructions || '',
    time_limit_minutes: time_limit_minutes || 60,
    violation_limit: violation_limit || 5,
    checks: sanitizeChecks(checks),
    created_by: req.user.id
  };
  if (starter_code) doc.starter_code = starter_code;

  const exam = await Exam.create(doc);
  res.status(201).json({ id: exam._id.toString() });
}));

// Update an exam's checks (e.g. after seeing real submissions come in and wanting to adjust).
router.put('/exams/:id/checks', asyncHandler(async (req, res) => {
  const checks = sanitizeChecks(req.body.checks);
  const result = await Exam.updateOne({ _id: req.params.id }, { $set: { checks } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, checks });
}));

// Full edit of a previously created exam. Existing assignments aren't touched — a student who
// already started keeps their in-progress code as-is (starter_code is only ever used to seed a
// still-empty assignment, see student.js), and checks changes simply apply the next time a
// submission is (re-)graded.
router.put('/exams/:id', asyncHandler(async (req, res) => {
  const { title, instructions, starter_code, time_limit_minutes, violation_limit, checks } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const update = {
    title,
    instructions: instructions || '',
    starter_code: starter_code || '',
    time_limit_minutes: time_limit_minutes || 60,
    violation_limit: violation_limit || 5,
    checks: sanitizeChecks(checks)
  };

  const result = await Exam.updateOne({ _id: req.params.id }, { $set: update });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

router.delete('/exams/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const assignments = await ExamAssignment.find({ exam: id }).select('_id').lean();
  const assignmentIds = assignments.map((a) => a._id);
  await Violation.deleteMany({ assignment: { $in: assignmentIds } });
  await ExamAssignment.deleteMany({ exam: id });
  await Exam.deleteOne({ _id: id });
  res.json({ ok: true });
}));

// Assign an exam to one or more students
router.post('/exams/:id/assign', asyncHandler(async (req, res) => {
  const examId = req.params.id;
  const { student_ids } = req.body;
  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return res.status(400).json({ error: 'student_ids array required' });
  }
  for (const sid of student_ids) {
    await ExamAssignment.updateOne(
      { exam: examId, student: sid },
      { $setOnInsert: { exam: examId, student: sid, status: 'not_started', code: '' } },
      { upsert: true }
    );
  }
  res.json({ ok: true });
}));

router.get('/exams/:id/assignments', asyncHandler(async (req, res) => {
  const examId = req.params.id;
  const assignments = await ExamAssignment.find({ exam: examId }).populate('student', 'username full_name').lean();

  const counts = await Violation.aggregate([
    { $match: { exam: oid(examId) } },
    { $group: { _id: '$assignment', count: { $sum: 1 } } }
  ]);
  const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));

  const rows = assignments
    .filter((a) => a.student) // guard against orphaned refs
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
    .populate('student', 'username full_name')
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
      violation_limit: a.exam.violation_limit,
      violation_count: countMap.get(a._id.toString()) || 0,
      score: typeof a.score === 'number' ? a.score : null
    }))
    .sort((x, y) => (y.violation_count - x.violation_count) || String(y.last_seen_at).localeCompare(String(x.last_seen_at)));

  res.json(rows);
}));

router.get('/assignments/:id', asyncHandler(async (req, res) => {
  const a = await ExamAssignment.findById(req.params.id)
    .populate('student', 'username full_name')
    .populate('exam', 'title instructions violation_limit checks')
    .lean();
  if (!a || !a.student || !a.exam) return res.status(404).json({ error: 'Not found' });

  const violations = await Violation.find({ assignment: a._id }).sort({ created_at: -1 }).lean();

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
      checks: a.exam.checks || []
    },
    code: a.code || '',
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
  await ExamAssignment.updateOne({ _id: req.params.id }, { $set: { status: 'in_progress' } });
  res.json({ ok: true });
}));

// Reopen an already-submitted exam so the student can keep working — e.g. they submitted early
// by mistake, or ran out of time unfairly. Resets started_at to now so they get a fresh full
// time limit rather than immediately hitting an already-expired one; their existing code and
// any prior test results/score are left as-is until they submit again.
router.post('/assignments/:id/continue', asyncHandler(async (req, res) => {
  const result = await ExamAssignment.updateOne(
    { _id: req.params.id, status: 'submitted' },
    { $set: { status: 'in_progress', started_at: new Date() }, $unset: { submitted_at: '' } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found, or not currently submitted' });
  res.json({ ok: true });
}));

// Re-run auto-grading on demand — useful after editing an exam's checks, or for a submission
// made before checks existed.
router.post('/assignments/:id/run-tests', asyncHandler(async (req, res) => {
  const assignment = await ExamAssignment.findById(req.params.id).populate('exam', 'checks');
  if (!assignment || !assignment.exam) return res.status(404).json({ error: 'Not found' });

  const { results, score } = runChecks(assignment.code, assignment.exam.checks || []);
  assignment.test_results = results;
  assignment.score = score;
  await assignment.save();

  res.json({ ok: true, test_results: results, score });
}));

module.exports = router;
