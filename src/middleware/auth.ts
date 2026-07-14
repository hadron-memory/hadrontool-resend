import type { NextFunction, Request, Response } from 'express';
import { safeEqual } from '../crypto.js';

/**
 * Bearer-token gate for the ops plane. When the token is unset (development
 * only — production boot refuses this), the gate is a pass-through.
 */
export function requireAuth(serviceToken: string | undefined) {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    if (!serviceToken) {
      next();
      return;
    }
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !safeEqual(match[1], serviceToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
