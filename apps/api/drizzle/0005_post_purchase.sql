CREATE TYPE "public"."order_kind" AS ENUM('sale', 'exchange');--> statement-breakpoint
CREATE TABLE "gateway_sim_refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_key" text NOT NULL,
	"gateway_ref" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_sim_refunds_requestKey_unique" UNIQUE("request_key")
);
--> statement-breakpoint
CREATE TABLE "gateway_sim_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"refund_failures_remaining" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "checkout_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "kind" "order_kind" DEFAULT 'sale' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "parent_order_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "reason" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "payment_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_parent_order_id_orders_id_fk" FOREIGN KEY ("parent_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Refund rows written before this migration carry their reason in the idempotency key prefix.
UPDATE "refunds" SET "reason" = replace(split_part("idempotency_key", ':', 1), '-', '_') WHERE "reason" = 'other';
