-- Additive provenance and learning records. Existing source tasks, requests and balances are unchanged.
CREATE TABLE "WorkContext" (
 "work_id" TEXT NOT NULL PRIMARY KEY, "media_version_id" TEXT NOT NULL, "schema_version" INTEGER NOT NULL DEFAULT 1,
 "submission_key" TEXT, "template_module" TEXT, "template_id" TEXT, "template_version" TEXT, "template_token" TEXT,
 "settings_json" TEXT NOT NULL DEFAULT '[]', "indexed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WorkContext_submission_key_work_id_idx" ON "WorkContext"("submission_key","work_id");
CREATE INDEX "WorkContext_template_module_template_id_template_version_work_id_idx" ON "WorkContext"("template_module","template_id","template_version","work_id");
CREATE TABLE "WorkSourceLink" (
 "work_id" TEXT NOT NULL, "media_version_id" TEXT NOT NULL, "source_kind" TEXT NOT NULL, "source_id" TEXT NOT NULL, "relation" TEXT NOT NULL,
 PRIMARY KEY("work_id","source_kind","source_id")
);
CREATE INDEX "WorkSourceLink_source_kind_source_id_work_id_idx" ON "WorkSourceLink"("source_kind","source_id","work_id");
CREATE TABLE "WorkLearningEntry" (
 "id" TEXT NOT NULL PRIMARY KEY, "work_id" TEXT NOT NULL, "media_version_id" TEXT NOT NULL, "author_id" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "parent_id" TEXT, "body" TEXT NOT NULL, "time_seconds" REAL, "revision" INTEGER NOT NULL DEFAULT 1,
 "removed_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL
);
CREATE INDEX "WorkLearningEntry_work_id_media_version_id_removed_at_created_at_id_idx" ON "WorkLearningEntry"("work_id","media_version_id","removed_at","created_at","id");
CREATE INDEX "WorkLearningEntry_parent_id_removed_at_created_at_id_idx" ON "WorkLearningEntry"("parent_id","removed_at","created_at","id");
CREATE TABLE "WorkDerivedLink" (
 "id" TEXT NOT NULL PRIMARY KEY, "source_work_id" TEXT NOT NULL, "derived_work_id" TEXT NOT NULL,
 "source_media_version_id" TEXT NOT NULL, "derived_media_version_id" TEXT NOT NULL, "author_id" TEXT NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1, "removed_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "WorkDerivedLink_source_work_id_derived_work_id_author_id_key" ON "WorkDerivedLink"("source_work_id","derived_work_id","author_id");
CREATE INDEX "WorkDerivedLink_source_work_id_removed_at_created_at_id_idx" ON "WorkDerivedLink"("source_work_id","removed_at","created_at","id");
CREATE INDEX "WorkDerivedLink_derived_work_id_removed_at_created_at_id_idx" ON "WorkDerivedLink"("derived_work_id","removed_at","created_at","id");
