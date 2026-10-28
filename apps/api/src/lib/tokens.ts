import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { env } from '../env';
import { prisma } from './prisma';
import { store } from './cache';

export const ACCESS_COOKIE = 'cv_access';
export const REFRESH_COOKIE = 'cv_refresh';

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface AccessPayload {
  sub: string;
}

export function signAccessToken(userId: string) {
  return jwt.sign({ sub: userId } satisfies AccessPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: ACCESS_TTL_SECONDS,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    // WebSocket tickets are signed with the same secret but are not access tokens.
    if (typeof payload !== 'object' || payload.aud !== undefined) return null;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export const hashToken = (token: string) =>
  createHash('sha256').update(token).update(env.JWT_REFRESH_SECRET).digest('hex');

/** Creates a random opaque refresh token and stores its hash. */
export async function issueRefreshToken(userId: string, familyId: string = randomUUID()) {
  const token = randomBytes(48).toString('base64url');
  const record = await prisma.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return { token, record };
}

export type RotateResult =
  { ok: true; userId: string; token: string } | { ok: false; reason: 'invalid' | 'expired' | 'reused' };

/**
 * Exchanges a refresh token for a new one. If a token that was already used shows up again,
 * someone may have stolen it, so every token in that login family is revoked.
 */
export async function rotateRefreshToken(token: string): Promise<RotateResult> {
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!existing) return { ok: false, reason: 'invalid' };

  if (existing.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: false, reason: 'reused' };
  }
  if (existing.expiresAt <= new Date()) return { ok: false, reason: 'expired' };

  const next = await issueRefreshToken(existing.userId, existing.familyId);
  // Only succeeds if nobody rotated this token in the meantime (two tabs refreshing at once).
  const { count } = await prisma.refreshToken.updateMany({
    where: { id: existing.id, revokedAt: null },
    data: { revokedAt: new Date(), replacedBy: next.record.id },
  });
  if (count === 0) {
    await prisma.refreshToken.delete({ where: { id: next.record.id } });
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, userId: existing.userId, token: next.token };
}

export async function revokeRefreshToken(token: string) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

const baseCookie = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax' as const,
  path: '/',
});

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie(), maxAge: ACCESS_TTL_SECONDS * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...baseCookie(), maxAge: REFRESH_TTL_MS });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, baseCookie());
  res.clearCookie(REFRESH_COOKIE, baseCookie());
}

// ---------- WebSocket tickets ----------

const WS_TICKET_TTL_SECONDS = 60;

/**
 * A short-lived, single-use token for opening one WebSocket. The browser fetches it through
 * the same-origin REST API (cookies), then passes it in the socket URL. The audience keeps
 * tickets and access tokens from being used in place of each other.
 */
export function signWsTicket(userId: string) {
  return jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, {
    expiresIn: WS_TICKET_TTL_SECONDS,
    algorithm: 'HS256',
    audience: 'ws',
    jwtid: randomUUID(),
  });
}

/** Returns the user id, or null if the ticket is invalid, expired or was already used. */
export async function verifyWsTicket(ticket: string): Promise<string | null> {
  try {
    const payload = jwt.verify(ticket, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], audience: 'ws' });
    if (typeof payload !== 'object' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null;
    // Tickets travel in the URL and can end up in proxy logs, so each one opens a single socket.
    const { count } = await store.incr(`ws-ticket:${payload.jti}`, WS_TICKET_TTL_SECONDS * 1000);
    return count === 1 ? payload.sub : null;
  } catch {
    return null;
  }
}
