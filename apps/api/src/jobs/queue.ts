import type { DbOrTx } from '../db/client';
import { jobs } from '../db/schema';

export interface EnqueueOptions {
  runAt?: Date;
  /** While a job with this key is pending/running, further enqueues are ignored. */
  dedupeKey?: string;
  maxAttempts?: number;
}

/**
 * Enqueue a background job. Call with the *transaction* that performs the state change so the
 * job is committed atomically with it (transactional outbox).
 */
export async function enqueue<T extends object>(
  db: DbOrTx,
  type: string,
  payload: T,
  options: EnqueueOptions = {},
): Promise<void> {
  await db
    .insert(jobs)
    .values({
      type,
      payload,
      runAt: options.runAt ?? new Date(0),
      dedupeKey: options.dedupeKey,
      maxAttempts: options.maxAttempts ?? 5,
    })
    .onConflictDoNothing();
}
