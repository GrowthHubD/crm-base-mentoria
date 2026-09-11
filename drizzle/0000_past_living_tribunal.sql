CREATE TYPE "public"."user_role" AS ENUM('admin', 'attendant');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'qr_pending', 'connected', 'disconnected', 'error');--> statement-breakpoint
CREATE TYPE "public"."connection_type" AS ENUM('whatsapp');--> statement-breakpoint
CREATE TYPE "public"."lead_channel" AS ENUM('whatsapp', 'instagram', 'google', 'manual');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'priority', 'urgency', 'attending', 'converted', 'lost');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_sender" AS ENUM('lead', 'human', 'ai', 'owner');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'button_reply', 'list_reply', 'system');--> statement-breakpoint
CREATE TYPE "public"."scheduled_message_status" AS ENUM('pending', 'sent', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."followup_status" AS ENUM('pending', 'sent', 'cancelled', 'responded');--> statement-breakpoint
CREATE TYPE "public"."attendance_action" AS ENUM('assigned', 'unassigned', 'status_changed', 'ai_enabled', 'ai_disabled', 'converted', 'lost', 'note_added');--> statement-breakpoint
CREATE TYPE "public"."automation_log_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."automation_step_type" AS ENUM('send_text', 'send_media', 'wait', 'set_status', 'add_tag', 'notify_human');--> statement-breakpoint
CREATE TYPE "public"."automation_trigger" AS ENUM('first_message', 'lead_inactive', 'stage_enter', 'tag_added', 'manual');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" "user_role" DEFAULT 'attendant' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "connection_type" NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"phone_number" text,
	"access_token_encrypted" text,
	"token_expires_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "connections_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"external_contact_id" text NOT NULL,
	"channel" "lead_channel" NOT NULL,
	"connection_id" text,
	"name" text,
	"phone" text,
	"avatar_url" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"assigned_to_id" text,
	"attributed_channel" "lead_channel",
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp,
	"last_inbound_at" timestamp,
	"last_outbound_at" timestamp,
	"last_escalation_at" timestamp,
	"status_changed_at" timestamp DEFAULT now() NOT NULL,
	"ai_agent_active" integer DEFAULT 0 NOT NULL,
	"ai_blocked_until" timestamp,
	"ai_paused_until" timestamp,
	"resolved_at" timestamp,
	"metadata" jsonb,
	"converted_at" timestamp,
	"converted_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text,
	"lead_id" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"type" "message_type" DEFAULT 'text' NOT NULL,
	"sender" "message_sender" NOT NULL,
	"sent_by_id" text,
	"body" text,
	"media_url" text,
	"media_caption" text,
	"mime_type" text,
	"file_name" text,
	"quoted_message_id" text,
	"quoted_content" text,
	"sender_name" text,
	"status" "message_status" DEFAULT 'sent' NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"failed_reason" text,
	"is_starred" boolean DEFAULT false NOT NULL,
	"reactions" jsonb,
	"embedding" jsonb,
	"metadata" jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "messages_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_config" (
	"id" text PRIMARY KEY NOT NULL,
	"new_to_priority_minutes" integer DEFAULT 15 NOT NULL,
	"priority_to_urgency_minutes" integer DEFAULT 30 NOT NULL,
	"auto_escalation_enabled" boolean DEFAULT true NOT NULL,
	"notify_on_escalation" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_agent_config" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"system_prompt" text,
	"support_system_prompt" text,
	"temperature" integer DEFAULT 70 NOT NULL,
	"max_messages_before_handoff" integer DEFAULT 10 NOT NULL,
	"agent_name" text DEFAULT 'Assistente' NOT NULL,
	"personality" text,
	"tone" text DEFAULT 'friendly' NOT NULL,
	"use_emojis" boolean DEFAULT true NOT NULL,
	"welcome_message" text,
	"transfer_message" text DEFAULT 'Deixa eu chamar um colega aqui pra continuar com você, um instante!' NOT NULL,
	"idle_seconds_before_ai" integer DEFAULT 0 NOT NULL,
	"idle_minutes_user" integer DEFAULT 20 NOT NULL,
	"typing_ms_per_char" integer DEFAULT 35 NOT NULL,
	"block_send_enabled" boolean DEFAULT true NOT NULL,
	"block_send_delay_sec" integer DEFAULT 1 NOT NULL,
	"followups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"channel_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transfer_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"operation_hours_text" text,
	"operation_hours" jsonb,
	"paused_until" timestamp,
	"ai_pause_minutes_after_human" integer DEFAULT 20 NOT NULL,
	"ai_pause_minutes_after_cancellation" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"created_by_id" text,
	"status" "scheduled_message_status" DEFAULT 'pending' NOT NULL,
	"body" text NOT NULL,
	"media_url" text,
	"scheduled_at" timestamp NOT NULL,
	"sent_at" timestamp,
	"bull_job_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followups" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"status" "followup_status" DEFAULT 'pending' NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"body" text NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"sent_at" timestamp,
	"bull_job_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"phone" text,
	"profile_name" text,
	"qr_code" text,
	"qr_expires_at" timestamp,
	"webhook_url" text,
	"metadata" jsonb,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_instances_connection_id_unique" UNIQUE("connection_id"),
	CONSTRAINT "whatsapp_instances_instance_id_unique" UNIQUE("instance_id")
);
--> statement-breakpoint
CREATE TABLE "attendance_log" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"user_id" text,
	"action" "attendance_action" NOT NULL,
	"from_value" text,
	"to_value" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_config" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"auto_ai_outside_shift" boolean DEFAULT false NOT NULL,
	"outside_shift_message" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"step_id" text,
	"lead_id" text NOT NULL,
	"status" "automation_log_status" DEFAULT 'pending' NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"executed_at" timestamp,
	"bull_job_id" text,
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" "automation_step_type" NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger" "automation_trigger" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger_config" jsonb,
	"filters" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quick_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"shortcut" text NOT NULL,
	"body" text NOT NULL,
	"variations" jsonb,
	"label" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_by_id_users_id_fk" FOREIGN KEY ("converted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_id_users_id_fk" FOREIGN KEY ("sent_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_instances" ADD CONSTRAINT "whatsapp_instances_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_log" ADD CONSTRAINT "attendance_log_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_log" ADD CONSTRAINT "attendance_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_step_id_automation_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."automation_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_channel_ext_uidx" ON "leads" USING btree ("channel","external_contact_id");--> statement-breakpoint
CREATE INDEX "idx_messages_lead_id" ON "messages" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_messages_timestamp" ON "messages" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_status" ON "messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_automation_logs_lead_id" ON "automation_logs" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_automation_logs_status" ON "automation_logs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_automation_logs_scheduled_at" ON "automation_logs" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_automation_steps_automation_id" ON "automation_steps" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "idx_automations_trigger" ON "automations" USING btree ("trigger");--> statement-breakpoint
CREATE INDEX "idx_automations_enabled" ON "automations" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_quick_replies_shortcut" ON "quick_replies" USING btree ("shortcut");