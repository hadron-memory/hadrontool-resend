import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESEND_EMAILS_URL, SEND_TIMEOUT_MS, sendEmail, type ResendDeps } from './resend.js';

const PROVIDER = { apiKey: 're_secret', from: 'Hadron Agent <agent@example.com>' };
const MESSAGE = {
  to: 'person@example.net',
  subject: 'Deploy finished',
  text: 'Everything is healthy.',
  idempotencyKey: 'run_123:abc',
};

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

describe('sendEmail', () => {
  afterEach(() => vi.useRealTimers());

  it('POSTs one text email with a fixed sender and provider idempotency key', async () => {
    const deps = depsReturning(jsonResponse(200, { id: 'email_123' }));
    await expect(sendEmail(PROVIDER, MESSAGE, deps)).resolves.toEqual({ id: 'email_123' });
    expect(deps.calls[0].url).toBe(RESEND_EMAILS_URL);
    const headers = deps.calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${PROVIDER.apiKey}`);
    expect(headers['idempotency-key']).toBe(MESSAGE.idempotencyKey);
    expect(JSON.parse(String(deps.calls[0].init.body))).toEqual({
      from: PROVIDER.from,
      to: [MESSAGE.to],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
  });

  it.each([
    [401, 502, 'provider_unauthorized'],
    [403, 502, 'provider_unauthorized'],
    [422, 502, 'provider_rejected'],
    [429, 429, 'provider_rate_limited'],
    [503, 502, 'upstream_unreachable'],
  ])('maps Resend HTTP %i to %i %s', async (providerStatus, _httpStatus, code) => {
    const deps = depsReturning(jsonResponse(providerStatus, { message: 'provider detail' }));
    await expect(sendEmail(PROVIDER, MESSAGE, deps)).rejects.toMatchObject({ code });
  });

  it('maps network and response-shape failures to upstream_unreachable', async () => {
    const broken: ResendDeps = { fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as typeof fetch };
    await expect(sendEmail(PROVIDER, MESSAGE, broken)).rejects.toMatchObject({ code: 'upstream_unreachable' });
    await expect(sendEmail(PROVIDER, MESSAGE, depsReturning(jsonResponse(200, {})))).rejects.toMatchObject({
      code: 'upstream_unreachable',
    });
  });

  it('maps the elapsed time budget to upstream_timeout', async () => {
    vi.useFakeTimers();
    const deps: ResendDeps = {
      fetchImpl: ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch,
    };
    const pending = sendEmail(PROVIDER, MESSAGE, deps);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'upstream_timeout' });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    await assertion;
  });

  it('never includes the API key or message content in thrown errors', async () => {
    const err = await sendEmail(PROVIDER, MESSAGE, depsReturning(jsonResponse(422, { message: MESSAGE.text }))).catch(
      (value: Error) => value,
    );
    const surface = String(err) + JSON.stringify((err as { toBody?: () => unknown }).toBody?.() ?? {});
    expect(surface).not.toContain(PROVIDER.apiKey);
    expect(surface).not.toContain(MESSAGE.text);
    expect(surface).not.toContain(MESSAGE.to);
  });
});
