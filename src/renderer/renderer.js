const elements = {
  fileInput: document.querySelector('#date-file'),
  loadSample: document.querySelector('#load-sample'),
  datePicker: document.querySelector('#date-picker'),
  addDate: document.querySelector('#add-date'),
  selectAllDates: document.querySelector('#select-all-dates'),
  invertDates: document.querySelector('#invert-dates'),
  dateList: document.querySelector('#date-list'),
  currencySelect: document.querySelector('#currency-select'),
  outputDirectory: document.querySelector('#output-directory'),
  pickOutput: document.querySelector('#pick-output'),
  startButton: document.querySelector('#start-button'),
  openOutput: document.querySelector('#open-output'),
  logList: document.querySelector('#log-list'),
  statusChip: document.querySelector('#status-chip'),
  appVersion: document.querySelector('#app-version'),
  captchaModal: document.querySelector('#captcha-modal'),
  captchaDate: document.querySelector('#captcha-date'),
  captchaProgress: document.querySelector('#captcha-progress'),
  captchaImage: document.querySelector('#captcha-image'),
  captchaInput: document.querySelector('#captcha-input'),
  captchaSubmit: document.querySelector('#captcha-submit'),
  captchaRefresh: document.querySelector('#captcha-refresh'),
  captchaCancel: document.querySelector('#captcha-cancel')
};

let running = false;
let latestOutputDirectory = '';
let dateEntries = [];
let datePickerInstance = null;
const fallbackCurrencies = ['美元', '港币', '澳大利亚元', '欧元', '日元', '英镑', '加拿大元', '新加坡元'];

async function loadAppInfo() {
  try {
    const info = await window.bocApp.getAppInfo();
    elements.appVersion.textContent = `${info.name} v${info.version}`;
  } catch (_error) {
    elements.appVersion.textContent = '版本信息不可用';
  }
}

function renderCurrencyOptions(options) {
  const currentValue = elements.currencySelect.value;
  const normalized = Array.isArray(options) && options.length ? options : fallbackCurrencies.map((item) => ({
    value: item,
    label: item
  }));

  elements.currencySelect.innerHTML = '';

  normalized.forEach((option) => {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    elements.currencySelect.appendChild(element);
  });

  const preserved = normalized.find((option) => option.value === currentValue || option.label === currentValue);
  elements.currencySelect.value = preserved ? preserved.value : normalized[0].value;
}

async function loadCurrencyOptions() {
  try {
    const result = await window.bocApp.getCurrencyOptions();
    renderCurrencyOptions(result.options);
    addLog(`已动态加载 ${result.options.length} 个币种。`, 'success');
  } catch (error) {
    renderCurrencyOptions();
    addLog(`动态加载币种失败，已使用默认列表: ${error.message}`, 'warn');
  }
}

function uniqueDates(dates) {
  return dates.filter((item, index, all) => all.indexOf(item) === index);
}

function addLog(message, tone = 'neutral') {
  const item = document.createElement('div');
  item.className = `log-item ${tone}`;
  item.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
  elements.logList.prepend(item);
  elements.logList.scrollTop = 0;
}

function setRunningState(nextRunning) {
  running = nextRunning;
  elements.startButton.disabled = nextRunning;
  elements.fileInput.disabled = nextRunning;
  elements.pickOutput.disabled = nextRunning;
  elements.currencySelect.disabled = nextRunning;
  elements.loadSample.disabled = nextRunning;
  elements.datePicker.disabled = nextRunning;
  elements.addDate.disabled = nextRunning;
  elements.selectAllDates.disabled = nextRunning || !dateEntries.length;
  elements.invertDates.disabled = nextRunning || !dateEntries.length;
  elements.openOutput.disabled = nextRunning || !latestOutputDirectory;
  renderDateList();
}

function initDatePicker() {
  if (typeof window.flatpickr !== 'function') {
    addLog('日期选择插件加载失败，当前无法点选日期。', 'error');
    return;
  }

  if (window.flatpickr.l10ns?.zh) {
    window.flatpickr.localize(window.flatpickr.l10ns.zh);
  }

  datePickerInstance = window.flatpickr(elements.datePicker, {
    dateFormat: 'Y-m-d',
    allowInput: false,
    clickOpens: true,
    disableMobile: true,
    locale: 'zh',
    monthSelectorType: 'static'
  });
}

function setStatus(label, tone) {
  elements.statusChip.textContent = label;
  elements.statusChip.className = `status-chip ${tone}`;
}

function parseDates(raw) {
  return uniqueDates(
    raw
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
  );
}

function validateDates(dates) {
  if (!dates.length) {
    throw new Error('请先提供至少一个日期。');
  }

  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`日期格式错误: ${date}`);
    }
  }
}

function renderDateList() {
  elements.dateList.innerHTML = '';
  elements.dateList.classList.toggle('disabled', running);

  if (!dateEntries.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'date-list-empty';
    emptyState.textContent = '导入文件或手动添加日期后，会在这里显示可选列表。';
    elements.dateList.appendChild(emptyState);
    return;
  }

  dateEntries.forEach((entry, index) => {
    const label = document.createElement('label');
    label.className = 'date-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = entry.checked;
    checkbox.disabled = running;
    checkbox.dataset.index = String(index);

    const value = document.createElement('span');
    value.className = 'date-row-value';
    value.textContent = entry.value;

    label.append(checkbox, value);
    elements.dateList.appendChild(label);
  });
}

function setDateEntries(dates) {
  dateEntries = uniqueDates(dates).map((value) => ({ value, checked: true }));
  elements.selectAllDates.disabled = running || !dateEntries.length;
  elements.invertDates.disabled = running || !dateEntries.length;
  renderDateList();
}

function appendDateEntry(date) {
  if (dateEntries.some((entry) => entry.value === date)) {
    return false;
  }

  dateEntries.push({ value: date, checked: true });
  elements.selectAllDates.disabled = running || !dateEntries.length;
  elements.invertDates.disabled = running || !dateEntries.length;
  renderDateList();
  return true;
}

function setAllDateEntries(checked) {
  if (!dateEntries.length) {
    return;
  }

  dateEntries = dateEntries.map((entry) => ({ ...entry, checked }));
  renderDateList();
}

function invertDateEntries() {
  if (!dateEntries.length) {
    return;
  }

  dateEntries = dateEntries.map((entry) => ({ ...entry, checked: !entry.checked }));
  renderDateList();
}

function getSelectedDates() {
  return dateEntries.filter((entry) => entry.checked).map((entry) => entry.value);
}

function openCaptchaModal(payload) {
  elements.captchaDate.textContent = payload.date;
  elements.captchaProgress.textContent =
    payload.current && payload.total ? `任务进度 ${payload.current} / ${payload.total}` : '任务进度待同步';
  elements.captchaImage.src = payload.imageDataUrl;
  elements.captchaInput.value = '';
  elements.captchaModal.classList.remove('hidden');
  elements.captchaModal.setAttribute('aria-hidden', 'false');
  setStatus(`等待输入 ${payload.date} 验证码`, 'waiting');
  addLog(`${payload.date} 需要输入验证码。`, 'warn');
  window.setTimeout(() => elements.captchaInput.focus(), 50);
}

function closeCaptchaModal() {
  elements.captchaModal.classList.add('hidden');
  elements.captchaModal.setAttribute('aria-hidden', 'true');
  elements.captchaImage.removeAttribute('src');
  elements.captchaProgress.textContent = '等待任务信息';
}

function appendSelectedDate() {
  const date = elements.datePicker.value.trim();
  if (!date) {
    addLog('请先从日期选择器里选一个日期。', 'warn');
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    addLog(`日期选择结果格式异常: ${date}`, 'error');
    elements.datePicker.focus();
    return;
  }

  if (!appendDateEntry(date)) {
    addLog(`${date} 已在列表中。`, 'warn');
    return;
  }

  if (datePickerInstance) {
    datePickerInstance.clear();
  } else {
    elements.datePicker.value = '';
  }

  addLog(`已添加日期: ${date}`);
}

async function handleStart() {
  try {
    if (!dateEntries.length) {
      throw new Error('请先提供至少一个日期。');
    }

    const dates = getSelectedDates();
    if (!dates.length) {
      throw new Error('请至少勾选一个日期。');
    }

    validateDates(dates);

    if (!elements.outputDirectory.value.trim()) {
      throw new Error('请先选择输出目录。');
    }

    latestOutputDirectory = elements.outputDirectory.value.trim();
    setRunningState(true);
    setStatus('任务运行中', 'busy');
    addLog(`开始执行，共 ${dates.length} 个日期。`);

    await window.bocApp.startCapture({
      dates,
      currency: elements.currencySelect.value,
      outputDirectory: elements.outputDirectory.value.trim()
    });
  } catch (error) {
    setRunningState(false);
    setStatus('执行失败', 'error');
    addLog(error.message, 'error');
  }
}

elements.fileInput.addEventListener('change', async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  const content = await file.text();
  setDateEntries(parseDates(content.trim()));
  addLog(`已加载日期文件: ${file.name}`);
});

elements.loadSample.addEventListener('click', () => {
  setDateEntries(['2026-03-20', '2026-03-21', '2026-03-22']);
  addLog('已载入示例日期内容。');
});

elements.addDate.addEventListener('click', appendSelectedDate);

elements.selectAllDates.addEventListener('click', () => {
  setAllDateEntries(true);
  addLog('已全选当前日期列表。');
});

elements.invertDates.addEventListener('click', () => {
  invertDateEntries();
  addLog('已反选当前日期列表。');
});

elements.dateList.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') {
    return;
  }

  const index = Number(target.dataset.index);
  if (!Number.isInteger(index) || !dateEntries[index]) {
    return;
  }

  dateEntries[index].checked = target.checked;
});

elements.pickOutput.addEventListener('click', async () => {
  const directory = await window.bocApp.pickOutputDirectory();
  if (!directory) {
    return;
  }

  elements.outputDirectory.value = directory;
  latestOutputDirectory = directory;
  elements.openOutput.disabled = running || !latestOutputDirectory;
  addLog(`输出目录已设置: ${directory}`);
});

elements.startButton.addEventListener('click', handleStart);

elements.openOutput.addEventListener('click', async () => {
  try {
    const directory = elements.outputDirectory.value.trim() || latestOutputDirectory;
    if (!directory) {
      throw new Error('当前没有可打开的输出目录。');
    }

    await window.bocApp.openOutputDirectory(directory);
    addLog(`已打开输出目录: ${directory}`, 'success');
  } catch (error) {
    addLog(error.message, 'error');
  }
});

elements.captchaSubmit.addEventListener('click', async () => {
  const code = elements.captchaInput.value.trim();
  if (!code) {
    addLog('验证码不能为空。', 'warn');
    elements.captchaInput.focus();
    return;
  }

  closeCaptchaModal();
  addLog('验证码已提交，继续执行。');
  await window.bocApp.submitCaptcha(code);
});

elements.captchaRefresh.addEventListener('click', async () => {
  addLog('请求刷新验证码。');
  await window.bocApp.refreshCaptcha();
});

elements.captchaCancel.addEventListener('click', async () => {
  closeCaptchaModal();
  setStatus('任务已取消', 'error');
  addLog('用户取消了当前任务。', 'error');
  await window.bocApp.cancelCaptcha();
});

elements.captchaInput.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    elements.captchaSubmit.click();
  }
});

window.bocApp.onProgress((payload) => {
  if (payload.phase === 'running') {
    setStatus(`处理中 ${payload.current}/${payload.total}`, 'busy');
  }

  if (payload.phase === 'retrying') {
    setStatus(`重试 ${payload.date}`, 'warn');
  }

  if (payload.phase === 'date-complete') {
    addLog(`${payload.date} 已保存到 ${payload.outputFile}`, 'success');
  } else if (payload.phase === 'date-failed') {
    addLog(payload.message, 'error');
  } else {
    addLog(payload.message);
  }
});

window.bocApp.onFinished((payload) => {
  closeCaptchaModal();
  latestOutputDirectory = payload.outputDirectory || latestOutputDirectory;
  setRunningState(false);
  setStatus(`完成 ${payload.success}/${payload.total}`, payload.failed ? 'warn' : 'success');
  addLog(
    `任务完成，成功 ${payload.success} 个，失败 ${payload.failed} 个，输出目录: ${payload.outputDirectory}`,
    payload.failed ? 'warn' : 'success'
  );
  elements.openOutput.disabled = !latestOutputDirectory;

  if (latestOutputDirectory) {
    window.bocApp
      .openOutputDirectory(latestOutputDirectory)
      .then(() => {
        addLog(`已自动打开输出目录: ${latestOutputDirectory}`, 'success');
      })
      .catch((error) => {
        addLog(`自动打开输出目录失败: ${error.message}`, 'error');
      });
  }
});

window.bocApp.onError((payload) => {
  closeCaptchaModal();
  setRunningState(false);
  setStatus('执行失败', 'error');
  addLog(payload.message, 'error');
  elements.openOutput.disabled = !latestOutputDirectory;
});

window.bocApp.onCaptchaRequired((payload) => {
  openCaptchaModal(payload);
});

loadAppInfo();
loadCurrencyOptions();
initDatePicker();
setRunningState(false);
