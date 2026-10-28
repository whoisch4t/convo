import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, cookieValue, signedInAgent } from './helpers';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../src/lib/tokens';

async function register(email: string, name = 'Test') {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: 'password123' });
  return { res, refresh: cookieValue(res.headers['set-cookie'], REFRESH_COOKIE)! };
}

describe('auth', () => {
  it('registers with a normalised email and sets httpOnly, SameSite cookies', async () => {
    const { res } = await register('ADA@Example.com', 'Ada');

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: 'Ada', email: 'ada@example.com' });
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith(`${ACCESS_COOKIE}=`) && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${REFRESH_COOKIE}=`) && c.includes('SameSite=Lax'))).toBe(true);
  });

  it('rejects a second account with the same email', async () => {
    const { email } = await signedInAgent();
    const { res } = await register(email);
    expect(res.status).toBe(409);
  });

  it('logs in with the right password only, with the same error for unknown emails', async () => {
    const { email, password } = await signedInAgent();

    const wrong = await request(app).post('/api/auth/login').send({ email, password: 'wrong-password1' });
    expect(wrong.status).toBe(401);
    const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);

    const ok = await request(app).post('/api/auth/login').send({ email, password });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe(email);
  });

  it('protects routes and returns the current user', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/workspaces')).status).toBe(401);

    const { agent, user } = await signedInAgent('Grace');
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: user.id, name: 'Grace' });
  });

  it('rotates refresh tokens and revokes the family when an old one is reused', async () => {
    const { refresh: first } = await register('rotate@example.com');

    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=${first}`);
    expect(refreshed.status).toBe(200);
    const second = cookieValue(refreshed.headers['set-cookie'], REFRESH_COOKIE)!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // Reusing the first token looks like theft: it fails, and the newer token stops working too.
    const reuse = await request(app).post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=${first}`);
    expect(reuse.status).toBe(401);
    const afterReuse = await request(app).post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=${second}`);
    expect(afterReuse.status).toBe(401);
  });

  it('lets only one of two concurrent refreshes with the same token succeed', async () => {
    const { refresh } = await register('race@example.com');

    const results = await Promise.all([
      request(app).post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=${refresh}`),
      request(app).post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=${refresh}`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('logout revokes the refresh token and clears cookies', async () => {
    const { refresh } = await register('bye@example.com');

    const out = await request(app).post('/api/auth/logout').set('Cookie', `${REFRESH_COOKIE}=${refresh}`);
    expect(out.status).toBe(204);
    expect(cookieValue(out.headers['set-cookie'], REFRESH_COOKIE)).toBe('');

    const again = await request(app).post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=${refresh}`);
    expect(again.status).toBe(401);
  });

  it('rejects non-JSON write requests (CSRF protection)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=a@b.c&password=x');
    expect(res.status).toBe(415);
  });
});
