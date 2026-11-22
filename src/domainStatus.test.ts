import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMAIN_STATUS_TIMEOUT_MS, RESEND_DOMAINS_URL, getDomainStatus } from './domainStatus.js';
import type { ResendDeps } from './resend.js';

const KEY = 're_org_secret_key';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function depsReturning(res: Response): ResendDeps & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return res;
    }) as typeof fetch,
  };
}

const list = (data: unknown[], extra: Record<string, unknown> = {}) => jsonResponse(200, { object: 'list', data, ...extra });
const allErrorSurfaces = (err: unknown) =>
  String(err) + JSON.stringify((err as { toBody?: () => unknown }).toBody?.() ?? {}) + JSON.stringify(err);

describe('getDomainStatus', () => {
  afterEach(() => vi.useRealTimers());

  it('verified: the domain is listed with status verified', async () => {
    const deps = depsReturning(list([{ id: 'd1', name: 'other.example', status: 'pending' }, { id: 'd2', name: 'acme.example', status: 'verified' }]));
    await expect(getDomainStatus(KEY, 'acme.example', deps)).resolves.toEqual({ domain: 'acme.example', status: 'verified' });
  });

  it.each(['pending', 'not_started', 'failed', 'temporary_failure'])('unverified: a listed domain in state %s', async (state) => {
    const deps = depsReturning(list([{ id: 'd1', name: 'acme.example', status: state }]));
    await expect(getDomainStatus(KEY, 'acme.example', deps)).resolves.toEqual({ domain: 'acme.example', status: 'unverified' });
  });

  it('unverified: an unrecognised or missing provider state never reads as verified', async () => {
    const deps = depsReturning(list([{ id: 'd1', name: 'acme.example', status: 'something_new' }]));
    await expect(getDomainStatus(KEY, 'acme.example', deps)).resolves.toEqual({ domain: 'acme.example', status: 'unverified' });
    const bare = depsReturning(list([{ id: 'd1', name: 'acme.example' }]));
    await expect(getDomainStatus(KEY, 'acme.example', bare)).resolves.toEqual({ domain: 'acme.example', status: 'unverified' });
  });

  it('not_found: the domain is absent from a complete list', async () => {
    const deps = depsReturning(list([{ id: 'd1', name: 'other.example', status: 'verified' }], { has_more: false }));
    await expect(getDomainStatus(KEY, 'acme.example', deps)).resolves.toEqual({ domain: 'acme.example', status: 'not_found' });
  });

  it('matches the exact domain, case-insensitively, never a parent or a subdomain', async () => {
    const deps = depsReturning(list([{ id: 'd1', name: 'Acme.Example', status: 'verified' }]));
    await expect(getDomainStatus(KEY, 'acme.example', deps)).resolves.toEqual({ domain: 'acme.example', status: 'verified' });
    await expect(getDomainStatus(KEY, 'ACME.Example', depsReturning(list([{ id: 'd1', name: 'Acme.Example', status: 'verified' }])))).resolves.toEqual({ domain: 'acme.example', status: 'verified' });
    const sub = depsReturning(list([{ id: 'd1', name: 'mail.acme.example', status: 'verified' }]));
    await expect(getDomainStatus(KEY, 'acme.example', sub)).resolves.toMatchObject({ status: 'not_found' });
    const parent = depsReturning(list([{ id: 'd1', name: 'acme.example', status: 'verified' }]));
    await expect(getDomainStatus(KEY, 'mail.acme.example', parent)).resolves.toMatchObject({ status: 'not_found' });
  });

  it('a truncated list that lacks the domain is an error, never not_found', async () => {
    const deps = depsReturning(list([{ id: 'd1', name: 'other.example', status: 'verified' }], { has_more: true }));
    await expect(getDomainStatus(KEY, 'acme.example', deps)).rejects.toMatchObject({ code: 'upstream_unreachable' });
    const found = depsReturning(list([{ id: 'd1', name: 'acme.example', status: 'verified' }], { has_more: true }));
    await expect(getDomainStatus(KEY, 'acme.example', found)).resolves.toMatchObject({ status: 'verified' });
  });

  it('is read-only: exactly one GET to the fixed domains URL, no body, with the inline key as bearer', async () => {
    const deps = depsReturning(list([]));
    await getDomainStatus(KEY, 'acme.example', deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].url).toBe(RESEND_DOMAINS_URL);
    expect(deps.calls[0].init.method).toBe('GET');
    expect(deps.calls[0].init.body).toBeUndefined();
    expect((deps.calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([
    [401, 'provider_unauthorized'],
    [403, 'provider_unauthorized'],
    [422, 'provider_rejected'],
    [429, 'provider_rate_limited'],
    [503, 'upstream_unreachable'],
  ])('maps Resend HTTP %i to %s', async (status, code) => {
    const deps = depsReturning(jsonResponse(status, { message: 'provider detail' }));
    await expect(getDomainStatus(KEY, 'acme.example', deps)).rejects.toMatchObject({ code });
  });

  it('maps a network failure and a wrong response shape to upstream_unreachable', async () => {
    const broken: ResendDeps = { fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as typeof fetch };
    await expect(getDomainStatus(KEY, 'acme.example', broken)).rejects.toMatchObject({ code: 'upstream_unreachable' });
    await expect(getDomainStatus(KEY, 'acme.example', depsReturning(jsonResponse(200, {})))).rejects.toMatchObject({ code: 'upstream_unreachable' });
    await expect(getDomainStatus(KEY, 'acme.example', depsReturning(jsonResponse(200, { data: [{ status: 'verified' }] })))).rejects.toMatchObject({ code: 'upstream_unreachable' });
  });

  it('a 200 whose body is not JSON is upstream_unreachable', async () => {
    const deps = depsReturning(new Response('<html>nope</html>', { status: 200 }));
    await expect(getDomainStatus(KEY, 'acme.example', deps)).rejects.toMatchObject({ code: 'upstream_unreachable' });
  });

  it('maps the elapsed time budget to upstream_timeout', async () => {
    vi.useFakeTimers();
    const deps: ResendDeps = {
      fetchImpl: ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch,
    };
    const assertion = expect(getDomainStatus(KEY, 'acme.example', deps)).rejects.toMatchObject({ code: 'upstream_timeout' });
    await vi.advanceTimersByTimeAsync(DOMAIN_STATUS_TIMEOUT_MS + 1);
    await assertion;
  });

  it('never puts the key in an error: provider body, thrown fetch error or timeout', async () => {
    const echoing = depsReturning(jsonResponse(401, { message: `invalid key ${KEY}` }));
    const leaky: ResendDeps = { fetchImpl: (async () => { throw new Error(`connect failed for Bearer ${KEY}`); }) as typeof fetch };
    const shape = depsReturning(jsonResponse(200, { echo: KEY }));
    for (const deps of [echoing, leaky, shape, depsReturning(jsonResponse(500, { message: KEY })), depsReturning(jsonResponse(422, { message: KEY }))]) {
      const err = await getDomainStatus(KEY, 'acme.example', deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(allErrorSurfaces(err)).not.toContain(KEY);
    }
  });
});
