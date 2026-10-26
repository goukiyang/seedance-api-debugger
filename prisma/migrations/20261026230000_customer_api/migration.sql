-- CreateTable
CREATE TABLE "ApiConfiguration" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "license_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "concurrency_limit" INTEGER,
    "storage_limit_bytes" BIGINT,
    "max_output_bytes" BIGINT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ApiCustomer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "video_card_id" TEXT NOT NULL,
    "create_enabled" BOOLEAN NOT NULL DEFAULT false,
    "read_enabled" BOOLEAN NOT NULL DEFAULT true,
    "license_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL,
    "models_json" TEXT NOT NULL DEFAULT '[]',
    "points_per_cny" REAL,
    "max_task_points" REAL,
    "daily_points" REAL,
    "monthly_points" REAL,
    "concurrency_limit" INTEGER,
    "storage_limit_bytes" BIGINT,
    "upload_limit_bytes" BIGINT,
    "retention_policy" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ApiCustomer_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApiCustomer_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApiCustomer_video_card_id_fkey" FOREIGN KEY ("video_card_id") REFERENCES "VideoCard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" DATETIME NOT NULL,
    "scopes_json" TEXT NOT NULL,
    "models_json" TEXT NOT NULL,
    "requests_per_minute" INTEGER NOT NULL,
    "window_start" DATETIME,
    "window_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ApiCustomer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customer_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "cny_per_second" REAL NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ApiRate_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ApiCustomer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiQuote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customer_id" TEXT NOT NULL,
    "input_json" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "asset_versions_json" TEXT NOT NULL,
    "pricing_json" TEXT NOT NULL,
    "customer_revision" INTEGER NOT NULL,
    "rate_id" TEXT NOT NULL,
    "rate_revision" INTEGER NOT NULL,
    "points" REAL NOT NULL,
    "max_cost_points" REAL NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiQuote_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ApiCustomer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiProviderCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "digest" TEXT NOT NULL,
    "configuration_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ApiRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customer_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "reserved_points" REAL NOT NULL,
    "day_key" TEXT NOT NULL,
    "month_key" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "output_reserved_bytes" BIGINT NOT NULL,
    "output_bytes" BIGINT,
    "output_sha256" TEXT,
    "output_version" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiRequest_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ApiCustomer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApiRequest_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "VideoTask" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApiRequest_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "ApiProviderCredential" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customer_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "asset_id" TEXT,
    "private_path" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiUpload_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ApiCustomer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customer_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "private_path" TEXT NOT NULL,
    "source_version" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiAsset_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ApiCustomer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApiAsset_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiCustomer_user_id_key" ON "ApiCustomer"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCustomer_project_id_key" ON "ApiCustomer"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCustomer_video_card_id_key" ON "ApiCustomer"("video_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_digest_key" ON "ApiKey"("digest");

-- CreateIndex
CREATE INDEX "ApiKey_customer_id_idx" ON "ApiKey"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "ApiRate_customer_id_model_resolution_key" ON "ApiRate"("customer_id", "model", "resolution");

-- CreateIndex
CREATE INDEX "ApiQuote_customer_id_created_at_idx" ON "ApiQuote"("customer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ApiProviderCredential_digest_key" ON "ApiProviderCredential"("digest");

-- CreateIndex
CREATE UNIQUE INDEX "ApiRequest_task_id_key" ON "ApiRequest"("task_id");

-- CreateIndex
CREATE INDEX "ApiRequest_customer_id_day_key_idx" ON "ApiRequest"("customer_id", "day_key");

-- CreateIndex
CREATE INDEX "ApiRequest_customer_id_month_key_idx" ON "ApiRequest"("customer_id", "month_key");

-- CreateIndex
CREATE UNIQUE INDEX "ApiRequest_customer_id_request_id_key" ON "ApiRequest"("customer_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "ApiUpload_customer_id_request_id_key" ON "ApiUpload"("customer_id", "request_id");

-- CreateIndex
CREATE INDEX "ApiAsset_customer_id_asset_id_idx" ON "ApiAsset"("customer_id", "asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "ApiAsset_customer_id_sha256_key" ON "ApiAsset"("customer_id", "sha256");
