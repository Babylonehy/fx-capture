function decodeHtml(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, '').trim();
}

export const DEFAULT_CURRENCIES = [
  { value: '1314', label: '美元' },
  { value: '1323', label: '欧元' },
  { value: '1325', label: '英镑' },
  { value: '1326', label: '港币' },
  { value: '1324', label: '日元' }
];

export async function fetchCurrencyOptions(env) {
  try {
    const response = await fetch(env.APP_URL, { cf: { cacheTtl: 300 } });
    if (!response.ok) {
      throw new Error(`货币列表请求失败: ${response.status}`);
    }

    const html = await response.text();
    const selectMatch =
      html.match(/<select[^>]+id=["']pjname["'][\s\S]*?<\/select>/i) ||
      html.match(/<select[^>]+name=["']pjname["'][\s\S]*?<\/select>/i);

    const selectHtml = selectMatch?.[0] || html;
    const optionPattern = /<option[^>]+value=["']?([^"'>\s]+)["']?[^>]*>([\s\S]*?)<\/option>/gi;
    const seen = new Set();
    const options = [];
    let match;

    while ((match = optionPattern.exec(selectHtml))) {
      const value = decodeHtml(match[1]);
      const label = decodeHtml(stripTags(match[2]));

      if (!value || value === '0' || !label || /选择货币/.test(label) || seen.has(value)) {
        continue;
      }

      seen.add(value);
      options.push({ value, label });
    }

    return options.length ? options : DEFAULT_CURRENCIES;
  } catch (_error) {
    return DEFAULT_CURRENCIES;
  }
}

export async function getOrCreatePage(browser) {
  const pages = await browser.pages();
  const page = pages[pages.length - 1] || (await browser.newPage());

  await page.setViewport({
    width: 1440,
    height: 1080,
    deviceScaleFactor: 1
  });

  return page;
}

export async function waitForCaptchaReady(page, timeoutMs = 15000) {
  await page.waitForFunction(
    () => {
      const image = document.querySelector('#captcha_img');
      const src = image?.getAttribute('src') || image?.src || '';
      const token = sessionStorage.getItem('auth_token') || '';
      return src.startsWith('data:image/') && Boolean(token);
    },
    { timeout: timeoutMs }
  );
}

export async function fillQueryForm(page, { date, currencyValue }) {
  await page.waitForSelector('#historysearchform', { timeout: 15000 });

  return page.evaluate((payload) => {
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

    const matchedOption = Array.from(select.options).find(
      (option) => String(option.value || '').trim() === payload.currencyValue
    );

    if (!matchedOption) {
      throw new Error(`站点中不存在币种: ${payload.currencyValue}`);
    }

    dateInput.focus();
    dateInput.value = payload.date;
    triggerInput(dateInput);

    select.value = matchedOption.value;
    triggerInput(select);

    captchaInput.value = '';
    triggerInput(captchaInput);

    return {
      selectedValue: matchedOption.value,
      selectedText: (matchedOption.text || '').trim()
    };
  }, { date, currencyValue });
}

export async function refreshCaptchaImage(page) {
  await page.evaluate(() => {
    if (typeof window.getCaptchaImg === 'function') {
      window.getCaptchaImg('captcha_img');
      return;
    }

    const image = document.querySelector('#captcha_img');
    if (!image) {
      throw new Error('未找到验证码图片。');
    }

    image.click();
  });
}

export async function prepareCaptchaChallenge(page, env, { date, currencyValue, refresh = false }) {
  if (!refresh) {
    await page.goto(env.APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await fillQueryForm(page, { date, currencyValue });
  }

  await waitForCaptchaReady(page);

  if (refresh) {
    await refreshCaptchaImage(page);
    await waitForCaptchaReady(page);
  }

  return page.evaluate(() => {
    const image = document.querySelector('#captcha_img');
    const src = image?.getAttribute('src') || image?.src || '';
    const token = sessionStorage.getItem('auth_token') || '';
    const formToken = document.querySelector('input[name="token"]')?.value || '';

    if (!src.startsWith('data:image/')) {
      throw new Error('验证码图片未准备完成。');
    }

    return {
      imageDataUrl: src,
      tokenLength: token.length,
      formTokenLength: formToken.length
    };
  });
}

export async function submitCaptchaAndWaitForResults(page, { captchaCode, expectedDate }) {
  const navigationPromise = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 })
    .catch(() => null);

  await page.evaluate((payload) => {
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
    captchaInput.value = payload.captchaCode;
    triggerInput(captchaInput);

    hiddenToken.value = sessionToken;
    form.method = 'post';

    if (typeof window.executeSearch === 'function') {
      window.executeSearch();
      return;
    }

    form.submit();
  }, { captchaCode });

  await navigationPromise;
  await waitForResults(page, expectedDate);
}

export async function waitForResults(page, expectedDate, timeoutMs = 25000) {
  const expectedDateText = expectedDate.replace(/-/g, '/');
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const inspection = await page.evaluate((payload) => {
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const tables = Array.from(document.querySelectorAll('table'));
      const resultTable = tables.find((table) => table.innerText.includes('货币名称'));
      const rowCount = resultTable ? resultTable.querySelectorAll('tr').length : 0;
      const alertText = Array.from(document.querySelectorAll('script'))
        .map((script) => script.innerText || '')
        .find((text) => /alert\(/.test(text)) || '';

      return {
        rowCount,
        hasExpectedDate: bodyText.includes(payload.expectedDateText),
        bodyText,
        alertText
      };
    }, { expectedDateText });

    if (inspection.rowCount > 1 && inspection.hasExpectedDate) {
      return;
    }

    if (/验证码|校验码|输入有误/.test(inspection.bodyText) || /验证码|校验码|输入有误/.test(inspection.alertText)) {
      throw new Error('验证码可能输入错误，请重试当前日期。');
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`等待查询结果超时: ${expectedDate}`);
}

export async function readTopQuote(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const resultTable = tables.find((table) => table.innerText.includes('货币名称'));

    if (!resultTable) {
      throw new Error('未找到结果表格。');
    }

    const rows = Array.from(resultTable.querySelectorAll('tr'));
    const headerCells = Array.from(rows[0]?.querySelectorAll('th,td') || []).map((cell) =>
      (cell.innerText || '').trim()
    );

    const firstDataRow = rows.find((row, index) => index > 0 && row.querySelectorAll('td').length >= 7);
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
  });
}

export async function captureResultScreenshot(page) {
  return page.screenshot({
    type: 'png',
    fullPage: true
  });
}
