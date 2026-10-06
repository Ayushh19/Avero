import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { appClock } from '../db/schema';

/**
 * Injectable clock. Business logic must use `clock.now()` instead of `new Date()` so the
 * dev simulation panel can fast-forward time (deliveries, return windows, expiries).
 */
export interface Clock {
  now(): Date;
  offsetMs(): number;
}

export class SimulatedClock implements Clock {
  private offset = 0;

  constructor(private readonly db?: Db) {}

  async load(): Promise<void> {
    if (!this.db) return;
    const row = await this.db.query.appClock.findFirst();
    this.offset = row?.offsetMs ?? 0;
  }

  now(): Date {
    return new Date(Date.now() + this.offset);
  }

  offsetMs(): number {
    return this.offset;
  }

  async advance(ms: number): Promise<void> {
    this.offset += ms;
    if (!this.db) return;
    await this.db
      .insert(appClock)
      .values({ id: 1, offsetMs: this.offset })
      .onConflictDoUpdate({ target: appClock.id, set: { offsetMs: this.offset } });
  }

  async reset(): Promise<void> {
    this.offset = 0;
    if (this.db) await this.db.delete(appClock).where(eq(appClock.id, 1));
  }
}

export const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
export const addHours = (d: Date, n: number) => addMinutes(d, n * 60);
export const addDays = (d: Date, n: number) => addHours(d, n * 24);
