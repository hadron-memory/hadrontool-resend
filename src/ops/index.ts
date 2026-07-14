import { z } from 'zod';
import { ProviderNotConfiguredError, ValidationError } from '../errors.js';
import { sendEmail, type ResendDeps } from '../resend.js';

export const MAX_EMAIL_SUBJECT_CHARS = 200;
export const MAX_EMAIL_TEXT_CHARS = 20_000;

const sendEmailSchema = z
  .object({
    to: z.email(),
    subject: z.string().min(1).max(MAX_EMAIL_SUBJECT_CHARS),
    text: z.string().min(1).max(MAX_EMAIL_TEXT_CHARS),
    idempotencyKey: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();

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
  if (!deps.provider) throw new ProviderNotConfiguredError();
  return sendEmail(deps.provider, input, deps);
});

export const OPERATIONS: Record<string, OperationDef> = {
  'send-email': sendEmailOp,
};

export async function runOperation(deps: ResendDeps, name: string, input: Record<string, unknown>): Promise<unknown> {
  const def = OPERATIONS[name];
  if (!def) throw new ValidationError('operation', `unknown operation "${name}"`);
  return def.run(deps, input);
}
