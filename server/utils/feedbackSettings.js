const FeedbackSettings = require('../models/FeedbackSettings');

// Returns { software, theory, practical } booleans, creating the settings document (all enabled)
// the first time it's needed.
async function getFeedbackSettings() {
  const doc = await FeedbackSettings.findOneAndUpdate(
    { key: 'feedback' },
    { $setOnInsert: { key: 'feedback' } },
    { upsert: true, new: true }
  ).lean();
  return {
    software: doc.software_enabled !== false,
    theory: doc.theory_enabled !== false,
    practical: doc.practical_enabled !== false
  };
}

const FEEDBACK_CATEGORIES = ['software', 'theory', 'practical'];

module.exports = { getFeedbackSettings, FEEDBACK_CATEGORIES };
