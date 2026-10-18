import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ERROR_SENTENCES } from '@living-wiki/contracts';
import { mapDbError } from '@living-wiki/db';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_failed',
        message: ERROR_SENTENCES.validation_failed,
        issues: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const mapped = mapDbError(err);
    if (mapped) {
      return reply.status(mapped.statusCode).send({ error: mapped.code, message: mapped.message });
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status <= 499) {
      // Fastify-native client errors (malformed JSON, 413, 415, ...): keep the status, hide the cause text.
      return reply.status(status).send({
        error: 'validation_failed',
        message: ERROR_SENTENCES.validation_failed,
      });
    }
    app.log.error(err);
    return reply.status(500).send({
      error: 'internal_error',
      message: ERROR_SENTENCES.internal_error,
    });
  });
}
