CREATE TYPE "public"."auth_token_purpose" AS ENUM('verify_email', 'reset_password');--> statement-breakpoint
CREATE TYPE "public"."catalog_status" AS ENUM('draft', 'active', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."collection_kind" AS ENUM('manual', 'rule');--> statement-breakpoint
CREATE TYPE "public"."cart_status" AS ENUM('active', 'merged', 'converted');--> statement-breakpoint
CREATE TYPE "public"."stock_alert_kind" AS ENUM('back_in_stock', 'price_drop');--> statement-breakpoint
CREATE TYPE "public"."checkout_session_status" AS ENUM('open', 'order_placed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."order_item_status" AS ENUM('ACTIVE', 'CANCELLED', 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED', 'REFUNDED', 'EXCHANGE_REQUESTED', 'EXCHANGED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING_PAYMENT', 'PAYMENT_FAILED', 'EXPIRED', 'PAID', 'PAID_UNFULFILLABLE', 'CONFIRMED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('upi', 'card', 'netbanking');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."refund_destination" AS ENUM('original', 'points');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('INITIATED', 'PROCESSING', 'FAILED', 'FALLBACK_TO_POINTS', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."return_kind" AS ENUM('return', 'exchange');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('REQUESTED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'INSPECTED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."shipment_kind" AS ENUM('forward', 'return_pickup', 'exchange');--> statement-breakpoint
CREATE TYPE "public"."shipping_method" AS ENUM('standard', 'express');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('active', 'committed', 'released');--> statement-breakpoint
CREATE TYPE "public"."coupon_kind" AS ENUM('percent', 'flat', 'free_shipping');--> statement-breakpoint
CREATE TYPE "public"."coupon_redemption_status" AS ENUM('active', 'released');--> statement-breakpoint
CREATE TYPE "public"."points_kind" AS ENUM('earn', 'redeem', 'reverse', 'expire', 'bonus', 'referral', 'refund_credit');--> statement-breakpoint
CREATE TYPE "public"."points_status" AS ENUM('pending', 'available', 'void');--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('signed_up', 'ordered', 'rewarded', 'void');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('order', 'payment', 'refund', 'return', 'stock_alert', 'price_drop', 'review_prompt', 'points', 'referral', 'account');--> statement-breakpoint
CREATE TYPE "public"."review_fit" AS ENUM('small', 'true', 'large');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('published', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"landmark" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"pincode" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"name" text NOT NULL,
	"phone" text,
	"preferred_size" text,
	"referral_code" text NOT NULL,
	"referred_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_referralCode_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"collection_id" uuid NOT NULL,
	"colorway_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "collection_items_collection_id_colorway_id_pk" PRIMARY KEY("collection_id","colorway_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" "collection_kind" DEFAULT 'manual' NOT NULL,
	"rules" jsonb,
	"hero_image_url" text,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "colorway_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"colorway_id" uuid NOT NULL,
	"url" text NOT NULL,
	"alt" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer
);
--> statement-breakpoint
CREATE TABLE "colorways" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"external_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"color_family" text NOT NULL,
	"hex" text,
	"status" "catalog_status" DEFAULT 'draft' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "colorways_externalId_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sku_id" uuid NOT NULL,
	"old_price_paise" integer NOT NULL,
	"new_price_paise" integer NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category_id" uuid NOT NULL,
	"gender" text DEFAULT 'unisex' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"size_chart_id" uuid,
	"gst_rate_bps" integer DEFAULT 1800 NOT NULL,
	"is_final_sale" boolean DEFAULT false NOT NULL,
	"status" "catalog_status" DEFAULT 'draft' NOT NULL,
	"rating_avg" numeric(3, 2) DEFAULT '0' NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"fit_small_count" integer DEFAULT 0 NOT NULL,
	"fit_true_count" integer DEFAULT 0 NOT NULL,
	"fit_large_count" integer DEFAULT 0 NOT NULL,
	"sold_count" integer DEFAULT 0 NOT NULL,
	"launched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_externalId_unique" UNIQUE("external_id"),
	CONSTRAINT "products_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "size_charts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"rows" jsonb NOT NULL,
	"guidance" text,
	CONSTRAINT "size_charts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY NOT NULL,
	"colorway_id" uuid NOT NULL,
	"sku_code" text NOT NULL,
	"size_label" text NOT NULL,
	"size_sort" integer NOT NULL,
	"price_paise" integer NOT NULL,
	"mrp_paise" integer NOT NULL,
	"status" "catalog_status" DEFAULT 'draft' NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 5 NOT NULL,
	"max_per_order" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skus_skuCode_unique" UNIQUE("sku_code"),
	CONSTRAINT "skus_on_hand_nonneg" CHECK ("skus"."on_hand" >= 0),
	CONSTRAINT "skus_reserved_nonneg" CHECK ("skus"."reserved" >= 0),
	CONSTRAINT "skus_reserved_lte_on_hand" CHECK ("skus"."reserved" <= "skus"."on_hand"),
	CONSTRAINT "skus_price_positive" CHECK ("skus"."price_paise" > 0),
	CONSTRAINT "skus_price_lte_mrp" CHECK ("skus"."price_paise" <= "skus"."mrp_paise"),
	CONSTRAINT "skus_max_per_order_positive" CHECK ("skus"."max_per_order" > 0)
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cart_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"saved_for_later" boolean DEFAULT false NOT NULL,
	"price_seen_paise" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_qty_positive" CHECK ("cart_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"guest_token_hash" text,
	"status" "cart_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"coupon_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_owner_xor" CHECK (("carts"."user_id" IS NULL) <> ("carts"."guest_token_hash" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "recently_viewed" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"colorway_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"kind" "stock_alert_kind" NOT NULL,
	"sku_id" uuid,
	"colorway_id" uuid NOT NULL,
	"baseline_price_paise" integer,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"colorway_id" uuid NOT NULL,
	"sku_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cart_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text,
	"phone" text,
	"address" jsonb,
	"shipping_method" "shipping_method" DEFAULT 'standard' NOT NULL,
	"coupon_code" text,
	"points_to_redeem" integer DEFAULT 0 NOT NULL,
	"quote" jsonb,
	"quote_hash" text,
	"quote_expires_at" timestamp with time zone,
	"status" "checkout_session_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid,
	"type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"meta" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"product_slug" text NOT NULL,
	"colorway_id" uuid NOT NULL,
	"colorway_name" text NOT NULL,
	"colorway_slug" text NOT NULL,
	"size_label" text NOT NULL,
	"sku_code" text NOT NULL,
	"image_url" text,
	"is_final_sale" boolean DEFAULT false NOT NULL,
	"unit_price_paise" integer NOT NULL,
	"mrp_paise" integer NOT NULL,
	"qty" integer NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"points_discount_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" integer NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"status" "order_item_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_qty_positive" CHECK ("order_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"user_id" uuid,
	"checkout_session_id" uuid NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"status" "order_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"address" jsonb NOT NULL,
	"shipping_method" "shipping_method" NOT NULL,
	"subtotal_paise" integer NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"shipping_paise" integer DEFAULT 0 NOT NULL,
	"points_discount_paise" integer DEFAULT 0 NOT NULL,
	"points_redeemed" integer DEFAULT 0 NOT NULL,
	"total_paise" integer NOT NULL,
	"tax_paise" integer DEFAULT 0 NOT NULL,
	"coupon_code" text,
	"paid_paise" integer DEFAULT 0 NOT NULL,
	"refunded_paise" integer DEFAULT 0 NOT NULL,
	"guest_token_hash" text,
	"reservation_expires_at" timestamp with time zone,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expected_delivery_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"return_window_ends_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_orderNumber_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_checkoutSessionId_unique" UNIQUE("checkout_session_id"),
	CONSTRAINT "orders_refund_lte_paid" CHECK ("orders"."refunded_paise" <= "orders"."paid_paise"),
	CONSTRAINT "orders_amounts_nonneg" CHECK ("orders"."total_paise" >= 0 AND "orders"."paid_paise" >= 0 AND "orders"."refunded_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'CREATED' NOT NULL,
	"scenario" text,
	"failure_reason" text,
	"gateway_ref" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_gatewayRef_unique" UNIQUE("gateway_ref"),
	CONSTRAINT "payment_attempts_idempotencyKey_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payment_events_eventId_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"return_request_id" uuid,
	"amount_paise" integer NOT NULL,
	"points_amount" integer DEFAULT 0 NOT NULL,
	"destination" "refund_destination" DEFAULT 'original' NOT NULL,
	"status" "refund_status" DEFAULT 'INITIATED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"idempotency_key" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "refunds_amount_nonneg" CHECK ("refunds"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "return_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"return_request_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"reason" text NOT NULL,
	"comment" text,
	"exchange_sku_id" uuid
);
--> statement-breakpoint
CREATE TABLE "return_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rma_number" text NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" "return_kind" NOT NULL,
	"status" "return_status" DEFAULT 'REQUESTED' NOT NULL,
	"refund_destination" "refund_destination" DEFAULT 'original' NOT NULL,
	"replacement_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_requests_rmaNumber_unique" UNIQUE("rma_number")
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "shipment_kind" DEFAULT 'forward' NOT NULL,
	"carrier" text NOT NULL,
	"tracking_number" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_trackingNumber_unique" UNIQUE("tracking_number")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sku_id" uuid NOT NULL,
	"delta_on_hand" integer DEFAULT 0 NOT NULL,
	"delta_reserved" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sku_id" uuid NOT NULL,
	"order_id" uuid,
	"return_request_id" uuid,
	"qty" integer NOT NULL,
	"status" "reservation_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "reservations_qty_positive" CHECK ("inventory_reservations"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"coupon_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"status" "coupon_redemption_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_orderId_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" "coupon_kind" NOT NULL,
	"value" integer NOT NULL,
	"max_discount_paise" integer,
	"min_order_paise" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"usage_limit" integer,
	"per_user_limit" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"first_order_only" boolean DEFAULT false NOT NULL,
	"eligible_category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"eligible_collection_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"restricted_to_user_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code"),
	CONSTRAINT "coupons_usage_within_limit" CHECK ("coupons"."usage_limit" IS NULL OR "coupons"."used_count" <= "coupons"."usage_limit"),
	CONSTRAINT "coupons_used_nonneg" CHECK ("coupons"."used_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "points_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"kind" "points_kind" NOT NULL,
	"status" "points_status" NOT NULL,
	"order_id" uuid,
	"note" text,
	"available_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"referee_user_id" uuid NOT NULL,
	"status" "referral_status" DEFAULT 'signed_up' NOT NULL,
	"qualifying_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rewarded_at" timestamp with time zone,
	CONSTRAINT "referrals_refereeUserId_unique" UNIQUE("referee_user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT true NOT NULL,
	CONSTRAINT "notification_preferences_user_id_kind_pk" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_votes" (
	"review_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_votes_review_id_user_id_pk" PRIMARY KEY("review_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"colorway_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"fit" "review_fit",
	"size_purchased" text NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"status" "review_status" DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "app_clock" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"offset_ms" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"dedupe_key" text,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"result_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sent_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"template" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_user_id_users_id_fk" FOREIGN KEY ("referred_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_colorway_id_colorways_id_fk" FOREIGN KEY ("colorway_id") REFERENCES "public"."colorways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colorway_images" ADD CONSTRAINT "colorway_images_colorway_id_colorways_id_fk" FOREIGN KEY ("colorway_id") REFERENCES "public"."colorways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colorways" ADD CONSTRAINT "colorways_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_size_chart_id_size_charts_id_fk" FOREIGN KEY ("size_chart_id") REFERENCES "public"."size_charts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_colorway_id_colorways_id_fk" FOREIGN KEY ("colorway_id") REFERENCES "public"."colorways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recently_viewed" ADD CONSTRAINT "recently_viewed_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recently_viewed" ADD CONSTRAINT "recently_viewed_colorway_id_colorways_id_fk" FOREIGN KEY ("colorway_id") REFERENCES "public"."colorways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_colorway_id_colorways_id_fk" FOREIGN KEY ("colorway_id") REFERENCES "public"."colorways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_colorway_id_colorways_id_fk" FOREIGN KEY ("colorway_id") REFERENCES "public"."colorways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_exchange_sku_id_skus_id_fk" FOREIGN KEY ("exchange_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_replacement_order_id_orders_id_fk" FOREIGN KEY ("replacement_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_restricted_to_user_id_users_id_fk" FOREIGN KEY ("restricted_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_user_id_users_id_fk" FOREIGN KEY ("referee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_qualifying_order_id_orders_id_fk" FOREIGN KEY ("qualifying_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_colorway_id_colorways_id_fk" FOREIGN KEY ("colorway_id") REFERENCES "public"."colorways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_user_idx" ON "addresses" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_one_default_uq" ON "addresses" USING btree ("user_id") WHERE "addresses"."is_default";--> statement-breakpoint
CREATE INDEX "auth_tokens_user_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_provider_account_uq" ON "oauth_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_user_provider_uq" ON "oauth_accounts" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "colorway_images_colorway_idx" ON "colorway_images" USING btree ("colorway_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "colorways_product_slug_uq" ON "colorways" USING btree ("product_id","slug");--> statement-breakpoint
CREATE INDEX "price_history_sku_idx" ON "price_history" USING btree ("sku_id","changed_at");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "skus_colorway_idx" ON "skus" USING btree ("colorway_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_colorway_size_uq" ON "skus" USING btree ("colorway_id","size_label");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_sku_uq" ON "cart_items" USING btree ("cart_id","sku_id","saved_for_later");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_active_user_uq" ON "carts" USING btree ("user_id") WHERE "carts"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "carts_guest_token_uq" ON "carts" USING btree ("guest_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "recently_viewed_user_colorway_uq" ON "recently_viewed" USING btree ("user_id","colorway_id");--> statement-breakpoint
CREATE INDEX "recently_viewed_user_time_idx" ON "recently_viewed" USING btree ("user_id","viewed_at");--> statement-breakpoint
CREATE INDEX "stock_alerts_pending_idx" ON "stock_alerts" USING btree ("colorway_id","kind") WHERE "stock_alerts"."notified_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wishlist_user_colorway_uq" ON "wishlist_items" USING btree ("user_id","colorway_id");--> statement-breakpoint
CREATE INDEX "checkout_sessions_cart_idx" ON "checkout_sessions" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","placed_at");--> statement-breakpoint
CREATE INDEX "orders_email_idx" ON "orders" USING btree ("email");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_attempts_order_idx" ON "payment_attempts" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_one_success_uq" ON "payment_attempts" USING btree ("order_id") WHERE "payment_attempts"."status" = 'SUCCEEDED';--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_items_order_item_uq" ON "return_items" USING btree ("return_request_id","order_item_id");--> statement-breakpoint
CREATE INDEX "return_requests_order_idx" ON "return_requests" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_sku_idx" ON "inventory_movements" USING btree ("sku_id","created_at");--> statement-breakpoint
CREATE INDEX "reservations_order_idx" ON "inventory_reservations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "reservations_active_expiry_idx" ON "inventory_reservations" USING btree ("expires_at") WHERE "inventory_reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "coupon_redemptions_coupon_email_idx" ON "coupon_redemptions" USING btree ("coupon_id","email");--> statement-breakpoint
CREATE INDEX "points_ledger_user_idx" ON "points_ledger" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "points_ledger_earn_per_order_uq" ON "points_ledger" USING btree ("order_id","kind") WHERE "points_ledger"."kind" IN ('earn', 'redeem');--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_user_product_uq" ON "reviews" USING btree ("user_id","product_id");--> statement-breakpoint
CREATE INDEX "reviews_product_idx" ON "reviews" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_key_uq" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_pending_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "search_queries_time_idx" ON "search_queries" USING btree ("created_at");