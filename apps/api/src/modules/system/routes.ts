import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { business } from '../../config/business';
import { googleEnabled } from '../../config/env';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/health', async () => {
    await ctx.db.execute(sql`select 1`);
    return { status: 'ok', time: ctx.clock.now().toISOString() };
  });

  /** Public configuration the web app needs for display. */
  app.get('/config', async () => ({
    currency: business.currency,
    freeShippingThresholdPaise: business.freeShippingThresholdPaise,
    shipping: business.shipping,
    returnWindowDays: business.returnWindowDays,
    points: {
      pointValuePaise: business.points.pointValuePaise,
      maxRedeemBps: business.points.maxRedeemBps,
    },
    auth: { googleEnabled: googleEnabled(ctx.env) },
    simulationTools: ctx.env.SIMULATION_TOOLS,
  }));
}
