const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const APP_URL = 'https://srh.bankofchina.com/search/whpj/search_cn.jsp';
const DEFAULT_WINDOW = { width: 1280, height: 900 };

let mainWindow = null;
let activeJob = null;
let pendingCaptchaResolver = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 1080,
    minWidth: 1240,
    minHeight: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setTitle('Bonnie FX Capture');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-');
}

function normalizeDates(dates) {
  if (!Array.isArray(dates)) {
    throw new Error('日期列表格式不正确。');
  }

  const normalized = dates
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);

  if (!normalized.length) {
    throw new Error('至少需要一个有效日期。');
  }

  for (const value of normalized) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`日期格式无效: ${value}`);
    }
  }

  return normalized;
}

async function executeInPage(targetWindow, fn, arg) {
  const source = `(${fn})(${JSON.stringify(arg ?? null)})`;
  return targetWindow.webContents.executeJavaScript(source, true);
}

async function waitForPageReady(targetWindow) {
  await targetWindow.webContents.executeJavaScript(
    `new Promise((resolve) => {
      if (document.readyState === 'complete') {
        resolve(true);
        return;
      }

      window.addEventListener('load', () => resolve(true), { once: true });
    })`,
    true
  );
}

async function waitForResults(targetWindow, expectedDate) {
  const expectedDateText = expectedDate.replace(/-/g, '/');
  const startedAt = Date.now();

  while (Date.now() - startedAt < 25000) {
    const inspection = await executeInPage(
      targetWindow,
      function inspectPage(arg) {
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const tables = Array.from(document.querySelectorAll('table'));
        const resultTable = tables.find((table) => table.innerText.includes('货币名称'));
        const rowCount = resultTable ? resultTable.querySelectorAll('tr').length : 0;
        const alertText = Array.from(document.querySelectorAll('script'))
          .map((script) => script.innerText || '')
          .find((text) => /alert\(/.test(text)) || '';

        return {
          rowCount,
          hasExpectedDate: bodyText.includes(arg.expectedDateText),
          bodyText,
          alertText,
          hasCaptchaImage: Boolean(document.querySelector('#captcha_img')),
          token: sessionStorage.getItem('auth_token') || '',
          formToken: document.querySelector('input[name="token"]')?.value || ''
        };
      },
      { expectedDateText }
    );

    if (inspection.rowCount > 1 && inspection.hasExpectedDate) {
      return;
    }

    if (/验证码|校验码|输入有误/.test(inspection.bodyText) || /验证码|校验码|输入有误/.test(inspection.alertText)) {
      throw new Error('验证码可能输入错误，请重试当前日期。');
    }

    await delay(500);
  }

  throw new Error(`等待查询结果超时: ${expectedDate}`);
}

async function waitForCaptchaReady(targetWindow) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 15000) {
    const state = await executeInPage(
      targetWindow,
      function inspectCaptchaState() {
        const image = document.querySelector('#captcha_img');
        const imageSrc = image?.getAttribute('src') || '';
        const token = sessionStorage.getItem('auth_token') || '';
        const formToken = document.querySelector('input[name="token"]')?.value || '';

        return {
          imageReady: imageSrc.startsWith('data:image/png;base64,'),
          imageSrcLength: imageSrc.length,
          tokenReady: Boolean(token),
          tokenLength: token.length,
          formTokenLength: formToken.length
        };
      },
      null
    );

    if (state.imageReady && state.tokenReady) {
      return state;
    }

    await delay(300);
  }

  throw new Error('验证码图片或 token 未准备完成。');
}

async function getPageMetrics(targetWindow) {
  return executeInPage(
    targetWindow,
    function readMetrics() {
      const root = document.documentElement;
      const body = document.body;

      return {
        width: Math.max(root.scrollWidth, body?.scrollWidth || 0, 1280),
        height: Math.max(root.scrollHeight, body?.scrollHeight || 0, 900)
      };
    },
    null
  );
}

async function readTopQuote(targetWindow) {
  return executeInPage(
    targetWindow,
    function collectTopQuote() {
      const tables = Array.from(document.querySelectorAll('table'));
      const resultTable = tables.find((table) => table.innerText.includes('货币名称'));
      if (!resultTable) {
        throw new Error('未找到结果表格。');
      }

      const rows = Array.from(resultTable.querySelectorAll('tr'));
      const headerCells = Array.from(rows[0]?.querySelectorAll('th,td') || []).map((cell) =>
        (cell.innerText || '').trim()
      );
      const firstDataRow = rows.find((row, index) => {
        if (index === 0) {
          return false;
        }

        return row.querySelectorAll('td').length >= 7;
      });

      if (!firstDataRow) {
        throw new Error('未找到结果数据行。');
      }

      const cells = Array.from(firstDataRow.querySelectorAll('td')).map((cell) =>
        (cell.innerText || '').trim()
      );
      const quote = {};

      headerCells.forEach((header, index) => {
        quote[header] = cells[index] || '';
      });

      return {
        currency: quote['货币名称'] || cells[0] || '',
        price:
          quote['中行折算价'] ||
          quote['现汇买入价'] ||
          quote['现钞买入价'] ||
          quote['现汇卖出价'] ||
          quote['现钞卖出价'] ||
          '',
        publishedAt: quote['发布时间'] || cells[cells.length - 1] || ''
      };
    },
    null
  );
}

async function findFormControls(targetWindow) {
  return executeInPage(
    targetWindow,
    function inspectControls() {
      const form = document.querySelector('#historysearchform');
      const dateInput = document.querySelector('#searchDate');
      const select = document.querySelector('#pjname');
      const captchaInput = document.querySelector('input[name="captcha"]');
      const captchaImage = document.querySelector('#captcha_img');
      const queryTrigger = form?.querySelector('input[type="button"][value="查询"]') || null;

      if (!form || !dateInput || !captchaInput || !select || !queryTrigger || !captchaImage) {
        return {
          ok: false,
          stats: {
            form: Boolean(form),
            dateInput: Boolean(dateInput),
            select: Boolean(select),
            captchaInput: Boolean(captchaInput),
            queryTrigger: Boolean(queryTrigger),
            captchaImage: Boolean(captchaImage)
          }
        };
      }

      const captchaRect = captchaImage.getBoundingClientRect();

      return {
        ok: true,
        stats: {
          tokenReady: Boolean(sessionStorage.getItem('auth_token'))
        },
        captchaRect: {
          x: Math.round(captchaRect.x),
          y: Math.round(captchaRect.y),
          width: Math.ceil(captchaRect.width),
          height: Math.ceil(captchaRect.height)
        },
        selectOptions: Array.from(select.options).map((option) => ({
          value: option.value,
          text: option.text.trim()
        }))
      };
    },
    null
  );
}

async function fillQueryForm(targetWindow, date, currency) {
  const result = await executeInPage(
    targetWindow,
    function fillForm(arg) {
      const triggerInput = (element) => {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const dateInput = document.querySelector('#searchDate');
      const captchaInput = document.querySelector('input[name="captcha"]');
      const select = document.querySelector('#pjname');

      if (!dateInput || !captchaInput || !select) {
        throw new Error('未找到查询表单控件。');
      }

      dateInput.focus();
      dateInput.value = arg.date;
      triggerInput(dateInput);

      const matchedOption =
        Array.from(select.options).find((option) => option.value === arg.currency) ||
        Array.from(select.options).find((option) => option.text.trim() === arg.currency);

      if (!matchedOption) {
        throw new Error(`站点中不存在币种: ${arg.currency}`);
      }

      select.value = matchedOption.value;
      triggerInput(select);

      captchaInput.value = '';
      triggerInput(captchaInput);

      return { selectedValue: matchedOption.value, selectedText: matchedOption.text.trim() };
    },
    { date, currency }
  );

  return result;
}

async function requestCaptcha(targetWindow, currentDate, progress) {
  while (true) {
    const controls = await findFormControls(targetWindow);
    if (!controls.ok) {
      throw new Error(`无法识别页面控件: ${JSON.stringify(controls.stats)}`);
    }

    const imageDataUrl = await executeInPage(
      targetWindow,
      function readCaptchaImage() {
        const image = document.querySelector('#captcha_img');
        const src = image?.getAttribute('src') || image?.src || '';
        if (!src || !src.startsWith('data:image/')) {
          throw new Error('验证码图片数据未准备完成。');
        }

        return src;
      },
      null
    );

    sendToRenderer('captcha:required', {
      date: currentDate,
      imageDataUrl,
      current: progress?.current || null,
      total: progress?.total || null
    });

    const action = await new Promise((resolve) => {
      pendingCaptchaResolver = resolve;
    });

    pendingCaptchaResolver = null;

    if (action.type === 'cancel') {
      throw new Error('任务已取消。');
    }

    if (action.type === 'refresh') {
      await executeInPage(
        targetWindow,
        function refreshCaptchaImage() {
          if (typeof window.getCaptchaImg === 'function') {
            window.getCaptchaImg('captcha_img');
            return;
          }

          const candidate = document.querySelector('#captcha_img');
          if (!candidate) {
            throw new Error('未找到验证码图片。');
          }

          candidate.click();
        },
        null
      );
      await waitForCaptchaReady(targetWindow);
      await delay(600);
      continue;
    }

    if (action.type === 'submit') {
      return action.code;
    }
  }
}

async function submitQuery(targetWindow, captchaCode) {
  await executeInPage(
    targetWindow,
    function applyCaptchaAndSubmit(arg) {
      const triggerInput = (element) => {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const form = document.querySelector('#historysearchform');
      const captchaInput = document.querySelector('input[name="captcha"]');
      const hiddenToken = document.querySelector('input[name="token"]');
      const sessionToken = sessionStorage.getItem('auth_token') || '';

      if (!form || !captchaInput || !hiddenToken) {
        throw new Error('未找到验证码输入框或隐藏 token。');
      }

      captchaInput.focus();
      captchaInput.value = arg.captchaCode;
      triggerInput(captchaInput);

      hiddenToken.value = sessionToken;
      form.method = 'post';

      if (typeof window.executeSearch === 'function') {
        window.executeSearch();
        return {
          tokenLength: sessionToken.length
        };
      }

      form.submit();
      return {
        tokenLength: sessionToken.length
      };
    },
    { captchaCode }
  );
}

async function waitForReload(targetWindow) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('提交查询后页面未刷新。'));
    }, 15000);

    const cleanup = () => {
      clearTimeout(timeout);
      targetWindow.webContents.removeListener('did-finish-load', handleFinish);
      targetWindow.webContents.removeListener('did-fail-load', handleFail);
    };

    const handleFinish = () => {
      cleanup();
      resolve();
    };

    const handleFail = (_event, errorCode, errorDescription) => {
      cleanup();
      reject(new Error(`页面加载失败: ${errorCode} ${errorDescription}`));
    };

    targetWindow.webContents.once('did-finish-load', handleFinish);
    targetWindow.webContents.once('did-fail-load', handleFail);
  });
}

async function getDebugSnapshot(targetWindow) {
  try {
    return await executeInPage(
      targetWindow,
      function collectDebugSnapshot() {
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500);
        return {
          location: window.location.href,
          title: document.title,
          bodyText,
          token: sessionStorage.getItem('auth_token') || '',
          formToken: document.querySelector('input[name="token"]')?.value || '',
          captchaSrcLength: document.querySelector('#captcha_img')?.getAttribute('src')?.length || 0
        };
      },
      null
    );
  } catch (error) {
    return { debugError: error.message };
  }
}

async function saveScreenshot(targetWindow, outputFile) {
  const metrics = await getPageMetrics(targetWindow);
  const contentWidth = Math.min(Math.max(metrics.width + 40, DEFAULT_WINDOW.width), 1600);
  const contentHeight = Math.min(Math.max(metrics.height + 40, DEFAULT_WINDOW.height), 3200);

  targetWindow.setContentSize(contentWidth, contentHeight);
  await delay(350);

  const image = await targetWindow.webContents.capturePage();
  await fs.writeFile(outputFile, image.toPNG());
}

async function captureSingleDate(targetWindow, options) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await targetWindow.loadURL(APP_URL, { userAgent: 'Mozilla/5.0 Electron' });
      await waitForPageReady(targetWindow);
      await waitForCaptchaReady(targetWindow);
      await fillQueryForm(targetWindow, options.date, options.currency);

      const captchaCode = await requestCaptcha(targetWindow, options.date, {
        current: options.current,
        total: options.total
      });
      await Promise.all([waitForReload(targetWindow), submitQuery(targetWindow, captchaCode)]);
      await waitForResults(targetWindow, options.date);
      const quote = await readTopQuote(targetWindow);
      const outputFile = path.join(
        options.outputDirectory,
        `${sanitizeFilenamePart(quote.currency || options.currency)}-${sanitizeFilenamePart(options.date)}-${sanitizeFilenamePart(quote.price || 'unknown')}.png`
      );
      await saveScreenshot(targetWindow, outputFile);
      return {
        outputFile,
        quote
      };
    } catch (error) {
      if (error.message === '任务已取消。') {
        throw error;
      }

      const debug = await getDebugSnapshot(targetWindow);
      lastError = new Error(`${error.message} | 调试信息: ${JSON.stringify(debug)}`);
      if (attempt < 3) {
        sendToRenderer('job:progress', {
          phase: 'retrying',
          date: options.date,
          message: `${options.date} 第 ${attempt} 次失败，准备重试: ${lastError.message}`
        });
      }
    }
  }

  throw lastError || new Error(`处理失败: ${options.date}`);
}

async function runCaptureJob(payload) {
  if (activeJob) {
    throw new Error('已有任务正在执行，请稍后再试。');
  }

  const dates = normalizeDates(payload?.dates);
  const currency = String(payload?.currency || '美元').trim();
  const outputDirectory = String(payload?.outputDirectory || '').trim();

  if (!outputDirectory) {
    throw new Error('请选择截图输出目录。');
  }

  await fs.mkdir(outputDirectory, { recursive: true });

  const automationWindow = new BrowserWindow({
    show: false,
    width: DEFAULT_WINDOW.width,
    height: DEFAULT_WINDOW.height,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false
    }
  });

  activeJob = { automationWindow };

  const summary = {
    total: dates.length,
    success: 0,
    failed: 0,
    files: [],
    errors: []
  };

  try {
    for (const [index, date] of dates.entries()) {
      sendToRenderer('job:progress', {
        phase: 'running',
        current: index + 1,
        total: dates.length,
        date,
        message: `正在处理 ${date}`
      });

      try {
        const result = await captureSingleDate(automationWindow, {
          date,
          currency,
          outputDirectory,
          current: index + 1,
          total: dates.length
        });
        summary.success += 1;
        summary.files.push(result.outputFile);

        sendToRenderer('job:progress', {
          phase: 'date-complete',
          current: index + 1,
          total: dates.length,
          date,
          outputFile: result.outputFile,
          message: `已保存 ${path.basename(result.outputFile)}`
        });
      } catch (error) {
        if (error.message === '任务已取消。') {
          throw error;
        }

        summary.failed += 1;
        summary.errors.push({ date, message: error.message });

        sendToRenderer('job:progress', {
          phase: 'date-failed',
          current: index + 1,
          total: dates.length,
          date,
          message: `${date} 失败: ${error.message}`
        });
      }
    }

    sendToRenderer('job:finished', {
      ...summary,
      outputDirectory
    });

    return {
      ok: true,
      ...summary,
      outputDirectory
    };
  } finally {
    pendingCaptchaResolver = null;
    activeJob = null;
    if (!automationWindow.isDestroyed()) {
      automationWindow.close();
    }
  }
}

ipcMain.handle('dialog:pick-output-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('app:get-info', async () => {
  return {
    name: app.getName(),
    version: app.getVersion()
  };
});

ipcMain.handle('currency:list', async () => {
  const probeWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false
    }
  });

  try {
    await probeWindow.loadURL(APP_URL, { userAgent: 'Mozilla/5.0 Electron' });
    await waitForPageReady(probeWindow);
    await waitForCaptchaReady(probeWindow);

    const options = await executeInPage(
      probeWindow,
      function collectCurrencyOptions() {
        const select = document.querySelector('#pjname');
        if (!select) {
          throw new Error('未找到币种下拉框。');
        }

        return Array.from(select.options)
          .map((option) => ({
            value: (option.value || '').trim(),
            label: (option.text || '').trim()
          }))
          .filter((option) => option.value && option.value !== '0' && option.label && option.label !== '选择货币');
      },
      null
    );

    return { options };
  } finally {
    if (!probeWindow.isDestroyed()) {
      probeWindow.close();
    }
  }
});

ipcMain.handle('shell:open-output-directory', async (_event, payload) => {
  const directory = String(payload?.directory || '').trim();
  if (!directory) {
    throw new Error('没有可打开的输出目录。');
  }

  const errorMessage = await shell.openPath(directory);
  if (errorMessage) {
    throw new Error(`打开目录失败: ${errorMessage}`);
  }

  return { ok: true };
});

ipcMain.handle('job:start-capture', async (_event, payload) => {
  try {
    return await runCaptureJob(payload);
  } catch (error) {
    sendToRenderer('job:error', { message: error.message });
    throw error;
  }
});

ipcMain.handle('captcha:submit', async (_event, payload) => {
  if (pendingCaptchaResolver) {
    pendingCaptchaResolver({
      type: 'submit',
      code: String(payload?.code || '').trim()
    });
  }
});

ipcMain.handle('captcha:refresh', async () => {
  if (pendingCaptchaResolver) {
    pendingCaptchaResolver({ type: 'refresh' });
  }
});

ipcMain.handle('captcha:cancel', async () => {
  if (pendingCaptchaResolver) {
    pendingCaptchaResolver({ type: 'cancel' });
  }
});

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
