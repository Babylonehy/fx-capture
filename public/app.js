const SAMPLE_DATES = ['2026-03-20', '2026-03-21', '2026-03-22'];

const state = {
  dates: [],
  jobId: null,
  pollTimer: null,
  latestCaptchaVersion: 0,
  lastRenderedLogsKey: '',
  activeState: null
};

const elements = {
  userEmail: document.querySelector('#user-email'),
  currencySelect: document.querySelector('#currency-select'),
  dateFile: document.querySelector('#date-file'),
  loadSample: document.querySelector('#load-sample'),
  datePicker: document.querySelector('#date-picker'),
  addDate: document.querySelector('#add-date'),
  selectAllDates: document.querySelector('#select-all-dates'),
  invertDates: document.querySelector('#invert-dates'),
  dateList: document.querySelector('#date-list'),
  startButton: document.querySelector('#start-button'),
  downloadButton: document.querySelector('#download-button'),
  statusChip: document.querySelector('#status-chip'),
  jobSummary: document.querySelector('#job-summary'),
  logList: document.querySelector('#log-list'),
  appVersion: document.querySelector('#app-version'),
  activeJobLabel: document.querySelector('#active-job-label'),
  captchaModal: document.querySelector('#captcha-modal'),
  captchaDate: document.querySelector('#captcha-date'),
  captchaProgress: document.querySelector('#captcha-progress'),
  captchaImage: document.querySelector('#captcha-image'),
  captchaInput: document.querySelector('#captcha-input'),
  captchaSubmit: document.querySelector('#captcha-submit'),
  captchaRefresh: document.querySelector('#captcha-refresh'),
  captchaCancel: document.querySelector('#captcha-cancel')
};

function normalizeDates(input) {
  const seen = new Set();
  const result = [];

  for (const item of input) {
    const value = String(item || '').trim();
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push({
      value,
      selected: true
    });
  }

  return result;
}

function upsertDates(values) {
  const existing = new Set(state.dates.map((item) => item.value));

  for (const item of normalizeDates(values)) {
    if (existing.has(item.value)) {
      continue;
    }

    state.dates.push(item);
    existing.add(item.value);
  }

  state.dates.sort((left, right) => left.value.localeCompare(right.value));
  renderDateList();
}

function getSelectedDates() {
  return state.dates.filter((item) => item.selected).map((item) => item.value);
}

function setStatus(status, text) {
  elements.statusChip.textContent = text;
  elements.statusChip.className = `status-chip ${status}`;
}

function pushLocalLog(message, level = 'info') {
  const item = document.createElement('div');
  item.className = `log-item ${level}`;
  item.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
  elements.logList.prepend(item);

  while (elements.logList.children.length > 30) {
    elements.logList.removeChild(elements.logList.lastChild);
  }
}

function renderDateList() {
  elements.dateList.innerHTML = '';

  if (!state.dates.length) {
    const empty = document.createElement('div');
    empty.className = 'date-list-empty';
    empty.textContent = '导入文件或手动添加日期后，会在这里显示可选列表。';
    elements.dateList.appendChild(empty);
    return;
  }

  for (const item of state.dates) {
    const label = document.createElement('label');
    label.className = 'date-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.selected;
    checkbox.addEventListener('change', () => {
      item.selected = checkbox.checked;
    });

    const text = document.createElement('span');
    text.className = 'date-row-value';
    text.textContent = item.value;

    label.append(checkbox, text);
    elements.dateList.appendChild(label);
  }
}

let cooldownTimer = null;

function setCooldown(seconds) {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
  }

  let remaining = seconds;
  elements.startButton.disabled = true;

  const updateText = () => {
    if (remaining > 0) {
      elements.startButton.textContent = `冷却中 (${remaining}s)`;
      remaining--;
    } else {
      elements.startButton.disabled = false;
      elements.startButton.textContent = '开始批量截图';
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  };

  updateText();
  cooldownTimer = setInterval(updateText, 1000);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(data?.error || `请求失败: ${response.status}`);
    error.status = response.status;
    error.data = data;
    
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After'), 10) || 60;
      setCooldown(retryAfter);
    }
    
    throw error;
  }

  return data;
}

function renderSummary(jobState) {
  if (!jobState) {
    elements.jobSummary.classList.add('hidden');
    return;
  }

  elements.jobSummary.classList.remove('hidden');
  elements.jobSummary.innerHTML = `
    <strong>任务 ${jobState.jobId}</strong>
    当前状态：${jobState.status}。
    进度：${Math.min(jobState.currentIndex + (jobState.status === 'completed' ? 0 : 1), jobState.totalCount)}/${jobState.totalCount}。
    成功 ${jobState.successCount} 个，失败 ${jobState.failedCount} 个。
  `;
}

function renderLogs(jobState) {
  const logs = jobState?.logs || [];
  const key = logs.map((item) => item.id).join(',');
  if (key === state.lastRenderedLogsKey) {
    return;
  }

  state.lastRenderedLogsKey = key;
  elements.logList.innerHTML = '';

  for (const item of logs) {
    const row = document.createElement('div');
    row.className = `log-item ${item.level || 'info'}`;
    row.textContent = `[${new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}] ${item.message}`;
    elements.logList.appendChild(row);
  }
}

function updateDownload(jobState) {
  if (jobState?.downloadReady) {
    elements.downloadButton.classList.remove('disabled');
    elements.downloadButton.href = `/api/jobs/${jobState.jobId}/download`;
    elements.downloadButton.setAttribute('download', jobState.downloadFilename || 'result.zip');
    return;
  }

  elements.downloadButton.classList.add('disabled');
  elements.downloadButton.href = '#';
  elements.downloadButton.removeAttribute('download');
}

function openCaptcha(jobState, captcha) {
  elements.captchaDate.textContent = captcha.captchaDate || jobState.currentDate || '待输入';
  elements.captchaProgress.textContent = `任务进度 ${Math.min(jobState.currentIndex + 1, jobState.totalCount)} / ${jobState.totalCount}`;
  elements.captchaImage.src = captcha.imageDataUrl;
  elements.captchaInput.value = '';
  elements.captchaModal.classList.remove('hidden');
  elements.captchaModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => elements.captchaInput.focus(), 0);
}

function closeCaptcha() {
  elements.captchaModal.classList.add('hidden');
  elements.captchaModal.setAttribute('aria-hidden', 'true');
  elements.captchaImage.removeAttribute('src');
}

async function loadCaptcha(jobState) {
  const captcha = await api(`/api/jobs/${jobState.jobId}/captcha`);
  state.latestCaptchaVersion = captcha.captchaVersion;
  openCaptcha(jobState, captcha);
}

function applyStatus(jobState) {
  switch (jobState.status) {
    case 'running':
      setStatus('busy', `处理中 ${jobState.currentDate || ''}`.trim());
      break;
    case 'waiting_captcha':
      setStatus('waiting', '等待验证码');
      break;
    case 'completed':
      setStatus('success', '已完成');
      break;
    case 'failed':
      setStatus('error', '已失败');
      break;
    case 'cancelled':
      setStatus('warn', '已取消');
      break;
    default:
      setStatus('idle', '待执行');
      break;
  }
}

async function renderJobState(jobState) {
  state.activeState = jobState;
  state.jobId = jobState.jobId;
  elements.activeJobLabel.textContent = `当前任务: ${jobState.jobId}`;
  applyStatus(jobState);
  renderSummary(jobState);
  renderLogs(jobState);
  updateDownload(jobState);

  if (jobState.status === 'waiting_captcha' && jobState.captchaVersion !== state.latestCaptchaVersion) {
    try {
      await loadCaptcha(jobState);
    } catch (error) {
      pushLocalLog(error.message, 'error');
    }
  } else if (jobState.status !== 'waiting_captcha') {
    closeCaptcha();
  }

  if (['completed', 'failed', 'cancelled'].includes(jobState.status)) {
    stopPolling();

    if (jobState.downloadReady) {
      pushLocalLog('任务已完成，可直接下载 ZIP。', 'success');
    }
  }
}

async function pollJob() {
  if (!state.jobId) {
    return;
  }

  try {
    const jobState = await api(`/api/jobs/${state.jobId}`);
    await renderJobState(jobState);
  } catch (error) {
    pushLocalLog(error.message, 'error');
    stopPolling();
  }
}

function startPolling() {
  stopPolling();
  void pollJob();
  state.pollTimer = window.setInterval(() => {
    void pollJob();
  }, 2000);
}

function stopPolling() {
  if (!state.pollTimer) {
    return;
  }

  window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function startJob() {
  const dates = getSelectedDates();
  if (!dates.length) {
    pushLocalLog('至少勾选一个日期。', 'warn');
    return;
  }

  const option = elements.currencySelect.selectedOptions[0];
  if (!option?.value) {
    pushLocalLog('请选择有效币种。', 'warn');
    return;
  }

  elements.startButton.disabled = true;

  try {
    const jobState = await api('/api/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        dates,
        currency: {
          value: option.value,
          label: option.textContent.trim()
        }
      })
    });

    state.latestCaptchaVersion = 0;
    await renderJobState(jobState);
    startPolling();
  } catch (error) {
    if (error.status === 409 && error.data?.activeJobId) {
      pushLocalLog(`${error.message}，将继续跟踪现有任务。`, 'warn');
      state.jobId = error.data.activeJobId;
      elements.activeJobLabel.textContent = `当前任务: ${error.data.activeJobId}`;
      startPolling();
    } else if (error.status === 429) {
      pushLocalLog(error.message, 'warn');
    } else {
      pushLocalLog(error.message, 'error');
    }
  } finally {
    if (!cooldownTimer) {
      elements.startButton.disabled = false;
    }
  }
}

async function loadSession() {
  const session = await api('/api/session');
  elements.userEmail.value = session.userEmail;
  elements.appVersion.textContent = `${session.appName} ${session.appVersion}`;

  if (session.activeJobId) {
    state.jobId = session.activeJobId;
    elements.activeJobLabel.textContent = `当前任务: ${session.activeJobId}`;
    startPolling();
  }
}

async function loadCurrencies() {
  const data = await api('/api/currencies');
  elements.currencySelect.innerHTML = '';

  for (const option of data.options || []) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    elements.currencySelect.appendChild(node);
  }
}

async function onDateFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const content = await file.text();
  const values = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  upsertDates(values);
  pushLocalLog(`已导入 ${values.length} 行日期。`, 'success');
  event.target.value = '';
}

async function submitCaptcha() {
  if (!state.jobId) {
    return;
  }

  const code = elements.captchaInput.value.trim();
  if (!code) {
    pushLocalLog('请输入验证码。', 'warn');
    return;
  }

  elements.captchaSubmit.disabled = true;

  try {
    state.latestCaptchaVersion = 0;
    const jobState = await api(`/api/jobs/${state.jobId}/captcha`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ code })
    });
    await renderJobState(jobState);
  } catch (error) {
    if (error.status === 429) {
      pushLocalLog(error.message, 'warn');
      closeCaptcha();
    } else {
      pushLocalLog(error.message, 'error');
    }
  } finally {
    elements.captchaSubmit.disabled = false;
  }
}

async function refreshCaptcha() {
  if (!state.jobId) {
    return;
  }

  elements.captchaRefresh.disabled = true;

  try {
    state.latestCaptchaVersion = 0;
    const jobState = await api(`/api/jobs/${state.jobId}/captcha/refresh`, {
      method: 'POST'
    });
    await renderJobState(jobState);
  } catch (error) {
    if (error.status === 429) {
      pushLocalLog(error.message, 'warn');
      closeCaptcha();
    } else {
      pushLocalLog(error.message, 'error');
    }
  } finally {
    elements.captchaRefresh.disabled = false;
  }
}

async function cancelJob() {
  if (!state.jobId) {
    return;
  }

  try {
    const jobState = await api(`/api/jobs/${state.jobId}/cancel`, {
      method: 'POST'
    });
    await renderJobState(jobState);
  } catch (error) {
    pushLocalLog(error.message, 'error');
  }
}

function bindEvents() {
  elements.dateFile.addEventListener('change', onDateFileChange);
  elements.loadSample.addEventListener('click', () => {
    upsertDates(SAMPLE_DATES);
    pushLocalLog('已载入示例日期。', 'success');
  });
  elements.addDate.addEventListener('click', () => {
    const value = elements.datePicker.value;
    if (!value) {
      pushLocalLog('请先选择日期。', 'warn');
      return;
    }

    upsertDates([value]);
    elements.datePicker.value = '';
  });
  elements.selectAllDates.addEventListener('click', () => {
    state.dates.forEach((item) => {
      item.selected = true;
    });
    renderDateList();
  });
  elements.invertDates.addEventListener('click', () => {
    state.dates.forEach((item) => {
      item.selected = !item.selected;
    });
    renderDateList();
  });
  elements.startButton.addEventListener('click', () => {
    void startJob();
  });
  elements.captchaSubmit.addEventListener('click', () => {
    void submitCaptcha();
  });
  elements.captchaRefresh.addEventListener('click', () => {
    void refreshCaptcha();
  });
  elements.captchaCancel.addEventListener('click', () => {
    void cancelJob();
  });
  elements.captchaInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitCaptcha();
    }
  });
}

async function boot() {
  renderDateList();
  bindEvents();
  setStatus('idle', '加载中');

  try {
    await Promise.all([loadSession(), loadCurrencies()]);
    setStatus('idle', '待执行');
  } catch (error) {
    setStatus('error', '初始化失败');
    pushLocalLog(error.message, 'error');
  }
}

void boot();
