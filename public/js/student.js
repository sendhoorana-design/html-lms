(function () {
  let me = null;
  let socket = null;
  let currentAssignmentId = null;
  let cm = null;
  let saveTimer = null;
  let heartbeatTimer = null;
  let timerInterval = null;
  let examEndsAt = null;
  let proctoringActive = false;
  let currentInstructions = '';
  let currentRequirements = [];
  let lastAssignments = [];
  let practiceCm = null;
  let practiceSaveTimer = null;

  const $ = (id) => document.getElementById(id);

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Not authenticated');
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.mustChangePassword && path !== '/api/student/change-password') {
      // Caught mid-session — an admin forced a password reset while this student was already
      // logged in. Interrupt whatever they were doing and put up the gate immediately.
      openPasswordModal(true);
      throw Object.assign(new Error(data.error || 'Password change required'), { status: res.status, data });
    }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
    return data;
  }

  async function init() {
    try {
      me = await api('/api/auth/me');
      if (me.role !== 'student') { window.location.href = '/login.html'; return; }
    } catch (e) { return; }

    $('whoami').textContent = `${me.full_name} (${me.username})`;
    $('logoutBtn').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
    $('changePasswordBtn').addEventListener('click', () => openPasswordModal(false));
    $('passwordCancelBtn').addEventListener('click', () => closePasswordModal());
    $('passwordForm').addEventListener('submit', onChangePasswordSubmit);
    $('instructionsBtn').addEventListener('click', openInstructionsModal);
    $('instructionsCloseBtn').addEventListener('click', () => { $('instructionsModal').style.display = 'none'; });
    $('practiceBtn').addEventListener('click', openPractice);
    $('practiceBackBtn').addEventListener('click', () => { showAssignmentList(); });
    $('practiceResetBtn').addEventListener('click', onPracticeReset);
    $('practiceSaveBtn').addEventListener('click', onPracticeSaveAs);
    $('practiceLoadBtn').addEventListener('click', onPracticeLoad);
    $('practiceDeleteBtn').addEventListener('click', onPracticeDelete);
    $('practiceRunBtn').addEventListener('click', runPractice);
    $('practiceReloadBtn').addEventListener('click', runPractice);
    $('practiceThemeBtn').addEventListener('click', togglePracticeTheme);
    $('practiceConsoleToggle').addEventListener('click', (e) => {
      if (e.target.id === 'practiceConsoleClear') return;
      $('practiceConsole').classList.toggle('open');
    });
    $('practiceConsoleClear').addEventListener('click', () => { $('practiceConsoleBody').innerHTML = ''; });
    window.addEventListener('message', onPracticeMessage);
    document.addEventListener('keydown', (e) => {
      if ($('practiceView').style.display !== 'none' && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runPractice();
      }
    });

    socket = io({ withCredentials: true });

    if (me.must_change_password) {
      openPasswordModal(true);
      return;
    }

    await showAssignmentList();
  }

  let passwordModalForced = false;

  function openPasswordModal(forced) {
    passwordModalForced = forced;
    $('passwordModalTitle').textContent = forced ? 'Set a new password' : 'Change your password';
    $('passwordModalSubtitle').style.display = forced ? 'block' : 'none';
    $('passwordCancelBtn').style.display = forced ? 'none' : 'inline-block';
    $('passwordError').textContent = '';
    $('passwordForm').reset();
    $('passwordModal').style.display = 'flex';
  }

  function closePasswordModal() {
    if (passwordModalForced) return; // not dismissable when required
    $('passwordModal').style.display = 'none';
  }

  async function onChangePasswordSubmit(e) {
    e.preventDefault();
    const currentPassword = $('pw_current').value;
    const newPassword = $('pw_new').value;
    const confirmPassword = $('pw_confirm').value;
    const errEl = $('passwordError');
    errEl.textContent = '';

    if (newPassword !== confirmPassword) {
      errEl.textContent = 'New passwords do not match';
      return;
    }
    if (newPassword.length < 6) {
      errEl.textContent = 'New password must be at least 6 characters';
      return;
    }

    try {
      await api('/api/student/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const wasForced = passwordModalForced;
      passwordModalForced = false;
      $('passwordModal').style.display = 'none';
      if (wasForced) {
        me.must_change_password = false;
        await showAssignmentList();
      }
    } catch (err) {
      errEl.textContent = err.message;
    }
  }

  async function showAssignmentList() {
    stopProctoring();
    currentAssignmentId = null;
    $('examView').style.display = 'none';
    $('practiceView').style.display = 'none';
    $('lockOverlay').style.display = 'none';
    $('fullscreenPrompt').style.display = 'none';
    $('violationsPane').style.display = 'none';
    $('testResultsPane').style.display = 'none';
    $('assignmentList').style.display = 'block';

    const assignments = await api('/api/student/assignments');
    lastAssignments = assignments;
    const tbody = document.querySelector('#assignmentsTable tbody');
    tbody.innerHTML = '';
    for (const a of assignments) {
      const tr = document.createElement('tr');
      const isReadOnly = a.status === 'locked' || a.status === 'submitted';
      tr.innerHTML = `
        <td>${escapeHtml(a.title)}</td>
        <td><span class="badge ${a.status}">${a.status.replace('_',' ')}</span></td>
        <td>${a.time_limit_minutes} min</td>
        <td>
          <button class="secondary detailsBtn" data-id="${a.assignment_id}">Details</button>
          ${isReadOnly
            ? `<button class="secondary openBtn" data-id="${a.assignment_id}">View</button>`
            : `<button data-id="${a.assignment_id}" class="openBtn">${a.status === 'not_started' ? 'Start' : 'Resume'}</button>`}
        </td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.openBtn').forEach((btn) => {
      btn.addEventListener('click', () => openAssignment(btn.dataset.id));
    });
    tbody.querySelectorAll('.detailsBtn').forEach((btn) => {
      btn.addEventListener('click', () => showAssignmentPreview(btn.dataset.id));
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function openAssignment(id) {
    let data;
    try {
      data = await api(`/api/student/assignments/${id}`);
    } catch (e) {
      alert(e.message);
      return;
    }

    currentAssignmentId = id;
    $('assignmentList').style.display = 'none';
    $('examView').style.display = 'flex';
    $('examTitle').textContent = data.assignment.title;
    currentInstructions = data.assignment.instructions || '';
    currentRequirements = data.requirements || [];

    const proctoringEnabled = data.assignment.proctoring_enabled !== false;
    $('proctoringOffBadge').style.display = proctoringEnabled ? 'none' : 'inline-block';

    if (data.readOnly) {
      // Past submission or locked exam: show saved code + re-rendered output, read-only, no proctoring.
      $('examTimer').textContent = data.assignment.status === 'submitted' ? 'Submitted' : 'Locked';
      $('readOnlyBanner').style.display = 'inline';
      $('saveStatus').style.display = 'none';
      $('submitBtn').style.display = 'none';
      initEditor(data.code || '', true);
      renderViolations(data.violations || []);
      renderTestResults(data.test_results || [], data.score);
      return;
    }

    $('readOnlyBanner').style.display = 'none';
    $('saveStatus').style.display = 'inline';
    $('submitBtn').style.display = 'inline-block';
    $('violationsPane').style.display = 'none';
    $('testResultsPane').style.display = 'none';

    if (data.assignment.started_at && data.assignment.time_limit_minutes) {
      // started_at comes from the server as a full ISO string that already ends in "Z" (or has
      // an offset) — appending another "Z" here used to produce an Invalid Date, which is still
      // a truthy object, so the timer's "no end time" guard never caught it and the countdown
      // silently ran forever showing NaN:NaN instead of a real time.
      const started = new Date(data.assignment.started_at);
      examEndsAt = new Date(started.getTime() + data.assignment.time_limit_minutes * 60000);
    } else {
      examEndsAt = null;
    }

    initEditor(data.code || '', false);
    if (proctoringEnabled) startProctoring();
    startTimer();

    // Open the instructions modal automatically the first time a student enters an exam, so the
    // problem description isn't something they have to know to go looking for — after that it's
    // just available via the "Instructions" button.
    openInstructionsModal();
  }

  function renderInstructionsModal(title, instructions, requirements) {
    $('instructionsModalTitle').textContent = title || 'Instructions';
    $('instructionsModalBody').textContent = instructions || 'No instructions were provided for this exam.';
    const list = $('instructionsRequirementsList');
    if (requirements && requirements.length) {
      $('instructionsRequirementsWrap').style.display = 'block';
      list.innerHTML = requirements.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
    } else {
      $('instructionsRequirementsWrap').style.display = 'none';
      list.innerHTML = '';
    }
    $('instructionsModal').style.display = 'flex';
  }

  function openInstructionsModal() {
    renderInstructionsModal($('examTitle').textContent, currentInstructions, currentRequirements);
    $('instructionsStartBtn').style.display = 'none';
  }

  // Lets a student see an exam's instructions and requirements checklist from the assignment
  // list, before starting it — i.e. before the timer or proctoring kick in. Uses the data already
  // fetched for the list (no extra request), and never touches the assignment's status.
  function showAssignmentPreview(id) {
    const a = lastAssignments.find((x) => x.assignment_id === id);
    if (!a) return;
    renderInstructionsModal(a.title, a.instructions, a.requirements);
    const startBtn = $('instructionsStartBtn');
    if (a.status === 'not_started' || a.status === 'in_progress') {
      startBtn.style.display = 'inline-block';
      startBtn.textContent = a.status === 'not_started' ? 'Start exam' : 'Resume exam';
      startBtn.onclick = () => {
        $('instructionsModal').style.display = 'none';
        openAssignment(id);
      };
    } else {
      startBtn.style.display = 'none';
    }
  }

  // ---------------- Practice compiler (OneCompiler-style) ----------------
  // Multi-file (HTML/CSS/JS) editor with Run, live preview and a console panel. All state lives
  // in this browser's localStorage, scoped per username — never sent to the server.

  const PRACTICE_DEFAULT_FILES = {
    'index.html': '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="UTF-8" />\n  <title>Practice</title>\n  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n  <h1>Hello, world!</h1>\n  <script src="script.js"></script>\n</body>\n</html>',
    'styles.css': 'body {\n  font-family: Arial, sans-serif;\n}\n',
    'script.js': '// JavaScript goes here\nconsole.log("Hello from script.js");\n'
  };

  let practiceFiles = {};
  let practiceActive = 'index.html';
  let practiceDark = false;
  const practiceDocs = {}; // CodeMirror.Doc per file

  function practiceKey(kind) { return `html-lms-practice-${kind}:${me ? me.username : 'anon'}`; }

  function readJson(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }

  // Saves from the older single-file sandbox have {name, code}; the new format has {name, files}.
  function loadPracticeSaves() {
    const arr = readJson(practiceKey('saves'), []);
    return Array.isArray(arr) ? arr.map((x) => (x.files ? x : { ...x, files: { 'index.html': x.code || '' } })) : [];
  }
  function writePracticeSaves(saves) { writeJson(practiceKey('saves'), saves); }

  function practiceMode(name) {
    if (/\.css$/i.test(name)) return 'css';
    if (/\.js$/i.test(name)) return 'javascript';
    return 'htmlmixed';
  }

  function openPractice() {
    stopProctoring();
    currentAssignmentId = null;
    $('assignmentList').style.display = 'none';
    $('examView').style.display = 'none';
    $('practiceView').style.display = 'flex';

    const draft = readJson(practiceKey('files'), null);
    if (draft && typeof draft === 'object' && Object.keys(draft).length) {
      practiceFiles = draft;
    } else {
      // Migrate the old single-file scratch draft, if there is one.
      let legacy = '';
      try { legacy = localStorage.getItem(`html-lms-practice-code:${me ? me.username : 'anon'}`) || ''; } catch (e) { /* ignore */ }
      practiceFiles = { ...PRACTICE_DEFAULT_FILES };
      if (legacy) practiceFiles['index.html'] = legacy;
    }
    practiceDark = (() => { try { return localStorage.getItem(practiceKey('theme')) === 'dark'; } catch (e) { return false; } })();
    applyPracticeTheme();

    if (!practiceCm) {
      practiceCm = CodeMirror.fromTextArea($('practiceCodeArea'), {
        mode: 'htmlmixed', lineNumbers: true, lineWrapping: true, tabSize: 2, autoCloseBrackets: true
      });
      practiceCm.on('change', () => {
        if (!practiceActive || practiceFiles[practiceActive] === undefined) return;
        practiceFiles[practiceActive] = practiceCm.getValue();
        clearTimeout(practiceSaveTimer);
        practiceSaveTimer = setTimeout(savePracticeDraft, 400);
      });
    }
    Object.keys(practiceDocs).forEach((k) => delete practiceDocs[k]);
    practiceActive = practiceFiles['index.html'] !== undefined ? 'index.html' : Object.keys(practiceFiles)[0];
    renderPracticeTabs();
    switchPracticeFile(practiceActive);
    $('practiceSaveName').value = '';
    $('practiceSaveStatus').textContent = '';
    $('practiceConsoleBody').innerHTML = '';
    refreshPracticeSavedSelect();
    runPractice();
    setTimeout(() => practiceCm.refresh(), 50);
  }

  function savePracticeDraft() { writeJson(practiceKey('files'), practiceFiles); }

  function renderPracticeTabs() {
    const bar = $('practiceTabs');
    bar.innerHTML = '';
    Object.keys(practiceFiles).forEach((name) => {
      const tab = document.createElement('div');
      tab.className = 'pc-tab' + (name === practiceActive ? ' active' : '');
      tab.innerHTML = `<span>${escapeHtml(name)}</span>${Object.keys(practiceFiles).length > 1 ? '<span class="pc-x" title="Delete file">&times;</span>' : ''}`;
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('pc-x')) {
          if (confirm(`Delete ${name}?`)) {
            delete practiceFiles[name];
            delete practiceDocs[name];
            if (practiceActive === name) practiceActive = Object.keys(practiceFiles)[0];
            savePracticeDraft();
            renderPracticeTabs();
            switchPracticeFile(practiceActive);
          }
          return;
        }
        switchPracticeFile(name);
      });
      bar.appendChild(tab);
    });
    const add = document.createElement('div');
    add.className = 'pc-add';
    add.title = 'New file';
    add.textContent = '+';
    add.addEventListener('click', () => {
      const name = (prompt('New file name (e.g. about.html, theme.css, app.js):') || '').trim();
      if (!name) return;
      if (!/^[\w.-]+\.(html|css|js)$/i.test(name)) { alert('File name must end in .html, .css or .js (letters, numbers, - _ . only).'); return; }
      if (practiceFiles[name] !== undefined) { alert('A file with that name already exists.'); return; }
      practiceFiles[name] = '';
      savePracticeDraft();
      renderPracticeTabs();
      switchPracticeFile(name);
    });
    bar.appendChild(add);
  }

  function switchPracticeFile(name) {
    practiceActive = name;
    if (!practiceDocs[name]) practiceDocs[name] = CodeMirror.Doc(practiceFiles[name] || '', practiceMode(name));
    practiceCm.swapDoc(practiceDocs[name]);
    renderPracticeTabs();
    practiceCm.refresh();
    practiceCm.focus();
  }

  function applyPracticeTheme() {
    const view = $('practiceView');
    view.classList.toggle('pc-dark', practiceDark);
    view.classList.toggle('pc-light', !practiceDark);
    if (practiceCm) practiceCm.setOption('theme', practiceDark ? 'dracula' : 'default');
    $('practiceThemeBtn').innerHTML = practiceDark ? '&#9790;' : '&#9788;';
  }
  function togglePracticeTheme() {
    practiceDark = !practiceDark;
    try { localStorage.setItem(practiceKey('theme'), practiceDark ? 'dark' : 'light'); } catch (e) { /* ignore */ }
    applyPracticeTheme();
  }

  // Builds one document for the preview: the entry HTML file, with <link href="x.css"> and
  // <script src="x.js"> pointing at one of the practice files replaced by inline <style>/<script>.
  // A console-capture script is injected first so console.* output and errors show in the panel.
  function buildPracticeDoc() {
    const entry = practiceFiles['index.html'] !== undefined ? 'index.html' : (Object.keys(practiceFiles).find((n) => /\.html$/i.test(n)) || null);
    let html = entry ? practiceFiles[entry] : '';
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    Object.keys(practiceFiles).forEach((name) => {
      if (/\.css$/i.test(name)) {
        html = html.replace(new RegExp(`<link[^>]*href=["']\\.?/?${esc(name)}["'][^>]*>`, 'gi'), () => `<style>\n${practiceFiles[name]}\n</style>`);
      } else if (/\.js$/i.test(name)) {
        html = html.replace(new RegExp(`<script[^>]*src=["']\\.?/?${esc(name)}["'][^>]*>\\s*</script>`, 'gi'), () => `<script>\n${practiceFiles[name].replace(/<\/script/gi, '<\\/script')}\n<\/script>`);
      }
    });
    const capture = `<script>(function(){
      function send(level,args){try{parent.postMessage({__pc:1,level:level,text:Array.prototype.map.call(args,function(a){
        if(typeof a==='object'&&a!==null){try{return JSON.stringify(a,null,2)}catch(e){return String(a)}}return String(a)}).join(' ')},'*')}catch(e){}}
      ['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){send(l,arguments);try{o.apply(console,arguments)}catch(e){}}});
      window.addEventListener('error',function(e){send('error',[e.message+(e.lineno?' (line '+e.lineno+')':'')])});
      window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled promise rejection: '+e.reason])});
    })();<\/script>`;
    return capture + html;
  }

  function runPractice() {
    $('practiceConsoleBody').innerHTML = '';
    $('practiceStatus').textContent = 'Running…';
    $('practicePreview').srcdoc = buildPracticeDoc();
    setTimeout(() => { $('practiceStatus').textContent = 'Ready'; }, 300);
  }

  function onPracticeMessage(e) {
    if (!e.data || e.data.__pc !== 1) return;
    if (e.source !== $('practicePreview').contentWindow) return;
    const body = $('practiceConsoleBody');
    const line = document.createElement('div');
    line.className = 'pc-log ' + (e.data.level === 'error' ? 'error' : e.data.level === 'warn' ? 'warn' : '');
    line.textContent = e.data.text;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
    if (e.data.level === 'error') $('practiceConsole').classList.add('open');
  }

  function onPracticeReset() {
    if (!confirm('Reset to the default index.html / styles.css / script.js? Unsaved work in the sandbox will be lost.')) return;
    practiceFiles = { ...PRACTICE_DEFAULT_FILES };
    Object.keys(practiceDocs).forEach((k) => delete practiceDocs[k]);
    savePracticeDraft();
    practiceActive = 'index.html';
    renderPracticeTabs();
    switchPracticeFile('index.html');
    runPractice();
  }

  function refreshPracticeSavedSelect(selectName) {
    const saves = loadPracticeSaves().sort((a, b) => a.name.localeCompare(b.name));
    const select = $('practiceSavedSelect');
    select.innerHTML = '<option value="">Saved…</option>'
      + saves.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
    if (selectName) select.value = selectName;
  }

  function flashPracticeStatus(msg) {
    const el = $('practiceSaveStatus');
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
  }

  function onPracticeSaveAs() {
    const name = $('practiceSaveName').value.trim();
    if (!name) { flashPracticeStatus('Enter a name first.'); return; }
    const saves = loadPracticeSaves();
    const idx = saves.findIndex((s) => s.name === name);
    if (idx !== -1 && !confirm(`A save named "${name}" already exists. Overwrite it?`)) return;
    const entry = { name, files: { ...practiceFiles }, saved_at: new Date().toISOString() };
    if (idx !== -1) saves[idx] = entry; else saves.push(entry);
    writePracticeSaves(saves);
    refreshPracticeSavedSelect(name);
    flashPracticeStatus(`Saved as "${name}".`);
  }

  function onPracticeLoad() {
    const name = $('practiceSavedSelect').value;
    if (!name) { flashPracticeStatus('Pick a saved session first.'); return; }
    const entry = loadPracticeSaves().find((s) => s.name === name);
    if (!entry) { flashPracticeStatus('That save no longer exists.'); refreshPracticeSavedSelect(); return; }
    practiceFiles = { ...entry.files };
    Object.keys(practiceDocs).forEach((k) => delete practiceDocs[k]);
    savePracticeDraft();
    practiceActive = practiceFiles['index.html'] !== undefined ? 'index.html' : Object.keys(practiceFiles)[0];
    renderPracticeTabs();
    switchPracticeFile(practiceActive);
    $('practiceSaveName').value = name;
    runPractice();
    flashPracticeStatus(`Opened "${name}".`);
  }

  function onPracticeDelete() {
    const name = $('practiceSavedSelect').value;
    if (!name) { flashPracticeStatus('Pick a saved session first.'); return; }
    if (!confirm(`Delete the saved session "${name}"? This can't be undone.`)) return;
    writePracticeSaves(loadPracticeSaves().filter((s) => s.name !== name));
    refreshPracticeSavedSelect();
    flashPracticeStatus(`Deleted "${name}".`);
  }

  function renderViolations(violations) {
    const pane = $('violationsPane');
    const list = $('studentViolationsList');
    if (!violations.length) {
      pane.style.display = 'none';
      return;
    }
    pane.style.display = 'flex';
    list.innerHTML = violations.map((v) => `
      <div style="padding:6px 0; border-bottom:1px solid var(--border);">
        <strong>${escapeHtml(humanType(v.type))}</strong><br/>
        <span class="muted">${escapeHtml((v.created_at || '').slice(0,19))}</span>
      </div>
    `).join('');
  }

  function renderTestResults(testResults, score) {
    const pane = $('testResultsPane');
    const badge = $('studentScoreBadge');
    const list = $('studentTestResultsList');
    if (!testResults || !testResults.length) {
      pane.style.display = 'none';
      return;
    }
    pane.style.display = 'flex';
    let scoreClass = 'low';
    if (typeof score === 'number') {
      scoreClass = score >= 80 ? 'high' : (score >= 50 ? 'mid' : 'low');
      badge.innerHTML = `<span class="score-badge ${scoreClass}">${score}%</span>`;
    } else {
      badge.innerHTML = '';
    }
    list.innerHTML = testResults.map((r) => `
      <div class="test-result-row">
        <span class="dot ${r.passed ? 'pass' : 'fail'}"></span>
        <div>
          <div>${escapeHtml(r.label)}</div>
          <div class="muted">${escapeHtml(r.detail || '')}</div>
        </div>
      </div>
    `).join('');
  }

  function initEditor(code, readOnly) {
    const textarea = $('codeArea');
    textarea.value = code;
    if (cm) { cm.toTextArea(); cm = null; }
    cm = CodeMirror.fromTextArea(textarea, {
      mode: 'htmlmixed',
      theme: 'dracula',
      lineNumbers: true,
      lineWrapping: true,
      tabSize: 2,
      autoCloseBrackets: true,
      readOnly: readOnly ? 'nocursor' : false
    });
    updatePreview();

    if (readOnly) return;

    cm.on('change', () => {
      updatePreview();
      scheduleSave();
    });

    // Block paste / copy / cut inside the editor (best-effort deterrent, logged as violation)
    const wrapper = cm.getWrapperElement();
    wrapper.addEventListener('paste', (e) => { e.preventDefault(); logViolation('paste', 'Paste blocked in editor'); });
    wrapper.addEventListener('copy', (e) => { e.preventDefault(); logViolation('copy', 'Copy blocked in editor'); });
    wrapper.addEventListener('cut', (e) => { e.preventDefault(); logViolation('cut', 'Cut blocked in editor'); });
  }

  function updatePreview() {
    const iframe = $('preview');
    iframe.srcdoc = cm.getValue();
  }

  function scheduleSave() {
    $('saveStatus').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api(`/api/student/assignments/${currentAssignmentId}/code`, {
          method: 'PUT',
          body: JSON.stringify({ code: cm.getValue() })
        });
        $('saveStatus').textContent = 'Saved';
      } catch (e) {
        if (e.status === 423) {
          showLock(e.data.error);
        } else {
          $('saveStatus').textContent = 'Save failed';
        }
      }
    }, 800);
  }

  function startTimer() {
    clearInterval(timerInterval);
    // Defensive: catches both "no end time set" and a malformed/unparseable date, since an
    // Invalid Date object is still truthy and would otherwise slip past a plain !examEndsAt check.
    if (!examEndsAt || isNaN(examEndsAt.getTime())) { $('examTimer').textContent = ''; return; }
    timerInterval = setInterval(() => {
      const remain = examEndsAt - new Date();
      if (remain <= 0) {
        $('examTimer').textContent = 'Time expired';
        clearInterval(timerInterval);
        submitExam(true);
        return;
      }
      const mins = Math.floor(remain / 60000);
      const secs = Math.floor((remain % 60000) / 1000);
      $('examTimer').textContent = `Time remaining: ${mins}:${String(secs).padStart(2, '0')}`;
    }, 1000);
  }

  $('submitBtn').addEventListener('click', () => submitExam(false));
  $('backBtn').addEventListener('click', () => { showAssignmentList(); });
  $('backFromLock').addEventListener('click', () => { showAssignmentList(); });

  // Custom in-page confirmation instead of the native confirm() dialog. Native alert/confirm/
  // prompt dialogs cause browsers to auto-exit fullscreen, which the proctoring code would then
  // log as a violation and show the "fullscreen required" overlay right over the submit flow —
  // that's what made Submit look broken.
  function confirmSubmitDialog() {
    return new Promise((resolve) => {
      const modal = $('submitConfirmModal');
      const yesBtn = $('confirmSubmitYes');
      const noBtn = $('confirmSubmitNo');
      const cleanup = (result) => {
        modal.style.display = 'none';
        yesBtn.removeEventListener('click', onYes);
        noBtn.removeEventListener('click', onNo);
        resolve(result);
      };
      const onYes = () => cleanup(true);
      const onNo = () => cleanup(false);
      yesBtn.addEventListener('click', onYes);
      noBtn.addEventListener('click', onNo);
      modal.style.display = 'flex';
    });
  }

  async function submitExam(auto) {
    if (!currentAssignmentId) return;
    if (!auto) {
      const confirmed = await confirmSubmitDialog();
      if (!confirmed) return;
    }
    try {
      await api(`/api/student/assignments/${currentAssignmentId}/code`, { method: 'PUT', body: JSON.stringify({ code: cm.getValue() }) });
    } catch (e) { /* ignore save error on submit */ }
    await api(`/api/student/assignments/${currentAssignmentId}/submit`, { method: 'POST' });
    stopProctoring();
    await showAssignmentList();
  }

  // ---------------- Proctoring ----------------

  let violationCooldown = {};
  function logViolation(type, detail) {
    // avoid spamming duplicate events within a short window
    const now = Date.now();
    if (violationCooldown[type] && now - violationCooldown[type] < 1500) return;
    violationCooldown[type] = now;

    if (!currentAssignmentId) return;
    api(`/api/student/assignments/${currentAssignmentId}/violation`, {
      method: 'POST',
      body: JSON.stringify({ type, detail })
    }).then((res) => {
      showToast(`Proctoring notice: ${humanType(type)}`);
      if (res.locked) {
        showLock('This exam has been locked due to repeated proctoring violations. Contact your administrator.');
      }
    }).catch(() => {});
  }

  function humanType(type) {
    return {
      tab_switch: 'tab switched / window hidden',
      window_blur: 'left the browser window',
      fullscreen_exit: 'exited fullscreen',
      copy: 'copy blocked',
      paste: 'paste blocked',
      cut: 'cut blocked',
      right_click: 'right-click blocked',
      devtools_attempt: 'developer tools shortcut blocked',
      reload_attempt: 'reload/refresh shortcut blocked',
      back_button: 'back navigation blocked',
      page_exit_attempt: 'tab closed, reloaded, or navigated away'
    }[type] || type;
  }

  function showToast(msg) {
    const el = document.createElement('div');
    el.className = 'violation-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  function showLock(message) {
    stopProctoring();
    $('examView').style.display = 'none';
    $('fullscreenPrompt').style.display = 'none';
    $('lockMessage').textContent = message || 'This exam has been locked.';
    $('lockOverlay').style.display = 'flex';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function onVisibilityChange() {
    if (!proctoringActive) return;
    if (document.hidden) logViolation('tab_switch', 'Tab hidden / switched away');
  }

  function onWindowBlur() {
    if (!proctoringActive) return;
    // Fires on tab switch AND on switching to another application/program.
    logViolation('window_blur', 'Browser window lost focus (tab switch or another program)');
  }

  function onFullscreenChange() {
    if (!proctoringActive) return;
    if (!document.fullscreenElement) {
      logViolation('fullscreen_exit', 'Exited fullscreen mode');
      $('fullscreenPrompt').style.display = 'flex';
    } else {
      $('fullscreenPrompt').style.display = 'none';
    }
  }

  function onContextMenu(e) {
    if (!proctoringActive) return;
    e.preventDefault();
    logViolation('right_click', 'Right-click / context menu blocked');
  }

  function onKeyDown(e) {
    if (!proctoringActive) return;
    const key = e.key;
    const isReload =
      key === 'F5' ||
      ((e.ctrlKey || e.metaKey) && !e.altKey && ['r', 'R'].includes(key));
    const blockedCombo =
      key === 'F12' ||
      (e.ctrlKey && e.shiftKey && ['I', 'J', 'C', 'i', 'j', 'c'].includes(key)) ||
      (e.metaKey && e.altKey && ['I', 'J', 'C', 'i', 'j', 'c'].includes(key)) ||
      (e.ctrlKey && ['u', 'U'].includes(key)) ||
      (e.metaKey && ['u', 'U'].includes(key));

    if (isReload) {
      e.preventDefault();
      logViolation('reload_attempt', `Blocked reload shortcut: ${key}`);
      return;
    }
    if (blockedCombo) {
      e.preventDefault();
      logViolation('devtools_attempt', `Blocked shortcut: ${key}`);
    }
  }

  // Back-button trap: keep re-pushing the current URL onto history so a back-navigation
  // attempt lands right back on the exam instead of actually leaving it, and log it.
  function onPopState() {
    if (!proctoringActive) return;
    history.pushState(null, '', location.href);
    logViolation('back_button', 'Attempted to navigate back during exam');
  }

  // Last-resort capture for anything the handlers above can't stop — e.g. clicking the
  // browser's own reload/back button in its UI chrome, which no webpage can ever intercept;
  // that's a hard platform limit, not something fixable from JS. sendBeacon is used instead of
  // fetch here because a normal fetch can get silently cancelled once the page starts
  // unloading, while sendBeacon is specifically designed to still deliver the request.
  function onBeforeUnload(e) {
    if (!proctoringActive || !currentAssignmentId) return;
    try {
      const blob = new Blob(
        [JSON.stringify({ type: 'page_exit_attempt', detail: 'Tab closed, reloaded, or navigated away' })],
        { type: 'application/json' }
      );
      navigator.sendBeacon(`/api/student/assignments/${currentAssignmentId}/violation`, blob);
    } catch (err) { /* best effort */ }
    e.preventDefault();
    e.returnValue = '';
  }

  $('enterFullscreenBtn').addEventListener('click', () => {
    document.documentElement.requestFullscreen().catch(() => {});
    $('fullscreenPrompt').style.display = 'none';
  });

  function startProctoring() {
    proctoringActive = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('beforeunload', onBeforeUnload);
    history.pushState(null, '', location.href);

    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {
        $('fullscreenPrompt').style.display = 'flex';
      });
    }

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('heartbeat', { assignmentId: currentAssignmentId });
      }
      api(`/api/student/assignments/${currentAssignmentId}/heartbeat`, { method: 'POST' }).catch(() => {});
    }, 15000);
  }

  function stopProctoring() {
    proctoringActive = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('beforeunload', onBeforeUnload);
    clearInterval(heartbeatTimer);
    clearInterval(timerInterval);
  }

  init();
})();
