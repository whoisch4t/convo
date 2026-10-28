import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiErrorBody } from '@convo/shared';
import { HttpError } from '../lib/errors';
import { Prisma } from '../lib/prisma';

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiErrorBody = { error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } };
  res.status(404).json(body);
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: ApiErrorBody = { error: { code: 'INTERNAL', message: 'Something went wrong' } };

  if (err instanceof HttpError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message, details: err.details } };
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    status = 409;
    body = { error: { code: 'CONFLICT', message: 'A record with these values already exists' } };
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
    status = 404;
    body = { error: { code: 'NOT_FOUND', message: 'Resource not found' } };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { error: { code: 'BAD_REQUEST', message: 'Request body is not valid JSON' } };
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    body = { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } };
  }

  if (status >= 500) req.log?.error({ err }, 'Unhandled error');
  res.status(status).json(body);
};
