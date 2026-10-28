import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma';

beforeEach(async () => {
  // Everything else cascades from users and workspaces.
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User", "Workspace" CASCADE');
});

afterAll(async () => {
  await prisma.$disconnect();
});
