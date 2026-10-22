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
  let examMulti = false;
  let examFiles = {};
  let examActive = 'index.html';
  let examReadOnly = false;
  const examDocs = {};
  let previewTimer = null;
  let practiceCm = null;
  let practiceSaveTimer = null;

  const $ = (id) => document.getElementById(id);

  // ---------------- Shared compiler helpers (used by the exam editor and the practice sandbox) ----------------
  // Keep combineFiles() in step with server/utils/combine.js — the preview a student sees must
  // match the single document that gets graded.

  const PC_CAPTURE = `<script>(function(){
      function send(level,args){try{parent.postMessage({__pc:1,level:level,text:Array.prototype.map.call(args,function(a){
        if(typeof a==='object'&&a!==null){try{return JSON.stringify(a,null,2)}catch(e){return String(a)}}return String(a)}).join(' ')},'*')}catch(e){}}
      ['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){send(l,arguments);try{o.apply(console,arguments)}catch(e){}}});
      window.addEventListener('error',function(e){send('error',[e.message+(e.lineno?' (line '+e.lineno+')':'')])});
      window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled promise rejection: '+e.reason])});
    })();<\/script>`;

  // Insert the console-capture script *inside* the document (after <head>, else <html>, else the
  // doctype) instead of in front of it. Putting anything before <!DOCTYPE> would drop the preview
  // into quirks mode and change how the page lays out.
  function injectCapture(html) {
    const at = (re) => {
      const m = re.exec(html);
      return m ? m.index + m[0].length : -1;
    };
    let pos = at(/<head[^>]*>/i);
    if (pos < 0) pos = at(/<html[^>]*>/i);
    if (pos < 0) pos = at(/<!doctype[^>]*>/i);
    if (pos < 0) return PC_CAPTURE + html;
    return html.slice(0, pos) + PC_CAPTURE + html.slice(pos);
  }

  function combineFiles(files, autoInclude) {
    const esc = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const names = Object.keys(files || {});
    const entry = files && files['index.html'] !== undefined ? 'index.html' : names.find((n) => /\.html$/i.test(n));
    let html = entry ? files[entry] : '';
    names.forEach((name) => {
      if (/\.css$/i.test(name)) {
        let used = false;
        html = html.replace(new RegExp(`<link[^>]*href=["']\\.?/?${esc(name)}["'][^>]*>`, 'gi'), () => { used = true; return `<style>\n${files[name]}\n</style>`; });
        if (!used && autoInclude && files[name].trim()) {
          const tag = `<style>\n${files[name]}\n</style>`;
          html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${tag}\n</head>`) : tag + html;
        }
      } else if (/\.js$/i.test(name)) {
        const safe = files[name].replace(/<\/script/gi, '<\\/script');
        let used = false;
        html = html.replace(new RegExp(`<script[^>]*src=["']\\.?/?${esc(name)}["'][^>]*>\\s*</script>`, 'gi'), () => { used = true; return `<script>\n${safe}\n<\/script>`; });
        if (!used && autoInclude && files[name].trim()) {
          const tag = `<script>\n${safe}\n<\/script>`;
          html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${tag}\n</body>`) : html + tag;
        }
      }
    });
    return html;
  }

  function appendConsoleLine(bodyId, consoleId, data) {
    const body = $(bodyId);
    const line = document.createElement('div');
    line.className = 'pc-log ' + (data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : '');
    line.textContent = data.text;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
    if (data.level === 'error') $(consoleId).classList.add('open');
  }

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
      try { await api('/api/student/presence', { method: 'POST', body: JSON.stringify({ offline: true }) }); } catch (e) { /* ignore */ }
      await api('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
    $('changePasswordBtn').addEventListener('click', () => openPasswordModal(false));
    $('passwordCancelBtn').addEventListener('click', () => closePasswordModal());
    $('passwordForm').addEventListener('submit', onChangePasswordSubmit);
    $('instructionsBtn').addEventListener('click', openInstructionsModal);
    $('instructionsCloseBtn').addEventListener('click', () => { $('instructionsModal').style.display = 'none'; });
    $('practiceBtn').addEventListener('click', openPractice);
    $('feedbackBtn').addEventListener('click', openFeedback);
    $('feedbackCloseBtn').addEventListener('click', () => { $('feedbackModal').style.display = 'none'; });
    wireChallenges();
    startPresence();
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
    $('examRunBtn').addEventListener('click', renderExamPreview);
    $('examConsoleToggle').addEventListener('click', (e) => {
      if (e.target.id === 'examConsoleClear') return;
      $('examConsole').classList.toggle('open');
    });
    $('examConsoleClear').addEventListener('click', () => { $('examConsoleBody').innerHTML = ''; });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if ($('practiceView').style.display !== 'none') { e.preventDefault(); runPractice(); }
        else if ($('examView').style.display !== 'none') { e.preventDefault(); renderExamPreview(); }
      }
    });

    socket = io({ withCredentials: true });
    wireLivePresentation();

    if (me.must_change_password) {
      openPasswordModal(true);
      return;
    }

    await showAssignmentList();
  }


  // ---------------- Live presentation (follows the admin) ----------------

  let live = null;            // { id, title, slide_count, index } while a presentation is live for me
  let liveDismissed = false;  // only used while an exam is open, so the overlay never traps a student mid-exam

  function examIsOpen() {
    const v = $('examView');
    return !!v && v.style.display !== 'none' && v.style.display !== '';
  }

  function renderLive() {
    const ov = $('liveSlideOverlay'); const banner = $('liveSlideBanner');
    if (!live) { ov.style.display = 'none'; banner.style.display = 'none'; $('liveSlideImg').removeAttribute('src'); liveDismissed = false; return; }
    const inExam = examIsOpen();
    $('liveSlideBackBtn').style.display = inExam ? '' : 'none';
    if (inExam && liveDismissed) { ov.style.display = 'none'; banner.style.display = 'block'; return; }
    banner.style.display = 'none';
    ov.style.display = 'flex';
    $('liveSlideTitle').textContent = live.title;
    $('liveSlideCounter').textContent = `Slide ${live.index + 1} / ${live.slide_count}`;
    const url = `/api/presentations/${live.id}/slides/${live.index}`;
    const img = $('liveSlideImg');
    if (img.getAttribute('src') !== url) img.src = url;
    if (live.index + 1 < live.slide_count) { const nx = new Image(); nx.src = `/api/presentations/${live.id}/slides/${live.index + 1}`; }
  }

  function applyLiveState(st) {
    if (!st || !st.live) {
      // Only clear if this event is about the presentation we're showing (or we have none).
      if (!live || !st || st.id === live.id) { live = null; renderLive(); }
      else { refreshLive(); }
      return;
    }
    const changed = !live || live.id !== st.id;
    live = { id: st.id, title: st.title, slide_count: st.slide_count, index: st.index };
    if (changed) liveDismissed = false;
    renderLive();
  }

  async function refreshLive() {
    try {
      const r = await api('/api/presentations/live');
      applyLiveState(r.presentation);
    } catch (e) { /* offline / not ready — next poll will retry */ }
  }

  function wireLivePresentation() {
    if (socket) {
      socket.on('presentation_state', (st) => {
        // Events are already scoped by room to presentations meant for me. If two are live
        // (main admin + my admin) re-ask the server which one wins.
        if (live && st.id !== live.id && st.live) refreshLive(); else applyLiveState(st);
      });
      socket.on('connect', refreshLive); // catches up after a dropped connection / late join
    }
    $('liveSlideBackBtn').addEventListener('click', () => { liveDismissed = true; renderLive(); });
    $('liveSlideBanner').addEventListener('click', () => { liveDismissed = false; renderLive(); });
    // Block context menu / dragging on the slide; polling is a safety net if the socket drops.
    $('liveSlideOverlay').addEventListener('contextmenu', (e) => e.preventDefault());
    setInterval(refreshLive, 20000);
    refreshLive();
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
    clearTimeout(saveTimer);
    clearTimeout(previewTimer);
    stopProctoring();
    currentAssignmentId = null;
    $('examView').style.display = 'none';
    $('practiceView').style.display = 'none';
    $('lockOverlay').style.display = 'none';
    $('fullscreenPrompt').style.display = 'none';
    $('violationsPane').style.display = 'none';
    $('testResultsPane').style.display = 'none';
    $('assignmentList').style.display = 'block';

    refreshFeedbackButton();
    loadChallenges();
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

    // Multi-file exams (HTML/CSS/JS tabs) vs the classic single-file editor.
    examMulti = !!data.assignment.multi_file_enabled;
    examFiles = examMulti
      ? (data.files && Object.keys(data.files).length ? { ...data.files } : { 'index.html': data.code || '', 'styles.css': '', 'script.js': '' })
      : {};
    $('examConsoleBody').innerHTML = '';

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


  // ---------------- Feedback (anonymous) ----------------

  const FEEDBACK_CATEGORIES = [
    { key: 'software', title: 'HTML LMS Software', hint: 'How easy and reliable is this software to use?' },
    { key: 'theory', title: 'Theory Class', hint: 'How was the theory class — clarity, pace, usefulness?' },
    { key: 'practical', title: 'Practical Class', hint: 'How was the practical/lab class — guidance, tasks, time?' }
  ];
  let feedbackSettings = { software: false, theory: false, practical: false };

  // The Feedback button only appears if the admin has at least one category switched on.
  async function refreshFeedbackButton() {
    try {
      feedbackSettings = await api('/api/student/feedback/settings');
    } catch (e) {
      feedbackSettings = { software: false, theory: false, practical: false };
    }
    $('feedbackBtn').style.display = Object.values(feedbackSettings).some(Boolean) ? 'inline-block' : 'none';
  }

  async function openFeedback() {
    await refreshFeedbackButton(); // settings may have changed since the page loaded
    const box = $('feedbackCards');
    const open = FEEDBACK_CATEGORIES.filter((c) => feedbackSettings[c.key]);
    if (!open.length) {
      box.innerHTML = '<p class="muted">Feedback is currently closed.</p>';
      $('feedbackModal').style.display = 'flex';
      return;
    }
    box.innerHTML = open.map((c) => `
      <div class="fb-card" data-cat="${c.key}">
        <strong>${escapeHtml(c.title)}</strong>
        <div class="muted" style="font-size:12px;">${escapeHtml(c.hint)}</div>
        <div class="fb-stars" data-rating="0">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="fb-star" data-n="${n}" title="${n} / 5">${n}</button>`).join('')}
        </div>
        <textarea class="fb-comments" rows="3" maxlength="2000" placeholder="Comments (optional)"></textarea>
        <div style="display:flex; gap:10px; align-items:center; margin-top:8px;">
          <button type="button" class="fb-submit">Submit</button>
          <span class="muted fb-status" style="font-size:12px;"></span>
        </div>
      </div>`).join('');

    box.querySelectorAll('.fb-card').forEach((card) => {
      const stars = card.querySelector('.fb-stars');
      stars.querySelectorAll('.fb-star').forEach((btn) => {
        btn.addEventListener('click', () => {
          const n = parseInt(btn.dataset.n, 10);
          stars.dataset.rating = String(n);
          stars.querySelectorAll('.fb-star').forEach((b) => b.classList.toggle('on', parseInt(b.dataset.n, 10) <= n));
        });
      });
      card.querySelector('.fb-submit').addEventListener('click', async () => {
        const status = card.querySelector('.fb-status');
        const rating = parseInt(stars.dataset.rating, 10);
        if (!rating) { status.textContent = 'Pick a rating from 1 to 5 first.'; return; }
        const submitBtn = card.querySelector('.fb-submit');
        submitBtn.disabled = true;
        try {
          await api('/api/student/feedback', {
            method: 'POST',
            body: JSON.stringify({ category: card.dataset.cat, rating, comments: card.querySelector('.fb-comments').value })
          });
          status.textContent = 'Thank you! Your anonymous feedback was sent.';
          card.querySelector('.fb-comments').value = '';
          stars.dataset.rating = '0';
          stars.querySelectorAll('.fb-star').forEach((b) => b.classList.remove('on'));
        } catch (err) {
          status.textContent = err.message;
        }
        submitBtn.disabled = false;
      });
    });
    $('feedbackModal').style.display = 'flex';
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

  function buildPracticeDoc() {
    return injectCapture(combineFiles(practiceFiles, false));
  }

  function runPractice() {
    $('practiceConsoleBody').innerHTML = '';
    $('practiceStatus').textContent = 'Running…';
    $('practicePreview').srcdoc = buildPracticeDoc();
    setTimeout(() => { $('practiceStatus').textContent = 'Ready'; }, 300);
  }

  // Console output from either preview iframe (exam editor or practice sandbox).
  function onPracticeMessage(e) {
    if (!e.data || e.data.__pc !== 1) return;
    if (e.source === $('practicePreview').contentWindow) appendConsoleLine('practiceConsoleBody', 'practiceConsole', e.data);
    else if (e.source === $('preview').contentWindow) appendConsoleLine('examConsoleBody', 'examConsole', e.data);
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
    examReadOnly = readOnly;
    const textarea = $('codeArea');
    examActive = examMulti ? (examFiles['index.html'] !== undefined ? 'index.html' : Object.keys(examFiles)[0]) : 'index.html';
    // Tear down the previous editor *before* setting the textarea's value: CodeMirror's
    // toTextArea() writes the old editor's content back into the textarea, which used to clobber
    // the freshly loaded code — so opening a second assignment showed the previous one's code
    // (and autosave could then overwrite the real code with it).
    if (cm) { cm.toTextArea(); cm = null; }
    textarea.value = examMulti ? (examFiles[examActive] || '') : code;
    Object.keys(examDocs).forEach((k) => delete examDocs[k]);
    cm = CodeMirror.fromTextArea(textarea, {
      mode: examMulti ? examModeFor(examActive) : 'htmlmixed',
      theme: 'dracula',
      lineNumbers: true,
      lineWrapping: true,
      tabSize: 2,
      autoCloseBrackets: true,
      readOnly: readOnly ? 'nocursor' : false
    });
    $('examPaneHeader').style.display = examMulti ? 'none' : 'block';
    $('examTabs').style.display = examMulti ? 'flex' : 'none';
    if (examMulti) {
      examDocs[examActive] = cm.getDoc();
      renderExamTabs();
    }
    renderExamPreview();

    if (readOnly) return;

    cm.on('change', () => {
      if (examMulti) examFiles[examActive] = cm.getValue();
      schedulePreview();
      scheduleSave();
    });

    // Block paste / copy / cut inside the editor (best-effort deterrent, logged as violation)
    const wrapper = cm.getWrapperElement();
    wrapper.addEventListener('paste', (e) => { e.preventDefault(); logViolation('paste', 'Paste blocked in editor'); });
    wrapper.addEventListener('copy', (e) => { e.preventDefault(); logViolation('copy', 'Copy blocked in editor'); });
    wrapper.addEventListener('cut', (e) => { e.preventDefault(); logViolation('cut', 'Cut blocked in editor'); });
  }

  function examModeFor(name) {
    if (/\.css$/i.test(name)) return 'css';
    if (/\.js$/i.test(name)) return 'javascript';
    return 'htmlmixed';
  }

  // Native prompt()/confirm() dialogs make browsers exit fullscreen, which proctoring would log
  // as a violation — so adding/deleting files in the exam editor uses inline controls instead.
  let examTabMessage = '';
  function renderExamTabs() {
    const bar = $('examTabs');
    bar.innerHTML = '';
    const names = Object.keys(examFiles);
    names.forEach((name) => {
      const tab = document.createElement('div');
      tab.className = 'pc-tab' + (name === examActive ? ' active' : '');
      const deletable = !examReadOnly && name !== 'index.html';
      tab.innerHTML = `<span>${escapeHtml(name)}</span>${deletable ? '<span class="pc-x" title="Delete file">&times;</span>' : ''}`;
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('pc-x')) {
          const x = e.target;
          if (x.dataset.armed) {
            delete examFiles[name];
            delete examDocs[name];
            if (examActive === name) examActive = 'index.html';
            examTabMessage = '';
            switchExamFile(examActive);
            scheduleSave();
            schedulePreview();
          } else {
            x.dataset.armed = '1';
            x.textContent = 'delete?';
            setTimeout(() => { if (x.isConnected) { delete x.dataset.armed; x.innerHTML = '&times;'; } }, 3000);
          }
          return;
        }
        switchExamFile(name);
      });
      bar.appendChild(tab);
    });
    if (!examReadOnly) {
      const add = document.createElement('div');
      add.className = 'pc-add';
      add.title = 'New file';
      add.textContent = '+';
      add.addEventListener('click', () => {
        add.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'name.css / .js / .html';
        input.style.cssText = 'width:160px; margin:4px 8px; padding:4px 8px; font-size:12px;';
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape') { renderExamTabs(); return; }
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          const name = input.value.trim();
          if (!/^[\w.-]{1,40}\.(html|css|js)$/i.test(name)) { examTabMessage = 'Use a name ending in .html, .css or .js'; renderExamTabs(); return; }
          if (examFiles[name] !== undefined) { examTabMessage = 'That file already exists'; renderExamTabs(); return; }
          if (Object.keys(examFiles).length >= 20) { examTabMessage = 'Too many files'; renderExamTabs(); return; }
          examFiles[name] = '';
          examTabMessage = '';
          switchExamFile(name);
          scheduleSave();
        });
        bar.appendChild(input);
        input.focus();
      });
      bar.appendChild(add);
    }
    if (examTabMessage) {
      const msg = document.createElement('span');
      msg.style.cssText = 'color:#dc3a5e; font-size:12px; padding:0 10px;';
      msg.textContent = examTabMessage;
      bar.appendChild(msg);
    }
  }

  function switchExamFile(name) {
    examActive = name;
    if (!examDocs[name]) examDocs[name] = CodeMirror.Doc(examFiles[name] || '', examModeFor(name));
    cm.swapDoc(examDocs[name]);
    renderExamTabs();
    cm.refresh();
    if (!examReadOnly) cm.focus();
  }

  function buildExamDoc() {
    return injectCapture(examMulti ? combineFiles(examFiles, true) : cm.getValue());
  }

  function renderExamPreview() {
    clearTimeout(previewTimer);
    $('examConsoleBody').innerHTML = '';
    $('preview').srcdoc = buildExamDoc();
  }

  // Re-rendering re-runs the student's JavaScript, so wait for a pause in typing first instead of
  // re-running (and re-logging) on every keystroke.
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderExamPreview, 500);
  }

  function savePayload() {
    return examMulti ? { files: examFiles } : { code: cm.getValue() };
  }

  function scheduleSave() {
    $('saveStatus').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api(`/api/student/assignments/${currentAssignmentId}/code`, {
          method: 'PUT',
          body: JSON.stringify(savePayload())
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
    clearTimeout(saveTimer); // the final save below supersedes any pending autosave
    try {
      await api(`/api/student/assignments/${currentAssignmentId}/code`, { method: 'PUT', body: JSON.stringify(savePayload()) });
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

  // ---------------- Presence (powers the admin Live Monitor's active / idle / offline lists) ----------------

  let lastActivityAt = Date.now();
  let presenceTimer = null;

  function startPresence() {
    const mark = () => { lastActivityAt = Date.now(); };
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click', 'wheel'].forEach((ev) => {
      window.addEventListener(ev, mark, { passive: true, capture: true });
    });
    const ping = () => {
      const visible = document.visibilityState !== 'hidden';
      const active = visible && (Date.now() - lastActivityAt) < 35000;
      api('/api/student/presence', { method: 'POST', body: JSON.stringify({ active }) }).catch(() => {});
    };
    ping();
    clearInterval(presenceTimer);
    presenceTimer = setInterval(ping, 30000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ping(); });
  }

  function sendOffline() {
    try {
      const blob = new Blob([JSON.stringify({ offline: true })], { type: 'application/json' });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/student/presence', blob);
    } catch (e) { /* best-effort */ }
  }

  // ---------------- Challenges ----------------

  const CH_TYPE_LABEL = { quiz: 'Quiz', fill: 'Fill the blanks', fix: 'Find the bug', order: 'Order the code' };
  let chItems = [];
  let chSummary = { total_points: 0, completed: 0, rank: null, ranked_students: 0 };
  let chCurrent = null;       // the challenge open in the player
  let chShownList = [];       // filtered list at the time of opening (for "Next")
  let chPlayerState = null;   // type-specific selection state

  function showTab(which) {
    const challenges = which === 'challenges';
    $('examsPane').style.display = challenges ? 'none' : 'block';
    $('challengesPane').style.display = challenges ? 'block' : 'none';
    $('tabExamsBtn').classList.toggle('active', !challenges);
    $('tabChallengesBtn').classList.toggle('active', challenges);
    if (challenges) loadChallenges();
  }

  function updatePointsChip() {
    $('ptsChip').style.display = 'flex';
    $('ptsChipValue').textContent = String(chSummary.total_points || 0);
    $('ptsChipRank').textContent = chSummary.rank ? `· rank #${chSummary.rank} of ${chSummary.ranked_students}` : '';
    const total = chItems.length;
    $('chProgressBar').style.width = total ? `${Math.round((chSummary.completed / total) * 100)}%` : '0%';
  }

  async function loadChallenges() {
    try {
      const data = await api('/api/student/challenges');
      chItems = data.challenges || [];
      chSummary = data.summary || chSummary;
    } catch (e) { return; }
    const units = Array.from(new Set(chItems.map((c) => (c.topic || '').split(' (')[0]).filter(Boolean)));
    const sel = $('chFilterUnit');
    const keep = sel.value;
    sel.innerHTML = '<option value="">All units</option>' + units.map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
    sel.value = units.includes(keep) ? keep : '';
    updatePointsChip();
    renderChallengeGrid();
  }

  function filteredChallenges() {
    const t = $('chFilterType').value;
    const u = $('chFilterUnit').value;
    const st = $('chFilterStatus').value;
    return chItems.filter((c) =>
      (!t || c.type === t) &&
      (!u || (c.topic || '').startsWith(u)) &&
      (!st || (st === 'done' ? c.completed : !c.completed)));
  }

  function renderChallengeGrid() {
    const list = filteredChallenges();
    $('chEmpty').style.display = list.length ? 'none' : 'block';
    $('chGrid').innerHTML = list.map((c) => `
      <div class="ch-card ${c.completed ? 'done' : ''}" data-id="${c.id}">
        ${c.completed ? '<span class="ch-done-mark">✓</span>' : ''}
        <div class="ch-title">${escapeHtml(c.title)}</div>
        <div class="muted" style="font-size:12px;">${escapeHtml(c.topic)}</div>
        <div class="ch-meta">
          <span class="ch-tag ${c.type}">${CH_TYPE_LABEL[c.type] || c.type}</span>
          <span class="ch-tag ${c.difficulty}">${c.difficulty}</span>
          <span class="ch-pts">${c.completed ? '+' + c.earned : c.points} pts</span>
        </div>
      </div>`).join('');
    $('chGrid').querySelectorAll('.ch-card').forEach((card) => {
      card.addEventListener('click', () => openChallenge(card.dataset.id));
    });
  }

  function chMetaHtml(c) {
    return `<span class="ch-tag ${c.type}">${CH_TYPE_LABEL[c.type] || c.type}</span>
      <span class="ch-tag ${c.difficulty}">${c.difficulty}</span>
      <span class="ch-pts" style="margin-left:6px;">${c.points} pts</span>
      <span class="muted" style="font-size:12px; margin-left:6px;">${escapeHtml(c.topic)}</span>`;
  }

  function openChallenge(id) {
    const c = chItems.find((x) => x.id === id);
    if (!c) return;
    chCurrent = c;
    chShownList = filteredChallenges();
    chPlayerState = {};
    $('chMeta').innerHTML = chMetaHtml(c);
    $('chTitle').textContent = c.title;
    $('chPrompt').textContent = c.prompt || '';
    $('chFeedback').className = 'ch-feedback';
    $('chFeedback').innerHTML = '';
    $('chHintText').textContent = '';
    $('chHintBtn').style.display = c.hint ? 'inline-block' : 'none';
    $('chHintBtn').textContent = 'Show hint';
    $('chNextBtn').style.display = 'none';
    $('chCheckBtn').style.display = 'inline-block';
    $('chCheckBtn').disabled = false;
    const body = $('chBody');
    if (c.type === 'quiz') renderQuiz(body, c);
    else if (c.type === 'fill') renderFill(body, c);
    else if (c.type === 'fix') renderFix(body, c);
    else if (c.type === 'order') renderOrder(body, c);
    $('challengeModal').style.display = 'flex';
  }

  function closeChallenge() {
    $('challengeModal').style.display = 'none';
    chCurrent = null;
  }

  function renderQuiz(body, c) {
    body.innerHTML = (c.code ? `<pre class="ch-code">${escapeHtml(c.code)}</pre>` : '') +
      c.options.map((o, i) => `<button type="button" class="ch-opt" data-i="${i}">${escapeHtml(o)}</button>`).join('');
    body.querySelectorAll('.ch-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        if ($('chCheckBtn').disabled) return;
        body.querySelectorAll('.ch-opt').forEach((b) => b.classList.remove('sel', 'wrong'));
        btn.classList.add('sel');
        chPlayerState.answer = parseInt(btn.dataset.i, 10);
      });
    });
  }

  function renderFill(body, c) {
    const parts = c.code.split('___');
    let html = '';
    parts.forEach((p, i) => {
      html += escapeHtml(p);
      if (i < parts.length - 1) html += `<input class="ch-blank" data-i="${i}" autocomplete="off" spellcheck="false" size="10" placeholder="…">`;
    });
    body.innerHTML = `<pre class="ch-code">${html}</pre>`;
    body.querySelectorAll('.ch-blank').forEach((inp) => {
      inp.addEventListener('input', () => { inp.classList.remove('wrong', 'right'); inp.size = Math.max(10, inp.value.length + 2); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitChallenge(); } });
    });
    const first = body.querySelector('.ch-blank'); if (first) setTimeout(() => first.focus(), 50);
  }

  function renderFix(body, c) {
    const lines = c.code.split('\n');
    body.innerHTML = '<div class="ch-code" style="white-space:normal;">' + lines.map((l, i) =>
      `<div class="ch-line" data-n="${i + 1}"><span class="n">${i + 1}</span><span style="white-space:pre;">${escapeHtml(l) || ' '}</span></div>`).join('') + '</div>';
    body.querySelectorAll('.ch-line').forEach((row) => {
      row.addEventListener('click', () => {
        if ($('chCheckBtn').disabled) return;
        body.querySelectorAll('.ch-line').forEach((r) => r.classList.remove('sel', 'wrong'));
        row.classList.add('sel');
        chPlayerState.answer = parseInt(row.dataset.n, 10);
      });
    });
    $('chCheckBtn').textContent = 'This is the buggy line';
  }

  function renderOrder(body, c) {
    body.innerHTML = '<div id="chOrderList" class="ch-code" style="white-space:normal;"></div><div class="muted" style="font-size:12px;">Drag the lines (or use the arrows) into the right order.</div>';
    const list = $('chOrderList');
    c.lines.forEach((l) => list.appendChild(orderItem(l)));
    let dragged = null;
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      const over = e.target.closest('.ch-item');
      list.querySelectorAll('.ch-item').forEach((i) => i.classList.remove('over'));
      if (over && over !== dragged) over.classList.add('over');
    });
    list.addEventListener('dragstart', (e) => { dragged = e.target.closest('.ch-item'); if (dragged) { dragged.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', ''); } catch (x) { /* old browsers */ } } });
    list.addEventListener('dragend', () => { if (dragged) dragged.classList.remove('drag'); list.querySelectorAll('.ch-item').forEach((i) => i.classList.remove('over')); dragged = null; });
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      const over = e.target.closest('.ch-item');
      if (dragged && over && over !== dragged) {
        const items = Array.from(list.children);
        if (items.indexOf(dragged) < items.indexOf(over)) over.after(dragged); else over.before(dragged);
      }
    });
    $('chCheckBtn').textContent = 'Check order';
  }

  function orderItem(text) {
    const el = document.createElement('div');
    el.className = 'ch-item';
    el.draggable = true;
    el.dataset.text = text;
    el.innerHTML = `<span class="grip">⠿</span><span class="txt">${escapeHtml(text)}</span><button type="button" class="secondary up" title="Move up">↑</button><button type="button" class="secondary down" title="Move down">↓</button>`;
    el.querySelector('.up').addEventListener('click', () => { const p = el.previousElementSibling; if (p) p.before(el); });
    el.querySelector('.down').addEventListener('click', () => { const n = el.nextElementSibling; if (n) n.after(el); });
    return el;
  }

  function collectAnswer(c) {
    if (c.type === 'quiz' || c.type === 'fix') return chPlayerState.answer;
    if (c.type === 'fill') return Array.from($('chBody').querySelectorAll('.ch-blank')).map((i) => i.value);
    if (c.type === 'order') return Array.from($('chOrderList').children).map((i) => i.dataset.text);
    return null;
  }

  async function submitChallenge() {
    const c = chCurrent;
    if (!c || $('chCheckBtn').disabled) return;
    const answer = collectAnswer(c);
    const fb = $('chFeedback');
    if ((c.type === 'quiz' || c.type === 'fix') && (answer === undefined || answer === null)) {
      fb.className = 'ch-feedback bad';
      fb.textContent = c.type === 'quiz' ? 'Pick an option first.' : 'Click the line you think has the bug first.';
      return;
    }
    if (c.type === 'fill' && answer.every((a) => !String(a).trim())) {
      fb.className = 'ch-feedback bad';
      fb.textContent = 'Type something into the blank first.';
      return;
    }
    $('chCheckBtn').disabled = true;
    let res;
    try {
      res = await api(`/api/student/challenges/${c.id}/attempt`, { method: 'POST', body: JSON.stringify({ answer }) });
    } catch (e) {
      fb.className = 'ch-feedback bad';
      fb.textContent = e.message || 'Could not check your answer.';
      $('chCheckBtn').disabled = false;
      return;
    }
    c.attempts = (c.attempts || 0) + 1;
    if (res.summary) { chSummary = res.summary; }
    if (res.correct) onChallengeSolved(c, res); else onChallengeWrong(c, res);
  }

  function onChallengeWrong(c, res) {
    const box = $('challengeBox');
    box.classList.remove('ch-shake'); void box.offsetWidth; box.classList.add('ch-shake');
    const fb = $('chFeedback');
    let msg = 'Not quite – try again!';
    if (c.type === 'fill' && res.detail && res.detail.blanks) {
      const inputs = $('chBody').querySelectorAll('.ch-blank');
      res.detail.blanks.forEach((ok, i) => { if (inputs[i]) inputs[i].classList.add(ok ? 'right' : 'wrong'); });
      const right = res.detail.blanks.filter(Boolean).length;
      msg = `${right} of ${res.detail.blanks.length} blank${res.detail.blanks.length === 1 ? '' : 's'} correct. Fix the red one${res.detail.blanks.length - right === 1 ? '' : 's'} and check again.`;
    } else if (c.type === 'quiz') {
      const sel = $('chBody').querySelector('.ch-opt.sel');
      if (sel) { sel.classList.remove('sel'); sel.classList.add('wrong'); }
      chPlayerState.answer = undefined;
    } else if (c.type === 'fix') {
      const sel = $('chBody').querySelector('.ch-line.sel');
      if (sel) { sel.classList.remove('sel'); sel.classList.add('wrong'); }
      chPlayerState.answer = undefined;
      msg = 'That line is fine. Look again!';
    } else if (c.type === 'order' && res.detail) {
      msg = `${res.detail.placed} of ${res.detail.total} lines are in the right place. Keep rearranging!`;
      Array.from($('chOrderList').children).forEach((el) => el.classList.remove('right', 'wrong'));
    }
    fb.className = 'ch-feedback bad';
    fb.textContent = msg;
    $('chCheckBtn').disabled = false;
  }

  function onChallengeSolved(c, res) {
    const first = res.awarded > 0;
    if (first) { c.completed = true; c.earned = res.awarded; }
    const fb = $('chFeedback');
    fb.className = 'ch-feedback ok';
    fb.innerHTML = (first
      ? `<div class="ch-earned ch-pop">+<span id="chEarnedNum">0</span> points!</div>`
      : `<div class="ch-pop"><strong>Correct!</strong> <span class="muted">You already earned the points for this one.</span></div>`) +
      (res.explanation ? `<div style="margin-top:6px;">${escapeHtml(res.explanation)}</div>` : '') +
      `<div class="muted" style="margin-top:6px; font-size:12px;">Total: ${chSummary.total_points} pts · ${chSummary.completed} challenge${chSummary.completed === 1 ? '' : 's'} solved${chSummary.rank ? ' · rank #' + chSummary.rank : ''}</div>`;
    if (first) countUp($('chEarnedNum'), res.awarded);
    // mark the right answer visually
    const body = $('chBody');
    if (c.type === 'quiz') { const sel = body.querySelector('.ch-opt.sel'); if (sel) { sel.classList.remove('sel'); sel.classList.add('right'); } }
    if (c.type === 'fix') { const sel = body.querySelector('.ch-line.sel'); if (sel) { sel.classList.remove('sel'); sel.classList.add('right'); } }
    if (c.type === 'fill') body.querySelectorAll('.ch-blank').forEach((i) => { i.classList.remove('wrong'); i.classList.add('right'); i.readOnly = true; });
    if (c.type === 'order') Array.from($('chOrderList').children).forEach((el) => { el.classList.add('right'); el.draggable = false; el.querySelectorAll('button').forEach((b) => { b.disabled = true; }); });
    $('chCheckBtn').style.display = 'none';
    const next = nextChallenge(c);
    $('chNextBtn').style.display = next ? 'inline-block' : 'none';
    $('chNextBtn').dataset.next = next ? next.id : '';
    updatePointsChip();
    renderChallengeGrid();
    launchConfetti(first ? 140 : 40);
  }

  function nextChallenge(c) {
    const list = chShownList.length ? chShownList : chItems;
    const i = list.findIndex((x) => x.id === c.id);
    for (let k = 1; k <= list.length; k++) {
      const cand = list[(i + k) % list.length];
      if (cand && !cand.completed && cand.id !== c.id) return cand;
    }
    return null;
  }

  function countUp(el, target) {
    if (!el) return;
    const start = performance.now();
    const dur = 700;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      el.textContent = String(Math.round(target * t));
      if (t < 1) requestAnimationFrame(step); else el.textContent = String(target);
    };
    requestAnimationFrame(step);
  }

  function launchConfetti(count) {
    const cv = $('confettiCanvas');
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    cv.style.display = 'block';
    cv.width = window.innerWidth; cv.height = window.innerHeight;
    const colors = ['#5b7cfa', '#34d399', '#fbbf24', '#f87171', '#c084fc', '#38bdf8'];
    const bits = Array.from({ length: count }, () => ({
      x: cv.width / 2 + (Math.random() - 0.5) * 200, y: cv.height * 0.35,
      vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 12 - 4,
      s: 5 + Math.random() * 6, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
      c: colors[Math.floor(Math.random() * colors.length)], life: 0
    }));
    let frames = 0;
    const tick = () => {
      frames += 1;
      ctx.clearRect(0, 0, cv.width, cv.height);
      bits.forEach((b) => {
        b.vy += 0.35; b.x += b.vx; b.y += b.vy; b.r += b.vr;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c;
        ctx.globalAlpha = Math.max(0, 1 - frames / 110);
        ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.6); ctx.restore();
      });
      if (frames < 110) requestAnimationFrame(tick); else { ctx.clearRect(0, 0, cv.width, cv.height); cv.style.display = 'none'; }
    };
    requestAnimationFrame(tick);
  }

  function wireChallenges() {
    $('tabExamsBtn').addEventListener('click', () => showTab('exams'));
    $('tabChallengesBtn').addEventListener('click', () => showTab('challenges'));
    ['chFilterType', 'chFilterUnit', 'chFilterStatus'].forEach((id) => $(id).addEventListener('change', renderChallengeGrid));
    $('chCloseBtn').addEventListener('click', closeChallenge);
    $('chCheckBtn').addEventListener('click', submitChallenge);
    $('chHintBtn').addEventListener('click', () => {
      if (chCurrent) { $('chHintText').textContent = '💡 ' + chCurrent.hint; $('chHintBtn').textContent = 'Hint shown'; }
    });
    $('chNextBtn').addEventListener('click', () => { if ($('chNextBtn').dataset.next) openChallenge($('chNextBtn').dataset.next); });
    $('challengeModal').addEventListener('mousedown', (e) => { if (e.target === $('challengeModal')) closeChallenge(); });
    window.addEventListener('pagehide', sendOffline);
  }

  init();
})();
