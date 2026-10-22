const { mongoose } = require('../db');

// A slide deck an admin presents live. Slides are stored as images (converted from PPTX/PDF in
// the admin's browser) in PresentationSlide. While `live` is true, students who belong to the
// presenter (or everyone, if the presenter is the main admin) are locked to `current_index`.
const presentationSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  slide_count: { type: Number, required: true, min: 1, max: 300 },
  live: { type: Boolean, default: false },
  current_index: { type: Number, default: 0 },
  started_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Presentation || mongoose.model('Presentation', presentationSchema);
