const { mongoose } = require('../db');

// Singleton document (key = 'feedback') holding which feedback categories are open to students.
// All three default to enabled; the main admin can switch each one off/on independently.
const feedbackSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'feedback', unique: true },
  software_enabled: { type: Boolean, default: true },
  theory_enabled: { type: Boolean, default: true },
  practical_enabled: { type: Boolean, default: true }
});

module.exports = mongoose.models.FeedbackSettings || mongoose.model('FeedbackSettings', feedbackSettingsSchema);
