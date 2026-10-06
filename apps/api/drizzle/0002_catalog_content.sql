ALTER TABLE "colorway_images" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "colorway_images" ADD COLUMN "thumb_url" text;--> statement-breakpoint
ALTER TABLE "colorway_images" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "colorways" ADD COLUMN "search_document" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "short_description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "highlights" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "colorways_search_trgm_idx" ON "colorways" USING gin ("search_document" gin_trgm_ops);