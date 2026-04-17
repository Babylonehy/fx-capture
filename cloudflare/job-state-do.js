import { DurableObject } from 'cloudflare:workers';
import puppeteer from '@cloudflare/puppeteer';
import { strToU8, zipSync } from 'fflate';
import {
  STATUS,
  applyExpiry,
  createLog,
  getUserGateStub,
  isTerminalStatus,
  json,
  publicState,
  readJson,
  sanitizeFilenamePart,
  screenshotKey,
  zipKey
} from './shared.js';
import {
  captureResultScreenshot,
  getOrCreatePage,
  prepareCaptchaChallenge,
  readTopQuote,
  submitCaptchaAndWaitForResults
} from './automation.js';

function withCode(error, code) {
  error.code = code;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCloudflareReference(message) {
  const match = String(message || '').match(/reference\s*=\s*([a-z0-9]+)/i);
  return match?.[1] || null;
}

function isRateLimitError(message) {
  return /rate limit exceeded|code:\s*429/i.test(String(message || ''));
}

export class JobStateDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.browser = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/state') {
        return this.handlePublicState(request);
      }

      if (request.method === 'GET' && url.pathname === '/captcha') {
        return this.handleCaptcha(request);
      }

      if (request.method === 'POST' && url.pathname === '/captcha') {
        return this.handleCaptchaSubmit(request);
      }

      if (request.method === 'POST' && url.pathname === '/captcha/refresh') {
        return this.handleCaptchaRefresh(request);
      }

      if (request.method === 'POST' && url.pathname === '/cancel') {
        return this.handleCancel(request);
      }

      if (request.method === 'POST' && url.pathname === '/internal/create') {
        return this.handleInternalCreate(request);
      }

      if (request.method === 'GET' && url.pathname === '/internal/status') {
        const state = await this.loadState();
        return json({
          status: state?.status || STATUS.FAILED,
          expiresAt: state?.expiresAt || null
        });
      }

    if (request.method === 'POST' && url.pathname === '/internal/cleanup') {
      await this.cleanupJob();
      return new Response(null, { status: 204 });
    }

      if (request.method === 'GET' && url.pathname === '/internal/download') {
        return this.handleInternalDownload(request);
      }

      return json({ error: 'Not found' }, { status: 404 });
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }

      return json({ error: error.message || '任务执行失败。' }, { status: 500 });
    }
  }

  async alarm() {
    const state = await this.loadState();
    if (!state) {
      return;
    }

    if (Date.parse(state.expiresAt || '') <= Date.now()) {
      await this.cleanupJob(state);
    }
  }

  async handleInternalCreate(request) {
    const payload = await readJson(request);
    const state = this.buildInitialState(payload);
    this.pushLog(state, `任务已创建，共 ${state.totalCount} 个日期。`);
    await this.saveState(state);

    try {
      await this.processJob(state, {});
    } catch (error) {
      if (error instanceof Response) {
        await this.failJob(state, '系统达到速率限制，任务已失败。');
        return error;
      }
      await this.failJob(state, `任务初始化失败: ${error.message}`);
    }

    return json(publicState(await this.loadState()));
  }

  async handlePublicState(request) {
    const state = await this.requireStateForUser(request);
    return json(publicState(state));
  }

  async handleCaptcha(request) {
    const state = await this.requireStateForUser(request);

    if (state.status !== STATUS.WAITING_CAPTCHA || !state.captchaImageDataUrl) {
      return json({ error: '当前任务不在等待验证码状态。' }, { status: 409 });
    }

    return json({
      jobId: state.jobId,
      captchaVersion: state.captchaVersion,
      captchaDate: state.captchaDate,
      imageDataUrl: state.captchaImageDataUrl,
      currentIndex: state.currentIndex,
      totalCount: state.totalCount
    });
  }

  async handleCaptchaSubmit(request) {
    const state = await this.requireStateForUser(request);
    const payload = await readJson(request);
    const captchaCode = String(payload?.code || '').trim();

    if (!captchaCode) {
      return json({ error: '请输入验证码。' }, { status: 400 });
    }

    try {
      await this.processJob(state, { captchaCode });
    } catch (error) {
      if (error instanceof Response) {
        await this.failJob(state, '系统达到速率限制，任务已失败。');
        return error;
      }
      await this.failJob(state, error.message);
    }

    return json(publicState(await this.loadState()));
  }

  async handleCaptchaRefresh(request) {
    const state = await this.requireStateForUser(request);

    try {
      await this.processJob(state, { refreshCaptcha: true });
    } catch (error) {
      if (error instanceof Response) {
        await this.failJob(state, '系统达到速率限制，任务已失败。');
        return error;
      }
      await this.failJob(state, `刷新验证码失败: ${error.message}`);
    }

    return json(publicState(await this.loadState()));
  }

  async handleCancel(request) {
    const state = await this.requireStateForUser(request);
    state.status = STATUS.CANCELLED;
    this.pushLog(state, '任务已取消。', 'warn');
    await this.finalizeTerminalState(state);
    return json(publicState(await this.loadState()));
  }

  async handleInternalDownload(request) {
    const state = await this.requireStateForUser(request);
    if (!state.downloadKey || !state.downloadFilename) {
      return json({ error: '结果 ZIP 尚未生成。' }, { status: 409 });
    }

    const zipBuffer = await this.ctx.storage.get(`blob:${state.downloadKey}`);
    if (!zipBuffer) {
      return json({ error: '结果文件不存在或已过期。' }, { status: 404 });
    }

    const body = zipBuffer instanceof Uint8Array ? zipBuffer : new Uint8Array(zipBuffer);
    return new Response(body, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${state.downloadFilename}"`
      }
    });
  }

  buildInitialState(payload) {
    return {
      jobId: payload.jobId,
      userEmail: payload.userEmail,
      userKey: payload.userKey,
      currencyValue: payload.currency?.value,
      currencyLabel: payload.currency?.label,
      dates: payload.dates,
      totalCount: payload.dates.length,
      status: STATUS.QUEUED,
      currentIndex: 0,
      currentDate: payload.dates[0] || null,
      successCount: 0,
      failedCount: 0,
      currentAttempt: 1,
      files: [],
      errors: [],
      logs: [],
      captchaVersion: 0,
      captchaDate: null,
      captchaImageDataUrl: null,
      sessionId: payload.sessionId || null,
      downloadKey: null,
      downloadFilename: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString()
    };
  }

  async requireStateForUser(request) {
    const state = await this.loadState();
    if (!state) {
      throw new Response(JSON.stringify({ error: '任务不存在。' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }

    const userKey = request.headers.get('x-user-key') || '';
    if (userKey !== state.userKey) {
      throw new Response(JSON.stringify({ error: '无权访问该任务。' }), {
        status: 403,
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }

    return state;
  }

  async loadState() {
    return (await this.ctx.storage.get('state')) || null;
  }

  async saveState(state) {
    applyExpiry(state, this.env);
    await this.ctx.storage.put('state', state);

    const expiresAtMs = Date.parse(state.expiresAt || '');
    if (Number.isFinite(expiresAtMs)) {
      await this.ctx.storage.setAlarm(expiresAtMs);
    }

    return state;
  }

  pushLog(state, message, level = 'info') {
    state.logs = [createLog(message, level), ...(state.logs || [])].slice(0, 80);
  }

  async ensureBrowser(state, options = {}) {
    const { requireExistingSession = false } = options;

    if (this.browser) {
      return this.browser;
    }

    if (state.sessionId) {
      try {
        this.browser = await puppeteer.connect(this.env.MYBROWSER, state.sessionId);
        return this.browser;
      } catch (_error) {
        state.sessionId = null;
        await this.saveState(state);
        if (requireExistingSession) {
          throw withCode(new Error('浏览器会话已失效，请重新获取验证码。'), 'SESSION_LOST');
        }
      }
    }

    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        this.browser = await puppeteer.launch(this.env.MYBROWSER, {
          keep_alive: 600000
        });
        state.sessionId = this.browser.sessionId();
        await this.saveState(state);

        const gateStub = getUserGateStub(this.env, state.userKey);
        await gateStub.fetch('https://do/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: state.sessionId })
        }).catch(() => {});

        return this.browser;
      } catch (error) {
        lastError = error;
        if (isRateLimitError(error?.message)) {
          const rateLimitMessage =
            'Cloudflare Browser Run 已达到速率限制，请等待重试。';
          this.pushLog(state, rateLimitMessage, 'warn');
          throw new Response(JSON.stringify({ error: rateLimitMessage }), {
            status: 429,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'Retry-After': '60'
            }
          });
        }

        const reference = extractCloudflareReference(error?.message);
        this.pushLog(
          state,
          reference
            ? `启动浏览器失败，第 ${attempt} 次重试。Cloudflare reference: ${reference}`
            : `启动浏览器失败，第 ${attempt} 次重试。`,
          'warn'
        );

        if (attempt < 3) {
          await delay(attempt * 1200);
        }
      }
    }

    const reference = extractCloudflareReference(lastError?.message);
    const details = reference
      ? `Cloudflare Browser Run 内部错误，reference=${reference}`
      : `Cloudflare Browser Run 内部错误: ${lastError?.message || 'unknown error'}`;
    throw new Error(details);
  }

  async disconnectBrowser() {
    if (!this.browser) {
      return;
    }

    try {
      await this.browser.disconnect();
    } catch (_error) {
      // Ignore disconnect failures; next request will reconnect or recreate the session.
    } finally {
      this.browser = null;
    }
  }

  async closeBrowserAndResetSession(state) {
    // Only disconnect to keep the session alive on Cloudflare side for reuse.
    // Cloudflare will close it automatically after keep_alive expires.
    await this.disconnectBrowser();
    this.browser = null;
    await this.saveState(state);
  }

  async processJob(state, { captchaCode = null, refreshCaptcha = false }) {
    if (isTerminalStatus(state.status)) {
      return state;
    }

    if (state.currentIndex >= state.totalCount) {
      await this.completeJob(state);
      return state;
    }

    while (state.currentIndex < state.totalCount) {
      state.currentDate = state.dates[state.currentIndex];
      const wasWaitingForCaptcha = state.status === STATUS.WAITING_CAPTCHA;
      state.status = STATUS.RUNNING;
      await this.saveState(state);

      if (!captchaCode) {
        await this.prepareCaptcha(state, {
          refreshCaptcha: refreshCaptcha && wasWaitingForCaptcha
        });
        return state;
      }

      try {
        await this.submitCurrentCaptcha(state, captchaCode);
        captchaCode = null;
        refreshCaptcha = false;
      } catch (error) {
        if (error instanceof Response) {
          throw error;
        }

        if (error.code === 'SESSION_LOST') {
          this.pushLog(state, `${state.currentDate} 的浏览器会话已失效，已重新准备验证码。`, 'warn');
          captchaCode = null;
          refreshCaptcha = false;
          continue;
        }

        state.currentAttempt += 1;
        this.pushLog(state, `${state.currentDate} 处理失败: ${error.message}`, 'warn');

        if (state.currentAttempt > 3) {
          state.failedCount += 1;
          state.errors.push({
            date: state.currentDate,
            message: error.message
          });
          this.pushLog(state, `${state.currentDate} 达到重试上限，已标记失败。`, 'error');
          state.currentIndex += 1;
          state.currentAttempt = 1;
          state.captchaImageDataUrl = null;
          state.captchaDate = null;
          captchaCode = null;
          refreshCaptcha = false;
          await this.disconnectBrowser();
          await this.saveState(state);
          continue;
        }

        captchaCode = null;
        refreshCaptcha = false;
        await this.disconnectBrowser();
        continue;
      }
    }

    await this.completeJob(state);
    return state;
  }

  async prepareCaptcha(state, { refreshCaptcha = false }) {
    const browser = await this.ensureBrowser(state);
    const page = await getOrCreatePage(browser);

    try {
      const challenge = await prepareCaptchaChallenge(page, this.env, {
        date: state.currentDate,
        currencyValue: state.currencyValue,
        refresh: refreshCaptcha && state.status === STATUS.WAITING_CAPTCHA
      });

      state.status = STATUS.WAITING_CAPTCHA;
      state.captchaDate = state.currentDate;
      state.captchaImageDataUrl = challenge.imageDataUrl;
      state.captchaVersion += 1;
      this.pushLog(
        state,
        refreshCaptcha
          ? `已刷新 ${state.currentDate} 的验证码。`
          : `等待 ${state.currentDate} 的验证码输入。`,
        'warn'
      );
      await this.saveState(state);
    } finally {
      await this.disconnectBrowser();
    }
  }

  async submitCurrentCaptcha(state, captchaCode) {
    const browser = await this.ensureBrowser(state, {
      requireExistingSession: true
    });
    const page = await getOrCreatePage(browser);

    try {
      await submitCaptchaAndWaitForResults(page, {
        captchaCode,
        expectedDate: state.currentDate
      });

      const quote = await readTopQuote(page);
      const filename = `${sanitizeFilenamePart(quote.currency || state.currencyLabel)}-${sanitizeFilenamePart(state.currentDate)}-${sanitizeFilenamePart(quote.price || 'unknown')}.png`;
      const key = screenshotKey(state.jobId, filename);
      const screenshot = await captureResultScreenshot(page);
      await this.ctx.storage.put(`blob:${key}`, screenshot);

      state.files.push({
        date: state.currentDate,
        filename,
        key,
        price: quote.price || '',
        currency: quote.currency || state.currencyLabel,
        publishedAt: quote.publishedAt || ''
      });
      state.successCount += 1;
      state.currentIndex += 1;
      state.currentAttempt = 1;
      state.captchaImageDataUrl = null;
      state.captchaDate = null;
      this.pushLog(state, `已生成 ${filename}`, 'success');
      await this.saveState(state);
      await this.disconnectBrowser();
    } catch (error) {
      await this.disconnectBrowser();
      throw error;
    }
  }

  async completeJob(state) {
    try {
      const zipBuffer = await this.buildZipArchive(state);
      const filename = `Bonnie-FX-${state.jobId}.zip`;
      const key = zipKey(state.jobId, filename);
      await this.ctx.storage.put(`blob:${key}`, zipBuffer);

      state.downloadKey = key;
      state.downloadFilename = filename;
      state.status = STATUS.COMPLETED;
      this.pushLog(
        state,
        `任务完成，成功 ${state.successCount} 个，失败 ${state.failedCount} 个。`,
        state.failedCount ? 'warn' : 'success'
      );
      await this.finalizeTerminalState(state);
    } catch (error) {
      await this.failJob(state, `打包结果失败: ${error.message}`);
    }
  }

  async buildZipArchive(state) {
    const entries = {};

    for (const file of state.files) {
      const object = await this.ctx.storage.get(`blob:${file.key}`);
      if (!object) {
        continue;
      }

      entries[file.filename] = object instanceof Uint8Array ? object : new Uint8Array(object);
    }

    const summaryLines = [
      `Job ID: ${state.jobId}`,
      `Currency: ${state.currencyLabel}`,
      `Success: ${state.successCount}`,
      `Failed: ${state.failedCount}`,
      '',
      'Errors:',
      ...(state.errors.length
        ? state.errors.map((item) => `${item.date}: ${item.message}`)
        : ['None'])
    ];

    entries['summary.txt'] = strToU8(summaryLines.join('\n'));
    return zipSync(entries, { level: 0 });
  }

  async failJob(state, message) {
    state.status = STATUS.FAILED;
    this.pushLog(state, message, 'error');
    await this.finalizeTerminalState(state);
  }

  async finalizeTerminalState(state) {
    state.captchaImageDataUrl = null;
    state.captchaDate = null;
    await this.closeBrowserAndResetSession(state);
    await this.saveState(state);
    await this.releaseUserGate(state);
  }

  async releaseUserGate(state) {
    const stub = getUserGateStub(this.env, state.userKey);
    await stub.fetch('https://do/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jobId: state.jobId })
    });
  }

  async cleanupJob(existingState = null) {
    const state = existingState || (await this.loadState());
    if (!state) {
      await this.ctx.storage.deleteAll();
      return;
    }

    await this.closeBrowserAndResetSession(state);
    await this.releaseUserGate(state);
    await this.ctx.storage.deleteAll();
  }
}
