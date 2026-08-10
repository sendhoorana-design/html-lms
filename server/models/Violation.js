const { mongoose } = require('../db');

const violationSchema = new mongoose.Schema({
  assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAssignment', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  type: { type: String, required: true },
  detail: { type: String, default: '' },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Violation || mongoose.model('Violation', violationSchema);
