const { mongoose } = require('../db');

// A single auto-grading check. Only the fields relevant to `type` are used:
//  - selector_exists: selector, min_count
//  - text_contains:   text, case_sensitive
//  - html_contains:   pattern
const checkSchema = new mongoose.Schema({
  label: { type: String, required: true },
  type: { type: String, required: true, enum: ['selector_exists', 'text_contains', 'html_contains'] },
  selector: { type: String, default: '' },
  min_count: { type: Number, default: 1 },
  text: { type: String, default: '' },
  case_sensitive: { type: Boolean, default: false },
  pattern: { type: String, default: '' }
}, { _id: false });

const examSchema = new mongoose.Schema({
  title: { type: String, required: true },
  instructions: { type: String, default: '' },
  starter_code: {
    type: String,
    default:
      '<!DOCTYPE html>\n<html>\n<head>\n  <title>My Page</title>\n</head>\n<body>\n  <h1>Hello, world!</h1>\n</body>\n</html>'
  },
  time_limit_minutes: { type: Number, default: 60 },
  violation_limit: { type: Number, default: 5 },
  // When false, the exam runs without any proctoring: no fullscreen requirement, no tab-switch/
  // copy-paste/devtools/back-button detection, no violation logging or auto-lock. Everything else
  // (timer, auto-grading, submission) still applies. Defaults to true so existing exams keep their
  // current behavior.
  proctoring_enabled: { type: Boolean, default: true },
  // Auto-grading checks run against the student's submitted code (see server/utils/grader.js).
  // Empty array = no auto-grading for this exam, just manual review.
  checks: { type: [checkSchema], default: [] },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Exam || mongoose.model('Exam', examSchema);
