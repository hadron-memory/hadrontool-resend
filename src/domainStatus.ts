import {
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderUnauthorizedError,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
} from './errors.js';
import { logger } from './logger.js';
import type { ResendDeps } from './resend.js';

/** Fixed upstream: the caller never supplies a URL. `limit=100` is Resend's page maximum. */
export const RESEND_DOMAINS_URL = 'https://api.resend.com/domains?limit=100';
export const DOMAIN_STATUS_TIMEOUT_MS = 10_000;

export type DomainStatus = 'verified' | 'unverified' | 'not_found';

export interface DomainStatusResult {
  domain: string;
  status: DomainStatus;
}

/**
 * Report a sender domain's Resend verification state. READ ONLY: one bounded GET of the account's domain list,
 * no domain creation, no verification trigger, no test send. The key arrives inline per request (cor:int:030:01),
 * is used for the one call, and is never stored, logged or echoed (any provider- or transport-supplied text that
 * carries it is dropped or redacted before it can reach an error).
 */
export async function getDomainStatus(apiKey: string, domain: string, deps: ResendDeps): Promise<DomainStatusResult> {
  const wanted = domain.toLowerCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOMAIN_STATUS_TIMEOUT_MS);
  const startedAt = Date.now();
  let res: Response;
  let payload: unknown;
  try {
    res = await deps.fetchImpl(RESEND_DOMAINS_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    try {
      payload = await res.json();
    } catch {
      if (controller.signal.aborted) throw new Error('timed out mid-body');
      payload = null;
    }
  } catch (err) {
    if (controller.signal.aborted) throw new UpstreamTimeoutError(DOMAIN_STATUS_TIMEOUT_MS / 1000);
    const detail = String((err as Error)?.message ?? err).split(apiKey).join('[redacted]').slice(0, 200);
    throw new UpstreamUnreachableError(detail);
  } finally {
    clearTimeout(timer);
  }

  logger.info('resend domain status attempted', { status: res.status, durationMs: Date.now() - startedAt });

  if (res.status === 429) throw new ProviderRateLimitedError();
  if (res.status === 401 || res.status === 403) throw new ProviderUnauthorizedError(res.status);
  if (res.status >= 500) throw new UpstreamUnreachableError(`Resend answered HTTP ${res.status}.`);
  if (!res.ok) throw new ProviderRejectedError(res.status);

  const body = payload as { data?: unknown; has_more?: unknown } | null;
  const data = body?.data;
  if (!Array.isArray(data) || data.some((d) => typeof (d as { name?: unknown } | null)?.name !== 'string')) {
    throw new UpstreamUnreachableError('Resend returned an unexpected response shape.');
  }
  const match = (data as { name: string; status?: unknown }[]).find((d) => d.name.toLowerCase() === wanted);
  if (match) return { domain: wanted, status: match.status === 'verified' ? 'verified' : 'unverified' };
  // An absent domain on a truncated list is unknown, not absent: never claim not_found from a partial view.
  if (body?.has_more === true) throw new UpstreamUnreachableError('Resend returned more domains than one page.');
  return { domain: wanted, status: 'not_found' };
}
