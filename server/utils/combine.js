// Multi-file exam support: a student's work can be several files (index.html, styles.css,
// script.js, ...). Auto-grading and the admin's "as rendered" view work on a single HTML string,
// so this folds the files into one document the way a browser would see them.
//
// - <link href="x.css"> / <script src="x.js"> that point at one of the student's files are
//   replaced inline with <style> / <script>.
// - With autoInclude (used for exams), a non-empty .css/.js file that index.html never references
//   is still included (CSS before </head>, JS before </body>), so a student who just types into
//   styles.css or script.js doesn't also have to remember the link/script tags.
// Keep this in step with combineFiles() in public/js/student.js — the preview a student sees
// there must match what gets graded here.

const FILE_NAME_RE = /^[\w.-]{1,40}\.(html|css|js)$/i;
const MAX_FILES = 20;
const MAX_TOTAL_CHARS = 400000;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns a clean { name: content } object, or null if the input isn't acceptable.
function sanitizeFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
  const names = Object.keys(files);
  if (names.length === 0 || names.length > MAX_FILES) return null;
  let total = 0;
  const clean = {};
  for (const name of names) {
    if (!FILE_NAME_RE.test(name) || typeof files[name] !== 'string') return null;
    total += files[name].length;
    if (total > MAX_TOTAL_CHARS) return null;
    clean[name] = files[name];
  }
  return clean;
}

function combineFiles(files, autoInclude) {
  const names = Object.keys(files || {});
  const entry = files && files['index.html'] !== undefined
    ? 'index.html'
    : names.find((n) => /\.html$/i.test(n));
  let html = entry ? files[entry] : '';

  names.forEach((name) => {
    if (/\.css$/i.test(name)) {
      let used = false;
      html = html.replace(new RegExp(`<link[^>]*href=["']\\.?/?${escapeRe(name)}["'][^>]*>`, 'gi'), () => {
        used = true;
        return `<style>\n${files[name]}\n</style>`;
      });
      if (!used && autoInclude && files[name].trim()) {
        const tag = `<style>\n${files[name]}\n</style>`;
        html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${tag}\n</head>`) : tag + html;
      }
    } else if (/\.js$/i.test(name)) {
      const safe = files[name].replace(/<\/script/gi, '<\\/script');
      let used = false;
      html = html.replace(new RegExp(`<script[^>]*src=["']\\.?/?${escapeRe(name)}["'][^>]*>\\s*</script>`, 'gi'), () => {
        used = true;
        return `<script>\n${safe}\n</script>`;
      });
      if (!used && autoInclude && files[name].trim()) {
        const tag = `<script>\n${safe}\n</script>`;
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${tag}\n</body>`) : html + tag;
      }
    }
  });
  return html;
}

function filesToArray(obj) {
  return Object.keys(obj).map((name) => ({ name, content: obj[name] }));
}

function filesToObject(arr) {
  const out = {};
  (arr || []).forEach((f) => { out[f.name] = f.content; });
  return out;
}

module.exports = { sanitizeFiles, combineFiles, filesToArray, filesToObject };
