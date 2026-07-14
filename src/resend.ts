import {
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderUnauthorizedError,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
} from './errors.js';
import { logger } from './logger.js';
import type { ResendProvider } from './config.js';

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
export const SEND_TIMEOUT_MS = 25_000;

export interface SendEmailRequest {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export interface SendEmailResult {
  id: string;
}

export interface ResendDeps {
  fetchImpl: typeof fetch;
  provider?: ResendProvider;
}

export async function sendEmail(
  provider: ResendProvider,
  request: SendEmailRequest,
  deps: ResendDeps,
): Promise<SendEmailResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  const startedAt = Date.now();
  let res: Response;
  let payload: Record<string, unknown> | null;
  try {
    res = await deps.fetchImpl(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': request.idempotencyKey,
      },
      body: JSON.stringify({
        from: provider.from,
        to: [request.to],
        subject: request.subject,
        text: request.text,
      }),
      signal: controller.signal,
    });
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch {
      if (controller.signal.aborted) throw new Error('timed out mid-body');
      payload = null;
    }
  } catch (err) {
    if (controller.signal.aborted) throw new UpstreamTimeoutError(SEND_TIMEOUT_MS / 1000);
    throw new UpstreamUnreachableError(String((err as Error)?.message ?? err).slice(0, 200));
  } finally {
    clearTimeout(timer);
  }

  logger.info('resend send attempted', { status: res.status, durationMs: Date.now() - startedAt });

  if (res.status === 429) throw new ProviderRateLimitedError();
  if (res.status === 401 || res.status === 403) throw new ProviderUnauthorizedError(res.status);
  if (res.status >= 500) throw new UpstreamUnreachableError(`Resend answered HTTP ${res.status}.`);
  if (!res.ok) throw new ProviderRejectedError(res.status);

  const id = typeof payload?.id === 'string' ? payload.id : null;
  if (!id) throw new UpstreamUnreachableError('Resend returned an unexpected response shape.');
  return { id };
}
