// Evaluation schema for PDF reports. A rubric converts an exam's auto-graded checks (each
// pass/fail) into a marks table, e.g. "Coding 20 + Design 10 + ... = 40".
//
//   rubric = { total_marks: 40, components: [ { name, max, checks: [<0-based check indexes>] } ] }
//
// Each component's marks are split equally across its checks (max / checks.length); a passed
// check earns its share. The grand total therefore equals (auto-score out of 100) x total / 100
// whenever the rubric's check weights match the auto-score's equal weighting.

// Rubric for the "Brochure Contest" exams (20 checks, see the contest test-case sheet).
//   Coding  (HTML structure & semantics, checks 1-10)        20 marks
//   Design  (CSS: font, gradient, radius, shadow, hover)      10 marks
//   Content & credits (footer, topic title, student name)      6 marks
//   Layout & responsiveness (flexbox, @media)                  4 marks
const BROCHURE_RUBRIC = {
  total_marks: 40,
  components: [
    { name: 'Coding – HTML structure & semantics', max: 20, checks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { name: 'Design – CSS styling', max: 10, checks: [13, 14, 15, 16, 17] },
    { name: 'Content & credits', max: 6, checks: [10, 11, 12] },
    { name: 'Layout & responsiveness', max: 4, checks: [18, 19] }
  ]
};

function resolveRubric(exam) {
  if (exam && exam.rubric && Array.isArray(exam.rubric.components) && exam.rubric.components.length) {
    return exam.rubric;
  }
  if (exam && /^Brochure Contest/i.test(exam.title || '')) return BROCHURE_RUBRIC;
  // Fallback for any other exam: one component covering every check, out of 40.
  const n = ((exam && exam.checks) || []).length;
  return {
    total_marks: 40,
    components: [{ name: 'Auto-graded test cases', max: 40, checks: Array.from({ length: n }, (_, i) => i) }]
  };
}

const round1 = (x) => Math.round(x * 10) / 10;

// results: the stored test_results array (same order as exam.checks).
function evaluate(exam, testResults) {
  const rubric = resolveRubric(exam);
  const results = Array.isArray(testResults) ? testResults : [];
  const graded = results.length > 0;
  const perCheck = new Map(); // check index -> marks for that check
  const components = rubric.components.map((c) => {
    const each = c.checks.length ? c.max / c.checks.length : 0;
    let awarded = 0; let passed = 0;
    c.checks.forEach((i) => {
      perCheck.set(i, each);
      if (results[i] && results[i].passed) { awarded += each; passed += 1; }
    });
    return { name: c.name, max: c.max, checks: c.checks, passed, total_checks: c.checks.length, awarded: round1(awarded) };
  });
  const awarded = round1(components.reduce((s, c) => s + c.awarded, 0));
  return { rubric, components, awarded, max: rubric.total_marks, graded, perCheck };
}

module.exports = { BROCHURE_RUBRIC, resolveRubric, evaluate };
