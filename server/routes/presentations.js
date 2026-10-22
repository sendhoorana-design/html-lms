const express = require('express');
const User = require('../models/User');
const Presentation = require('../models/Presentation');
const PresentationSlide = require('../models/PresentationSlide');
const { authRequired } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired);

const MAX_SLIDE_BYTES = 2 * 1024 * 1024;

function isAdmin(req) { return req.user && req.user.role === 'admin'; }
function adminOnly(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Fresh super-admin lookup per request (same reasoning as requireSuperAdmin).
async function loadMe(req) {
  const me = await User.findById(req.user.id).select('is_super_admin managing_admin role').lean();
  return me || {};
}

// Rooms a presentation's state changes are broadcast to: every student when the presenter is
// the main admin, otherwise only that admin's students.
function roomFor(ownerId, ownerIsSuper) {
  return ownerIsSuper ? 'pres_all' : `pres_admin_${ownerId}`;
}

function stateOf(p) {
  return {
    id: p._id.toString(),
    title: p.title,
    slide_count: p.slide_count,
    live: !!p.live,
    index: p.current_index || 0,
    owner: p.owner && p.owner._id ? p.owner._id.toString() : String(p.owner)
  };
}

async function ownerIsSuper(ownerId) {
  const o = await User.findById(ownerId).select('is_super_admin').lean();
  return !!(o && o.is_super_admin);
}

function broadcast(req, p, ownerSuper) {
  const io = req.app.get('io');
  if (!io) return;
  io.to(roomFor(String(p.owner), ownerSuper)).emit('presentation_state', stateOf(p));
}

// Loads a presentation the calling admin may control (own, or any for the main admin).
async function loadControlled(req, res) {
  const me = await loadMe(req);
  const p = await Presentation.findById(req.params.id);
  if (!p) { res.status(404).json({ error: 'Presentation not found' }); return null; }
  if (!me.is_super_admin && String(p.owner) !== req.user.id) {
    res.status(403).json({ error: 'You can only control your own presentations' });
    return null;
  }
  return { p, me };
}

// ---------------- Student: what's live for me? ----------------
router.get('/live', asyncHandler(async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Forbidden' });
  const me = await loadMe(req);
  const supers = (await User.find({ role: 'admin', is_super_admin: true }).select('_id').lean()).map((u) => u._id);
  const owners = supers.slice();
  if (me.managing_admin) owners.push(me.managing_admin);
  const p = await Presentation.findOne({ live: true, owner: { $in: owners } }).sort({ started_at: -1 }).lean();
  res.json({ presentation: p ? stateOf(p) : null });
}));

// ---------------- Slide image (admin who may see it, or a student it is live for) ----------------
router.get('/:id/slides/:i', asyncHandler(async (req, res) => {
  const idx = parseInt(req.params.i, 10);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Bad slide index' });
  const p = await Presentation.findById(req.params.id).lean();
  if (!p) return res.status(404).json({ error: 'Not found' });
  const me = await loadMe(req);
  if (req.user.role === 'admin') {
    if (!me.is_super_admin && String(p.owner) !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  } else {
    if (!p.live) return res.status(403).json({ error: 'Not live' });
    const ownerSuper = await ownerIsSuper(p.owner);
    const mine = me.managing_admin && String(me.managing_admin) === String(p.owner);
    if (!ownerSuper && !mine) return res.status(403).json({ error: 'Forbidden' });
  }
  const s = await PresentationSlide.findOne({ presentation: p._id, index: idx }).lean();
  if (!s) return res.status(404).json({ error: 'Slide not found' });
  res.set('Content-Type', s.mime || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data.buffer || s.data));
}));

// ---------------- Admin ----------------
router.get('/', adminOnly, asyncHandler(async (req, res) => {
  const me = await loadMe(req);
  const filter = me.is_super_admin ? {} : { owner: req.user.id };
  const list = await Presentation.find(filter).sort({ created_at: -1 }).populate('owner', 'full_name username').lean();
  const ids = list.map((p) => p._id);
  const counts = await PresentationSlide.aggregate([
    { $match: { presentation: { $in: ids } } },
    { $group: { _id: '$presentation', n: { $sum: 1 } } }
  ]);
  const cmap = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json({
    presentations: list.map((p) => ({
      ...stateOf(p),
      owner_name: p.owner ? (p.owner.full_name || p.owner.username) : '',
      mine: p.owner && String(p.owner._id) === req.user.id,
      uploaded: cmap.get(String(p._id)) || 0,
      created_at: p.created_at
    }))
  });
}));

router.post('/', adminOnly, asyncHandler(async (req, res) => {
  const title = String((req.body && req.body.title) || '').trim();
  const n = parseInt(req.body && req.body.slide_count, 10);
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (!Number.isInteger(n) || n < 1 || n > 300) return res.status(400).json({ error: 'Slide count must be 1–300' });
  const p = await Presentation.create({ title: title.slice(0, 150), owner: req.user.id, slide_count: n });
  res.json({ ok: true, id: p._id.toString() });
}));

const DATA_URL = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/;

router.put('/:id/slides/:i', adminOnly, asyncHandler(async (req, res) => {
  const ctx = await loadControlled(req, res); if (!ctx) return;
  const { p } = ctx;
  const idx = parseInt(req.params.i, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= p.slide_count) return res.status(400).json({ error: 'Slide index out of range' });
  const m = DATA_URL.exec(String((req.body && req.body.image) || ''));
  if (!m) return res.status(400).json({ error: 'image must be a JPEG/PNG data URL' });
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_SLIDE_BYTES) return res.status(400).json({ error: 'Slide image is empty or larger than 2 MB' });
  await PresentationSlide.updateOne(
    { presentation: p._id, index: idx },
    { $set: { mime: m[1], data: buf } },
    { upsert: true }
  );
  res.json({ ok: true });
}));

router.get('/:id/state', adminOnly, asyncHandler(async (req, res) => {
  const ctx = await loadControlled(req, res); if (!ctx) return;
  const uploaded = await PresentationSlide.countDocuments({ presentation: ctx.p._id });
  res.json({ ...stateOf(ctx.p), uploaded });
}));

router.post('/:id/start', adminOnly, asyncHandler(async (req, res) => {
  const ctx = await loadControlled(req, res); if (!ctx) return;
  const { p } = ctx;
  const uploaded = await PresentationSlide.countDocuments({ presentation: p._id });
  if (uploaded < p.slide_count) return res.status(400).json({ error: `Only ${uploaded} of ${p.slide_count} slides uploaded` });
  // One live presentation per presenter: stop their others first and tell students.
  const others = await Presentation.find({ owner: p.owner, live: true, _id: { $ne: p._id } });
  const ownerSuper = await ownerIsSuper(p.owner);
  for (const o of others) { o.live = false; await o.save(); broadcast(req, o, ownerSuper); }
  p.live = true; p.current_index = 0; p.started_at = new Date();
  await p.save();
  broadcast(req, p, ownerSuper);
  res.json({ ok: true, ...stateOf(p) });
}));

router.post('/:id/goto', adminOnly, asyncHandler(async (req, res) => {
  const ctx = await loadControlled(req, res); if (!ctx) return;
  const { p } = ctx;
  if (!p.live) return res.status(400).json({ error: 'Presentation is not live' });
  const idx = parseInt(req.body && req.body.index, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= p.slide_count) return res.status(400).json({ error: 'Slide index out of range' });
  p.current_index = idx;
  await p.save();
  broadcast(req, p, await ownerIsSuper(p.owner));
  res.json({ ok: true, ...stateOf(p) });
}));

router.post('/:id/stop', adminOnly, asyncHandler(async (req, res) => {
  const ctx = await loadControlled(req, res); if (!ctx) return;
  const { p } = ctx;
  p.live = false;
  await p.save();
  broadcast(req, p, await ownerIsSuper(p.owner));
  res.json({ ok: true, ...stateOf(p) });
}));

router.delete('/:id', adminOnly, asyncHandler(async (req, res) => {
  const ctx = await loadControlled(req, res); if (!ctx) return;
  const { p } = ctx;
  if (p.live) { p.live = false; await p.save(); broadcast(req, p, await ownerIsSuper(p.owner)); }
  await PresentationSlide.deleteMany({ presentation: p._id });
  await Presentation.deleteOne({ _id: p._id });
  res.json({ ok: true });
}));

module.exports = router;
