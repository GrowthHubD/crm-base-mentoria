CREATE TABLE "email_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"refresh_token_encrypted" text NOT NULL,
	"scopes" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"last_sync_at" timestamp,
	"last_history_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_accounts_user_email_uq" ON "email_accounts" USING btree ("user_id","email");