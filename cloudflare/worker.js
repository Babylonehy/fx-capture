import { fetchCurrencyOptions } from './automation.js';
import { JobStateDO } from './job-state-do.js';
import {
  errorJson,
  getJobStub,
  getRequestUser,
  getUserGateStub,
  json,
  normalizeDates,
  readJson,
  statusLabel
} from './shared.js';
import { UserGateDO } from './user-gate-do.js';

async function proxyJobRequest(env, jobId, request, path, init = {}) {
  const user = getRequestUser(request, env);
  const stub = getJobStub(env, jobId);
  return stub.fetch(`https://do${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      'x-user-key': user.userKey
    }
  });
}

async function handleSession(request, env) {
  const user = getRequestUser(request, env);
  const gateStub = getUserGateStub(env, user.userKey);
  const gateResponse = await gateStub.fetch('https://do/current');
  const gate = await gateResponse.json();

  return json({
    appName: env.APP_NAME,
    appVersion: env.APP_VERSION,
    userEmail: user.email,
    activeJobId: gate.activeJobId || null,
    activeStatus: gate.status || null
  });
}

async function handleCurrencies(env) {
  const options = await fetchCurrencyOptions(env);
  return json({ options });
}

async function handleCreateJob(request, env) {
  const user = getRequestUser(request, env);
  const payload = await readJson(request);

  let dates;
  try {
    dates = normalizeDates(payload?.dates);
  } catch (error) {
    return errorJson(400, error.message);
  }

  const currencyValue = String(payload?.currency?.value || '').trim();
  const currencyLabel = String(payload?.currency?.label || '').trim();

  if (!currencyValue || !currencyLabel) {
    return errorJson(400, '请选择有效币种。');
  }

  const jobId = crypto.randomUUID();
  const gateStub = getUserGateStub(env, user.userKey);
  const claimResponse = await gateStub.fetch('https://do/claim', {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jobId })
  });

  if (claimResponse.status === 409) {
    const conflict = await claimResponse.json();
    return json(
      {
        error: '当前用户已有活动任务。',
        activeJobId: conflict.activeJobId,
        activeStatus: conflict.activeStatus,
        activeStatusLabel: statusLabel(conflict.activeStatus)
      },
      { status: 409 }
    );
  }

  const claimData = await claimResponse.json();
  const stub = getJobStub(env, jobId);

  try {
    const response = await stub.fetch('https://do/internal/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        jobId,
        userEmail: user.email,
        userKey: user.userKey,
        dates,
        currency: {
          value: currencyValue,
          label: currencyLabel
        },
        sessionId: claimData.browserSessionId
      })
    });

    return json(await response.json(), { status: response.status });
  } catch (error) {
    await gateStub.fetch('https://do/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jobId })
    });
    return errorJson(500, `创建任务失败: ${error.message}`);
  }
}

async function handleDownload(request, env, jobId) {
  const user = getRequestUser(request, env);
  const stub = getJobStub(env, jobId);
  const response = await stub.fetch('https://do/state', {
    headers: {
      'x-user-key': user.userKey
    }
  });
  if (!response.ok) {
    return response;
  }

  const state = await response.json();
  if (!state?.downloadReady || !state?.downloadFilename) {
    return errorJson(409, '结果 ZIP 尚未生成。');
  }
  return stub.fetch('https://do/internal/download', {
    headers: {
      'x-user-key': user.userKey
    }
  });
}

function splitApiPath(pathname) {
  return pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const parts = splitApiPath(url.pathname);

    if (request.method === 'GET' && parts[0] === 'session') {
      return handleSession(request, env);
    }

    if (request.method === 'GET' && parts[0] === 'currencies') {
      return handleCurrencies(env);
    }

    if (request.method === 'POST' && parts[0] === 'jobs' && parts.length === 1) {
      return handleCreateJob(request, env);
    }

    if (parts[0] === 'jobs' && parts[1]) {
      const jobId = parts[1];

      if (request.method === 'GET' && parts.length === 2) {
        return proxyJobRequest(env, jobId, request, '/state');
      }

      if (request.method === 'GET' && parts[2] === 'captcha') {
        return proxyJobRequest(env, jobId, request, '/captcha');
      }

      if (request.method === 'POST' && parts[2] === 'captcha' && parts.length === 3) {
        const payload = await readJson(request);
        return proxyJobRequest(env, jobId, request, '/captcha', {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(payload || {})
        });
      }

      if (request.method === 'POST' && parts[2] === 'captcha' && parts[3] === 'refresh') {
        return proxyJobRequest(env, jobId, request, '/captcha/refresh', {
          method: 'POST'
        });
      }

      if (request.method === 'POST' && parts[2] === 'cancel') {
        return proxyJobRequest(env, jobId, request, '/cancel', {
          method: 'POST'
        });
      }

      if (request.method === 'GET' && parts[2] === 'download') {
        return handleDownload(request, env, jobId);
      }
    }

    return errorJson(404, '接口不存在。');
  },

  async scheduled(_controller, env) {
    void env;
  }
};

export { JobStateDO, UserGateDO };
