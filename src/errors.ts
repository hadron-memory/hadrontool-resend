/** Stable public error catalog consumed by hadron-server. */
export abstract class ResendToolError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extraFields() };
  }

  protected extraFields(): Record<string, unknown> {
    return {};
  }
}

export class ValidationError extends ResendToolError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
  constructor(
    public field: string,
    public reason: string,
  ) {
    super(`This request couldn't be processed: ${reason}`);
  }
  protected override extraFields() {
    return { field: this.field, reason: this.reason };
  }
}

export class ProviderNotConfiguredError extends ResendToolError {
  readonly code = 'provider_not_configured';
  readonly httpStatus = 503;
  constructor() {
    super('Resend is not configured on this tool.');
  }
}

export class ProviderUnauthorizedError extends ResendToolError {
  readonly code = 'provider_unauthorized';
  readonly httpStatus = 502;
  constructor(public providerStatus: number) {
    super(`Resend rejected the configured credentials (HTTP ${providerStatus}).`);
  }
  protected override extraFields() {
    return { providerStatus: this.providerStatus };
  }
}

export class ProviderRejectedError extends ResendToolError {
  readonly code = 'provider_rejected';
  readonly httpStatus = 502;
  constructor(public providerStatus: number) {
    super(`Resend rejected the email (HTTP ${providerStatus}).`);
  }
  protected override extraFields() {
    return { providerStatus: this.providerStatus };
  }
}

export class ProviderRateLimitedError extends ResendToolError {
  readonly code = 'provider_rate_limited';
  readonly httpStatus = 429;
  constructor() {
    super('Resend rate-limited this account. Do not retry immediately.');
  }
}

export class UpstreamUnreachableError extends ResendToolError {
  readonly code = 'upstream_unreachable';
  readonly httpStatus = 502;
  constructor(detail?: string) {
    super(detail ? `Resend is unreachable: ${detail}` : 'Resend is unreachable.');
  }
}

export class UpstreamTimeoutError extends ResendToolError {
  readonly code = 'upstream_timeout';
  readonly httpStatus = 504;
  constructor(public timeoutSeconds: number) {
    super(`The Resend request timed out after ${timeoutSeconds}s.`);
  }
  protected override extraFields() {
    return { timeoutSeconds: this.timeoutSeconds };
  }
}

export function validationFromZod(err: { issues: { path: PropertyKey[]; message: string }[] }): ValidationError {
  const issue = err.issues[0];
  return new ValidationError(issue?.path.map(String).join('.') || 'input', issue?.message ?? 'invalid input');
}
