import type { ApiErrorBody } from '@avero/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      const body: ApiErrorBody = {
        error: { code: error.code, message: error.message, details: error.details, requestId },
      };
      return reply.status(error.status).send(body);
    }

    if (error instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: 'VALIDATION_FAILED',
          message: error.issues[0]?.message ?? 'Invalid request',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId,
        },
      };
      return reply.status(400).send(body);
    }

    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a moment.', requestId },
      } satisfies ApiErrorBody);
    }

    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: { code: 'VALIDATION_FAILED', message: error.message, requestId },
      } satisfies ApiErrorBody);
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.', requestId },
    } satisfies ApiErrorBody);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id },
    } satisfies ApiErrorBody),
  );
}
