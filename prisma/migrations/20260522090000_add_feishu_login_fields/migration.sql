ALTER TABLE "User" ADD COLUMN "mobile" TEXT;
ALTER TABLE "User" ADD COLUMN "avatar_url" TEXT;
ALTER TABLE "User" ADD COLUMN "feishu_user_id" TEXT;
ALTER TABLE "User" ADD COLUMN "feishu_open_id" TEXT;
ALTER TABLE "User" ADD COLUMN "feishu_union_id" TEXT;
ALTER TABLE "User" ADD COLUMN "feishu_tenant_key" TEXT;
ALTER TABLE "User" ADD COLUMN "feishu_employee_no" TEXT;
ALTER TABLE "User" ADD COLUMN "feishu_department_ids" TEXT;
ALTER TABLE "User" ADD COLUMN "feishu_raw_profile" TEXT;
ALTER TABLE "User" ADD COLUMN "last_feishu_sync_at" DATETIME;

CREATE UNIQUE INDEX "User_feishu_user_id_key" ON "User"("feishu_user_id");
CREATE UNIQUE INDEX "User_feishu_open_id_key" ON "User"("feishu_open_id");
CREATE INDEX "User_feishu_union_id_idx" ON "User"("feishu_union_id");
CREATE INDEX "User_feishu_tenant_key_idx" ON "User"("feishu_tenant_key");
