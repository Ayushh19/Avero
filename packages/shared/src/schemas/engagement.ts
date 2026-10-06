import { z } from 'zod';
import { emailSchema } from './auth';
import type { ListingItemDto } from './catalog';

/* ---------------- reviews ---------------- */

export const REVIEW_FITS = ['small', 'true', 'large'] as const;
export type ReviewFit = (typeof REVIEW_FITS)[number];

const reviewFields = {
  rating: z.number().int().min(1, 'Choose a star rating').max(5),
  title: z.string().trim().min(3, 'Add a short title').max(80),
  body: z.string().trim().min(10, 'Tell other shoppers a little more (at least 10 characters)').max(2000),
  fit: z.enum(REVIEW_FITS).nullable().optional(),
};

/** Written against the order line the shopper received (gives product, colour and size). */
export const createReviewSchema = z.object({ orderItemId: z.uuid(), ...reviewFields });
export const updateReviewSchema = z.object(reviewFields).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const REVIEW_SORTS = ['recent', 'helpful', 'rating_high', 'rating_low'] as const;
export const reviewListQuerySchema = z.object({
  sort: z.enum(REVIEW_SORTS).default('recent'),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

export interface ReviewDto {
  id: string;
  rating: number;
  title: string;
  body: string;
  fit: ReviewFit | null;
  sizePurchased: string;
  colorName: string;
  /** "Riya S." */
  authorName: string;
  verified: true;
  helpfulCount: number;
  /** Signed-in viewer marked it helpful. */
  votedHelpful: boolean;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSummaryDto {
  average: number;
  count: number;
  /** count per star, index 0 = 1 star */
  distribution: [number, number, number, number, number];
  fit: { small: number; true: number; large: number };
}

export interface ReviewListDto {
  summary: ReviewSummaryDto;
  reviews: ReviewDto[];
  page: number;
  pageCount: number;
  /** Signed-in viewer can review this product now (order line to review against). */
  canReview: { orderItemId: string } | null;
  myReviewId: string | null;
}

export interface ReviewableItemDto {
  orderItemId: string;
  orderNumber: string;
  productName: string;
  productSlug: string;
  colorName: string;
  sizeLabel: string;
  imageUrl: string | null;
  href: string;
  deliveredAt: string | null;
}

export interface MyReviewDto extends ReviewDto {
  productName: string;
  productSlug: string;
  href: string;
  imageUrl: string | null;
}

/* ---------------- loyalty ---------------- */

export interface LedgerEntryDto {
  id: string;
  delta: number;
  kind: 'earn' | 'redeem' | 'reverse' | 'expire' | 'bonus' | 'referral' | 'refund_credit';
  status: 'pending' | 'available' | 'void';
  note: string | null;
  orderNumber: string | null;
  createdAt: string;
  availableAt: string | null;
  expiresAt: string | null;
}

export interface LoyaltyDto {
  balance: number;
  /** Earned on orders whose return window is still open. */
  pending: number;
  /** Points that will expire within 30 days if not used, soonest first. */
  expiringSoon: { points: number; on: string }[];
  /** Rupee value of 1 point, and the redemption cap, for display. */
  pointValuePaise: number;
  maxRedeemPercent: number;
  ledger: LedgerEntryDto[];
  /** Coupons issued to this member only (e.g. a referral welcome offer). */
  coupons: PersonalCouponDto[];
}

/* ---------------- referrals ---------------- */

export interface ReferralInviteDto {
  name: string;
  status: 'signed_up' | 'ordered' | 'rewarded' | 'void';
  joinedAt: string;
  rewardedAt: string | null;
}

export interface ReferralDto {
  code: string;
  link: string;
  offer: { refereeDiscountPaise: number; refereeMinOrderPaise: number; referrerRewardPoints: number };
  invites: ReferralInviteDto[];
  pointsEarned: number;
}

export interface ReferralCodeDto {
  valid: boolean;
  /** First name only. */
  referrerName: string | null;
  offer: { refereeDiscountPaise: number; refereeMinOrderPaise: number };
}

/** A coupon issued to this shopper only (e.g. referral welcome offer). */
export interface PersonalCouponDto {
  code: string;
  description: string;
  endsAt: string | null;
}

/* ---------------- alerts & recommendations ---------------- */

export const priceAlertSchema = z.object({
  colorwayId: z.uuid(),
  email: emailSchema.optional(),
});

export interface PersonalRowDto {
  key: 'picked_for_you' | 'wishlist_price_drops';
  title: string;
  items: ListingItemDto[];
}
