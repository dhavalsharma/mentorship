CREATE TABLE "action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pairing_id" uuid NOT NULL,
	"session_id" uuid,
	"owner_participant_id" uuid NOT NULL,
	"text" text NOT NULL,
	"due_at" timestamp with time zone,
	"state" text DEFAULT 'open' NOT NULL,
	"evidence" jsonb
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pairing_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"options" jsonb NOT NULL,
	"participant_ids" jsonb NOT NULL,
	"responses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"resolution" text,
	"timeout_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"primitive" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric,
	"latency_ms" integer,
	"verdict" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_ref" text,
	"action" text NOT NULL,
	"subject_ref" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"prompt_version" text
);
--> statement-breakpoint
CREATE TABLE "cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"program_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"cadence_override" jsonb
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"participant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"granted" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"evidence" text
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"subject_ref" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relayed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"source_note_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"prompt_version" text,
	"confirmed_by" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"score" integer,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "goal_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"goal_id" uuid NOT NULL,
	"session_id" uuid,
	"direction" text NOT NULL,
	"note" text,
	"evidence" jsonb
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pairing_id" uuid NOT NULL,
	"mentee_participant_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"measure" text,
	"baseline" text,
	"target" text,
	"horizon_at" timestamp with time zone,
	"state" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slot" text NOT NULL,
	"adapter_id" text NOT NULL,
	"credentials_ref" text,
	"capabilities" jsonb,
	"probed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "match_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"mentor_participant_id" uuid NOT NULL,
	"mentee_participant_id" uuid NOT NULL,
	"score" real NOT NULL,
	"features" jsonb NOT NULL,
	"explanation" text,
	"caveats" jsonb,
	"prompt_version" text
);
--> statement-breakpoint
CREATE TABLE "nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pairing_id" uuid,
	"recipient_participant_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"dropped_reason" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"mentor_participant_id" uuid NOT NULL,
	"mentee_participant_id" uuid NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"origin" text NOT NULL,
	"pair_key" text NOT NULL,
	"cadence_override" jsonb,
	"thread_ref" jsonb,
	"document_ref" text,
	"last_session_at" timestamp with time zone,
	"import_file_hash" text,
	"notes" text,
	"ended_reason" text
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"capacity" integer,
	"state" text DEFAULT 'enrolled' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"participant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"value" jsonb NOT NULL,
	"embedding" text
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"policy" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"file_hash" text NOT NULL,
	"file_name" text,
	"uploaded_by" uuid,
	"plan" jsonb NOT NULL,
	"committed_at" timestamp with time zone,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "saga_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saga_name" text NOT NULL,
	"subject_ref" text NOT NULL,
	"state" jsonb NOT NULL,
	"awaiting_event" jsonb,
	"timeout_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"completed_effects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"author_participant_id" uuid,
	"external_ref" text,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pairing_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"source" text DEFAULT 'calendar' NOT NULL,
	"calendar_adapter_id" text,
	"calendar_event_id" text,
	"conference_url" text,
	"transcription_enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject_ref" text NOT NULL,
	"kind" text NOT NULL,
	"value" numeric NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"tz_offset_minutes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "action_items_open_idx" ON "action_items" USING btree ("org_id","pairing_id","state");--> statement-breakpoint
CREATE INDEX "ai_runs_primitive_idx" ON "ai_runs" USING btree ("org_id","primitive","created_at");--> statement-breakpoint
CREATE INDEX "audit_subject_idx" ON "audit_log" USING btree ("org_id","subject_ref","created_at");--> statement-breakpoint
CREATE INDEX "cohorts_program_idx" ON "cohorts" USING btree ("org_id","program_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_unique" ON "consents" USING btree ("org_id","participant_id","kind");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("org_id","subject_ref","occurred_at");--> statement-breakpoint
CREATE INDEX "events_relay_idx" ON "events" USING btree ("relayed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_unique" ON "feedback" USING btree ("org_id","session_id","participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_unique" ON "identity_links" USING btree ("org_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "identity_links_user_idx" ON "identity_links" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_bindings_slot" ON "integration_bindings" USING btree ("org_id","slot");--> statement-breakpoint
CREATE INDEX "match_candidates_cohort_idx" ON "match_candidates" USING btree ("org_id","cohort_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nudges_dedupe_unique" ON "nudges" USING btree ("org_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pairings_pair_key_unique" ON "pairings" USING btree ("org_id","cohort_id","pair_key");--> statement-breakpoint
CREATE INDEX "pairings_state_idx" ON "pairings" USING btree ("org_id","cohort_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_unique" ON "participants" USING btree ("org_id","cohort_id","user_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_attributes_unique" ON "profile_attributes" USING btree ("org_id","participant_id","key");--> statement-breakpoint
CREATE INDEX "saga_due_idx" ON "saga_instances" USING btree ("status","timeout_at");--> statement-breakpoint
CREATE INDEX "saga_subject_idx" ON "saga_instances" USING btree ("org_id","saga_name","subject_ref");--> statement-breakpoint
CREATE INDEX "sessions_pairing_idx" ON "sessions" USING btree ("org_id","pairing_id","starts_at");--> statement-breakpoint
CREATE INDEX "signals_subject_idx" ON "signals" USING btree ("org_id","subject_ref","kind","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_idx" ON "users" USING btree ("org_id","email");