const { mongoose } = require('../db');

// Feedback is anonymous: no reference to the student who wrote it is stored at all. The only
// thing kept is which admin manages that student's group (managing_admin), so a sub-admin can see
// feedback from their own group without it being traceable to an individual. The timestamp is
// truncated to the day for the same reason.
// A student can submit more than once per category (e.g. weekly), so there is no uniqueness
// constraint.
const feedbackSchema = new mongoose.Schema({
  category: { type: String, required: true, enum: ['software', 'theory', 'practical'] },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comments: { type: String, default: '', maxlength: 2000 },
  managing_admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_at: { type: Date, default: Date.now }
});

feedbackSchema.index({ category: 1, created_at: -1 });

module.exports = mongoose.models.Feedback || mongoose.model('Feedback', feedbackSchema);
