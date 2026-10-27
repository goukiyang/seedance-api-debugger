CREATE TABLE "ApiRateLimit" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "count" INTEGER NOT NULL,
  "expires_at_ms" BIGINT NOT NULL,
  "updated_at_ms" BIGINT NOT NULL
);
CREATE INDEX "ApiRateLimit_expires_at_ms_idx" ON "ApiRateLimit"("expires_at_ms");
