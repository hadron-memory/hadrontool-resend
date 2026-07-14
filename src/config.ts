import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  RESEND_TOOL_TOKEN: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z
    .string()
    .min(3)
    .max(320)
    .refine((value) => !/[\r\n]/.test(value), 'must not contain newlines')
    .refine((value) => {
      const angle = /<([^<>]+)>$/.exec(value.trim());
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((angle?.[1] ?? value).trim());
    }, 'must be an email address or Name <email@example.com>')
    .optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

const env = parsed.data;
const isProduction = env.NODE_ENV === 'production';

if (isProduction && !env.RESEND_TOOL_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('RESEND_TOOL_TOKEN must be set when NODE_ENV=production. Refusing to start.');
  process.exit(1);
}

if (Boolean(env.RESEND_API_KEY) !== Boolean(env.RESEND_FROM)) {
  // eslint-disable-next-line no-console
  console.error('RESEND_API_KEY and RESEND_FROM must either both be set or both be unset. Refusing to start.');
  process.exit(1);
}

export const VERSION = '0.1.0';

export interface ResendProvider {
  apiKey: string;
  from: string;
}

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction,
  port: env.PORT,
  serviceToken: env.RESEND_TOOL_TOKEN,
  provider:
    env.RESEND_API_KEY && env.RESEND_FROM
      ? ({ apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM } satisfies ResendProvider)
      : undefined,
} as const;

export type Config = typeof config;
