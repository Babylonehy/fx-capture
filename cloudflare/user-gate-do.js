import { DurableObject } from 'cloudflare:workers';
import { STATUS, isTerminalStatus, json, readJson } from './shared.js';

export class UserGateDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/current') {
      const current = await this.ctx.storage.get('current');
      return json(current || { activeJobId: null, status: STATUS.QUEUED, browserSessionId: null });
    }

    if (request.method === 'POST' && url.pathname === '/claim') {
      const payload = await readJson(request);
      const jobId = String(payload?.jobId || '').trim();

      if (!jobId) {
        return json({ error: '缺少 jobId。' }, { status: 400 });
      }

      const current = await this.ctx.storage.get('current');

      if (current?.activeJobId && current.activeJobId !== jobId) {
        const activeJobStub = this.env.JOB_STATE.get(this.env.JOB_STATE.idFromName(current.activeJobId));
        const activeResponse = await activeJobStub.fetch('https://do/internal/status');
        const activeState = await activeResponse.json();

        if (!isTerminalStatus(activeState?.status)) {
          return json(
            {
              ok: false,
              activeJobId: current.activeJobId,
              activeStatus: activeState?.status || STATUS.RUNNING
            },
            { status: 409 }
          );
        }
      }

      await this.ctx.storage.put('current', {
        activeJobId: jobId,
        status: STATUS.RUNNING,
        updatedAt: new Date().toISOString(),
        browserSessionId: current?.browserSessionId || null
      });

      return json({ ok: true, activeJobId: jobId, browserSessionId: current?.browserSessionId || null });
    }

    if (request.method === 'POST' && url.pathname === '/release') {
      const payload = await readJson(request);
      const jobId = String(payload?.jobId || '').trim();
      const current = await this.ctx.storage.get('current');

      if (!current?.activeJobId || current.activeJobId === jobId) {
        // Keep the session ID when releasing the gate, so the next job can reuse it
        await this.ctx.storage.put('current', {
          activeJobId: null,
          status: STATUS.QUEUED,
          updatedAt: new Date().toISOString(),
          browserSessionId: current?.browserSessionId || null
        });
      }

      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/session') {
      const payload = await readJson(request);
      const current = (await this.ctx.storage.get('current')) || { activeJobId: null, status: STATUS.QUEUED };
      current.browserSessionId = payload.sessionId || null;
      await this.ctx.storage.put('current', current);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, { status: 404 });
  }
}
