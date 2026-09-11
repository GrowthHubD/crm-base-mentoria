CREATE TABLE "attendant_close_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"lead_id_text" text NOT NULL,
	"action" text NOT NULL,
	"duration_ms" bigint NOT NULL,
	"closed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendant_close_log" ADD CONSTRAINT "attendant_close_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;