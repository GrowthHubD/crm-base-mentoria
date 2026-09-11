CREATE TABLE "units" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "units_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
DROP INDEX "pipeline_stages_status_uq";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "unit_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "unit_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "unit_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "stage_id" text;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN "is_custom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_units_active" ON "units" USING btree ("active");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_status_uq" ON "pipeline_stages" USING btree ("status") WHERE "pipeline_stages"."is_custom" = false;