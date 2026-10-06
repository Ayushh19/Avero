import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context';
import { jobs } from '../db/schema';

export type JobHandler = (payload: unknown, ctx: AppContext) => Promise<void>;

const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 500;

/** Exponential backoff: 5s, 20s, 80s, … capped at 30 min. */
export function backoffMs(attempt: number): number {
  return Math.min(5_000 * 4 ** (attempt - 1), 30 * 60_000);
}

/**
 * In-process worker for the DB-backed queue. Handlers must be idempotent: a job can run more
 * than once if the process dies between running it and marking it done.
 */
export class JobWorker {
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
  ) {}

  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  async start(): Promise<void> {
    // Jobs left "running" by a crashed process go back to the queue.
    await this.ctx.db
      .update(jobs)
      .set({ status: 'pending', lockedAt: null })
      .where(eq(jobs.status, 'running'));
    const tick = async () => {
      await this.runDue().catch((err) => this.log.error({ err }, 'job worker tick failed'));
      this.timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    this.timer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Claims and runs all currently-due jobs. Returns how many ran. Exposed for tests. */
  async runDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      for (;;) {
        const now = this.ctx.clock.now();
        const claimed = await this.ctx.db.transaction(async (tx) => {
          const due = await tx
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, now)))
            .orderBy(jobs.runAt)
            .limit(BATCH_SIZE)
            .for('update', { skipLocked: true });
          if (due.length === 0) return [];
          return tx
            .update(jobs)
            .set({ status: 'running', lockedAt: now, attempts: sql`${jobs.attempts} + 1` })
            .where(
              inArray(
                jobs.id,
                due.map((d) => d.id),
              ),
            )
            .returning();
        });
        if (claimed.length === 0) break;
        for (const job of claimed) await this.execute(job);
        total += claimed.length;
      }
    } finally {
      this.running = false;
    }
    return total;
  }

  private async execute(job: typeof jobs.$inferSelect): Promise<void> {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
      await handler(job.payload, this.ctx);
      await this.ctx.db
        .update(jobs)
        .set({ status: 'done', completedAt: this.ctx.clock.now(), lockedAt: null })
        .where(eq(jobs.id, job.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = job.attempts >= job.maxAttempts;
      this.log[exhausted ? 'error' : 'warn'](
        { err, jobId: job.id, type: job.type, attempt: job.attempts },
        exhausted ? 'job failed permanently' : 'job failed, will retry',
      );
      await this.ctx.db
        .update(jobs)
        .set({
          status: exhausted ? 'failed' : 'pending',
          lastError: message,
          lockedAt: null,
          runAt: new Date(this.ctx.clock.now().getTime() + backoffMs(job.attempts)),
        })
        .where(eq(jobs.id, job.id));
    }
  }
}
