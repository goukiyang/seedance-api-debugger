ALTER TABLE "ImageStudioModule" ADD COLUMN "quality" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "ImageStudioModule" ADD COLUMN "group_name" TEXT NOT NULL DEFAULT '未分组';
ALTER TABLE "ImageStudioModule" ADD COLUMN "banner_asset_id" TEXT;
ALTER TABLE "ImageStudioTask" ADD COLUMN "quality" TEXT NOT NULL DEFAULT 'auto';
