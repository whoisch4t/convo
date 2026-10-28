import type { z } from 'zod';
import { badRequest } from '../lib/errors';

/** Parses `data` with `schema` or throws a 400 with one entry per invalid field. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'Validation failed',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
