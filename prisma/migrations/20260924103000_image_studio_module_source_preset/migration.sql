ALTER TABLE "ImageStudioModule" ADD COLUMN "source_preset_id" TEXT;
ALTER TABLE "ImageStudioTask" ADD COLUMN "source_preset_id" TEXT;

CREATE INDEX "ImageStudioModule_source_preset_id_idx" ON "ImageStudioModule"("source_preset_id");
CREATE INDEX "ImageStudioTask_source_preset_id_created_at_idx" ON "ImageStudioTask"("source_preset_id", "created_at");

-- Existing administrator modules are the original source templates. Preserve
-- their configuration and make the old behavior (shared by default) explicit.
INSERT INTO "ImageStudioPreset" (
  "id", "owner_id", "scope", "is_shared", "name", "group_name", "prompt",
  "context", "model", "quality", "resolution", "count", "reference_limit",
  "aspect_ratio", "banner_asset_id", "reference_ids", "created_at", "updated_at"
)
SELECT
  'module-source:' || m."id", m."owner_id", 'admin', 1, m."name", m."group_name",
  m."prompt", m."context", COALESCE(m."model", 'gemini-3.1-flash-image-preview'),
  m."quality", m."resolution", m."count", m."reference_limit", m."aspect_ratio",
  m."banner_asset_id", m."reference_ids", m."created_at", m."updated_at"
FROM "ImageStudioModule" m
JOIN "User" u ON u."id" = m."owner_id"
WHERE u."role" = 'admin'
  AND m."id" NOT LIKE 'default-%';

UPDATE "ImageStudioModule"
SET "source_preset_id" = 'module-source:' || "id"
WHERE "id" IN (
  SELECT m."id"
  FROM "ImageStudioModule" m
  JOIN "User" u ON u."id" = m."owner_id"
  WHERE u."role" = 'admin' AND m."id" NOT LIKE 'default-%'
);
