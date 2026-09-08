const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const ExamAssignment = require('../models/ExamAssignment');
const Violation = require('../models/Violation');
const { authRequired, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { runChecks } = require('../utils/grader');

const router = express.Router();
router.use(authRequired, requireRole('student'));

// Change password — required before doing anything else when must_change_password is set
// (fresh CSV import, or an admin forcing a reset), but callable any time otherwise too.
router.post('/change-password', asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  user.password_hash = bcrypt.hashSync(newPassword, 10);
  user.must_change_password = false;
  await user.save();
  res.json({ ok: true });
}));

// Server-side enforcement, not just a UI gate: block every other student route until a
// forced/temporary password has actually been changed, so it can't be bypassed by calling
// the API directly instead of going through the change-password screen.
router.use(asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id).select('must_change_password').lean();
  if (user && user.must_change_password) {
    return res.status(403).json({ error: 'You must set a new password before continuing', mustChangePassword: true });
  }
  next();
}));

// List all exams assigned to the logged-in student
router.get('/assignments', asyncHandler(async (req, res) => {
  const assignments = await ExamAssignment.find({ student: req.user.id })
    .populate('exam', 'title instructions time_limit_minutes')
    .sort({ _id: -1 })
    .lean();

  res.json(
    assignments
      .filter((a) => a.exam)
      .map((a) => ({
        assignment_id: a._id.toString(),
        status: a.status,
        started_at: a.started_at,
        submitted_at: a.submitted_at,
        exam_id: a.exam._id.toString(),
        title: a.exam.title,
        instructions: a.exam.instructions,
        time_limit_minutes: a.exam.time_limit_minutes
      }))
  );
}));

// Get a specific assignment (exam + starter/saved code); marks as started
router.get('/assignments/:id', asyncHandler(async (req, res) => {
  const assignment = await ExamAssignment.findOne({ _id: req.params.id, student: req.user.id }).populate('exam');
  if (!assignment || !assignment.exam) return res.status(404).json({ error: 'Not found' });

  // Locked and submitted exams are viewable read-only anytime (code + output + violation log),
  // just not editable. Only a fresh, in-progress exam is a "live" editable session.
  const readOnly = assignment.status === 'locked' || assignment.status === 'submitted';

  if (assignment.status === 'not_started') {
    assignment.status = 'in_progress';
    assignment.started_at = new Date();
    assignment.last_seen_at = new Date();
    if (!assignment.code) assignment.code = assignment.exam.starter_code || '';
    await assignment.save();
  }

  const violations = readOnly
    ? (await Violation.find({ assignment: assignment._id }).sort({ created_at: -1 }).lean()).map((v) => ({
        id: v._id.toString(),
        type: v.type,
        detail: v.detail,
        created_at: v.created_at
      }))
    : [];

  res.json({
    assignment: {
      id: assignment._id.toString(),
      exam_id: assignment.exam._id.toString(),
      student_id: req.user.id,
      status: assignment.status,
      started_at: assignment.started_at,
      submitted_at: assignment.submitted_at,
      title: assignment.exam.title,
      instructions: assignment.exam.instructions,
      starter_code: assignment.exam.starter_code,
      time_limit_minutes: assignment.exam.time_limit_minutes,
      violation_limit: assignment.exam.violation_limit
    },
    code: assignment.code || '',
    readOnly,
    violations,
    test_results: assignment.test_results || [],
    score: assignment.score
  });
}));

// Autosave code
router.put('/assignments/:id/code', asyncHandler(async (req, res) => {
  const { code } = req.body;
  const assignment = await ExamAssignment.findOne({ _id: req.params.id, student: req.user.id });
  if (!assignment) return res.status(404).json({ error: 'Not found' });
  if (assignment.status === 'locked' || assignment.status === 'submitted') {
    return res.status(423).json({ error: 'Exam is no longer editable' });
  }

  assignment.code = code;
  assignment.last_seen_at = new Date();
  await assignment.save();
  res.json({ ok: true });
}));

// Submit
router.post('/assignments/:id/submit', asyncHandler(async (req, res) => {
  const assignment = await ExamAssignment.findOne({ _id: req.params.id, student: req.user.id }).populate('exam', 'checks');
  if (!assignment) return res.status(404).json({ error: 'Not found' });
  if (assignment.status === 'submitted' || assignment.status === 'locked') {
    return res.status(423).json({ error: 'This exam is no longer editable' });
  }
  assignment.status = 'submitted';
  assignment.submitted_at = new Date();

  // Auto-grade against whatever checks the exam defines, if any. Grading only ever reads the
  // student's code — it can't fail the submission itself, so any grading error is swallowed
  // rather than blocking the submit.
  try {
    const { results, score } = runChecks(assignment.code, assignment.exam ? assignment.exam.checks : []);
    assignment.test_results = results;
    assignment.score = score;
  } catch (e) {
    // leave test_results/score as-is (defaults) if grading itself throws
  }

  await assignment.save();
  res.json({ ok: true, test_results: assignment.test_results, score: assignment.score });
}));

// Heartbeat (keeps last_seen_at fresh for the live monitor, called periodically)
router.post('/assignments/:id/heartbeat', asyncHandler(async (req, res) => {
  await ExamAssignment.updateOne(
    { _id: req.params.id, student: req.user.id },
    { $set: { last_seen_at: new Date() } }
  );
  res.json({ ok: true });
}));

// Log a proctoring violation
router.post('/assignments/:id/violation', asyncHandler(async (req, res) => {
  const { type, detail } = req.body;
  const assignment = await ExamAssignment.findOne({ _id: req.params.id, student: req.user.id }).populate('exam', 'violation_limit');
  if (!assignment || !assignment.exam) return res.status(404).json({ error: 'Not found' });
  if (assignment.status === 'submitted' || assignment.status === 'locked') {
    return res.json({ ok: true, ignored: true });
  }

  await Violation.create({
    assignment: assignment._id,
    student: req.user.id,
    exam: assignment.exam._id,
    type,
    detail: detail || ''
  });

  const count = await Violation.countDocuments({ assignment: assignment._id });

  let locked = false;
  if (assignment.exam.violation_limit && count >= assignment.exam.violation_limit) {
    assignment.status = 'locked';
    await assignment.save();
    locked = true;
  }

  const io = req.app.get('io');
  if (io) {
    io.to('admins').emit('violation', {
      assignment_id: assignment._id.toString(),
      student_id: req.user.id,
      full_name: req.user.full_name,
      exam_id: assignment.exam._id.toString(),
      type,
      detail,
      count,
      locked,
      created_at: new Date().toISOString()
    });
  }

  res.json({ ok: true, count, locked });
}));

module.exports = router;
