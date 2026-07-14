import { z } from 'zod';
import { ProviderNotConfiguredError, ValidationError } from '../errors.js';
import { sendEmail, type ResendDeps } from '../resend.js';
import type { ResendProvider } from '../config.js';

export const MAX_EMAIL_SUBJECT_CHARS = 200;
export const MAX_EMAIL_TEXT_CHARS = 20_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validFrom(value: string): boolean {
  const angle = /<([^<>]+)>$/.exec(value.trim());
  return EMAIL_RE.test((angle?.[1] ?? value).trim());
}

const sendEmailSchema = z
  .object({
    to: z.email(),
    subject: z.string().min(1).max(MAX_EMAIL_SUBJECT_CHARS),
    text: z.string().min(1).max(MAX_EMAIL_TEXT_CHARS),
    idempotencyKey: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/),
    apiKey: z.string().min(1).max(8_192).regex(/^\S+$/).optional(),
    from: z
      .string()
      .min(3)
      .max(320)
      .refine((value) => !/[\r\n]/.test(value), 'must not contain newlines')
      .refine(validFrom, 'must be an email address or Name <email@example.com>')
      .optional(),
  })
  .strict();

function resolveProvider(
  input: z.infer<typeof sendEmailSchema>,
  platformProvider: ResendProvider | undefined,
): ResendProvider {
  const hasApiKey = input.apiKey !== undefined;
  const hasFrom = input.from !== undefined;
  if (!hasApiKey && !hasFrom) {
    if (!platformProvider) throw new ProviderNotConfiguredError();
    return platformProvider;
  }
  if (!hasApiKey || !hasFrom) {
    throw new ValidationError('apiKey', 'inline credentials require both apiKey and from');
  }
  return { apiKey: input.apiKey!, from: input.from! };
}

export interface OperationDef {
  schema: z.ZodType;
  run(deps: ResendDeps, input: Record<string, unknown>): Promise<unknown>;
}

function defineOp<S extends z.ZodType>(
  schema: S,
  handler: (deps: ResendDeps, input: z.infer<S>) => Promise<unknown>,
): OperationDef {
  return { schema, run: (deps, raw) => handler(deps, schema.parse(raw)) };
}

const sendEmailOp = defineOp(sendEmailSchema, async (deps, input) => {
  const provider = resolveProvider(input, deps.provider);
  return sendEmail(
    provider,
    {
      to: input.to,
      subject: input.subject,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    },
    deps,
  );
});

export const OPERATIONS: Record<string, OperationDef> = {
  'send-email': sendEmailOp,
};

export async function runOperation(deps: ResendDeps, name: string, input: Record<string, unknown>): Promise<unknown> {
  const def = Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name] : undefined;
  if (!def) throw new ValidationError('operation', `unknown operation "${name}"`);
  return def.run(deps, input);
}
