-- Additive: older releases keep reading avatar_url unchanged.
ALTER TABLE "User" ADD COLUMN "feishu_avatar_url" TEXT;
ALTER TABLE "User" ADD COLUMN "avatar_source" TEXT NOT NULL DEFAULT 'feishu';
ALTER TABLE "User" ADD COLUMN "custom_avatar_key" TEXT;
UPDATE "User" SET "feishu_avatar_url" = "avatar_url" WHERE "feishu_avatar_url" IS NULL;
