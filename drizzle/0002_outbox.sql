CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"aggregate_type" varchar(64) NOT NULL,
	"aggregate_id" varchar(64) NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"event_id" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp (3) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"dead_lettered_at" timestamp (3) with time zone,
	CONSTRAINT "outbox_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "outbox_attempts_nonnegative" CHECK ("outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"consumer_group" varchar(128) NOT NULL,
	"event_id" varchar(64) NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"processed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_consumer_group_event_id_pk" PRIMARY KEY("consumer_group","event_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("available_at","id") WHERE published_at is null;--> statement-breakpoint
CREATE INDEX "outbox_dead_letter_idx" ON "outbox" USING btree ("dead_lettered_at") WHERE dead_lettered_at is not null;--> statement-breakpoint
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events" USING btree ("processed_at");