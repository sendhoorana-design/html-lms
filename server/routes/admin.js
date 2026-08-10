const express = require('express');
const bcrypt = require('bcryptjs');
const { mongoose } = require('../db');
const User = require('../models/User');
const Exam = require('../models/Exam');
const ExamAssignment = require('../models/ExamAssignment');
const Violation = require('../models/Violation');
const { authRequired, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

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
    created_at: s.created_at
  })));
}));

router.post('/students', asyncHandler(async (req, res) => {
  const { username, password, full_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const existing = await User.findOne({ username });
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const user = await User.create({ username, password_hash: hash, role: 'student', full_name: full_name || username });
  res.status(201).json({ id: user._id.toString(), username: user.username, full_name: user.full_name });
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
    created_by: e.created_by ? e.created_by.toString() : null,
    created_at: e.created_at
  })));
}));

router.post('/exams', asyncHandler(async (req, res) => {
  const { title, instructions, starter_code, time_limit_minutes, violation_limit } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const doc = { title, instructions: instructions || '', time_limit_minutes: time_limit_minutes || 60, violation_limit: violation_limit || 5, created_by: req.user.id };
  if (starter_code) doc.starter_code = starter_code;

  const exam = await Exam.create(doc);
  res.status(201).json({ id: exam._id.toString() });
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
      violation_count: countMap.get(a._id.toString()) || 0
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
      violation_count: countMap.get(a._id.toString()) || 0
    }))
    .sort((x, y) => (y.violation_count - x.violation_count) || String(y.last_seen_at).localeCompare(String(x.last_seen_at)));

  res.json(rows);
}));

router.get('/assignments/:id', asyncHandler(async (req, res) => {
  const a = await ExamAssignment.findById(req.params.id)
    .populate('student', 'username full_name')
    .populate('exam', 'title instructions violation_limit')
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
      violation_limit: a.exam.violation_limit
    },
    code: a.code || '',
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

module.exports = router;
