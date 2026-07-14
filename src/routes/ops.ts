/**
 * Operations plane — POST /ops/<operation> (internal, bearer-gated).
 *
 * Every response is JSON. Errors use the typed catalog (src/errors.ts) —
 * hadron-server's resendToolClient passes the `error` code through verbatim.
 * The tool keeps no idempotency ledger: it forwards the caller's key to
 * Resend's provider-managed idempotency and never retries a send itself.
 */

import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { ResendToolError, validationFromZod } from '../errors.js';
import { OPERATIONS, runOperation } from '../ops/index.js';
import type { ResendDeps } from '../resend.js';

function respondWithError(res: Response, err: unknown, opName: string): void {
  const typed = err instanceof ZodError ? validationFromZod(err) : err;
  if (typed instanceof ResendToolError) {
    res.status(typed.httpStatus).json(typed.toBody());
    return;
  }
  // Log the error class + a short message only — never inputs, headers, or
  // bodies (operation inputs carry recipient addresses and email text).
  logger.error('operation failed', {
    op: opName,
    err: String((typed as Error)?.message ?? typed).slice(0, 200),
  });
  res.status(500).json({ error: 'internal_error', message: 'Unexpected error.' });
}

/** Build the /ops router over injected Resend deps (tests inject fakes). */
export function opsRouter(deps: ResendDeps): Router {
  const router = Router();

  router.post('/:operation', async (req, res) => {
    const name = req.params.operation;
    if (!OPERATIONS[name]) {
      res.status(404).json({
        error: 'unknown_operation',
        message: `No operation "${name}"`,
        operations: Object.keys(OPERATIONS),
      });
      return;
    }
    try {
      const result = await runOperation(deps, name, (req.body ?? {}) as Record<string, unknown>);
      res.status(200).json({ ok: true, ...(result as Record<string, unknown>) });
    } catch (err) {
      respondWithError(res, err, name);
    }
  });

  return router;
}
