ALTER TABLE "events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "events_pending_idx" ON "events" USING btree ("relayed_at","dead_lettered_at","occurred_at");