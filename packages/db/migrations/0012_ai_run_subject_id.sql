ALTER TABLE "ai_runs" ADD COLUMN "subject_id" text;--> statement-breakpoint
CREATE INDEX "ai_runs_subject_idx" ON "ai_runs" USING btree ("org_id","subject_id");
