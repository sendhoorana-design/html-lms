(function () {
  let me = null;
  let socket = null;
  let students = [];
  let exams = [];
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

    $('whoami').textContent = `${me.full_name} (${me.username})`;
    $('logoutBtn').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('addStudentForm').addEventListener('submit', onAddStudent);
    $('addExamForm').addEventListener('submit', onAddExam);
    setupCsvImport();
    $('assignCancelBtn').addEventListener('click', () => $('assignModal').style.display = 'none');
    $('detailCloseBtn').addEventListener('click', () => $('detailModal').style.display = 'none');
    $('submissionsCloseBtn').addEventListener('click', () => $('submissionsModal').style.display = 'none');

    socket = io({ withCredentials: true });
    socket.on('violation', () => { loadMonitor(); flashMonitorTab(); });
    socket.on('heartbeat', () => { loadMonitor(); });
    socket.on('status_change', () => { loadMonitor(); });

    await Promise.all([loadStudents(), loadExams(), loadMonitor()]);
    setInterval(loadMonitor, 10000);
  }

  function flashMonitorTab() {
    const btn = document.querySelector('.tab-btn[data-tab="monitor"]');
    btn.style.color = 'var(--danger)';
    setTimeout(() => { btn.style.color = ''; }, 2000);
  }

  function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.style.display = (p.id === `tab-${tab}` ? 'block' : 'none'));
  }

  // ---------------- Students ----------------

  async function loadStudents() {
    students = await api('/api/admin/students');
    const tbody = $('studentsBody');
    tbody.innerHTML = '';
    for (const s of students) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(s.full_name)}</td>
        <td>${escapeHtml(s.username)}</td>
        <td>
          ${s.must_change_password
            ? '<span class="badge pw_pending">Must change</span>'
            : '<span class="badge pw_ok">OK</span>'}
        </td>
        <td>${escapeHtml((s.created_at || '').slice(0,16))}</td>
        <td>
          ${s.must_change_password ? '' : `<button class="secondary force-pw" data-id="${s.id}">Force change</button>`}
          <button class="secondary danger-del" data-id="${s.id}">Remove</button>
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
    if (usernameIdx === -1 || passwordIdx === -1) {
      throw new Error('Header row must include "username" and "password" columns');
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      rows.push({
        username: fields[usernameIdx] || '',
        password: fields[passwordIdx] || '',
        full_name: fullNameIdx !== -1 ? (fields[fullNameIdx] || '') : ''
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
      const sample = 'username,password,full_name\njdoe,Temp1234,Jane Doe\nasmith,Temp5678,Alex Smith\n';
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
          password: $('s_password').value
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
      tr.innerHTML = `
        <td>${escapeHtml(ex.title)}</td>
        <td>${ex.time_limit_minutes} min</td>
        <td>${escapeHtml((ex.created_at || '').slice(0,16))}</td>
        <td>
          <button class="secondary assign-btn" data-id="${ex.id}">Assign</button>
          <button class="secondary submissions-btn" data-id="${ex.id}">Submissions</button>
          <button class="secondary danger-exam" data-id="${ex.id}">Delete</button>
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
    tbody.querySelectorAll('.danger-exam').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this exam and all related assignments/submissions?')) return;
        await api(`/api/admin/exams/${btn.dataset.id}`, { method: 'DELETE' });
        await loadExams();
      });
    });
  }

  async function onAddExam(e) {
    e.preventDefault();
    $('examError').textContent = '';
    try {
      await api('/api/admin/exams', {
        method: 'POST',
        body: JSON.stringify({
          title: $('e_title').value.trim(),
          instructions: $('e_instructions').value,
          starter_code: $('e_starter').value,
          time_limit_minutes: parseInt($('e_time').value, 10) || 60,
          violation_limit: parseInt($('e_vlimit').value, 10) || 5
        })
      });
      $('addExamForm').reset();
      await loadExams();
    } catch (err) {
      $('examError').textContent = err.message;
    }
  }

  let assignExamId = null;
  function openAssignModal(examId) {
    assignExamId = examId;
    const list = $('assignStudentList');
    list.innerHTML = students.map((s) => `
      <div class="checkbox-row">
        <input type="checkbox" value="${s.id}" id="chk_${s.id}" />
        <label for="chk_${s.id}" style="margin:0;">${escapeHtml(s.full_name)} (${escapeHtml(s.username)})</label>
      </div>
    `).join('') || '<p class="muted">No students yet — add some in the Students tab.</p>';
    $('assignModal').style.display = 'flex';
  }

  // All submissions for an exam, any status — this is how an admin retrieves any student's
  // code/output/violation history at any time, not just while an exam is live.
  async function openSubmissionsModal(examId) {
    const exam = exams.find((e) => String(e.id) === String(examId));
    $('submissionsTitle').textContent = exam ? `Submissions — ${exam.title}` : 'Submissions';

    const rows = await api(`/api/admin/exams/${examId}/assignments`);
    const tbody = $('submissionsBody');
    tbody.innerHTML = rows.length
      ? '' : '<tr><td colspan="5" class="muted">No students assigned to this exam yet.</td></tr>';
    for (const r of rows) {
      const vClass = r.violation_count === 0 ? 'zero' : 'some';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.full_name)} <span class="muted">(${escapeHtml(r.username)})</span></td>
        <td><span class="badge ${r.status}">${r.status.replace('_',' ')}</span></td>
        <td><span class="violation-count ${vClass}">${r.violation_count}</span></td>
        <td class="muted">${r.submitted_at ? escapeHtml(r.submitted_at.slice(0,19)) : '—'}</td>
        <td><button class="secondary view-sub-btn" data-id="${r.id}">View</button></td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.view-sub-btn').forEach((btn) => {
      btn.addEventListener('click', () => openDetail(btn.dataset.id));
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
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">No exams currently in progress.</td></tr>';
    }
    for (const r of rows) {
      const vClass = r.violation_count === 0 ? 'zero' : (r.violation_count >= r.violation_limit ? 'high' : 'some');
      const tr = document.createElement('tr');
      tr.innerHTML = `
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

  async function openDetail(assignmentId) {
    const data = await api(`/api/admin/assignments/${assignmentId}`);
    $('detailTitle').textContent = `${data.assignment.full_name} — ${data.assignment.exam_title}`;

    const textarea = $('detailCode');
    textarea.value = data.code;
    if (detailCM) { detailCM.toTextArea(); detailCM = null; }
    detailCM = CodeMirror.fromTextArea(textarea, {
      mode: 'htmlmixed', theme: 'dracula', lineNumbers: true, readOnly: true, lineWrapping: true
    });
    setTimeout(() => detailCM.refresh(), 50);

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

    $('detailModal').style.display = 'flex';
  }

  init();
})();
