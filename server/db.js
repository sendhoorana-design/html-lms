// MongoDB connection (Mongoose). Point MONGODB_URI at a local mongod for development or an
// Atlas free-tier cluster for anything shared/hosted.
const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/html_lms';

mongoose.set('strictQuery', true);

let connecting = null;

function connectDB() {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection);
  if (!connecting) {
    connecting = mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 }).then(() => {
      console.log(`Connected to MongoDB (${MONGODB_URI.replace(/\/\/.*@/, '//<credentials>@')})`);
      return mongoose.connection;
    });
  }
  return connecting;
}

module.exports = { mongoose, connectDB };
