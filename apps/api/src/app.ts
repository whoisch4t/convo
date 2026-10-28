import express, { Router, type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { env } from './env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { HttpError } from './lib/errors';
import { requireAuth } from './middleware/auth';
import { rateLimit } from './middleware/rate-limit';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { authRouter } from './modules/auth';
import { workspacesRouter } from './modules/workspaces';
import { channelsRouter } from './modules/channels';
import { messagesRouter } from './modules/messages';
import { realtimeRouter } from './modules/realtime';

/**
 * Cookies are SameSite=Lax, and every write must be JSON. Browsers cannot send a cross-site
 * JSON request without a CORS preflight, which this API never approves for other origins.
 * Together that blocks CSRF without a separate token.
 */
function requireJsonForWrites(req: Request, _res: Response, next: NextFunction) {
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding');
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && hasBody && !req.is('application/json')) {
    return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json'));
  }
  next();
}

/** Allows the configured web origin when it calls the API directly instead of through the Next.js proxy. */
function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('origin');
  if (origin && origin === env.WEB_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
  }
  next();
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(helmet());
  app.use(cors);
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use(requireJsonForWrites);

  app.get('/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  });

  const api = Router();
  api.use(rateLimit({ name: 'api', windowMs: 60_000, max: env.NODE_ENV === 'test' ? 10_000 : 300 }));
  api.use('/auth', authRouter);

  api.use(requireAuth);
  api.use('/workspaces', workspacesRouter);
  api.use('/channels', channelsRouter);
  api.use('/messages', messagesRouter);
  api.use('/realtime', realtimeRouter);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
