CREATE TABLE "pipeline_stages" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "lead_status" NOT NULL,
	"label" text NOT NULL,
	"color" text DEFAULT '#8B8B94' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_status_uq" ON "pipeline_stages" USING btree ("status");
--> statement-breakpoint
-- REMOVIDO daqui, de propósito: o drizzle-kit também gerou
--   CREATE INDEX "idx_messages_lead_id_timestamp" ON "messages" ...
-- porque esse índice está no schema TS mas nunca passou por migration — quem o
-- cria é `scripts/create-messages-index.ts`, com CONCURRENTLY e IF NOT EXISTS,
-- fora de transação (CONCURRENTLY não roda dentro de uma, e sem ele o índice
-- trava escrita na tabela de mensagens).
--
-- Mantê-lo aqui quebraria a migration em TODAS as instalações existentes: o
-- índice já existe nelas, o CREATE sem IF NOT EXISTS falharia, a transação
-- inteira faria rollback e a `pipeline_stages` não seria criada. O sintoma
-- apareceria longe da causa — kanban sem configuração, migration "aplicada".
--> statement-breakpoint
-- O quadro nasce idêntico ao que já estava no ar. Sem este seed o código cairia
-- nos padrões de qualquer forma, mas com as linhas gravadas a tela de
-- configuração abre preenchida em vez de parecer nunca configurada.
--
-- `lost` fica de fora: existe no enum, mas o kanban não tem consulta para ele.
INSERT INTO "pipeline_stages" ("id", "status", "label", "color", "position", "visible") VALUES
	(gen_random_uuid()::text, 'new',       'Novos',       '#00d492', 0, true),
	(gen_random_uuid()::text, 'priority',  'Prioridade',  '#d99d00', 1, true),
	(gen_random_uuid()::text, 'urgency',   'Urgência',    '#ff6060', 2, true),
	(gen_random_uuid()::text, 'attending', 'Respondidos', '#94A3B8', 3, true),
	(gen_random_uuid()::text, 'converted', 'Convertidos', '#22D3EE', 4, true)
ON CONFLICT ("status") DO NOTHING;