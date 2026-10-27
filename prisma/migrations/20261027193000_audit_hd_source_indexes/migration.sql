-- Additive lookup indexes only. No UPDATE, backfill, or historical row repair.
CREATE INDEX "Asset_original_url_idx" ON "Asset"("original_url");
CREATE INDEX "ReferenceImage_url_idx" ON "ReferenceImage"("url");
