CREATE TABLE "ContentReaction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "content_key" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "liked" BOOLEAN NOT NULL DEFAULT false,
  "favorited" BOOLEAN NOT NULL DEFAULT false,
  "liked_at" DATETIME,
  "favorited_at" DATETIME,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "ContentReaction_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ContentReaction_user_id_content_key_key" ON "ContentReaction"("user_id", "content_key");
CREATE INDEX "ContentReaction_content_key_liked_idx" ON "ContentReaction"("content_key", "liked");
CREATE INDEX "ContentReaction_user_id_favorited_favorited_at_idx" ON "ContentReaction"("user_id", "favorited", "favorited_at");
CREATE INDEX "ContentReaction_user_id_liked_liked_at_idx" ON "ContentReaction"("user_id", "liked", "liked_at");

CREATE TABLE "ContentReactionEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "content_key" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentReactionEvent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ContentReactionEvent_user_id_request_id_key" ON "ContentReactionEvent"("user_id", "request_id");
CREATE INDEX "ContentReactionEvent_user_id_created_at_idx" ON "ContentReactionEvent"("user_id", "created_at");
