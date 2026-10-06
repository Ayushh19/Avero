import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

export const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const ts = () => timestamp({ withTimezone: true, mode: 'date' });

export const createdAt = () => ts().notNull().defaultNow();
export const updatedAt = () =>
  ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
