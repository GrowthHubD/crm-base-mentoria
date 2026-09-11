ALTER TABLE "pipeline_stages" ADD COLUMN "escalate_after_minutes" integer;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN "escalate_to_stage_id" text;
--> statement-breakpoint
-- Herda os tempos que JÁ ESTAVAM valendo.
--
-- A escalação deixou de ser duas transições no código e passou a ser
-- propriedade de cada coluna. Sem este passo, a instalação continuaria com as
-- colunas sem tempo nenhum — e o funil pararia de escalar em silêncio, que é
-- pior do que qualquer erro: os leads simplesmente ficariam parados em "Novos"
-- e ninguém saberia por quê.
--
-- Os valores vêm de `pipeline_config` quando ela existe (o cliente pode ter
-- ajustado os minutos na tela) e caem nos defaults do produto quando não.
UPDATE "pipeline_stages" ps
SET
  "escalate_after_minutes" = COALESCE(
    (SELECT "new_to_priority_minutes" FROM "pipeline_config" LIMIT 1), 15
  ),
  "escalate_to_stage_id" = (
    SELECT id FROM "pipeline_stages"
    WHERE status = 'priority' AND is_custom = false LIMIT 1
  )
WHERE ps.status = 'new' AND ps.is_custom = false;
--> statement-breakpoint
UPDATE "pipeline_stages" ps
SET
  "escalate_after_minutes" = COALESCE(
    (SELECT "priority_to_urgency_minutes" FROM "pipeline_config" LIMIT 1), 30
  ),
  "escalate_to_stage_id" = (
    SELECT id FROM "pipeline_stages"
    WHERE status = 'urgency' AND is_custom = false LIMIT 1
  )
WHERE ps.status = 'priority' AND ps.is_custom = false;
