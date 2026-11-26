const { mongoose } = require('../db');

// Screenshot of a student's rendered page, captured in an admin's browser and embedded in the
// PDF reports. Kept in its own collection so the big image never rides along with ordinary
// assignment queries. One per assignment; `for_submitted_at` records which submission it shows,
// so a re-submission is detected as "needs a fresh capture".
const outputSchema = new mongoose.Schema({
  assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAssignment', required: true, unique: true },
  mime: { type: String, default: 'image/jpeg' },
  data: { type: Buffer, required: true },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  truncated: { type: Boolean, default: false },   // page was taller than the capture cap
  for_submitted_at: { type: Date, default: null },
  captured_at: { type: Date, default: Date.now }
});

module.exports = mongoose.models.AssignmentOutput || mongoose.model('AssignmentOutput', outputSchema);
