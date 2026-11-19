// Builds the per-student submission report PDF: front page (modelled on the college's
// "Higher Order Assessment Instructions with Rubrics" sheet), the evaluation schema with marks,
// the per-test-case results, and the submitted code. Landscape A4 like the college sheet.
const path = require('path');
const PDFDocument = require('pdfkit');
const { evaluate } = require('./rubric');

const ASSETS = path.join(__dirname, '..', 'assets');
const LOGO_NBA = path.join(ASSETS, 'image1.png');
const LOGO_NAAC = path.join(ASSETS, 'image2.png');
const LOGO_SRM = path.join(ASSETS, 'image3.png');

// Course/assessment details shown on the front page. Override with env vars if they change.
const COURSE = {
  department: process.env.REPORT_DEPARTMENT || 'Computer Science and Engineering',
  programme: process.env.REPORT_PROGRAMME || 'B.E.',
  semester: process.env.REPORT_SEMESTER || 'I',
  ay: process.env.REPORT_AY || '2026 – 2027 [ODD]',
  faculty: process.env.REPORT_FACULTY || 'Mr. A. Sendhooran, AP/CSE',
  course: process.env.REPORT_COURSE || '2611CSSJ102 & Web Essentials',
  outcomes: process.env.REPORT_COS || 'CO1, CO2'
};

const M = 36; // page margin
const BORDER = '#000000';

function newDoc() {
  return new PDFDocument({ size: 'A4', layout: 'landscape', margin: M, bufferPages: false, autoFirstPage: false,
    info: { Title: 'Contest Submission Report', Author: 'HTML LMS' } });
}

function letterhead(doc, subtitle) {
  const W = doc.page.width;
  try {
    doc.image(LOGO_SRM, M, M - 4, { height: 48 });
    doc.image(LOGO_NBA, W - M - 190, M - 2, { height: 38 });
    doc.image(LOGO_NAAC, W - M - 48, M - 6, { height: 46 });
  } catch (e) { /* logos are decorative; never fail a report over them */ }
  doc.fillColor('#000');
  doc.font('Times-Bold').fontSize(16).text('SRM TRP Engineering College', M, M - 2, { width: W - 2 * M, align: 'center' });
  doc.font('Times-Bold').fontSize(9).text('(An AUTONOMOUS Institution)', { width: W - 2 * M, align: 'center' });
  doc.font('Times-Bold').fontSize(12).text('Tiruchirappalli', { width: W - 2 * M, align: 'center' });
  doc.font('Times-Bold').fontSize(10.5).text(subtitle, { width: W - 2 * M, align: 'center' });
  doc.y = M + 66;
}

// ---- small table helpers (rows of cells with borders) ----
function cellText(doc, text, x, y, w, h, opts = {}) {
  doc.rect(x, y, w, h).lineWidth(0.6).strokeColor(BORDER).stroke();
  if (opts.fill) { doc.rect(x + 0.3, y + 0.3, w - 0.6, h - 0.6).fill(opts.fill); doc.rect(x, y, w, h).stroke(); }
  doc.fillColor(opts.color || '#000').font(opts.font || 'Times-Roman').fontSize(opts.size || 10);
  const th = doc.heightOfString(String(text), { width: w - 12 });
  const ty = y + Math.max(3, (h - th) / 2);
  doc.text(String(text), x + 6, ty, { width: w - 12, align: opts.align || 'left' });
}

function rowHeight(doc, cells, size) {
  let h = 20;
  cells.forEach((c) => {
    doc.font(c.font || 'Times-Roman').fontSize(size || 10);
    h = Math.max(h, doc.heightOfString(String(c.text), { width: c.w - 12 }) + 10);
  });
  return h;
}

function drawRow(doc, cells, y, size) {
  const h = rowHeight(doc, cells, size);
  let x = M;
  cells.forEach((c) => { cellText(doc, c.text, x, y, c.w, h, { font: c.font, align: c.align, size, fill: c.fill, color: c.color }); x += c.w; });
  return h;
}

const fmt = (n) => (Math.round(n * 10) / 10).toString();
const fmtDate = (d) => {
  if (!d) return '—';
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getDate())}/${p(x.getMonth() + 1)}/${x.getFullYear()} ${p(x.getHours())}:${p(x.getMinutes())}`;
};

// Pulls extra student-facing details out of the exam text the contest was created with
// ("Reg. No.: 8147...", 'YOUR BROCHURE TOPIC: "..."'), falling back to the LMS fields.
function studentFacts(d) {
  const ins = d.exam.instructions || '';
  const reg = (ins.match(/Reg\.?\s*No\.?:\s*([A-Za-z0-9]+)/i) || [])[1] || d.student.username;
  const topic = (ins.match(/TOPIC:\s*"([^"]+)"/i) || [])[1] || d.exam.title;
  return { reg, topic };
}

// ---- pages ----
function frontPage(doc, d, ev) {
  doc.addPage();
  const W = doc.page.width - 2 * M;
  letterhead(doc, 'Higher Order Assessment – Submission Report with Evaluation');
  const { reg, topic } = studentFacts(d);
  const L = Math.round(W * 0.2); // label column width
  let y = doc.y + 4;
  const b = 'Times-Bold';
  const rows = [
    [{ text: 'Department', w: L, font: b }, { text: COURSE.department, w: W - L }],
    [{ text: 'Programme:', w: L, font: b }, { text: COURSE.programme, w: W * 0.28 }, { text: 'Semester:', w: W * 0.14, font: b }, { text: COURSE.semester, w: W * 0.12 }, { text: 'AY:', w: W * 0.08, font: b }, { text: COURSE.ay, w: W - L - W * 0.62 }],
    [{ text: 'Faculty Handling:', w: L, font: b }, { text: COURSE.faculty, w: W - L }],
    [{ text: 'Course Code & Title:', w: L, font: b }, { text: COURSE.course, w: W - L }],
    [{ text: 'Assessment Task:', w: L, font: b }, { text: 'Individual Contest – Digital Brochure Design (Easy)', w: W * 0.30 }, { text: 'Assessment Type:', w: W * 0.13, font: b }, { text: 'Term Work / Individual', w: W * 0.16 }, { text: 'Required Time:', w: W * 0.11, font: b }, { text: `${d.exam.time_limit_minutes || 45} Minutes`, w: W * 0.10 }],
    [{ text: 'Presentation Format:', w: L, font: b }, { text: 'Proctored online submission in the HTML LMS (HTML + CSS), auto-graded', w: W - L }],
    [{ text: 'Max Marks:', w: L, font: b }, { text: `${ev.max} Marks  (auto-graded score out of 100 converted to ${ev.max})`, w: W - L, font: b }],
    [{ text: 'Relevant Course Outcome(s):', w: L, font: b }, { text: COURSE.outcomes, w: W - L }],
    [{ text: 'Student Name & Register No.:', w: L, font: b }, { text: `${d.student.full_name}  –  ${reg}`, w: W - L, font: b }],
    [{ text: 'Allocated Brochure Topic:', w: L, font: b }, { text: topic, w: W - L }],
    [{ text: 'Submitted On:', w: L, font: b }, { text: fmtDate(d.submitted_at), w: W * 0.3 }, { text: 'Status:', w: W * 0.1, font: b }, { text: d.status === 'submitted' ? 'Submitted' : d.status.replace('_', ' '), w: W * 0.15 }, { text: 'Proctoring violations:', w: W * 0.17, font: b }, { text: String(d.violation_count || 0), w: W - L - W * 0.72 }],
    [{ text: 'Marks Obtained:', w: L, font: b, fill: '#E9EEF7' }, { text: ev.graded ? `${fmt(ev.awarded)} / ${ev.max}` : 'Not graded', w: W - L, font: b, fill: '#E9EEF7' }]
  ];
  rows.forEach((r) => { y += drawRow(doc, r, y, 10); });
  return y;
}

function evaluationPage(doc, d, ev) {
  doc.addPage();
  const W = doc.page.width - 2 * M;
  letterhead(doc, 'Evaluation Schema and Marks');
  const { reg } = studentFacts(d);
  doc.font('Times-Roman').fontSize(10).fillColor('#000')
    .text(`${d.student.full_name} (${reg})  |  ${d.exam.title}`, M, doc.y, { width: W });
  let y = doc.y + 8;
  const b = 'Times-Bold';
  const cw = [W * 0.08, W * 0.52, W * 0.14, W * 0.13, W * 0.13];
  y += drawRow(doc, [
    { text: 'S.No', w: cw[0], font: b, align: 'center', fill: '#D9E2F3' }, { text: 'Evaluation Criterion', w: cw[1], font: b, fill: '#D9E2F3' },
    { text: 'Test cases passed', w: cw[2], font: b, align: 'center', fill: '#D9E2F3' }, { text: 'Max Marks', w: cw[3], font: b, align: 'center', fill: '#D9E2F3' }, { text: 'Marks Awarded', w: cw[4], font: b, align: 'center', fill: '#D9E2F3' }
  ], y, 10);
  ev.components.forEach((c, i) => {
    y += drawRow(doc, [
      { text: String(i + 1), w: cw[0], align: 'center' }, { text: c.name, w: cw[1] },
      { text: ev.graded ? `${c.passed} / ${c.total_checks}` : '—', w: cw[2], align: 'center' }, { text: fmt(c.max), w: cw[3], align: 'center' }, { text: ev.graded ? fmt(c.awarded) : '—', w: cw[4], align: 'center' }
    ], y, 10);
  });
  y += drawRow(doc, [
    { text: '', w: cw[0] }, { text: 'TOTAL', w: cw[1], font: b }, { text: '', w: cw[2] },
    { text: fmt(ev.max), w: cw[3], font: b, align: 'center' }, { text: ev.graded ? fmt(ev.awarded) : '—', w: cw[4], font: b, align: 'center' }
  ], y, 10);

  const checks = d.exam.checks || [];
  const total = checks.length;
  const pass = (d.test_results || []).filter((r) => r.passed).length;
  const scoreTxt = ev.graded
    ? `Auto-graded score: ${typeof d.score === 'number' ? d.score : Math.round((pass / Math.max(total, 1)) * 100)} / 100  (${pass} of ${total} test cases passed), converted to ${fmt(ev.awarded)} / ${ev.max} marks.`
    : 'This submission has not been auto-graded yet.';
  doc.font('Times-Bold').fontSize(10.5).text(scoreTxt, M, y + 8, { width: W });

  // Per-test-case results
  y = doc.y + 10;
  doc.font('Times-Bold').fontSize(11).text('Test case results', M, y);
  y = doc.y + 4;
  const tw = [W * 0.06, W * 0.56, W * 0.12, W * 0.13, W * 0.13];
  const head = () => {
    y += drawRow(doc, [
      { text: 'No.', w: tw[0], font: b, align: 'center', fill: '#D9E2F3' }, { text: 'Test case', w: tw[1], font: b, fill: '#D9E2F3' },
      { text: 'Result', w: tw[2], font: b, align: 'center', fill: '#D9E2F3' }, { text: 'Max marks', w: tw[3], font: b, align: 'center', fill: '#D9E2F3' }, { text: 'Awarded', w: tw[4], font: b, align: 'center', fill: '#D9E2F3' }
    ], y, 9);
  };
  head();
  checks.forEach((c, i) => {
    const res = (d.test_results || [])[i];
    const each = ev.perCheck.get(i) || 0;
    const rowCells = [
      { text: String(i + 1), w: tw[0], align: 'center' }, { text: c.label, w: tw[1] },
      { text: res ? (res.passed ? 'PASS' : 'FAIL') : '—', w: tw[2], align: 'center', font: b },
      { text: fmt(each), w: tw[3], align: 'center' }, { text: res && res.passed ? fmt(each) : '0', w: tw[4], align: 'center' }
    ];
    const h = rowHeight(doc, rowCells, 9);
    if (y + h > doc.page.height - M - 14) {
      doc.addPage(); letterhead(doc, 'Evaluation Schema and Marks (contd.)'); y = doc.y + 4; head();
    }
    y += drawRow(doc, rowCells, y, 9);
  });
  doc.y = y;
}

function codePages(doc, d) {
  const W = doc.page.width - 2 * M;
  const files = d.files && d.files.length ? d.files : [{ name: 'index.html', content: d.code || '' }];
  const LH = 9.6; // code line height
  files.forEach((f) => {
    doc.addPage();
    letterhead(doc, 'Submitted Code');
    let y = doc.y;
    const header = (cont) => {
      doc.font('Times-Bold').fontSize(10.5).fillColor('#000')
        .text(`${d.student.full_name}  |  File: ${f.name}${cont ? ' (contd.)' : ''}`, M, y, { width: W });
      y = doc.y + 4;
    };
    header(false);
    // Built-in PDF fonts only cover Latin-1/WinAnsi; show anything else as '?' instead of garbage.
    const lines = String(f.content || '').replace(/\t/g, '  ').replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\r\n]/g, '?').split(/\r?\n/);
    const numW = 30;
    const codeW = W - numW - 8;
    doc.font('Courier').fontSize(8);
    const maxChars = Math.floor(codeW / doc.widthOfString('M'));
    lines.forEach((line, i) => {
      // wrap long lines at maxChars so nothing is cut off
      const parts = line.length ? line.match(new RegExp(`.{1,${maxChars}}`, 'g')) : [''];
      parts.forEach((part, k) => {
        if (y + LH > doc.page.height - M - 14) {
          doc.addPage(); letterhead(doc, 'Submitted Code (contd.)'); y = doc.y; header(true);
          doc.font('Courier').fontSize(8);
        }
        doc.font('Courier').fontSize(8).fillColor('#777').text(k === 0 ? String(i + 1) : '', M, y, { width: numW, align: 'right', lineBreak: false });
        doc.fillColor('#000').text(part, M + numW + 8, y, { width: codeW, lineBreak: false });
        y += LH;
      });
    });
    if (!String(f.content || '').trim()) {
      doc.font('Times-Italic').fontSize(10).fillColor('#555').text('(file is empty)', M + numW + 8, y);
    }
  });
}

// d = { student:{full_name,username}, exam:{title,instructions,checks,time_limit_minutes,rubric},
//       status, started_at, submitted_at, violation_count, score, test_results, files:[{name,content}], code }
function addReport(doc, d) {
  const ev = evaluate(d.exam, d.test_results);
  frontPage(doc, d, ev);
  evaluationPage(doc, d, ev);
  codePages(doc, d);
}

function addPageNumbers(doc) {
  // pdfkit buffered pages are only available when bufferPages is on; we keep it off and number
  // at draw time instead, so nothing to do here. Kept for a future switch to buffered mode.
}

module.exports = { newDoc, addReport, addPageNumbers, studentFacts };
