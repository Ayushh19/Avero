import { addressSchema, changePasswordSchema, profileSchema, type AddressDto } from '@avero/shared';
import { hash, verify } from '@node-rs/argon2';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbOrTx } from '../../db/client';
import { addresses, sessions, users } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { requireUser } from '../../plugins/session';
import { toSessionUser } from '../auth/service';
import { lookupPincode } from '../delivery/pincode';

const MAX_ADDRESSES = 20;
const idParam = z.object({ id: z.uuid() });

type AddressRow = typeof addresses.$inferSelect;

function toDto(a: AddressRow): AddressDto {
  return {
    id: a.id,
    fullName: a.fullName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2 ?? undefined,
    landmark: a.landmark ?? undefined,
    city: a.city,
    state: a.state as AddressDto['state'],
    pincode: a.pincode,
    isDefault: a.isDefault,
    serviceable: lookupPincode(a.pincode).serviceable,
  };
}

async function listFor(db: DbOrTx, userId: string): Promise<AddressDto[]> {
  const rows = await db.query.addresses.findMany({
    where: eq(addresses.userId, userId),
    orderBy: [desc(addresses.isDefault), asc(addresses.createdAt)],
  });
  return rows.map(toDto);
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  /* ---------- profile ---------- */

  app.patch('/account/profile', async (req) => {
    const user = requireUser(req);
    const input = profileSchema.parse(req.body);
    const [updated] = await ctx.db
      .update(users)
      .set({
        name: input.name,
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.preferredSize !== undefined ? { preferredSize: input.preferredSize } : {}),
      })
      .where(eq(users.id, user.id))
      .returning();
    return { user: toSessionUser(updated!) };
  });

  /** Change (or, for Google-only accounts, set) a password. Other devices are signed out. */
  app.post('/account/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    if (user.passwordHash) {
      if (!currentPassword || !(await verify(user.passwordHash, currentPassword))) {
        throw new AppError('VALIDATION_FAILED', 'Your current password is incorrect', [
          { path: 'currentPassword', message: 'Your current password is incorrect' },
        ]);
      }
    }
    const passwordHash = await hash(newPassword);
    const [updated] = await ctx.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: ctx.clock.now() })
        .where(and(eq(sessions.userId, user.id), ne(sessions.id, req.sessionId!), isNull(sessions.revokedAt)));
      return tx.update(users).set({ passwordHash }).where(eq(users.id, user.id)).returning();
    });
    return { user: toSessionUser(updated!) };
  });

  /* ---------- addresses ---------- */

  app.get('/account/addresses', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { addresses: await listFor(ctx.db, requireUser(req).id) };
  });

  app.post('/account/addresses', async (req, reply) => {
    const user = requireUser(req);
    const input = addressSchema.parse(req.body);
    const list = await ctx.db.transaction(async (tx) => {
      const existing = await tx.query.addresses.findMany({ where: eq(addresses.userId, user.id), columns: { id: true } });
      if (existing.length >= MAX_ADDRESSES) throw new AppError('CONFLICT', `You can save up to ${MAX_ADDRESSES} addresses`);
      const makeDefault = input.isDefault || existing.length === 0;
      if (makeDefault) await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, user.id));
      await tx.insert(addresses).values({ ...input, userId: user.id, isDefault: makeDefault });
      return listFor(tx, user.id);
    });
    return reply.status(201).send({ addresses: list });
  });

  app.put('/account/addresses/:id', async (req) => {
    const user = requireUser(req);
    const { id } = idParam.parse(req.params);
    const input = addressSchema.parse(req.body);
    return {
      addresses: await ctx.db.transaction(async (tx) => {
        const current = await tx.query.addresses.findFirst({ where: and(eq(addresses.id, id), eq(addresses.userId, user.id)) });
        if (!current) throw new AppError('NOT_FOUND', 'Address not found');
        if (input.isDefault && !current.isDefault) {
          await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, user.id));
        }
        await tx
          .update(addresses)
          .set({ ...input, line2: input.line2 ?? null, landmark: input.landmark ?? null, isDefault: input.isDefault || current.isDefault })
          .where(eq(addresses.id, id));
        return listFor(tx, user.id);
      }),
    };
  });

  app.post('/account/addresses/:id/default', async (req) => {
    const user = requireUser(req);
    const { id } = idParam.parse(req.params);
    return {
      addresses: await ctx.db.transaction(async (tx) => {
        const current = await tx.query.addresses.findFirst({ where: and(eq(addresses.id, id), eq(addresses.userId, user.id)) });
        if (!current) throw new AppError('NOT_FOUND', 'Address not found');
        await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, user.id));
        await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, id));
        return listFor(tx, user.id);
      }),
    };
  });

  app.delete('/account/addresses/:id', async (req) => {
    const user = requireUser(req);
    const { id } = idParam.parse(req.params);
    return {
      addresses: await ctx.db.transaction(async (tx) => {
        const [deleted] = await tx.delete(addresses).where(and(eq(addresses.id, id), eq(addresses.userId, user.id))).returning();
        if (!deleted) throw new AppError('NOT_FOUND', 'Address not found');
        // Keep exactly one default while any address exists.
        if (deleted.isDefault) {
          const next = await tx.query.addresses.findFirst({ where: eq(addresses.userId, user.id), orderBy: asc(addresses.createdAt) });
          if (next) await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, next.id));
        }
        return listFor(tx, user.id);
      }),
    };
  });
}
