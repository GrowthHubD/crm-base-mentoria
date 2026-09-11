ALTER TABLE "connections" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;