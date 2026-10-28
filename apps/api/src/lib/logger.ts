import { pino } from 'pino';
import { env, isProd, isTest } from '../env';

export const logger = pino({
  level: env.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
  ...(isProd || isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } } }),
});
