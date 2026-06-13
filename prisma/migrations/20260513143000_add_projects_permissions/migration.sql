-- Phase 1: project space, ownership, membership, invites.
-- This migration is intentionally additive so existing tasks and users remain usable.

ALTER TABLE "User" ADD COLUMN "account_type" TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE "User" ADD COLUMN "feature_profile_id" TEXT;
ALTER TABLE "User" ADD COLUMN "expires_at" DATETIME;

ALTER TABLE "VideoTask" ADD COLUMN "owner_user_id" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "project_id" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'project';
ALTER TABLE "VideoTask" ADD COLUMN "billing_scope" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "VideoTask" ADD COLUMN "billing_account_id" TEXT;

CREATE TABLE "Project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT NOT NULL DEFAULT 'team',
  "visibility" TEXT NOT NULL DEFAULT 'private',
  "owner_user_id" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "archived_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "Project_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Project_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ProjectMember" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "project_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "joined_by" TEXT,
  "joined_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'active',
  CONSTRAINT "ProjectMember_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectMember_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectMember_joined_by_fkey" FOREIGN KEY ("joined_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ProjectInvite" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "project_id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "default_role" TEXT NOT NULL DEFAULT 'member',
  "allowed_account_type" TEXT,
  "max_uses" INTEGER,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" DATETIME,
  "require_approval" BOOLEAN NOT NULL DEFAULT false,
  "created_by" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectInvite_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectInvite_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "User_account_type_idx" ON "User"("account_type");
CREATE INDEX "VideoTask_owner_user_id_idx" ON "VideoTask"("owner_user_id");
CREATE INDEX "VideoTask_project_id_idx" ON "VideoTask"("project_id");
CREATE INDEX "Project_workspace_id_idx" ON "Project"("workspace_id");
CREATE INDEX "Project_owner_user_id_idx" ON "Project"("owner_user_id");
CREATE INDEX "Project_created_by_idx" ON "Project"("created_by");
CREATE INDEX "Project_type_idx" ON "Project"("type");
CREATE INDEX "Project_visibility_idx" ON "Project"("visibility");
CREATE INDEX "Project_status_idx" ON "Project"("status");
CREATE UNIQUE INDEX "ProjectMember_project_id_user_id_key" ON "ProjectMember"("project_id", "user_id");
CREATE INDEX "ProjectMember_project_id_idx" ON "ProjectMember"("project_id");
CREATE INDEX "ProjectMember_user_id_idx" ON "ProjectMember"("user_id");
CREATE INDEX "ProjectMember_role_idx" ON "ProjectMember"("role");
CREATE INDEX "ProjectMember_status_idx" ON "ProjectMember"("status");
CREATE UNIQUE INDEX "ProjectInvite_token_key" ON "ProjectInvite"("token");
CREATE INDEX "ProjectInvite_project_id_idx" ON "ProjectInvite"("project_id");
CREATE INDEX "ProjectInvite_created_by_idx" ON "ProjectInvite"("created_by");
CREATE INDEX "ProjectInvite_status_idx" ON "ProjectInvite"("status");
CREATE INDEX "ProjectInvite_expires_at_idx" ON "ProjectInvite"("expires_at");
