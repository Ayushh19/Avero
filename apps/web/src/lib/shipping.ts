import { formatINR } from '@avero/shared';

/**
 * Shopper-facing delivery promise, from the server's free-shipping threshold
 * (0 = standard delivery free on every order).
 */
export function deliveryPromise(thresholdPaise: number | undefined): { headline: string; title: string; body: string } {
  if (thresholdPaise === undefined || thresholdPaise <= 0) {
    return { headline: 'Free delivery on all orders', title: 'Free delivery', body: 'On every order, no minimum' };
  }
  return {
    headline: `Free shipping on orders over ${formatINR(thresholdPaise)}`,
    title: 'Free shipping',
    body: `On orders over ${formatINR(thresholdPaise)}`,
  };
}
