CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" varchar(64) NOT NULL,
	"subject" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"event_id" varchar(64),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE read_at is null;