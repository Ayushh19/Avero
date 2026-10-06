import { addToCartSchema, updateCartItemSchema, type CartMutationResponse } from '@avero/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import * as cart from './service';

const idParam = z.object({ id: z.uuid() });

export async function cartRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/cart', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { cart: await cart.buildCartDto(ctx, await cart.resolveCart(ctx, req, null, false)) };
  });

  app.post('/cart/items', async (req, reply): Promise<CartMutationResponse> => {
    const { skuId, qty } = addToCartSchema.parse(req.body);
    const row = await cart.resolveCart(ctx, req, reply, true);
    return cart.addItem(ctx, row!, skuId, qty);
  });

  app.patch('/cart/items/:id', async (req, reply): Promise<CartMutationResponse> => {
    const { id } = idParam.parse(req.params);
    const patch = updateCartItemSchema.parse(req.body);
    const row = await cart.resolveCart(ctx, req, reply, false);
    if (!row) throw new AppError('NOT_FOUND', 'Your bag is empty');
    try {
      return await cart.updateItem(ctx, row, id, patch);
    } catch (err) {
      // Hand the client the current bag so it can re-render without another round trip.
      if (err instanceof AppError && err.code === 'CART_VERSION_CONFLICT') {
        throw new AppError(err.code, err.message, { cart: await cart.buildCartDto(ctx, row) });
      }
      throw err;
    }
  });

  app.delete('/cart/items/:id', async (req): Promise<CartMutationResponse> => {
    const { id } = idParam.parse(req.params);
    const row = await cart.resolveCart(ctx, req, null, false);
    if (!row) throw new AppError('NOT_FOUND', 'Your bag is empty');
    return cart.removeItem(ctx, row, id);
  });

  app.post('/cart/acknowledge-prices', async (req): Promise<CartMutationResponse> => {
    const row = await cart.resolveCart(ctx, req, null, false);
    return row ? cart.acknowledgePrices(ctx, row) : { cart: await cart.buildCartDto(ctx, null) };
  });
}
