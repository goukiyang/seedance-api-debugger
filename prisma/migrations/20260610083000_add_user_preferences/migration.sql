CREATE TABLE "UserPreference" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value_json" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "UserPreference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserPreference_user_id_key_key" ON "UserPreference"("user_id", "key");
CREATE INDEX "UserPreference_user_id_idx" ON "UserPreference"("user_id");
CREATE INDEX "UserPreference_key_idx" ON "UserPreference"("key");
