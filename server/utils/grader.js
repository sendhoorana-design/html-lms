// Server-side auto-grading for HTML exercises. This parses the student's submitted markup with
// cheerio (a static HTML parser — it does NOT execute any <script> in the code, so this is safe
// to run on untrusted student HTML) and checks it against the exam's defined checks.
//
// This is a static approximation of what a browser would render, not a real browser — it won't
// catch behavior that only appears after JS runs (e.g. content injected by a script). For plain
// HTML/CSS structure exercises (the common case here) that's a non-issue.
const cheerio = require('cheerio');

function runOneCheck(html, $, check) {
  const label = check.label || '(unnamed check)';
  try {
    if (check.type === 'selector_exists') {
      const selector = check.selector || '';
      if (!selector) return { label, type: check.type, passed: false, detail: 'No selector configured' };
      const count = $(selector).length;
      const min = check.min_count && check.min_count > 0 ? check.min_count : 1;
      const passed = count >= min;
      return {
        label,
        type: check.type,
        passed,
        detail: `Found ${count} match(es) for "${selector}" (need at least ${min})`
      };
    }

    if (check.type === 'text_contains') {
      const needleRaw = check.text || '';
      if (!needleRaw) return { label, type: check.type, passed: false, detail: 'No text configured' };
      const bodyText = $('body').length ? $('body').text() : $.root().text();
      const haystack = check.case_sensitive ? bodyText : bodyText.toLowerCase();
      const needle = check.case_sensitive ? needleRaw : needleRaw.toLowerCase();
      const passed = haystack.includes(needle);
      return {
        label,
        type: check.type,
        passed,
        detail: passed ? 'Text found in rendered output' : `"${needleRaw}" not found in rendered output`
      };
    }

    if (check.type === 'html_contains') {
      const needle = check.pattern || '';
      if (!needle) return { label, type: check.type, passed: false, detail: 'No pattern configured' };
      const passed = (html || '').includes(needle);
      return {
        label,
        type: check.type,
        passed,
        detail: passed ? 'Pattern found in source' : `"${needle}" not found in source`
      };
    }

    return { label, type: check.type, passed: false, detail: `Unknown check type "${check.type}"` };
  } catch (e) {
    return { label, type: check.type, passed: false, detail: `Error running check: ${e.message}` };
  }
}

function runChecks(html, checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return { results: [], score: null };
  }

  let $;
  try {
    $ = cheerio.load(html || '');
  } catch (e) {
    return {
      results: checks.map((c) => ({ label: c.label, type: c.type, passed: false, detail: 'Could not parse HTML' })),
      score: 0
    };
  }

  const results = checks.map((check) => runOneCheck(html, $, check));
  const score = Math.round((results.filter((r) => r.passed).length / results.length) * 100);
  return { results, score };
}

module.exports = { runChecks };
