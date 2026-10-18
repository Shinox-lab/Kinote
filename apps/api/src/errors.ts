import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ERROR_SENTENCES } from '@living-wiki/contracts';

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
    app.log.error(err);
    return reply.status(500).send({
      error: 'internal_error',
      message: ERROR_SENTENCES.internal_error,
    });
  });
}
