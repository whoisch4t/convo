import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Applies migrations to the test database once before all tests. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://convo:convo@localhost:5434/convo_test';
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(`Refusing to run tests: database name in TEST_DATABASE_URL must contain "test" (got ${url})`);
  }
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
