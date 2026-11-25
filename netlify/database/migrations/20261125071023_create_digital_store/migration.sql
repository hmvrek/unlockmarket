CREATE TYPE "product_category" AS ENUM('license', 'addon', 'other');--> statement-breakpoint
CREATE TYPE "order_status" AS ENUM('new', 'confirmed', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY,
	"email" text NOT NULL,
	"items" jsonb NOT NULL,
	"total_grosz" integer NOT NULL,
	"status" "order_status" DEFAULT 'new'::"order_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stripe_session_id" text,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "order_total_positive" CHECK ("total_grosz" > 0),
	CONSTRAINT "orders_payment_status_check" CHECK ("payment_status" IN ('unpaid', 'paid', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" "product_category" NOT NULL,
	"price_grosz" integer NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_price_range" CHECK ("price_grosz" between 1 and 999999)
);
--> statement-breakpoint
CREATE TABLE "activation_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
	"code" text NOT NULL,
	"code_hash" text NOT NULL,
	"reserved_order_id" uuid,
	"reservation_expires_at" timestamp with time zone,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_code_reservation_pair" CHECK (("reserved_order_id" IS NULL) = ("reservation_expires_at" IS NULL)),
	CONSTRAINT "activation_code_not_reserved_and_sold" CHECK ("reserved_order_id" IS NULL OR "order_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_stripe_session_unique_idx" ON "orders" ("stripe_session_id") WHERE "stripe_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "products_catalog_idx" ON "products" ("published","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "activation_codes_code_hash_unique_idx" ON "activation_codes" ("code_hash");--> statement-breakpoint
CREATE INDEX "activation_codes_product_available_idx" ON "activation_codes" ("product_id","created_at") WHERE "order_id" IS NULL;--> statement-breakpoint
CREATE INDEX "activation_codes_reservation_idx" ON "activation_codes" ("reserved_order_id") WHERE "reserved_order_id" IS NOT NULL;
