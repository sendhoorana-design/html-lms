(function () {
  let me = null;
  let socket = null;
  let students = [];
  let exams = [];
  let admins = [];
  let isSuperAdmin = false;
  let detailCM = null;

  const $ = (id) => document.getElementById(id);

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    if (res.status === 401) { window.location.href = '/login.html'; throw new Error('Not authenticated'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
    return data;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  async function init() {
    try {
      me = await api('/api/auth/me');
      if (me.role !== 'admin') { window.location.href = '/login.html'; return; }
    } catch (e) { return; }

    isSuperAdmin = !!me.is_super_admin;

    $('whoami').textContent = `${me.full_name} (${me.username})${isSuperAdmin ? ' — Main admin' : ''}`;
    $('logoutBtn').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    $('feedbackCategoryFilter').addEventListener('change', loadFeedback);
    $('feedbackCsvBtn').addEventListener('click', downloadFeedbackCsv);
    wireChallengesAdmin();
    $('fbSettingsSaveBtn').addEventListener('click', saveFeedbackSettings);

    // Main-admin-only UI: creating/importing/removing students, bulk-assigning students to a
    // sub-admin, and the Admin Requests tab. A sub-admin only ever works with the students
    // already handed to them.
    $('adminsTabBtn').style.display = isSuperAdmin ? '' : 'none';
    $('addStudentCard').style.display = isSuperAdmin ? '' : 'none';
    $('csvImportCard').style.display = isSuperAdmin ? '' : 'none';
    $('subAdminStudentsNote').style.display = isSuperAdmin ? 'none' : 'block';
    $('managedByHeader').style.display = isSuperAdmin ? '' : 'none';
    $('superAdminStudentControls').style.display = isSuperAdmin ? 'inline-flex' : 'none';

    $('addStudentForm').addEventListener('submit', onAddStudent);
    $('studentsClassFilter').addEventListener('change', (e) => {
      studentsClassFilterValue = e.target.value;
      renderStudentsTable();
    });
    $('removeAllStudentsBtn').addEventListener('click', onRemoveAllStudents);
    $('bulkAssignAdminBtn').addEventListener('click', onBulkAssignAdmin);
    $('addExamForm').addEventListener('submit', onAddExam);
    $('examCancelEditBtn').addEventListener('click', () => resetExamForm());
    $('e_vlimit_none').addEventListener('change', () => {
      $('e_vlimit').disabled = $('e_vlimit_none').checked;
    });
    $('addCheckBtn').addEventListener('click', () => addCheckRow());
    setupChecksBulkAdd();
    setupChecksCsvImport();
    setupCsvImport();
    $('assignCancelBtn').addEventListener('click', () => $('assignModal').style.display = 'none');
    $('assignSelectAllBtn').addEventListener('click', () => {
      document.querySelectorAll('#assignStudentList input[type="checkbox"]').forEach((el) => { el.checked = true; });
    });
    $('assignClearAllBtn').addEventListener('click', () => {
      document.querySelectorAll('#assignStudentList input[type="checkbox"]').forEach((el) => { el.checked = false; });
    });
    $('detailCloseBtn').addEventListener('click', () => $('detailModal').style.display = 'none');
    $('submissionsCloseBtn').addEventListener('click', () => $('submissionsModal').style.display = 'none');

    socket = io({ withCredentials: true });
    socket.on('violation', () => { loadMonitor(); flashMonitorTab(); });
    socket.on('heartbeat', () => { loadMonitor(); });
    socket.on('status_change', () => { loadMonitor(); });

    // Admins list is needed to render student "Managed by" names and the admin dropdown, so
    // load it before the students table (super admin only — a sub-admin can't call this route).
    if (isSuperAdmin) await loadAdmins();
    await Promise.all([loadStudents(), loadExams(), loadMonitor(), loadPresence()]);
    setInterval(loadMonitor, 10000);
    setInterval(loadPresence, 10000);
  }

  function flashMonitorTab() {
    const btn = document.querySelector('.tab-btn[data-tab="monitor"]');
    btn.style.color = 'var(--danger)';
    setTimeout(() => { btn.style.color = ''; }, 2000);
  }

  function switchTab(tab) {
    if (tab === 'feedback') loadFeedback();
    if (tab === 'challenges') loadChallengesAdmin();
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.style.display = (p.id === `tab-${tab}` ? 'block' : 'none'));
  }


  // ---------------- Student presence (Live Monitor) ----------------

  function savedIdleSeconds() {
    const v = parseInt(localStorage.getItem('lms_idle_after') || '120', 10);
    return [60, 120, 300, 600, 900].includes(v) ? v : 120;
  }

  function agoText(iso) {
    if (!iso) return 'never';
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
    return `${Math.round(sec / 86400)} d ago`;
  }

  async function loadPresence() {
    let data;
    try { data = await api(`/api/admin/presence?idle=${savedIdleSeconds()}`); } catch (e) { return; }
    const groups = { offline: [], idle: [], active: [] };
    data.students.forEach((st) => groups[st.status].push(st));
    $('presenceSummary').innerHTML =
      `<span class="presence-chip">🟢 Active ${data.counts.active}</span>` +
      `<span class="presence-chip">🟡 Idle ${data.counts.idle}</span>` +
      `<span class="presence-chip">🔴 Offline ${data.counts.offline}</span>` +
      `<span class="muted" style="align-self:center; font-size:12px;">${data.students.length} student${data.students.length === 1 ? '' : 's'} with an assigned exam</span>`;
    const render = (id, nId, list, field) => {
      $(nId).textContent = `(${list.length})`;
      $(id).innerHTML = list.length ? list.map((st) => `
        <div class="presence-row">
          <span><strong>${escapeHtml(st.full_name || st.username)}</strong>${st.section ? ` <span class="muted">· ${escapeHtml(st.section)}</span>` : ''}${st.exam_title ? `<br><span class="muted" style="font-size:12px;">in exam: ${escapeHtml(st.exam_title)}</span>` : ''}</span>
          <span class="muted" style="white-space:nowrap; font-size:12px;">${field === 'seen' ? 'last seen ' + agoText(st.last_seen_at) : 'active ' + agoText(st.last_active_at)}</span>
        </div>`).join('') : '<span class="muted">Nobody.</span>';
    };
    render('presenceOffline', 'presenceOfflineN', groups.offline, 'seen');
    render('presenceIdle', 'presenceIdleN', groups.idle, 'active');
    render('presenceActive', 'presenceActiveN', groups.active, 'active');
  }

  // ---------------- Challenges ----------------

  const CH_TYPE_LABEL = { quiz: 'Quiz', fill: 'Fill the blanks', fix: 'Find the bug', order: 'Order the code' };
  let adminChallenges = [];
  let pointsRows = [];

  async function loadChallengesAdmin() {
    $('challengeAdminBtns').style.display = isSuperAdmin ? 'flex' : 'none';
    adminChallenges = await api('/api/admin/challenges');
    renderChallengesAdmin();
    loadPoints();
  }

  function renderChallengesAdmin() {
    const t = $('chAdminTypeFilter').value;
    const list = adminChallenges.filter((c) => !t || c.type === t);
    $('chAdminCount').textContent = `${list.length} of ${adminChallenges.length} challenges`;
    $('chAdminBody').innerHTML = list.length ? list.map((c) => `
      <tr>
        <td>${escapeHtml(c.title)}</td>
        <td class="muted">${escapeHtml(c.topic)}</td>
        <td>${CH_TYPE_LABEL[c.type] || c.type}</td>
        <td>${escapeHtml(c.difficulty)}</td>
        <td><strong>${c.points}</strong></td>
        <td>${c.solved_by}</td>
        <td>${isSuperAdmin ? `<input type="checkbox" class="ch-active" data-id="${c.id}" ${c.active ? 'checked' : ''} />` : (c.active ? 'Yes' : 'No')}</td>
        <td>${isSuperAdmin ? `<button class="secondary ch-edit" data-id="${c.id}">Edit</button> <button class="secondary ch-del" data-id="${c.id}">Delete</button>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="8" class="muted">No challenges yet.' + (isSuperAdmin ? ' Click "Load starter challenges" to add the lab-manual set.' : '') + '</td></tr>';
    document.querySelectorAll('#chAdminBody .ch-active').forEach((cb) => cb.addEventListener('change', async () => {
      await api(`/api/admin/challenges/${cb.dataset.id}/active`, { method: 'PUT', body: JSON.stringify({ active: cb.checked }) });
      const c = adminChallenges.find((x) => x.id === cb.dataset.id); if (c) c.active = cb.checked;
    }));
    document.querySelectorAll('#chAdminBody .ch-edit').forEach((b) => b.addEventListener('click', () => openChallengeEditor(b.dataset.id)));
    document.querySelectorAll('#chAdminBody .ch-del').forEach((b) => b.addEventListener('click', async () => {
      const c = adminChallenges.find((x) => x.id === b.dataset.id);
      if (!window.confirm(`Delete "${c ? c.title : 'this challenge'}"? Students' points for it are removed too.`)) return;
      await api(`/api/admin/challenges/${b.dataset.id}`, { method: 'DELETE' });
      await loadChallengesAdmin();
    }));
  }

  function syncEditorType() {
    const type = $('ce_type').value;
    $('ce_quizWrap').style.display = type === 'quiz' ? 'block' : 'none';
    $('ce_fillWrap').style.display = type === 'fill' ? 'block' : 'none';
    $('ce_fixWrap').style.display = type === 'fix' ? 'block' : 'none';
    $('ce_orderWrap').style.display = type === 'order' ? 'block' : 'none';
    $('ce_codeWrap').style.display = type === 'order' ? 'none' : 'block';
    $('ce_codeLabel').textContent = type === 'fill' ? 'Code – write ___ (three underscores) wherever a blank should be'
      : type === 'fix' ? 'Code that contains the bug' : 'Code to show with the question (optional)';
  }

  function openChallengeEditor(id) {
    const c = id ? adminChallenges.find((x) => x.id === id) : null;
    $('chEditorTitle').textContent = c ? 'Edit challenge' : 'New challenge';
    $('ce_id').value = c ? c.id : '';
    $('ce_title').value = c ? c.title : '';
    $('ce_type').value = c ? c.type : 'quiz';
    $('ce_difficulty').value = c ? c.difficulty : 'easy';
    $('ce_points').value = c ? c.points : 10;
    $('ce_topic').value = c ? c.topic : '';
    $('ce_prompt').value = c ? c.prompt : '';
    $('ce_code').value = c ? c.code : '';
    const d = (c && c.data) || {};
    $('ce_options').value = (d.options || []).join('\n');
    $('ce_correct').value = (d.correct || 0) + 1;
    $('ce_answers').value = (d.answers || []).map((a) => a.join('|')).join('\n');
    $('ce_case').checked = !!d.case_sensitive;
    $('ce_bug').value = (d.bug_lines || []).join(', ');
    $('ce_lines').value = (d.lines || []).join('\n');
    $('ce_hint').value = d.hint || '';
    $('ce_explanation').value = c ? c.explanation : '';
    $('ce_active').checked = c ? c.active : true;
    $('ceStatus').textContent = '';
    syncEditorType();
    $('chEditor').style.display = 'block';
    $('chEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function readChallengeEditor() {
    const type = $('ce_type').value;
    const data = { hint: $('ce_hint').value };
    if (type === 'quiz') {
      data.options = $('ce_options').value.split('\n').map((x) => x.trim()).filter(Boolean);
      data.correct = (parseInt($('ce_correct').value, 10) || 1) - 1;
    } else if (type === 'fill') {
      data.answers = $('ce_answers').value.split('\n').map((l) => l.split('|').map((x) => x.trim()).filter(Boolean)).filter((a) => a.length);
      data.case_sensitive = $('ce_case').checked;
    } else if (type === 'fix') {
      data.bug_lines = $('ce_bug').value.split(',').map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
    } else if (type === 'order') {
      data.lines = $('ce_lines').value.split('\n').filter((l) => l.trim());
    }
    return {
      title: $('ce_title').value, type, difficulty: $('ce_difficulty').value, points: parseInt($('ce_points').value, 10),
      topic: $('ce_topic').value, prompt: $('ce_prompt').value,
      code: type === 'order' ? '' : $('ce_code').value, explanation: $('ce_explanation').value,
      active: $('ce_active').checked, data
    };
  }

  async function saveChallengeEditor() {
    const id = $('ce_id').value;
    $('ceStatus').textContent = 'Saving…';
    try {
      await api(id ? `/api/admin/challenges/${id}` : '/api/admin/challenges', { method: id ? 'PUT' : 'POST', body: JSON.stringify(readChallengeEditor()) });
      $('chEditor').style.display = 'none';
      await loadChallengesAdmin();
    } catch (e) {
      $('ceStatus').textContent = e.message || 'Could not save';
    }
  }

  async function seedStarterChallenges() {
    $('chSeedStatus').textContent = 'Loading…';
    try {
      const r = await api('/api/admin/challenges/seed-starter', { method: 'POST' });
      $('chSeedStatus').textContent = `Added ${r.added} challenge${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already existed)` : ''}.`;
      await loadChallengesAdmin();
    } catch (e) {
      $('chSeedStatus').textContent = e.message || 'Could not load starter challenges';
    }
  }

  async function loadPoints() {
    let data;
    try { data = await api('/api/admin/challenges/points'); } catch (e) { return; }
    pointsRows = data.students;
    const withPts = pointsRows.filter((r) => r.points > 0).length;
    $('pointsSummary').textContent = `${withPts} of ${pointsRows.length} students have earned points · ${data.total_challenges} active challenges`;
    $('pointsBody').innerHTML = pointsRows.length ? pointsRows.map((r) => `
      <tr>
        <td>${r.rank ? '#' + r.rank : '—'}</td>
        <td>${escapeHtml(r.full_name)}</td>
        <td class="muted">${escapeHtml(r.username)}</td>
        <td>${escapeHtml(r.section)}</td>
        <td><strong>${r.points}</strong></td>
        <td>${r.completed} / ${data.total_challenges}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">No students yet.</td></tr>';
  }

  function downloadPointsCsv() {
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['rank,name,username,class,points,challenges_solved']
      .concat(pointsRows.map((r) => [r.rank || '', r.full_name, r.username, r.section, r.points, r.completed].map(q).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'challenge-points.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  function wireChallengesAdmin() {
    $('chSeedBtn').addEventListener('click', seedStarterChallenges);
    $('chNewBtn').addEventListener('click', () => openChallengeEditor(null));
    $('ce_type').addEventListener('change', syncEditorType);
    $('ceSaveBtn').addEventListener('click', saveChallengeEditor);
    $('ceCancelBtn').addEventListener('click', () => { $('chEditor').style.display = 'none'; });
    $('chAdminTypeFilter').addEventListener('change', renderChallengesAdmin);
    $('pointsCsvBtn').addEventListener('click', downloadPointsCsv);
    $('idleAfterSelect').value = String(savedIdleSeconds());
    $('idleAfterSelect').addEventListener('change', () => { localStorage.setItem('lms_idle_after', $('idleAfterSelect').value); loadPresence(); });
  }

  // ---------------- Feedback (anonymous) ----------------

  const FEEDBACK_LABELS = { software: 'HTML LMS Software', theory: 'Theory Class', practical: 'Practical Class' };
  let feedbackItems = [];

  async function loadFeedback() {
    // Switches (main admin only) — everyone else just sees the responses.
    $('feedbackSettingsCard').style.display = isSuperAdmin ? 'block' : 'none';
    if (isSuperAdmin) {
      try {
        const st = await api('/api/admin/feedback/settings');
        ['software', 'theory', 'practical'].forEach((c) => { $(`fbEnable_${c}`).checked = !!st[c]; });
      } catch (e) { /* leave as is */ }
    }

    // Summary cards are always across all categories; the table respects the category filter.
    const all = await api('/api/admin/feedback');
    $('feedbackSummary').innerHTML = ['software', 'theory', 'practical'].map((c) => {
      const rows = all.filter((f) => f.category === c);
      const avg = rows.length ? (rows.reduce((sum, f) => sum + f.rating, 0) / rows.length).toFixed(2) : '—';
      return `<div class="card" style="padding:14px 18px; min-width:170px;">
        <div class="muted" style="font-size:12px;">${FEEDBACK_LABELS[c]}</div>
        <div style="font-size:26px; font-weight:700;">${avg}${rows.length ? ' <span class="muted" style="font-size:13px; font-weight:400;">/ 5</span>' : ''}</div>
        <div class="muted" style="font-size:12px;">${rows.length} response${rows.length === 1 ? '' : 's'}</div>
      </div>`;
    }).join('');

    const cat = $('feedbackCategoryFilter').value;
    feedbackItems = cat ? all.filter((f) => f.category === cat) : all;
    const tbody = $('feedbackBody');
    tbody.innerHTML = feedbackItems.length ? '' : '<tr><td colspan="4" class="muted">No feedback yet.</td></tr>';
    for (const f of feedbackItems) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="muted">${escapeHtml(f.date)}</td>
        <td>${escapeHtml(FEEDBACK_LABELS[f.category] || f.category)}</td>
        <td>${'★'.repeat(f.rating)}<span class="muted">${'★'.repeat(5 - f.rating)}</span> <span class="muted">(${f.rating})</span></td>
        <td style="white-space:pre-wrap;">${escapeHtml(f.comments) || '<span class="muted">—</span>'}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function saveFeedbackSettings() {
    const body = {};
    ['software', 'theory', 'practical'].forEach((c) => { body[c] = $(`fbEnable_${c}`).checked; });
    const status = $('fbSettingsStatus');
    try {
      await api('/api/admin/feedback/settings', { method: 'PUT', body: JSON.stringify(body) });
      status.textContent = 'Saved.';
    } catch (e) {
      status.textContent = e.message;
    }
    setTimeout(() => { status.textContent = ''; }, 3000);
  }

  function downloadFeedbackCsv() {
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['date,category,rating,comments']
      .concat(feedbackItems.map((f) => [f.date, FEEDBACK_LABELS[f.category] || f.category, f.rating, f.comments].map(q).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'feedback.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------------- Students ----------------

  let studentsClassFilterValue = '';

  async function loadStudents() {
    students = await api('/api/admin/students');
    populateStudentsClassFilter();
    renderStudentsTable();
  }

  function populateStudentsClassFilter() {
    const select = $('studentsClassFilter');
    const classes = Array.from(new Set(students.map((s) => s.section).filter((c) => c))).sort();
    const prev = studentsClassFilterValue;
    select.innerHTML = '<option value="">All classes</option>'
      + classes.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    // Keep the current selection if that class still exists, otherwise fall back to "All".
    if (classes.includes(prev)) {
      select.value = prev;
    } else {
      studentsClassFilterValue = '';
      select.value = '';
    }
  }

  // A per-student <select> of approved sub-admins (plus "Unassigned"), for reassigning one
  // student at a time — the bulk "Assign filtered to admin" control above handles whole classes,
  // this handles the one-off case without needing to fiddle with the class filter to isolate a
  // single student.
  function managerSelectHtml(s) {
    const approved = admins.filter((a) => a.admin_status === 'approved' && !a.is_super_admin);
    const options = ['<option value="">Unassigned</option>']
      .concat(approved.map((a) => `<option value="${a.id}" ${a.id === s.managing_admin ? 'selected' : ''}>${escapeHtml(a.full_name)} (${escapeHtml(a.username)})</option>`));
    // If the student's current manager isn't in the approved list (e.g. that admin was since
    // rejected/removed), still show something sensible instead of silently switching to
    // "Unassigned" under them.
    if (s.managing_admin && !approved.some((a) => a.id === s.managing_admin)) {
      options.push(`<option value="${s.managing_admin}" selected>(unknown admin)</option>`);
    }
    if (!s.managing_admin) options[0] = '<option value="" selected>Unassigned</option>';
    return `<select class="manager-select" data-id="${s.id}" style="width:auto; font-size:12px; padding:4px 6px;">${options.join('')}</select>`;
  }

  function renderStudentsTable() {
    const visible = studentsClassFilterValue
      ? students.filter((s) => s.section === studentsClassFilterValue)
      : students;

    const tbody = $('studentsBody');
    tbody.innerHTML = '';
    for (const s of visible) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(s.full_name)}</td>
        <td>${escapeHtml(s.username)}</td>
        <td>${s.section ? escapeHtml(s.section) : '<span class="muted">—</span>'}</td>
        ${isSuperAdmin ? `<td>${managerSelectHtml(s)}</td>` : ''}
        <td>
          ${s.must_change_password
            ? '<span class="badge pw_pending">Must change</span>'
            : '<span class="badge pw_ok">OK</span>'}
        </td>
        <td>${escapeHtml((s.created_at || '').slice(0,16))}</td>
        <td>
          <button class="secondary edit-class" data-id="${s.id}">Edit class</button>
          ${s.must_change_password ? '' : `<button class="secondary force-pw" data-id="${s.id}">Force change</button>`}
          <button class="secondary reset-pw" data-id="${s.id}" data-name="${escapeHtml(s.full_name)}">Reset password</button>
          ${isSuperAdmin ? `<button class="secondary danger-del" data-id="${s.id}">Remove</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.danger-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this student? Their assignments and history will be deleted.')) return;
        await api(`/api/admin/students/${btn.dataset.id}`, { method: 'DELETE' });
        await loadStudents();
      });
    });
    tbody.querySelectorAll('.force-pw').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Require this student to set a new password next time they log in?')) return;
        await api(`/api/admin/students/${btn.dataset.id}/force-password-change`, { method: 'POST' });
        await loadStudents();
      });
    });
    tbody.querySelectorAll('.reset-pw').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name || 'this student';
        if (!confirm(`Reset ${name}'s password to the default "Welcome@123"? They'll be required to set a new one the next time they log in.`)) return;
        const res = await api(`/api/admin/students/${btn.dataset.id}/reset-password`, { method: 'POST' });
        alert(`Password reset. ${name} can now log in with: ${res.default_password}`);
        await loadStudents();
      });
    });
    tbody.querySelectorAll('.edit-class').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const student = students.find((s) => s.id === btn.dataset.id);
        const next = window.prompt('Class / section for this student:', (student && student.section) || '');
        if (next === null) return; // cancelled
        await api(`/api/admin/students/${btn.dataset.id}/section`, {
          method: 'PUT',
          body: JSON.stringify({ section: next.trim() })
        });
        await loadStudents();
      });
    });
    tbody.querySelectorAll('.manager-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        sel.disabled = true;
        try {
          await api(`/api/admin/students/${sel.dataset.id}/manager`, {
            method: 'PUT',
            body: JSON.stringify({ admin_id: sel.value })
          });
          await loadStudents();
        } catch (err) {
          alert(err.message);
          sel.disabled = false;
        }
      });
    });
  }

  // Removes either every student, or just the currently filtered class, depending on whether
  // the class filter dropdown has a selection — so this one button covers both "wipe everyone
  // at end of term" and "remove just this section" without needing two separate controls.
  async function onRemoveAllStudents() {
    const target = studentsClassFilterValue
      ? students.filter((s) => s.section === studentsClassFilterValue)
      : students;

    if (target.length === 0) {
      alert('No students to remove.');
      return;
    }

    const scopeLabel = studentsClassFilterValue ? `class "${studentsClassFilterValue}"` : 'ALL classes';
    const confirmed = confirm(
      `Remove all ${target.length} student(s) in ${scopeLabel}? This cannot be undone — their exam ` +
      `assignments and submission history will be deleted too.`
    );
    if (!confirmed) return;

    $('removeAllStudentsBtn').disabled = true;
    try {
      await api('/api/admin/students/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ student_ids: target.map((s) => s.id) })
      });
      await loadStudents();
    } catch (err) {
      alert(err.message);
    } finally {
      $('removeAllStudentsBtn').disabled = false;
    }
  }

  // Hands the currently filtered class (or every student, with no filter) to whichever admin is
  // picked in the dropdown — the main admin's way of deciding which students a sub-admin can
  // see and assign exams to. "Unassign" clears managing_admin back to null.
  async function onBulkAssignAdmin() {
    const adminId = $('bulkAssignAdminSelect').value;
    if (!adminId) {
      alert('Choose an admin (or "Unassign") first.');
      return;
    }

    const target = studentsClassFilterValue
      ? students.filter((s) => s.section === studentsClassFilterValue)
      : students;
    if (target.length === 0) {
      alert('No students to assign.');
      return;
    }

    const scopeLabel = studentsClassFilterValue ? `class "${studentsClassFilterValue}"` : 'ALL classes';
    const targetAdmin = admins.find((a) => a.id === adminId);
    const adminLabel = adminId === '__unassign__' ? 'Unassigned' : (targetAdmin ? `${targetAdmin.full_name} (${targetAdmin.username})` : 'that admin');
    if (!confirm(`Assign all ${target.length} student(s) in ${scopeLabel} to ${adminLabel}?`)) return;

    $('bulkAssignAdminBtn').disabled = true;
    try {
      await api('/api/admin/students/bulk-assign-manager', {
        method: 'POST',
        body: JSON.stringify({
          student_ids: target.map((s) => s.id),
          admin_id: adminId === '__unassign__' ? '' : adminId
        })
      });
      await loadStudents();
    } catch (err) {
      alert(err.message);
    } finally {
      $('bulkAssignAdminBtn').disabled = false;
    }
  }

  // ---------------- Admin accounts (main admin only) ----------------

  async function loadAdmins() {
    admins = await api('/api/admin/admins');
    renderAdminsTable();
    populateBulkAssignAdminSelect();
  }

  function populateBulkAssignAdminSelect() {
    const select = $('bulkAssignAdminSelect');
    const approved = admins.filter((a) => a.admin_status === 'approved' && !a.is_super_admin);
    select.innerHTML = '<option value="">Assign filtered to admin…</option>'
      + approved.map((a) => `<option value="${a.id}">${escapeHtml(a.full_name)} (${escapeHtml(a.username)})</option>`).join('')
      + '<option value="__unassign__">Unassign (no admin)</option>';
  }

  function renderAdminsTable() {
    const tbody = $('adminsBody');
    tbody.innerHTML = '';
    for (const a of admins) {
      const tr = document.createElement('tr');
      const statusBadge = a.is_super_admin
        ? '<span class="badge approved">Main admin</span>'
        : `<span class="badge ${a.admin_status}">${a.admin_status}</span>`;

      let actions = '';
      if (!a.is_super_admin) {
        if (a.admin_status === 'pending') {
          actions = `<button class="secondary approve-admin" data-id="${a.id}">Approve</button>
                     <button class="secondary reject-admin" data-id="${a.id}">Reject</button>`;
        } else if (a.admin_status === 'approved') {
          actions = `<button class="secondary reject-admin" data-id="${a.id}">Revoke</button>
                     <button class="secondary remove-admin" data-id="${a.id}">Remove</button>`;
        } else {
          actions = `<button class="secondary approve-admin" data-id="${a.id}">Approve</button>
                     <button class="secondary remove-admin" data-id="${a.id}">Remove</button>`;
        }
      }

      tr.innerHTML = `
        <td>${escapeHtml(a.full_name)}</td>
        <td>${escapeHtml(a.username)}</td>
        <td>${statusBadge}</td>
        <td class="muted">${escapeHtml((a.created_at || '').slice(0,16))}</td>
        <td>${actions}</td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('.approve-admin').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/api/admin/admins/${btn.dataset.id}/approve`, { method: 'POST' });
        await loadAdmins();
      });
    });
    tbody.querySelectorAll('.reject-admin').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Reject/revoke this admin? They will no longer be able to log in.')) return;
        await api(`/api/admin/admins/${btn.dataset.id}/reject`, { method: 'POST' });
        await loadAdmins();
      });
    });
    tbody.querySelectorAll('.remove-admin').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this admin account? Any students they managed will become unassigned.')) return;
        await api(`/api/admin/admins/${btn.dataset.id}`, { method: 'DELETE' });
        await loadAdmins();
        await loadStudents();
      });
    });
  }

  // ---------------- CSV import ----------------

  // Small CSV line parser that handles double-quoted fields (including embedded commas and
  // escaped "" quotes) — enough for simple username/password/full_name rows without needing
  // a library.
  function parseCsvLine(line) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else { inQuotes = false; }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields.map((f) => f.trim());
  }

  function parseCsv(text) {
    const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error('File is empty');

    const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    const usernameIdx = header.indexOf('username');
    const passwordIdx = header.indexOf('password');
    const fullNameIdx = header.indexOf('full_name');
    const sectionIdx = header.indexOf('section');
    if (usernameIdx === -1 || passwordIdx === -1) {
      throw new Error('Header row must include "username" and "password" columns');
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      rows.push({
        username: fields[usernameIdx] || '',
        password: fields[passwordIdx] || '',
        full_name: fullNameIdx !== -1 ? (fields[fullNameIdx] || '') : '',
        section: sectionIdx !== -1 ? (fields[sectionIdx] || '') : ''
      });
    }
    return rows;
  }

  let pendingCsvRows = null;

  function setupCsvImport() {
    $('csvFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      $('csvError').textContent = '';
      $('csvResults').style.display = 'none';
      pendingCsvRows = null;
      $('csvImportBtn').disabled = true;
      if (!file) return;

      try {
        const text = await file.text();
        const rows = parseCsv(text);
        if (rows.length === 0) throw new Error('No data rows found');
        pendingCsvRows = rows;
        $('csvImportBtn').disabled = false;
        $('csvError').textContent = '';
        $('csvError').style.color = 'var(--muted)';
        $('csvError').textContent = `${rows.length} row(s) ready to import.`;
      } catch (err) {
        $('csvError').style.color = '';
        $('csvError').textContent = err.message;
      }
    });

    $('csvImportBtn').addEventListener('click', async () => {
      if (!pendingCsvRows) return;
      $('csvImportBtn').disabled = true;
      $('csvError').textContent = '';
      try {
        const results = await api('/api/admin/students/import', {
          method: 'POST',
          body: JSON.stringify({ students: pendingCsvRows })
        });
        renderCsvResults(results);
        pendingCsvRows = null;
        $('csvFileInput').value = '';
        await loadStudents();
      } catch (err) {
        $('csvError').style.color = '';
        $('csvError').textContent = err.message;
        $('csvImportBtn').disabled = false;
      }
    });

    $('csvSampleBtn').addEventListener('click', () => {
      const sample = 'username,password,full_name,section\njdoe,Temp1234,Jane Doe,CSE A\nasmith,Temp5678,Alex Smith,CSE B\n';
      const blob = new Blob([sample], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'students-sample.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function renderCsvResults(results) {
    const el = $('csvResults');
    el.style.display = 'block';
    const parts = [];
    parts.push(`<div><strong style="color:var(--accent-2)">${results.created.length} created</strong></div>`);
    if (results.skipped.length) {
      parts.push(`<div class="mt-16 muted">${results.skipped.length} skipped (already existed):</div>`);
      parts.push('<div class="muted">' + results.skipped.map((s) => escapeHtml(s.username)).join(', ') + '</div>');
    }
    if (results.errors.length) {
      parts.push(`<div class="mt-16" style="color:var(--danger)">${results.errors.length} error(s):</div>`);
      parts.push('<div>' + results.errors.map((e) => `Row ${e.row} (${escapeHtml(e.username || '—')}): ${escapeHtml(e.error)}`).join('<br/>') + '</div>');
    }
    el.innerHTML = parts.join('');
  }

  async function onAddStudent(e) {
    e.preventDefault();
    $('studentError').textContent = '';
    try {
      await api('/api/admin/students', {
        method: 'POST',
        body: JSON.stringify({
          full_name: $('s_fullname').value.trim(),
          username: $('s_username').value.trim(),
          password: $('s_password').value,
          section: $('s_section').value.trim()
        })
      });
      $('addStudentForm').reset();
      await loadStudents();
    } catch (err) {
      $('studentError').textContent = err.message;
    }
  }

  // ---------------- Exams ----------------

  async function loadExams() {
    exams = await api('/api/admin/exams');
    const tbody = $('examsBody');
    tbody.innerHTML = '';
    for (const ex of exams) {
      const tr = document.createElement('tr');
      // A sub-admin can assign/view submissions for any exam they can see (the main admin's or
      // their own), but can only edit/delete exams they created themselves.
      const canEdit = isSuperAdmin || ex.created_by === me.id;
      const proctoringOn = ex.proctoring_enabled !== false;
      tr.innerHTML = `
        <td>${escapeHtml(ex.title)}</td>
        <td>${ex.time_limit_minutes} min</td>
        <td><span class="badge ${proctoringOn ? 'approved' : 'pending'}">${proctoringOn ? 'On' : 'Off'}</span></td>
        <td>${escapeHtml((ex.created_at || '').slice(0,16))}</td>
        <td>
          <button class="secondary assign-btn" data-id="${ex.id}">Assign</button>
          <button class="secondary submissions-btn" data-id="${ex.id}">Submissions</button>
          ${canEdit ? `<button class="secondary edit-exam-btn" data-id="${ex.id}">Edit</button>` : ''}
          ${canEdit ? `<button class="secondary danger-exam" data-id="${ex.id}">Delete</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.assign-btn').forEach((btn) => {
      btn.addEventListener('click', () => openAssignModal(btn.dataset.id));
    });
    tbody.querySelectorAll('.submissions-btn').forEach((btn) => {
      btn.addEventListener('click', () => openSubmissionsModal(btn.dataset.id));
    });
    tbody.querySelectorAll('.edit-exam-btn').forEach((btn) => {
      btn.addEventListener('click', () => startEditExam(btn.dataset.id));
    });
    tbody.querySelectorAll('.danger-exam').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this exam and all related assignments/submissions?')) return;
        await api(`/api/admin/exams/${btn.dataset.id}`, { method: 'DELETE' });
        await loadExams();
      });
    });
  }

  // ---------------- Auto-grading checks builder (Create Exam form) ----------------

  let checkRowSeq = 0;

  function checkRowFieldsHtml(type) {
    if (type === 'selector_exists') {
      return `
        <input type="text" class="chk-selector" placeholder="CSS selector, e.g. h1 or table tr" />
        <label class="muted" style="margin:0; white-space:nowrap;">min count</label>
        <input type="number" class="chk-min-count" value="1" min="1" />
      `;
    }
    if (type === 'text_contains') {
      return `
        <input type="text" class="chk-text" placeholder="Text that must appear on the page" />
        <label class="checkbox-row" style="padding:0; margin:0;">
          <input type="checkbox" class="chk-case-sensitive" />
          <span class="muted" style="white-space:nowrap;">Case sensitive</span>
        </label>
      `;
    }
    if (type === 'html_contains') {
      return `<input type="text" class="chk-pattern" placeholder="Exact text that must appear in the HTML source" />`;
    }
    return '';
  }

  function addCheckRow(existing) {
    const id = `chk_${++checkRowSeq}`;
    const row = document.createElement('div');
    row.className = 'check-row';
    row.dataset.rowId = id;
    const type = (existing && existing.type) || 'selector_exists';
    row.innerHTML = `
      <div class="check-row-top">
        <input type="text" class="chk-label" placeholder="Check name, e.g. \"Has a heading\"" value="${existing ? escapeHtml(existing.label) : ''}" />
        <select class="chk-type">
          <option value="selector_exists">Element exists (CSS selector)</option>
          <option value="text_contains">Page text contains</option>
          <option value="html_contains">HTML source contains</option>
        </select>
        <button type="button" class="secondary remove-check">Remove</button>
      </div>
      <div class="check-row-fields">${checkRowFieldsHtml(type)}</div>
    `;
    $('checksList').appendChild(row);

    const select = row.querySelector('.chk-type');
    select.value = type;
    select.addEventListener('change', () => {
      row.querySelector('.check-row-fields').innerHTML = checkRowFieldsHtml(select.value);
      applyExistingValuesToRow(row, existing && existing.type === select.value ? existing : null);
    });
    row.querySelector('.remove-check').addEventListener('click', () => row.remove());

    applyExistingValuesToRow(row, existing);
  }

  function applyExistingValuesToRow(row, existing) {
    if (!existing) return;
    const set = (sel, val) => { const el = row.querySelector(sel); if (el) { if (el.type === 'checkbox') el.checked = !!val; else el.value = val; } };
    set('.chk-selector', existing.selector);
    set('.chk-min-count', existing.min_count);
    set('.chk-text', existing.text);
    set('.chk-case-sensitive', existing.case_sensitive);
    set('.chk-pattern', existing.pattern);
  }

  // Parses the bulk-add textarea: one check per line, pipe-delimited
  // "type|label|value|extra". Lets an admin paste a whole set of checks at once instead of
  // clicking "+ Add single check" and filling in fields one by one.
  function parseBulkChecksText(text) {
    const lines = text.split(/\r\n|\n|\r/).map((l) => l.trim()).filter((l) => l.length > 0);
    const parsed = [];
    const errors = [];
    const validTypes = ['selector_exists', 'text_contains', 'html_contains'];

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      const fields = line.split('|').map((f) => f.trim());
      const [type, label, value, extra] = fields;

      if (!type || !validTypes.includes(type)) {
        errors.push(`Line ${lineNum}: type must be one of ${validTypes.join(', ')}`);
        return;
      }
      if (!label) {
        errors.push(`Line ${lineNum}: missing label`);
        return;
      }

      const check = { type, label };
      if (type === 'selector_exists') {
        if (!value) { errors.push(`Line ${lineNum}: selector_exists needs a CSS selector`); return; }
        check.selector = value;
        check.min_count = parseInt(extra, 10) || 1;
      } else if (type === 'text_contains') {
        if (!value) { errors.push(`Line ${lineNum}: text_contains needs text`); return; }
        check.text = value;
        check.case_sensitive = (extra || '').toLowerCase() === 'case';
      } else if (type === 'html_contains') {
        if (!value) { errors.push(`Line ${lineNum}: html_contains needs a pattern`); return; }
        check.pattern = value;
      }
      parsed.push(check);
    });

    return { parsed, errors };
  }

  // Generic checks-CSV parser: header row must include type,label,value,extra (any column
  // order). Reuses the same quote-aware parseCsvLine already used for student CSV import, and
  // the same type/value/extra semantics as the pipe-delimited bulk-add textarea above.
  function parseChecksCsvText(text) {
    const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error('File is empty');

    const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    const typeIdx = header.indexOf('type');
    const labelIdx = header.indexOf('label');
    const valueIdx = header.indexOf('value');
    const extraIdx = header.indexOf('extra');
    if (typeIdx === -1 || labelIdx === -1) {
      throw new Error('Header row must include "type" and "label" columns');
    }

    const validTypes = ['selector_exists', 'text_contains', 'html_contains'];
    const parsed = [];
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
      const lineNum = i + 1;
      const fields = parseCsvLine(lines[i]);
      const type = (fields[typeIdx] || '').trim();
      const label = (fields[labelIdx] || '').trim();
      const value = valueIdx !== -1 ? (fields[valueIdx] || '').trim() : '';
      const extra = extraIdx !== -1 ? (fields[extraIdx] || '').trim() : '';

      if (!type || !validTypes.includes(type)) {
        errors.push(`Row ${lineNum}: type must be one of ${validTypes.join(', ')}`);
        continue;
      }
      if (!label) {
        errors.push(`Row ${lineNum}: missing label`);
        continue;
      }

      const check = { type, label };
      if (type === 'selector_exists') {
        if (!value) { errors.push(`Row ${lineNum}: selector_exists needs a CSS selector`); continue; }
        check.selector = value;
        check.min_count = parseInt(extra, 10) || 1;
      } else if (type === 'text_contains') {
        if (!value) { errors.push(`Row ${lineNum}: text_contains needs text`); continue; }
        check.text = value;
        check.case_sensitive = extra.toLowerCase() === 'case';
      } else if (type === 'html_contains') {
        if (!value) { errors.push(`Row ${lineNum}: html_contains needs a pattern`); continue; }
        check.pattern = value;
      }
      parsed.push(check);
    }

    return { parsed, errors };
  }

  let pendingChecksCsvText = null;

  function setupChecksCsvImport() {
    $('checksCsvFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      $('checksCsvError').textContent = '';
      $('checksCsvError').style.color = '';
      pendingChecksCsvText = null;
      $('checksCsvImportBtn').disabled = true;
      if (!file) return;

      try {
        pendingChecksCsvText = await file.text();
        $('checksCsvImportBtn').disabled = false;
        $('checksCsvError').style.color = 'var(--muted)';
        $('checksCsvError').textContent = 'File ready — click Import CSV.';
      } catch (err) {
        $('checksCsvError').textContent = err.message;
      }
    });

    $('checksCsvImportBtn').addEventListener('click', () => {
      if (!pendingChecksCsvText) return;
      const errEl = $('checksCsvError');
      errEl.textContent = '';
      errEl.style.color = '';
      try {
        const { parsed, errors } = parseChecksCsvText(pendingChecksCsvText);
        parsed.forEach((c) => addCheckRow(c));
        if (errors.length && parsed.length) {
          errEl.textContent = `${parsed.length} check(s) added. ${errors.length} row(s) skipped — ${errors.join('; ')}`;
        } else if (errors.length) {
          errEl.textContent = `Nothing added — ${errors.join('; ')}`;
        } else {
          errEl.style.color = 'var(--muted)';
          errEl.textContent = `${parsed.length} check(s) added below.`;
        }
        pendingChecksCsvText = null;
        $('checksCsvFileInput').value = '';
        $('checksCsvImportBtn').disabled = true;
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    $('checksCsvSampleBtn').addEventListener('click', () => {
      const sample = 'type,label,value,extra\n'
        + 'selector_exists,Has a heading,h1,1\n'
        + 'text_contains,Contains welcome,Welcome,case\n'
        + 'html_contains,Has doctype,<!DOCTYPE,\n';
      const blob = new Blob([sample], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'checks-sample.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function setupChecksBulkAdd() {
    $('checksBulkAddBtn').addEventListener('click', () => {
      const text = $('checksBulkInput').value;
      const errEl = $('checksBulkError');
      errEl.textContent = '';
      errEl.style.color = '';

      if (!text.trim()) {
        errEl.textContent = 'Paste one or more check lines first.';
        return;
      }

      const { parsed, errors } = parseBulkChecksText(text);
      parsed.forEach((c) => addCheckRow(c));

      if (parsed.length) $('checksBulkInput').value = '';

      if (errors.length && parsed.length) {
        errEl.textContent = `${parsed.length} check(s) added. ${errors.length} line(s) skipped — ${errors.join('; ')}`;
      } else if (errors.length) {
        errEl.textContent = `Nothing added — ${errors.join('; ')}`;
      } else {
        errEl.style.color = 'var(--muted)';
        errEl.textContent = `${parsed.length} check(s) added below.`;
      }
    });
  }

  function collectChecks() {
    return Array.from($('checksList').querySelectorAll('.check-row')).map((row) => {
      const type = row.querySelector('.chk-type').value;
      const label = row.querySelector('.chk-label').value.trim();
      const base = { label, type };
      if (type === 'selector_exists') {
        base.selector = (row.querySelector('.chk-selector') || {}).value || '';
        base.min_count = parseInt((row.querySelector('.chk-min-count') || {}).value, 10) || 1;
      } else if (type === 'text_contains') {
        base.text = (row.querySelector('.chk-text') || {}).value || '';
        base.case_sensitive = !!(row.querySelector('.chk-case-sensitive') || {}).checked;
      } else if (type === 'html_contains') {
        base.pattern = (row.querySelector('.chk-pattern') || {}).value || '';
      }
      return base;
    }).filter((c) => c.label);
  }

  // ----- Create / edit exam (same form doubles as both, toggled by editingExamId) -----

  let editingExamId = null;

  function resetExamForm() {
    editingExamId = null;
    $('addExamForm').reset();
    $('e_proctoring').checked = true;
    $('e_multifile').checked = true;
    $('e_vlimit_none').checked = false;
    $('e_vlimit').disabled = false;
    $('checksList').innerHTML = '';
    $('checksBulkInput').value = '';
    $('checksBulkError').textContent = '';
    $('checksCsvFileInput').value = '';
    $('checksCsvImportBtn').disabled = true;
    $('checksCsvError').textContent = '';
    pendingChecksCsvText = null;
    $('examFormTitle').textContent = 'Create exam';
    $('examSubmitBtn').textContent = 'Create exam';
    $('examCancelEditBtn').style.display = 'none';
    $('examError').textContent = '';
  }

  function startEditExam(examId) {
    const ex = exams.find((e) => String(e.id) === String(examId));
    if (!ex) return;

    editingExamId = examId;
    $('e_title').value = ex.title || '';
    $('e_instructions').value = ex.instructions || '';
    $('e_starter').value = ex.starter_code || '';
    $('e_time').value = ex.time_limit_minutes || 60;
    const hasNoLimit = ex.violation_limit === 0;
    $('e_vlimit_none').checked = hasNoLimit;
    $('e_vlimit').value = hasNoLimit ? 5 : (ex.violation_limit || 5);
    $('e_vlimit').disabled = hasNoLimit;
    $('e_proctoring').checked = ex.proctoring_enabled !== false;
    $('e_multifile').checked = !!ex.multi_file_enabled;

    $('checksList').innerHTML = '';
    (ex.checks || []).forEach((c) => addCheckRow(c));

    $('examFormTitle').textContent = `Edit exam — ${ex.title}`;
    $('examSubmitBtn').textContent = 'Save changes';
    $('examCancelEditBtn').style.display = 'inline-block';
    $('examError').textContent = '';
    $('addExamForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function onAddExam(e) {
    e.preventDefault();
    $('examError').textContent = '';
    const payload = {
      title: $('e_title').value.trim(),
      instructions: $('e_instructions').value,
      starter_code: $('e_starter').value,
      time_limit_minutes: parseInt($('e_time').value, 10) || 60,
      violation_limit: $('e_vlimit_none').checked ? 0 : (parseInt($('e_vlimit').value, 10) || 5),
      proctoring_enabled: $('e_proctoring').checked,
      multi_file_enabled: $('e_multifile').checked,
      checks: collectChecks()
    };
    try {
      if (editingExamId) {
        await api(`/api/admin/exams/${editingExamId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/admin/exams', { method: 'POST', body: JSON.stringify(payload) });
      }
      resetExamForm();
      await loadExams();
    } catch (err) {
      $('examError').textContent = err.message;
    }
  }

  let assignExamId = null;
  function openAssignModal(examId) {
    assignExamId = examId;
    const list = $('assignStudentList');

    if (students.length === 0) {
      list.innerHTML = '<p class="muted">No students yet — add some in the Students tab.</p>';
      $('assignModal').style.display = 'flex';
      return;
    }

    // Group by class/section so a whole class can be picked in one click instead of checking
    // students off a flat list. Students with no section fall into "Unassigned", sorted last.
    const groups = new Map();
    students.forEach((s) => {
      const key = s.section || 'Unassigned';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      return a.localeCompare(b);
    });

    list.innerHTML = sortedKeys.map((key) => {
      const groupStudents = groups.get(key);
      return `
        <div class="mt-16">
          <div class="flex-between" style="margin-bottom:4px;">
            <strong style="font-size:13px;">${escapeHtml(key)} <span class="muted">(${groupStudents.length})</span></strong>
            <button type="button" class="secondary select-class-btn" data-group="${escapeHtml(key)}" style="padding:2px 8px; font-size:11px;">Select class</button>
          </div>
          ${groupStudents.map((s) => `
            <div class="checkbox-row">
              <input type="checkbox" value="${s.id}" class="assign-chk" data-group="${escapeHtml(key)}" id="chk_${s.id}" />
              <label for="chk_${s.id}" style="margin:0;">${escapeHtml(s.full_name)} (${escapeHtml(s.username)})</label>
            </div>
          `).join('')}
        </div>
      `;
    }).join('');

    list.querySelectorAll('.select-class-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.group;
        list.querySelectorAll('.assign-chk').forEach((el) => {
          if (el.dataset.group === group) el.checked = true;
        });
      });
    });

    $('assignModal').style.display = 'flex';
  }

  // All submissions for an exam, any status — this is how an admin retrieves any student's
  // code/output/violation history at any time, not just while an exam is live.
  function scoreBadgeHtml(score) {
    if (score === null || score === undefined) return '<span class="muted">—</span>';
    const cls = score >= 80 ? 'high' : score >= 50 ? 'mid' : 'low';
    return `<span class="score-badge ${cls}">${score}%</span>`;
  }

  async function openSubmissionsModal(examId) {
    const exam = exams.find((e) => String(e.id) === String(examId));
    $('submissionsTitle').textContent = exam ? `Submissions — ${exam.title}` : 'Submissions';

    $('unlockAllBtn').onclick = async () => {
      if (!confirm('Unlock every currently-locked student for this exam? They\'ll be able to keep working from where they left off.')) return;
      const result = await api(`/api/admin/exams/${examId}/unlock-all`, { method: 'POST' });
      alert(result.unlocked > 0 ? `Unlocked ${result.unlocked} student(s).` : 'No locked students to unlock.');
      await openSubmissionsModal(examId);
    };

    const rows = await api(`/api/admin/exams/${examId}/assignments`);
    const tbody = $('submissionsBody');
    tbody.innerHTML = rows.length
      ? '' : '<tr><td colspan="6" class="muted">No students assigned to this exam yet.</td></tr>';
    for (const r of rows) {
      const vClass = r.violation_count === 0 ? 'zero' : 'some';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.full_name)} <span class="muted">(${escapeHtml(r.username)})</span></td>
        <td><span class="badge ${r.status}">${r.status.replace('_',' ')}</span></td>
        <td><span class="violation-count ${vClass}">${r.violation_count}</span></td>
        <td>${scoreBadgeHtml(r.score)}</td>
        <td class="muted">${r.submitted_at ? escapeHtml(r.submitted_at.slice(0,19)) : '—'}</td>
        <td>
          <button class="secondary view-sub-btn" data-id="${r.id}">View</button>
          ${r.status === 'submitted' ? `<button class="secondary continue-sub-btn" data-id="${r.id}" data-name="${escapeHtml(r.full_name)}">Continue</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.view-sub-btn').forEach((btn) => {
      btn.addEventListener('click', () => openDetail(btn.dataset.id));
    });
    tbody.querySelectorAll('.continue-sub-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Let ${btn.dataset.name} continue this exam? They'll get a fresh full time limit starting now.`)) return;
        await api(`/api/admin/assignments/${btn.dataset.id}/continue`, { method: 'POST' });
        await openSubmissionsModal(examId);
      });
    });
    $('submissionsModal').style.display = 'flex';
  }

  $('assignConfirmBtn').addEventListener('click', async () => {
    // Student ids are Mongo ObjectId strings — keep them as strings, don't parseInt.
    const ids = Array.from(document.querySelectorAll('#assignStudentList input:checked')).map((el) => el.value);
    if (ids.length === 0) { $('assignModal').style.display = 'none'; return; }
    await api(`/api/admin/exams/${assignExamId}/assign`, { method: 'POST', body: JSON.stringify({ student_ids: ids }) });
    $('assignModal').style.display = 'none';
    await loadMonitor();
  });

  // ---------------- Live Monitor ----------------

  async function loadMonitor() {
    const rows = await api('/api/admin/monitor');
    const tbody = $('monitorBody');
    tbody.innerHTML = '';
    $('monitorSelectAll').checked = false;
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">No exams currently in progress.</td></tr>';
    }
    for (const r of rows) {
      const vClass = r.violation_count === 0 ? 'zero' : (r.violation_count >= r.violation_limit ? 'high' : 'some');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.status === 'locked' ? `<input type="checkbox" class="monitor-select" data-id="${r.assignment_id}" />` : ''}</td>
        <td>${escapeHtml(r.full_name)}</td>
        <td>${escapeHtml(r.exam_title)}</td>
        <td><span class="badge ${r.status}">${r.status.replace('_',' ')}</span></td>
        <td><span class="violation-count ${vClass}">${r.violation_count} / ${r.violation_limit}</span></td>
        <td class="muted">${escapeHtml((r.last_seen_at || '').slice(0,19))}</td>
        <td><button class="secondary view-btn" data-id="${r.assignment_id}">View</button></td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => openDetail(btn.dataset.id));
    });
    $('monitorUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  $('monitorSelectAll').addEventListener('change', () => {
    const checked = $('monitorSelectAll').checked;
    document.querySelectorAll('#monitorBody .monitor-select').forEach((cb) => { cb.checked = checked; });
  });

  $('unlockSelectedBtn').addEventListener('click', async () => {
    const ids = Array.from(document.querySelectorAll('#monitorBody .monitor-select:checked')).map((cb) => cb.dataset.id);
    if (ids.length === 0) {
      alert('Select one or more locked students first (checkbox only appears for locked rows).');
      return;
    }
    if (!confirm(`Unlock ${ids.length} selected student(s)? They'll be able to keep working from where they left off.`)) return;
    const result = await api('/api/admin/assignments/unlock-bulk', { method: 'POST', body: JSON.stringify({ assignment_ids: ids }) });
    alert(`Unlocked ${result.unlocked} student(s).`);
    await loadMonitor();
  });

  async function openDetail(assignmentId) {
    const data = await api(`/api/admin/assignments/${assignmentId}`);
    $('detailTitle').textContent = data.assignment.exam_title;
    $('detailStudent').innerHTML = `${escapeHtml(data.assignment.full_name)} <span class="muted">(${escapeHtml(data.assignment.username)})</span>`;
    $('detailCodeStudent').textContent = `${data.assignment.full_name} — ${data.assignment.username}`;

    const textarea = $('detailCode');
    // Tear down the previous viewer first — toTextArea() writes its content back into the
    // textarea, which used to overwrite the code just loaded, so opening another student's
    // submission showed the previous student's code.
    if (detailCM) { detailCM.toTextArea(); detailCM = null; }
    textarea.value = data.code;
    detailCM = CodeMirror.fromTextArea(textarea, {
      mode: 'htmlmixed', theme: 'dracula', lineNumbers: true, readOnly: true, lineWrapping: true
    });
    setTimeout(() => detailCM.refresh(), 50);

    // Multi-file submissions: the main view shows the combined page (what's graded); this lets
    // the admin flip to any individual file the student wrote.
    const fileSel = $('detailFileSelect');
    const fileNames = Object.keys(data.files || {});
    if (fileNames.length) {
      fileSel.style.display = 'block';
      fileSel.innerHTML = '<option value="">Combined page (as graded)</option>'
        + fileNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      fileSel.onchange = () => {
        const n = fileSel.value;
        detailCM.setOption('mode', !n ? 'htmlmixed' : /\.css$/i.test(n) ? 'css' : /\.js$/i.test(n) ? 'javascript' : 'htmlmixed');
        detailCM.setValue(n ? data.files[n] : data.code);
      };
    } else {
      fileSel.style.display = 'none';
      fileSel.onchange = null;
    }

    const vList = $('detailViolations');
    vList.innerHTML = data.violations.length
      ? data.violations.map((v) => `
          <div style="padding:6px 0; border-bottom:1px solid var(--border);">
            <strong>${escapeHtml(v.type)}</strong> <span class="muted">${escapeHtml((v.created_at||'').slice(0,19))}</span><br/>
            <span class="muted">${escapeHtml(v.detail || '')}</span>
          </div>
        `).join('')
      : '<p class="muted">No violations recorded.</p>';

    $('unlockBtn').style.display = data.assignment.status === 'locked' ? 'inline-block' : 'none';
    $('unlockBtn').onclick = async () => {
      await api(`/api/admin/assignments/${assignmentId}/unlock`, { method: 'POST' });
      $('detailModal').style.display = 'none';
      await loadMonitor();
    };

    // Reopens a submitted exam so the student can keep working — resets the timer to a fresh
    // full time limit, so warn before doing it.
    $('continueTestBtn').style.display = data.assignment.status === 'submitted' ? 'inline-block' : 'none';
    $('continueTestBtn').onclick = async () => {
      if (!confirm(`Let ${data.assignment.full_name} continue this exam? They'll get a fresh full time limit starting now.`)) return;
      await api(`/api/admin/assignments/${assignmentId}/continue`, { method: 'POST' });
      $('detailModal').style.display = 'none';
      await loadMonitor();
    };

    renderTestResults(data.test_results, data.score, (data.assignment.checks || []).length);
    $('runTestsBtn').style.display = (data.assignment.checks || []).length ? 'inline-block' : 'none';
    $('runTestsBtn').onclick = async () => {
      const result = await api(`/api/admin/assignments/${assignmentId}/run-tests`, { method: 'POST' });
      renderTestResults(result.test_results, result.score, (data.assignment.checks || []).length);
    };

    // Per-student violation limit override — takes precedence over the exam's own setting.
    const hasOverride = data.assignment.violation_limit_override !== null && data.assignment.violation_limit_override !== undefined;
    $('detailEffectiveLimit').textContent = hasOverride
      ? `Currently: custom limit for this student (exam default is ${data.assignment.violation_limit || 'no limit'})`
      : `Currently: using the exam's default (${data.assignment.violation_limit || 'no limit'})`;
    $('detailVLimitNone').checked = hasOverride && data.assignment.violation_limit_override === 0;
    $('detailVLimitInput').value = hasOverride && data.assignment.violation_limit_override > 0
      ? data.assignment.violation_limit_override
      : (data.assignment.violation_limit || 5);
    $('detailVLimitInput').disabled = $('detailVLimitNone').checked;
    $('detailVLimitNone').onchange = () => {
      $('detailVLimitInput').disabled = $('detailVLimitNone').checked;
    };
    $('detailVLimitSaveBtn').onclick = async () => {
      const override = $('detailVLimitNone').checked ? 0 : (parseInt($('detailVLimitInput').value, 10) || 1);
      await api(`/api/admin/assignments/${assignmentId}/violation-limit`, {
        method: 'PUT',
        body: JSON.stringify({ violation_limit_override: override })
      });
      await openDetail(assignmentId);
    };
    $('detailVLimitClearBtn').onclick = async () => {
      await api(`/api/admin/assignments/${assignmentId}/violation-limit`, {
        method: 'PUT',
        body: JSON.stringify({ violation_limit_override: null })
      });
      await openDetail(assignmentId);
    };

    $('detailModal').style.display = 'flex';
  }

  function renderTestResults(testResults, score, checkCount) {
    $('detailScore').innerHTML = score === null || score === undefined ? '' : scoreBadgeHtml(score);
    const el = $('detailTestResults');
    if (!checkCount) {
      el.innerHTML = '<p class="muted">This exam has no auto-grading checks defined.</p>';
      return;
    }
    if (!testResults || testResults.length === 0) {
      el.innerHTML = '<p class="muted">Not graded yet — click "Run tests".</p>';
      return;
    }
    el.innerHTML = testResults.map((r) => `
      <div class="test-result-row">
        <span class="dot ${r.passed ? 'pass' : 'fail'}"></span>
        <div>
          <strong>${escapeHtml(r.label)}</strong><br/>
          <span class="muted">${escapeHtml(r.detail || '')}</span>
        </div>
      </div>
    `).join('');
  }

  init();
})();
