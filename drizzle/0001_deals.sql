CREATE TYPE "public"."deal_stage" AS ENUM('sourced', 'screening', 'diligence', 'negotiation', 'closed_won', 'closed_lost');--> statement-breakpoint
CREATE TABLE "deals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"company" varchar(200) NOT NULL,
	"stage" "deal_stage" DEFAULT 'sourced' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp (3) with time zone,
	CONSTRAINT "deals_amount_nonnegative" CHECK ("deals"."amount_cents" >= 0),
	CONSTRAINT "deals_currency_iso" CHECK ("deals"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "deals_closed_at_matches_stage" CHECK (("deals"."stage" in ('closed_won', 'closed_lost')) = ("deals"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "deals_created_at_id_idx" ON "deals" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deals_owner_created_id_idx" ON "deals" USING btree ("owner_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deals_open_created_idx" ON "deals" USING btree ("stage","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE closed_at is null;