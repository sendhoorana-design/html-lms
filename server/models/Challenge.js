const { mongoose } = require('../db');

// A self-contained, auto-graded mini challenge (quiz / fill-in-the-blanks / find-the-bug /
// put-the-lines-in-order). The answer key lives in `data` and is NEVER sent to students — only
// the server checks attempts (see utils/challenges.js).
//   quiz  : data = { options: [..], correct: <index>, hint? }
//   fill  : code contains "___" blanks; data = { answers: [[accepted, ...], ...], case_sensitive?, hint? }
//   fix   : code is shown with line numbers; data = { bug_lines: [<1-based line>, ...], hint? }
//   order : data = { lines: [..lines in the correct order..], hint? }
const challengeSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  topic: { type: String, default: '', trim: true },          // e.g. "Ex. 3.1 – CSS basics"
  type: { type: String, required: true, enum: ['quiz', 'fill', 'fix', 'order'] },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'easy' },
  points: { type: Number, required: true, min: 1, max: 100, default: 10 },
  prompt: { type: String, default: '' },
  code: { type: String, default: '' },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  explanation: { type: String, default: '' },
  active: { type: Boolean, default: true },
  order_no: { type: Number, default: 0 },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_at: { type: Date, default: Date.now }
});

challengeSchema.index({ title: 1 });

module.exports = mongoose.models.Challenge || mongoose.model('Challenge', challengeSchema);
