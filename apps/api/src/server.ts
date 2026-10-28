import { createServer } from 'node:http';
import { createApp } from './app';
import { env } from './env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { store } from './lib/cache';
import { realtime } from './realtime';
import { Gateway } from './realtime/gateway';

const server = createServer(createApp());
const gateway = new Gateway({ bus: realtime.bus, presence: realtime.presence });
gateway.attach(server);

server.listen(env.PORT, () => {
  logger.info(`Convo API listening on http://localhost:${env.PORT} (WebSocket at /ws)`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  await gateway.close();
  server.close();
  await Promise.allSettled([
    prisma.$disconnect(),
    store.close(),
    realtime.bus.close(),
    realtime.presence.close(),
    realtime.redis?.quit(),
  ]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
