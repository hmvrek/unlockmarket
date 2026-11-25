CREATE TYPE "product_category" AS ENUM('license', 'addon', 'other');--> statement-breakpoint
CREATE TYPE "order_status" AS ENUM('new', 'confirmed', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY,
	"email" text NOT NULL,
	"items" jsonb NOT NULL,
	"total_grosz" integer NOT NULL,
	"status" "order_status" DEFAULT 'new'::"order_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_total_positive" CHECK ("total_grosz" > 0)
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
CREATE INDEX "orders_created_at_idx" ON "orders" ("created_at");--> statement-breakpoint
CREATE INDEX "products_catalog_idx" ON "products" ("published","created_at");