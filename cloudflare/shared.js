export const STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_CAPTCHA: 'waiting_captcha',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

export const TERMINAL_STATUSES = new Set([
  STATUS.COMPLETED,
  STATUS.FAILED,
  STATUS.CANCELLED
]);

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorJson(status, message, extras = {}) {
  return json({ error: message, ...extras }, { status });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch (_error) {
    return null;
  }
}

export function normalizeDates(input) {
  if (!Array.isArray(input)) {
    throw new Error('日期列表格式不正确。');
  }

  const uniqueDates = [];
  const seen = new Set();

  for (const item of input) {
    const value = String(item || '').trim();
    if (!value) {
      continue;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`日期格式无效: ${value}`);
    }

    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueDates.push(value);
  }

  if (!uniqueDates.length) {
    throw new Error('至少需要一个有效日期。');
  }

  return uniqueDates;
}

export function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'unknown';
}

export function getRequestUser(request, env) {
  const email =
    request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('cf-access-verified-email') ||
    request.headers.get('x-user-email') ||
    env.DEV_USER_EMAIL ||
    'local-dev@example.com';

  const normalizedEmail = String(email).trim().toLowerCase();

  return {
    email: normalizedEmail,
    userKey: encodeURIComponent(normalizedEmail)
  };
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function createLog(message, level = 'info') {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    message: String(message || '').trim()
  };
}

export function applyExpiry(state, env) {
  const ttlSeconds = Number(env.RESULT_TTL_SECONDS || 600);
  state.updatedAt = new Date().toISOString();
  state.expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  return state;
}

export function publicState(state) {
  if (!state) {
    return null;
  }

  return {
    jobId: state.jobId,
    status: state.status,
    userEmail: state.userEmail,
    currency: {
      value: state.currencyValue,
      label: state.currencyLabel
    },
    dates: state.dates,
    currentIndex: state.currentIndex,
    currentDate: state.currentDate,
    totalCount: state.totalCount,
    successCount: state.successCount,
    failedCount: state.failedCount,
    files: state.files,
    errors: state.errors,
    logs: state.logs,
    captchaVersion: state.captchaVersion,
    captchaDate: state.captchaDate,
    currentAttempt: state.currentAttempt,
    downloadReady: Boolean(state.downloadKey),
    downloadFilename: state.downloadFilename || null,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    expiresAt: state.expiresAt
  };
}

export function screenshotKey(jobId, filename) {
  return `jobs/${jobId}/screenshots/${filename}`;
}

export function zipKey(jobId, filename) {
  return `jobs/${jobId}/downloads/${filename}`;
}

export function getJobStub(env, jobId) {
  const id = env.JOB_STATE.idFromName(jobId);
  return env.JOB_STATE.get(id);
}

export function getUserGateStub(env, userKey) {
  const id = env.USER_GATE.idFromName(userKey);
  return env.USER_GATE.get(id);
}

export function statusLabel(status) {
  switch (status) {
    case STATUS.RUNNING:
      return '运行中';
    case STATUS.WAITING_CAPTCHA:
      return '等待验证码';
    case STATUS.COMPLETED:
      return '已完成';
    case STATUS.FAILED:
      return '已失败';
    case STATUS.CANCELLED:
      return '已取消';
    default:
      return '待执行';
  }
}
