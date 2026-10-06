import { and, eq, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { business } from '../config/business';
import type { AppContext } from '../context';
import { idempotencyKeys } from '../db/schema';
import { addHours } from './clock';
import { sha256, stableStringify } from './crypto';
import { AppError } from './errors';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

interface IdempotentResult {
  status: number;
  body: unknown;
}

/**
 * Runs `handler` at most once per (scope, Idempotency-Key). Replays with the same key and body
 * return the stored response; the same key with a different body is rejected.
 *
 * Business errors (4xx) are stored and replayed — the client must use a new key for a new attempt.
 * Unexpected errors (5xx) release the key so the request can be retried.
 */
export async function withIdempotency(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  handler: () => Promise<IdempotentResult>,
): Promise<FastifyReply> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
  }

  const { db, clock } = ctx;
  const now = clock.now();
  const requestHash = sha256(`${request.method} ${request.routeOptions.url} ${stableStringify(request.body ?? null)}`);
  const fullScope = `${scope}:${request.routeOptions.url}`;

  // Expired keys can be reused.
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.scope, fullScope),
        eq(idempotencyKeys.key, key),
        lt(idempotencyKeys.expiresAt, now),
      ),
    );

  const [inserted] = await db
    .insert(idempotencyKeys)
    .values({
      scope: fullScope,
      key,
      requestHash,
      expiresAt: addHours(now, business.idempotencyTtlHours),
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });

  if (!inserted) {
    const existing = await db.query.idempotencyKeys.findFirst({
      where: and(eq(idempotencyKeys.scope, fullScope), eq(idempotencyKeys.key, key)),
    });
    if (!existing) throw new AppError('CONFLICT', 'Please retry the request');
    if (existing.requestHash !== requestHash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request',
      );
    }
    if (existing.status === 'in_progress') {
      throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'This request is still being processed');
    }
    reply.header('Idempotent-Replayed', 'true');
    return reply.status(existing.responseStatus ?? 200).send(existing.responseBody);
  }

  const save = (status: number, body: unknown) =>
    db
      .update(idempotencyKeys)
      .set({ status: 'completed', responseStatus: status, responseBody: body })
      .where(eq(idempotencyKeys.id, inserted.id));

  try {
    const result = await handler();
    await save(result.status, result.body);
    return reply.status(result.status).send(result.body);
  } catch (err) {
    if (err instanceof AppError && err.status < 500) {
      await save(err.status, {
        error: { code: err.code, message: err.message, details: err.details },
      });
    } else {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, inserted.id));
    }
    throw err;
  }
}
