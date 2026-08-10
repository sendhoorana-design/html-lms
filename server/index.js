require('dotenv').config();
const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const { connectDB } = require('./db');
const ExamAssignment = require('./models/ExamAssignment');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const studentRoutes = require('./routes/student');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.set('io', io);
// Needed on hosts like Render/Railway that sit behind a reverse proxy, so secure cookies
// and req.protocol are detected correctly.
app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/student', studentRoutes);

app.get('/', (req, res) => res.redirect('/login.html'));

// Catches errors forwarded by asyncHandler-wrapped routes (e.g. a malformed id producing a
// Mongoose CastError) so a bad request returns a clean response instead of hanging.
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid id' });
  }
  res.status(500).json({ error: 'Something went wrong' });
});

// ---- Socket.io auth + rooms ----
io.use((socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers.cookie || '';
    const match = cookieHeader.match(/token=([^;]+)/);
    if (!match) return next(new Error('Not authenticated'));
    const payload = jwt.verify(decodeURIComponent(match[1]), process.env.JWT_SECRET);
    socket.user = payload;
    next();
  } catch (e) {
    next(new Error('Not authenticated'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user;
  if (user.role === 'admin') {
    socket.join('admins');
  } else if (user.role === 'student') {
    socket.join(`student_${user.id}`);
  }

  // Student heartbeat -> notify admins of live status
  socket.on('heartbeat', async (data) => {
    if (user.role !== 'student') return;
    if (data && data.assignmentId) {
      try {
        await ExamAssignment.updateOne(
          { _id: data.assignmentId, student: user.id },
          { $set: { last_seen_at: new Date() } }
        );
      } catch (e) {
        // invalid/unknown assignment id — ignore, the heartbeat is best-effort
      }
    }
    io.to('admins').emit('heartbeat', {
      student_id: user.id,
      full_name: user.full_name,
      assignment_id: data ? data.assignmentId : null,
      at: new Date().toISOString()
    });
  });

  socket.on('status_change', (data) => {
    if (user.role !== 'student') return;
    io.to('admins').emit('status_change', {
      student_id: user.id,
      full_name: user.full_name,
      assignment_id: data ? data.assignmentId : null,
      status: data ? data.status : null,
      at: new Date().toISOString()
    });
  });
});

const PORT = process.env.PORT || 4000;

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`HTML LMS server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    console.error('Set MONGODB_URI in .env to a running mongod instance or an Atlas connection string.');
    process.exit(1);
  });
