// Validation, answer checking and student-safe views for challenges. Kept free of database code
// so it can be unit-tested directly.

const TYPES = ['quiz', 'fill', 'fix', 'order'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const DEFAULT_POINTS = { easy: 10, medium: 15, hard: 20 };
const BLANK = '___';

function countBlanks(code) {
  return (String(code || '').split(BLANK).length - 1);
}

function str(v, max) {
  return String(v === undefined || v === null ? '' : v).slice(0, max);
}

// Normalises a raw admin/seed payload into a challenge document, or returns { error }.
function sanitizeChallenge(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid challenge' };
  const type = body.type;
  if (!TYPES.includes(type)) return { error: 'Type must be quiz, fill, fix or order' };
  const title = str(body.title, 200).trim();
  if (!title) return { error: 'Title is required' };
  const difficulty = DIFFICULTIES.includes(body.difficulty) ? body.difficulty : 'easy';
  let points = parseInt(body.points, 10);
  if (Number.isNaN(points)) points = DEFAULT_POINTS[difficulty];
  if (points < 1 || points > 100) return { error: 'Points must be between 1 and 100' };

  const raw = body.data && typeof body.data === 'object' ? body.data : {};
  const doc = {
    title,
    topic: str(body.topic, 200).trim(),
    type,
    difficulty,
    points,
    prompt: str(body.prompt, 2000),
    code: str(body.code, 8000),
    explanation: str(body.explanation, 2000),
    active: body.active === undefined ? true : !!body.active,
    order_no: Number.isFinite(parseInt(body.order_no, 10)) ? parseInt(body.order_no, 10) : 0,
    data: {}
  };
  const hint = str(raw.hint, 500).trim();

  if (type === 'quiz') {
    const options = (Array.isArray(raw.options) ? raw.options : []).map((o) => str(o, 300).trim()).filter(Boolean);
    const correct = parseInt(raw.correct, 10);
    if (options.length < 2 || options.length > 8) return { error: 'A quiz needs 2 to 8 options' };
    if (Number.isNaN(correct) || correct < 0 || correct >= options.length) return { error: 'Pick the correct option' };
    doc.data = { options, correct };
  } else if (type === 'fill') {
    const answers = (Array.isArray(raw.answers) ? raw.answers : [])
      .map((a) => (Array.isArray(a) ? a : [a]).map((x) => str(x, 200).trim()).filter(Boolean));
    const blanks = countBlanks(doc.code);
    if (blanks < 1) return { error: `Put ${BLANK} in the code wherever a blank should go` };
    if (answers.length !== blanks || answers.some((a) => a.length === 0)) {
      return { error: `The code has ${blanks} blank(s) but ${answers.length} answer line(s) were given` };
    }
    doc.data = { answers, case_sensitive: !!raw.case_sensitive };
  } else if (type === 'fix') {
    const lines = doc.code.split('\n');
    const bug = (Array.isArray(raw.bug_lines) ? raw.bug_lines : [raw.bug_lines])
      .map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
    if (lines.length < 2) return { error: 'Add the code that contains the bug' };
    if (!bug.length || bug.some((n) => n < 1 || n > lines.length)) return { error: 'Buggy line number is outside the code' };
    doc.data = { bug_lines: Array.from(new Set(bug)) };
  } else if (type === 'order') {
    const lines = (Array.isArray(raw.lines) ? raw.lines : []).map((l) => str(l, 300).replace(/\s+$/, '')).filter((l) => l.trim());
    if (lines.length < 3 || lines.length > 20) return { error: 'Ordering needs 3 to 20 lines' };
    doc.data = { lines };
  }
  if (hint) doc.data.hint = hint;
  return { doc };
}

// Small deterministic PRNG so a student sees the same shuffle on every page load.
function seeded(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6D2B79F5; let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledLines(id, lines) {
  const trimmed = lines.map((l) => l.trim());
  if (new Set(trimmed).size <= 1) return lines.slice();
  for (let attempt = 0; attempt < 20; attempt++) {
    const rnd = seeded(`${id}:${attempt}`);
    const arr = lines.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    if (arr.some((l, i) => l.trim() !== trimmed[i])) return arr; // never hand out the solved order
  }
  return lines.slice().reverse();
}

// What a student is allowed to see: everything except the answer key.
function studentView(ch) {
  const id = String(ch._id || ch.id);
  const d = ch.data || {};
  const view = {
    id, title: ch.title, topic: ch.topic || '', type: ch.type, difficulty: ch.difficulty,
    points: ch.points, prompt: ch.prompt || '', code: ch.code || '', hint: d.hint || ''
  };
  if (ch.type === 'quiz') view.options = d.options || [];
  if (ch.type === 'fill') view.blanks = countBlanks(ch.code);
  if (ch.type === 'fix') view.line_count = String(ch.code || '').split('\n').length;
  if (ch.type === 'order') view.lines = shuffledLines(id, d.lines || []);
  return view;
}

function norm(s, caseSensitive) {
  const t = String(s === undefined || s === null ? '' : s).trim().replace(/\s+/g, ' ');
  return caseSensitive ? t : t.toLowerCase();
}

// Checks one attempt. Returns { correct, detail } where detail never leaks the answer
// (only which blanks / how many lines are right).
function checkAnswer(ch, answer) {
  const d = ch.data || {};
  if (ch.type === 'quiz') {
    const n = parseInt(answer, 10);
    return { correct: n === d.correct, detail: {} };
  }
  if (ch.type === 'fill') {
    const given = Array.isArray(answer) ? answer : [];
    const answers = d.answers || [];
    const blanks = answers.map((alts, i) => alts.some((a) => norm(a, d.case_sensitive) === norm(given[i], d.case_sensitive)));
    return { correct: blanks.length > 0 && blanks.every(Boolean), detail: { blanks } };
  }
  if (ch.type === 'fix') {
    const n = parseInt(answer, 10);
    return { correct: (d.bug_lines || []).includes(n), detail: {} };
  }
  if (ch.type === 'order') {
    const given = Array.isArray(answer) ? answer.map((l) => String(l).trim()) : [];
    const want = (d.lines || []).map((l) => l.trim());
    const placed = want.filter((l, i) => given[i] === l).length;
    const same = given.length === want.length && placed === want.length;
    return { correct: same, detail: { placed, total: want.length } };
  }
  return { correct: false, detail: {} };
}

module.exports = { sanitizeChallenge, studentView, checkAnswer, shuffledLines, countBlanks, TYPES, DIFFICULTIES, DEFAULT_POINTS, BLANK };
