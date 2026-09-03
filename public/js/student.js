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
    $('lockOverlay').style.display = 'none';
    $('fullscreenPrompt').style.display = 'none';
    $('violationsPane').style.display = 'none';
    $('assignmentList').style.display = 'block';

    const assignments = await api('/api/student/assignments');
    const tbody = document.querySelector('#assignmentsTable tbody');
    tbody.innerHTML = '';
    for (const a of assignments) {
      const tr = document.createElement('tr');
      const isReadOnly = a.status === 'locked' || a.status === 'submitted';
      tr.innerHTML = `
        <td>${escapeHtml(a.title)}</td>
        <td><span class="badge ${a.status}">${a.status.replace('_',' ')}</span></td>
        <td>${a.time_limit_minutes} min</td>
        <td>${isReadOnly
          ? `<button class="secondary openBtn" data-id="${a.assignment_id}">View</button>`
          : `<button data-id="${a.assignment_id}" class="openBtn">${a.status === 'not_started' ? 'Start' : 'Resume'}</button>`}</td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.openBtn').forEach((btn) => {
      btn.addEventListener('click', () => openAssignment(btn.dataset.id));
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

    if (data.readOnly) {
      // Past submission or locked exam: show saved code + re-rendered output, read-only, no proctoring.
      $('examTimer').textContent = data.assignment.status === 'submitted' ? 'Submitted' : 'Locked';
      $('readOnlyBanner').style.display = 'inline';
      $('saveStatus').style.display = 'none';
      $('submitBtn').style.display = 'none';
      initEditor(data.code || '', true);
      renderViolations(data.violations || []);
      return;
    }

    $('readOnlyBanner').style.display = 'none';
    $('saveStatus').style.display = 'inline';
    $('submitBtn').style.display = 'inline-block';
    $('violationsPane').style.display = 'none';

    if (data.assignment.started_at && data.assignment.time_limit_minutes) {
      const started = new Date(data.assignment.started_at + 'Z');
      examEndsAt = new Date(started.getTime() + data.assignment.time_limit_minutes * 60000);
    } else {
      examEndsAt = null;
    }

    initEditor(data.code || '', false);
    startProctoring();
    startTimer();
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
    if (!examEndsAt) { $('examTimer').textContent = ''; return; }
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
