import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { loginSchema, registerSchema } from '@convo/shared';
import { prisma } from '../lib/prisma';
import { conflict, notFound, unauthorized } from '../lib/errors';
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  setAuthCookies,
  signAccessToken,
} from '../lib/tokens';
import { parse } from '../middleware/validate';
import { currentUserId, requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { isTest } from '../env';

const BCRYPT_ROUNDS = isTest ? 4 : 12;
// Compared against when the email does not exist, so both paths take about the same time.
const DUMMY_HASH = bcrypt.hashSync('timing-safe-dummy-password', BCRYPT_ROUNDS);

const publicUser = { id: true, name: true, email: true, createdAt: true } as const;

const authLimiter = rateLimit({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 20,
});

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  const input = parse(registerSchema, req.body);
  const exists = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (exists) throw conflict('An account with this email already exists');

  const user = await prisma.user.create({
    data: { name: input.name, email: input.email, passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS) },
    select: publicUser,
  });
  const refresh = await issueRefreshToken(user.id);
  setAuthCookies(res, signAccessToken(user.id), refresh.token);
  res.status(201).json({ user });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const valid = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) throw unauthorized('Email or password is incorrect');

  const refresh = await issueRefreshToken(user.id);
  setAuthCookies(res, signAccessToken(user.id), refresh.token);
  res.json({ user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt } });
});

authRouter.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw unauthorized('No refresh token');

  const result = await rotateRefreshToken(token);
  if (!result.ok) {
    clearAuthCookies(res);
    throw unauthorized('Session expired, please sign in again');
  }
  setAuthCookies(res, signAccessToken(result.userId), result.token);
  res.json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (token) await revokeRefreshToken(token);
  clearAuthCookies(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: currentUserId(req) }, select: publicUser });
  if (!user) throw notFound('User');
  res.json({ user });
});
