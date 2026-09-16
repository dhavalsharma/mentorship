CREATE TABLE "risk_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pairing_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"requires_human" boolean DEFAULT false NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "risk_findings_pairing_idx" ON "risk_findings" USING btree ("org_id","pairing_id","detected_at");--> statement-breakpoint
CREATE INDEX "risk_findings_open_idx" ON "risk_findings" USING btree ("org_id","requires_human","acknowledged_at");