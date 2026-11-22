import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { runOperation } from '../ops/index.js';
import type { ResendDeps } from '../resend.js';

const TOKEN = 'test-service-token';
const PROVIDER = { apiKey: 're_secret', from: 'Hadron Agent <agent@example.com>' };
const INLINE = { apiKey: 're_org_secret', from: 'Acme Agent <agent@acme.example>' };
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
      operations: ['send-email', 'get-domain-status'],
      stateless: true,
      platformProviderConfigured: true,
    });
    const unconfigured = await request(appWith(fakeDeps(undefined, {})))
      .get('/info')
      .set('authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(unconfigured.body.platformProviderConfigured).toBe(false);
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

  it('uses all-or-nothing inline credentials instead of the platform provider', async () => {
    const deps = fakeDeps();
    await send(appWith(deps), { ...EMAIL, ...INLINE }).expect(200);
    const call = deps.calls[0].init;
    expect((call.headers as Record<string, string>).authorization).toBe(`Bearer ${INLINE.apiKey}`);
    expect(JSON.parse(String(call.body)).from).toBe(INLINE.from);
  });

  it('inline credentials work when no platform provider is configured', async () => {
    const deps = fakeDeps(undefined, {});
    await send(appWith(deps), { ...EMAIL, ...INLINE }).expect(200);
    expect(deps.calls).toHaveLength(1);
  });

  it.each([
    [{ ...EMAIL, to: 'not-email' }, 'bad recipient'],
    [{ ...EMAIL, subject: '' }, 'empty subject'],
    [{ ...EMAIL, text: '' }, 'empty body'],
    [{ ...EMAIL, idempotencyKey: 'contains spaces' }, 'bad idempotency key'],
    [{ ...EMAIL, apiKey: INLINE.apiKey }, 'API key without sender'],
    [{ ...EMAIL, from: INLINE.from }, 'sender without API key'],
    [{ ...EMAIL, ...INLINE, from: 'not-an-email' }, 'bad inline sender'],
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
    const res = await send(appWith(deps), { ...EMAIL, ...INLINE }).expect(502);
    expect(res.body.error).toBe('provider_rejected');
    const surface = JSON.stringify(res.body) + logs.join('\n');
    expect(surface).not.toContain(EMAIL.to);
    expect(surface).not.toContain(EMAIL.subject);
    expect(surface).not.toContain(EMAIL.text);
    expect(surface).not.toContain(PROVIDER.apiKey);
    expect(surface).not.toContain(INLINE.apiKey);
  });

  it('reports unknown operations', async () => {
    const res = await request(appWith(fakeDeps()))
      .post('/ops/send-bulk-email')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({})
      .expect(404);
    expect(res.body).toMatchObject({ error: 'unknown_operation', operations: ['send-email', 'get-domain-status'] });
  });

  it.each(['toString', 'constructor', '__proto__'])('rejects inherited operation name %s', async (name) => {
    const deps = fakeDeps();
    const res = await request(appWith(deps))
      .post(`/ops/${name}`)
      .set('authorization', `Bearer ${TOKEN}`)
      .send({})
      .expect(404);
    expect(res.body.error).toBe('unknown_operation');
    expect(deps.calls).toHaveLength(0);
    await expect(runOperation(deps, name, {})).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('accepts a maximum-size multibyte envelope that exceeds 64kb', async () => {
    const deps = fakeDeps();
    await send(appWith(deps), {
      ...EMAIL,
      subject: 's'.repeat(200),
      text: '界'.repeat(20_000),
      idempotencyKey: 'i'.repeat(256),
      apiKey: 'r'.repeat(8_192),
      from: INLINE.from,
    }).expect(200);
    expect(deps.calls).toHaveLength(1);
  });

  it('maps malformed JSON to a sanitized validation_error', async () => {
    const raw = '{"to":"private@example.net"';
    const res = await request(appWith(fakeDeps()))
      .post('/ops/send-email')
      .set('authorization', `Bearer ${TOKEN}`)
      .set('content-type', 'application/json')
      .send(raw)
      .expect(400);
    expect(res.body).toMatchObject({ error: 'validation_error', field: 'body', reason: 'request body is invalid' });
    expect(JSON.stringify(res.body)).not.toContain('private@example.net');
  });

  it('maps oversized JSON to a sanitized validation_error', async () => {
    const privateBody = 'private-body-'.repeat(12_000);
    const res = await send(appWith(fakeDeps()), { ...EMAIL, text: privateBody }).expect(413);
    expect(res.body).toMatchObject({
      error: 'validation_error',
      field: 'body',
      reason: 'request body is too large',
    });
    expect(JSON.stringify(res.body)).not.toContain('private-body');
  });
});

describe('get-domain-status operation', () => {
  const KEY = 're_org_secret_key';
  const status = (app: ReturnType<typeof createApp>, body: unknown) =>
    request(app).post('/ops/get-domain-status').set('authorization', `Bearer ${TOKEN}`).send(body as object);
  const listing = (data: unknown[]) => jsonResponse(200, { object: 'list', data });

  it('requires the bearer like every op', async () => {
    await request(appWith(fakeDeps())).post('/ops/get-domain-status').send({ domain: 'acme.example', apiKey: KEY }).expect(401);
  });

  it('answers { ok, domain, status } for verified, unverified and not_found', async () => {
    const data = [
      { id: '1', name: 'good.example', status: 'verified' },
      { id: '2', name: 'wait.example', status: 'pending' },
    ];
    for (const [domain, expected] of [['good.example', 'verified'], ['wait.example', 'unverified'], ['none.example', 'not_found']]) {
      const res = await status(appWith(fakeDeps(listing(data))), { domain, apiKey: KEY }).expect(200);
      expect(res.body).toEqual({ ok: true, domain, status: expected });
    }
  });

  it('takes the credential inline only: no platform fallback, no from, no unknown fields', async () => {
    const deps = fakeDeps(listing([]));
    await status(appWith(deps), { domain: 'acme.example' }).expect(400);
    await status(appWith(deps), { apiKey: KEY }).expect(400);
    await status(appWith(deps), { domain: 'acme.example', apiKey: KEY, from: 'a@acme.example' }).expect(400);
    await status(appWith(deps), { domain: 'not a domain', apiKey: KEY }).expect(400);
    await status(appWith(deps), { domain: 'https://acme.example/', apiKey: KEY }).expect(400);
    expect(deps.calls).toHaveLength(0);
  });

  it('uses the inline key, never the platform key, and makes one GET', async () => {
    const deps = fakeDeps(listing([]));
    await status(appWith(deps), { domain: 'acme.example', apiKey: KEY }).expect(200);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].init.method).toBe('GET');
    expect((deps.calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('the key appears in no response body, including the typed provider error and a validation error', async () => {
    const bodies: string[] = [];
    for (const res of [jsonResponse(401, { message: KEY }), jsonResponse(422, { message: KEY }), jsonResponse(500, { message: KEY }), listing([])]) {
      bodies.push(JSON.stringify((await status(appWith(fakeDeps(res)), { domain: 'acme.example', apiKey: KEY })).body));
    }
    const leaky: ResendDeps = { fetchImpl: (async () => { throw new Error(`boom ${KEY}`); }) as typeof fetch };
    bodies.push(JSON.stringify((await status(appWith(leaky), { domain: 'acme.example', apiKey: KEY })).body));
    bodies.push(JSON.stringify((await status(appWith(fakeDeps()), { domain: 'bad domain', apiKey: KEY })).body));
    bodies.push(JSON.stringify((await status(appWith(fakeDeps()), { domain: 'acme.example', apiKey: KEY, extra: 1 })).body));
    for (const b of bodies) expect(b).not.toContain(KEY);
  });

  it('send-email is unchanged: still accepts the platform provider with no inline key', async () => {
    await send(appWith(fakeDeps()), EMAIL).expect(200);
  });
});
