import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../lib/errors';
import { ACCESS_COOKIE, verifyAccessToken } from '../lib/tokens';

/** Accepts the access token from the auth cookie or an `Authorization: Bearer` header. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = bearer ?? (req.cookies?.[ACCESS_COOKIE] as string | undefined);
  const userId = token ? verifyAccessToken(token) : null;
  if (!userId) return next(unauthorized());
  req.userId = userId;
  next();
}

/** Use after `requireAuth`. */
export function currentUserId(req: Request): string {
  if (!req.userId) throw unauthorized();
  return req.userId;
}
