const { mongoose } = require('../db');

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
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Exam || mongoose.model('Exam', examSchema);
