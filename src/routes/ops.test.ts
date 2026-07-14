import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import type { ResendDeps } from '../resend.js';

const TOKEN = 'test-service-token';
const PROVIDER = { apiKey: 're_secret', from: 'Hadron Agent <agent@example.com>' };
const EMAIL = {
  to: 'person@example.net',
  subject: 'Deploy finished',
  text: 'Everything is healthy.',
  idempotencyKey: 'run_123:abc',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeDeps(
  res: Response = jsonResponse(200, { id: 'email_123' }),
  options: { provider?: ResendDeps['provider'] } = { provider: PROVIDER },
): ResendDeps & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    provider: options.provider,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return res;
    }) as typeof fetch,
  };
}

function appWith(deps: ResendDeps) {
  return createApp({ resendDeps: deps, serviceToken: TOKEN });
}

const send = (app: ReturnType<typeof createApp>, body: unknown) =>
  request(app).post('/ops/send-email').set('authorization', `Bearer ${TOKEN}`).send(body as object);

describe('auth and discovery', () => {
  it('gates /ops and /info but leaves health routes public', async () => {
    const app = appWith(fakeDeps());
    await request(app).post('/ops/send-email').send(EMAIL).expect(401);
    await request(app).get('/info').expect(401);
    await request(app).get('/healthz').expect(200);
    await request(app).get('/readyz').expect(200);
  });

  it('/info advertises the effective provider state', async () => {
    const configured = await request(appWith(fakeDeps())).get('/info').set('authorization', `Bearer ${TOKEN}`).expect(200);
    expect(configured.body).toMatchObject({
      name: 'hadrontool-resend',
      operations: ['send-email'],
      stateless: true,
      providerConfigured: true,
    });
    const unconfigured = await request(appWith(fakeDeps(undefined, {})))
      .get('/info')
      .set('authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(unconfigured.body.providerConfigured).toBe(false);
  });
});

describe('send-email operation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends one email and returns its provider id', async () => {
    const deps = fakeDeps();
    const res = await send(appWith(deps), EMAIL).expect(200);
    expect(res.body).toEqual({ ok: true, id: 'email_123' });
    expect(deps.calls).toHaveLength(1);
  });

  it.each([
    [{ ...EMAIL, to: 'not-email' }, 'bad recipient'],
    [{ ...EMAIL, subject: '' }, 'empty subject'],
    [{ ...EMAIL, text: '' }, 'empty body'],
    [{ ...EMAIL, idempotencyKey: 'contains spaces' }, 'bad idempotency key'],
    [{ ...EMAIL, html: '<b>no</b>' }, 'unknown field'],
  ])('rejects invalid input before calling Resend (%s)', async (payload, _label) => {
    const deps = fakeDeps();
    const res = await send(appWith(deps), payload).expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(deps.calls).toHaveLength(0);
  });

  it('returns provider_not_configured before calling Resend', async () => {
    const deps = fakeDeps(undefined, {});
    const res = await send(appWith(deps), EMAIL).expect(503);
    expect(res.body.error).toBe('provider_not_configured');
    expect(deps.calls).toHaveLength(0);
  });

  it('returns stable provider errors without leaking email content', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void logs.push(String(line)));
    const deps = fakeDeps(jsonResponse(422, { message: EMAIL.text }));
    const res = await send(appWith(deps), EMAIL).expect(502);
    expect(res.body.error).toBe('provider_rejected');
    const surface = JSON.stringify(res.body) + logs.join('\n');
    expect(surface).not.toContain(EMAIL.to);
    expect(surface).not.toContain(EMAIL.subject);
    expect(surface).not.toContain(EMAIL.text);
    expect(surface).not.toContain(PROVIDER.apiKey);
  });

  it('reports unknown operations', async () => {
    const res = await request(appWith(fakeDeps()))
      .post('/ops/send-bulk-email')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({})
      .expect(404);
    expect(res.body).toMatchObject({ error: 'unknown_operation', operations: ['send-email'] });
  });
});
