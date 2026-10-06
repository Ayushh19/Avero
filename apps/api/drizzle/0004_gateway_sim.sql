CREATE TYPE "public"."gateway_sim_charge_status" AS ENUM('created', 'processing', 'succeeded', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "gateway_sim_charges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gateway_ref" text NOT NULL,
	"merchant_reference" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "gateway_sim_charge_status" DEFAULT 'created' NOT NULL,
	"scenario" text,
	"failure_reason" text,
	"resolve_at" timestamp with time zone,
	"late_after" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_sim_charges_gatewayRef_unique" UNIQUE("gateway_ref")
);
