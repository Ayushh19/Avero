/** All money is integer paise. These helpers never use floating point for arithmetic on amounts. */

export type Paise = number;

export function assertPaise(value: number): asserts value is Paise {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid paise amount: ${value}`);
}

export function rupees(amount: number): Paise {
  return Math.round(amount * 100);
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** ₹4,999 or ₹4,999.50 */
export function formatINR(paise: Paise): string {
  return inrFormatter.format(paise / 100);
}

/** Percentage of `amount` expressed in basis points (1% = 100 bps), rounded half-up. */
export function percentOf(amount: Paise, bps: number): Paise {
  return Math.floor((amount * bps + 5000) / 10000);
}

/**
 * Splits `total` across `weights` proportionally so the parts sum exactly to `total`
 * (largest-remainder method). Used to allocate order-level discounts to lines.
 */
export function allocate(total: Paise, weights: readonly number[]): Paise[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (weightSum === 0) return weights.map((_, i) => (i === 0 ? total : 0));

  const raw = weights.map((w) => (total * w) / weightSum);
  const parts = raw.map(Math.floor);
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) {
    parts[order[k]!.i]! += 1;
  }
  return parts;
}

/** GST contained in a GST-inclusive amount. */
export function includedGst(inclusive: Paise, rateBps: number): Paise {
  return Math.round((inclusive * rateBps) / (10000 + rateBps));
}
