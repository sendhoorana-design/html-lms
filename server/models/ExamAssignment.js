const { mongoose } = require('../db');

const testResultSchema = new mongoose.Schema({
  label: String,
  type: String,
  passed: Boolean,
  detail: String
}, { _id: false });

// One document per (exam, student) pair. The student's current/final code lives directly on
// this document (folded in from what used to be a separate "submissions" table) since it's
// always a strict 1:1 relationship — no need for a join.
const examAssignmentSchema = new mongoose.Schema({
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['not_started', 'in_progress', 'submitted', 'locked'],
    default: 'not_started'
  },
  code: { type: String, default: '' },
  started_at: { type: Date, default: null },
  submitted_at: { type: Date, default: null },
  last_seen_at: { type: Date, default: null },
  // Auto-grading results against the exam's checks — set on submit, and re-runnable by an
  // admin at any time (e.g. after editing the checks). null score = never graded (no checks
  // defined on the exam, or not graded yet).
  test_results: { type: [testResultSchema], default: [] },
  score: { type: Number, default: null },
  // Per-student override of the exam's violation_limit. null/undefined = use the exam's setting.
  // 0 = no limit for this student specifically (never auto-lock them), even if the exam itself
  // has a limit. A positive number = a custom limit just for this student. Set by an admin from
  // the assignment detail view, e.g. for a student who needs an accommodation.
  violation_limit_override: { type: Number, default: null }
});

examAssignmentSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = mongoose.models.ExamAssignment || mongoose.model('ExamAssignment', examAssignmentSchema);
