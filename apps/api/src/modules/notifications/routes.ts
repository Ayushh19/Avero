import { markNotificationsReadSchema, notificationPreferencesSchema } from '@avero/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../plugins/session';
import * as service from './service';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/notifications', async (req) => {
    const user = requireUser(req);
    const { cursor } = z.object({ cursor: z.iso.datetime().optional() }).parse(req.query);
    return service.listNotifications(ctx, user.id, cursor);
  });

  app.post('/notifications/read', async (req) => {
    const user = requireUser(req);
    const body = markNotificationsReadSchema.parse(req.body);
    return service.markRead(ctx, user.id, 'all' in body ? 'all' : body.ids);
  });

  app.get('/notifications/preferences', async (req) => ({ preferences: await service.getPreferences(ctx.db, requireUser(req).id) }));

  app.put('/notifications/preferences', async (req) => {
    const user = requireUser(req);
    const { preferences } = notificationPreferencesSchema.parse(req.body);
    return { preferences: await service.setPreferences(ctx, user.id, preferences) };
  });
}
