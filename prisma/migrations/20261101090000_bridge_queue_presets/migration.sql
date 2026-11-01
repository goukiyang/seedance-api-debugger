-- Additive: SD2 生产桥队列预设（组合）与点赞；旧版本不读这两张表。
CREATE TABLE "BridgeQueuePreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "client_id" TEXT,
    "name" TEXT NOT NULL,
    "items_json" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "team_id" TEXT,
    "like_count" INTEGER NOT NULL DEFAULT 0,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "copied_from" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "BridgeQueuePresetLike" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "preset_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "BridgeQueuePreset_owner_id_client_id_key" ON "BridgeQueuePreset"("owner_id", "client_id");
CREATE INDEX "BridgeQueuePreset_owner_id_updated_at_idx" ON "BridgeQueuePreset"("owner_id", "updated_at");
CREATE INDEX "BridgeQueuePreset_shared_updated_at_idx" ON "BridgeQueuePreset"("shared", "updated_at");
CREATE UNIQUE INDEX "BridgeQueuePresetLike_preset_id_user_id_key" ON "BridgeQueuePresetLike"("preset_id", "user_id");
CREATE INDEX "BridgeQueuePresetLike_user_id_idx" ON "BridgeQueuePresetLike"("user_id");
