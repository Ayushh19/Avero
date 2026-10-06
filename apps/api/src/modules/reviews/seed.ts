import { and, asc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Db, Tx } from '../../db/client';
import { colorwayImages, colorways, orderItems, orders, products, reviewVotes, reviews, skus, users, type AddressSnapshot } from '../../db/schema';
import type { SimulatedClock } from '../../lib/clock';
import { addDays } from '../../lib/clock';
import { randomCode } from '../../lib/crypto';
import { orderNumber } from '../checkout/service';
import { recomputeAggregates } from './service';

/**
 * Sample reviews for a fresh catalogue. Reviews on AVERO are always verified, so each one is
 * written by a fictional reviewer account against a past delivered order of that product
 * (one item per order — no effect on "frequently bought together"). Deterministic per product,
 * idempotent: products that already have seeded reviews are skipped.
 */

const REVIEWER_DOMAIN = 'reviewers.avero.local';

const REVIEWERS: { name: string; city: string; state: string; pincode: string }[] = [
  { name: 'Ananya Iyer', city: 'Chennai', state: 'Tamil Nadu', pincode: '600040' },
  { name: 'Rohan Mehta', city: 'Mumbai', state: 'Maharashtra', pincode: '400053' },
  { name: 'Priya Sharma', city: 'New Delhi', state: 'Delhi', pincode: '110017' },
  { name: 'Karthik Reddy', city: 'Hyderabad', state: 'Telangana', pincode: '500034' },
  { name: 'Sneha Kulkarni', city: 'Pune', state: 'Maharashtra', pincode: '411038' },
  { name: 'Aditya Bose', city: 'Kolkata', state: 'West Bengal', pincode: '700019' },
  { name: 'Meera Pillai', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
  { name: 'Vikram Singh', city: 'Jaipur', state: 'Rajasthan', pincode: '302017' },
  { name: 'Ishita Ghosh', city: 'Ahmedabad', state: 'Gujarat', pincode: '380015' },
  { name: 'Nikhil Verma', city: 'Lucknow', state: 'Uttar Pradesh', pincode: '226010' },
];

type Fit = 'small' | 'true' | 'large';
interface Template {
  rating: number;
  fit: Fit | null;
  title: string;
  body: string;
}

/** Product-agnostic but footwear-specific; mostly positive with honest mixed ones. */
const TEMPLATES: Template[] = [
  { rating: 5, fit: 'true', title: 'Comfortable from day one', body: 'No break-in period at all. I wore them for a full day of walking around the city and my feet felt great in the evening.' },
  { rating: 5, fit: 'true', title: 'My new everyday pair', body: 'Light, breathable and they go with almost everything. I have been reaching for these every morning since they arrived.' },
  { rating: 4, fit: 'small', title: 'Lovely, but size up', body: 'Really like the look and the cushioning. They run a little snug in the toe box, so I would go half a size up if you are between sizes.' },
  { rating: 5, fit: 'true', title: 'Great cushioning', body: 'The sole has a nice bounce without feeling unstable. Did a few 5k runs and a long day on my feet — no soreness.' },
  { rating: 4, fit: 'true', title: 'Good value', body: 'Well made for the price. Stitching is neat and the insole is comfortable. Took one star off because the laces are a bit short.' },
  { rating: 3, fit: 'large', title: 'Nice shoe, roomy fit', body: 'Looks exactly like the photos and feels comfortable, but they run slightly large. With thicker socks they are fine.' },
  { rating: 5, fit: null, title: 'Exactly as pictured', body: 'Colour is true to the photos and the finish feels premium. Delivery was quick and the box was well packed.' },
  { rating: 4, fit: 'true', title: 'Breathable in the heat', body: 'Wore these through a humid week and my feet stayed cool. The upper is soft and doesn’t rub at the heel.' },
  { rating: 2, fit: 'small', title: 'Too narrow for me', body: 'Quality looks good, but they were too narrow for my wide feet even after a few days. Might work for narrower feet.' },
  { rating: 5, fit: 'true', title: 'Second pair already', body: 'Bought a pair a few months ago and they held up so well that I came back for another colour.' },
  { rating: 4, fit: 'true', title: 'Smart and comfortable', body: 'Works with jeans and chinos, and I can wear them to the office on casual days. Comfortable for long commutes.' },
  { rating: 3, fit: 'true', title: 'Decent, sole is firm', body: 'Fits well and looks good. The sole is firmer than I expected; it softened slightly after a couple of weeks.' },
];

/** Small deterministic PRNG (mulberry32) seeded from a string. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const emailFor = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${REVIEWER_DOMAIN}`;

async function ensureReviewers(tx: Tx, now: Date): Promise<(typeof users.$inferSelect)[]> {
  const out: (typeof users.$inferSelect)[] = [];
  for (const r of REVIEWERS) {
    const email = emailFor(r.name);
    let user = await tx.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({ email, name: r.name, passwordHash: null, emailVerifiedAt: now, referralCode: `RV${randomCode(6)}`, createdAt: addDays(now, -400) })
        .returning();
    }
    out.push(user!);
  }
  return out;
}

export interface SeedReport {
  products: number;
  reviews: number;
  skipped: number;
}

export async function seedReviews(db: Db, clock: SimulatedClock): Promise<SeedReport> {
  const now = clock.now();
  const report: SeedReport = { products: 0, reviews: 0, skipped: 0 };
  const all = await db.query.products.findMany({ where: eq(products.status, 'active'), orderBy: asc(products.createdAt) });

  for (const product of all) {
    await db.transaction(async (tx) => {
      const reviewers = await ensureReviewers(tx, now);
      const already = await tx
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.productId, product.id), inArray(reviews.userId, reviewers.map((u) => u.id))))
        .limit(1);
      if (already.length) {
        report.skipped++;
        return;
      }
      const cws = await tx.query.colorways.findMany({ where: and(eq(colorways.productId, product.id), eq(colorways.status, 'active')) });
      const options = cws.length
        ? await tx.select({ sku: skus, colorway: colorways }).from(skus).innerJoin(colorways, eq(colorways.id, skus.colorwayId)).where(inArray(skus.colorwayId, cws.map((c) => c.id)))
        : [];
      if (options.length === 0) {
        report.skipped++;
        return;
      }
      const images = await tx.query.colorwayImages.findMany({ where: and(inArray(colorwayImages.colorwayId, cws.map((c) => c.id)), eq(colorwayImages.position, 0)) });

      const rand = rng(product.slug);
      const count = 4 + Math.floor(rand() * 4); // 4–7
      const people = [...reviewers].sort(() => rand() - 0.5).slice(0, count);
      const pool = [...TEMPLATES].sort(() => rand() - 0.5);
      const created: string[] = [];

      for (const [i, person] of people.entries()) {
        const t = pool[i % pool.length]!;
        const pick = options[Math.floor(rand() * options.length)]!;
        const reviewedAt = addDays(now, -(7 + Math.floor(rand() * 170)));
        const placedAt = addDays(reviewedAt, -(8 + Math.floor(rand() * 6)));
        const deliveredAt = addDays(placedAt, 4);
        const meta = REVIEWERS.find((r) => r.name === person.name)!;
        const address: AddressSnapshot = { fullName: person.name, phone: '+919000000000', line1: 'Sample address', line2: null, landmark: null, city: meta.city, state: meta.state, pincode: meta.pincode };
        const orderId = uuidv7();
        await tx.insert(orders).values({
          id: orderId,
          orderNumber: `${orderNumber(placedAt).slice(0, 8)}${randomCode(5)}`,
          userId: person.id,
          checkoutSessionId: null,
          email: person.email,
          phone: '+919000000000',
          status: 'DELIVERED',
          address,
          shippingMethod: 'standard',
          subtotalPaise: pick.sku.pricePaise,
          totalPaise: pick.sku.pricePaise,
          paidPaise: pick.sku.pricePaise,
          placedAt,
          deliveredAt,
          expectedDeliveryAt: deliveredAt,
          returnWindowEndsAt: addDays(deliveredAt, 15),
          createdAt: placedAt,
        });
        const image = images.find((im) => im.colorwayId === pick.colorway.id);
        const [item] = await tx
          .insert(orderItems)
          .values({
            orderId,
            skuId: pick.sku.id,
            productId: product.id,
            productName: product.name,
            productSlug: product.slug,
            colorwayId: pick.colorway.id,
            colorwayName: pick.colorway.name,
            colorwaySlug: pick.colorway.slug,
            sizeLabel: pick.sku.sizeLabel,
            skuCode: pick.sku.skuCode,
            imageUrl: image?.thumbUrl ?? image?.url ?? null,
            unitPricePaise: pick.sku.pricePaise,
            mrpPaise: pick.sku.mrpPaise,
            qty: 1,
            totalPaise: pick.sku.pricePaise,
            gstRateBps: product.gstRateBps,
            status: 'DELIVERED',
          })
          .returning();
        const [rev] = await tx
          .insert(reviews)
          .values({
            productId: product.id,
            colorwayId: pick.colorway.id,
            userId: person.id,
            orderItemId: item!.id,
            rating: t.rating,
            title: t.title,
            body: t.body,
            fit: t.fit,
            sizePurchased: pick.sku.sizeLabel,
            createdAt: reviewedAt,
            updatedAt: reviewedAt,
          })
          .returning();
        created.push(rev!.id);
        report.reviews++;
      }

      // Helpful votes from other reviewers (kept consistent with helpful_count).
      for (const id of created) {
        const author = (await tx.query.reviews.findFirst({ where: eq(reviews.id, id) }))!.userId;
        const voters = reviewers.filter((u) => u.id !== author && rand() < 0.35);
        for (const v of voters) await tx.insert(reviewVotes).values({ reviewId: id, userId: v.id }).onConflictDoNothing();
        await tx.update(reviews).set({ helpfulCount: voters.length }).where(eq(reviews.id, id));
      }
      await recomputeAggregates(tx, product.id);
      report.products++;
    });
  }
  return report;
}
