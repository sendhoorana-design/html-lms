const { mongoose } = require('../db');

const slideSchema = new mongoose.Schema({
  presentation: { type: mongoose.Schema.Types.ObjectId, ref: 'Presentation', required: true },
  index: { type: Number, required: true, min: 0 },
  mime: { type: String, default: 'image/jpeg' },
  data: { type: Buffer, required: true }
});
slideSchema.index({ presentation: 1, index: 1 }, { unique: true });

module.exports = mongoose.models.PresentationSlide || mongoose.model('PresentationSlide', slideSchema);
