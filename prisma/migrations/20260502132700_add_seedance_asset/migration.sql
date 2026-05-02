-- AddSeedanceAsset
-- Migration: Add SeedanceAsset table for official API asset persistence
-- Branch: feature/seedance-asset-schema-migration-fix
-- Date: 2026-05-02
-- Phase: SD2 API 资产管理模块第一阶段 - 数据库持久化

-- CreateTable
CREATE TABLE "SeedanceAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL DEFAULT 'seedance',
    "provider_asset_id" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL DEFAULT 'Image',
    "name" TEXT NOT NULL,
    "original_url" TEXT NOT NULL,
    "provider_preview_url" TEXT,
    "provider_status" TEXT,
    "local_status" TEXT NOT NULL DEFAULT 'Active',
    "raw_provider_response" TEXT,
    "last_synced_at" DATETIME,
    "deleted_at" DATETIME,
    "provider_deleted_at" DATETIME,
    "delete_error" TEXT,
    "group_id" TEXT,
    "project_name" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SeedanceAsset_provider_asset_id_idx" ON "SeedanceAsset"("provider_asset_id");

-- CreateIndex
CREATE INDEX "SeedanceAsset_provider_provider_asset_id_idx" ON "SeedanceAsset"("provider", "provider_asset_id");
