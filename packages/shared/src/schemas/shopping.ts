import { z } from 'zod';
import { indianPhoneSchema, passwordSchema } from './auth';
import type { ImageDto, ListingItemDto } from './catalog';

/* ---------------- bag ---------------- */

export const addToCartSchema = z.object({
  skuId: z.uuid(),
  qty: z.number().int().min(1).max(10).default(1),
});

export const updateCartItemSchema = z
  .object({
    qty: z.number().int().min(1).max(10).optional(),
    savedForLater: z.boolean().optional(),
    /** Optimistic concurrency: reject if the bag changed elsewhere since the client last saw it. */
    expectedVersion: z.number().int().positive().optional(),
  })
  .refine((v) => v.qty !== undefined || v.savedForLater !== undefined, 'Nothing to update');

/**
 * Why a bag line needs attention. `blocking` issues exclude the line from totals and checkout.
 * - unavailable: discontinued product / colour / size
 * - out_of_stock: no units left
 * - insufficient_stock: fewer units left than requested (line counted at `maxQty`)
 * - price_changed: informational, price differs from when it was added
 */
export type CartLineIssue =
  | { type: 'unavailable'; blocking: true }
  | { type: 'out_of_stock'; blocking: true }
  | { type: 'insufficient_stock'; blocking: false; maxQty: number }
  | { type: 'price_changed'; blocking: false; fromPaise: number; toPaise: number };

export interface CartLineDto {
  id: string;
  skuId: string;
  skuCode: string;
  productName: string;
  productSlug: string;
  colorwayId: string;
  colorName: string;
  sizeLabel: string;
  href: string;
  image: ImageDto | null;
  qty: number;
  /** Max this line can be set to right now (stock and per-order limit). */
  maxQty: number;
  unitPricePaise: number;
  mrpPaise: number;
  lineTotalPaise: number;
  savedForLater: boolean;
  stockState: 'available' | 'low' | 'unavailable';
  issues: CartLineIssue[];
}

export interface CartTotalsDto {
  itemCount: number;
  subtotalPaise: number;
  /** MRP savings on in-bag items (shown as "You save"). */
  savingsPaise: number;
  shippingPaise: number;
  freeShippingThresholdPaise: number;
  /** Amount still needed for free shipping, 0 if already free. */
  freeShippingRemainingPaise: number;
  totalPaise: number;
  taxIncludedPaise: number;
}

export interface CartDto {
  id: string | null;
  version: number;
  lines: CartLineDto[];
  savedForLater: CartLineDto[];
  totals: CartTotalsDto;
  /** True when any in-bag line has a blocking issue (checkout disabled until resolved). */
  hasBlockingIssues: boolean;
}

export interface CartMutationResponse {
  cart: CartDto;
  /** Human-readable adjustments made by the server, e.g. quantity clamped to stock. */
  notice?: string;
}

/* ---------------- wishlist ---------------- */

export interface WishlistItemDto extends ListingItemDto {
  addedAt: string;
  /** Price when added — lets the UI show "Price dropped". */
  addedPricePaise: number | null;
}

export const wishlistMergeSchema = z.object({ colorwayIds: z.array(z.uuid()).max(100) });

export const stockAlertSchema = z.object({
  skuId: z.uuid(),
  email: z.email().optional(),
});

/* ---------------- recently viewed ---------------- */

export const recentlyViewedSchema = z.object({ colorwayIds: z.array(z.uuid()).min(1).max(20) });

/* ---------------- addresses ---------------- */

export const INDIAN_STATES = [
  'Andaman & Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra & Nagar Haveli and Daman & Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu & Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
] as const;

export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');

export const addressSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the recipient’s full name').max(80),
  phone: indianPhoneSchema,
  line1: z.string().trim().min(3, 'Enter house / flat and building').max(120),
  line2: z.string().trim().max(120).optional(),
  landmark: z.string().trim().max(80).optional(),
  city: z.string().trim().min(2, 'Enter a city').max(60),
  state: z.enum(INDIAN_STATES, { message: 'Choose a state' }),
  pincode: pincodeSchema,
  isDefault: z.boolean().optional(),
});
export type AddressInput = z.infer<typeof addressSchema>;

export interface AddressDto extends Omit<AddressInput, 'isDefault'> {
  id: string;
  isDefault: boolean;
  /** False when our (simulated) courier network doesn't reach the PIN code. */
  serviceable: boolean;
}

/* ---------------- profile ---------------- */

export const UK_SIZES = ['3', '4', '5', '6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10', '11', '12'] as const;

export const profileSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80),
  phone: indianPhoneSchema.nullable().optional(),
  preferredSize: z.enum(UK_SIZES).nullable().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(128).optional(),
  newPassword: passwordSchema,
});
