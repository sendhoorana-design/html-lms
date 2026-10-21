const { mongoose } = require('../db');

// One row per (student, challenge). Retries are unlimited; the points are awarded once, the first
// time the challenge is solved, and stay fixed afterwards.
const progressSchema = new mongoose.Schema({
  challenge: { type: mongoose.Schema.Types.ObjectId, ref: 'Challenge', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  attempts: { type: Number, default: 0 },
  completed: { type: Boolean, default: false },
  points: { type: Number, default: 0 },
  completed_at: { type: Date, default: null }
});

progressSchema.index({ challenge: 1, student: 1 }, { unique: true });
progressSchema.index({ student: 1, completed: 1 });

module.exports = mongoose.models.ChallengeProgress || mongoose.model('ChallengeProgress', progressSchema);
