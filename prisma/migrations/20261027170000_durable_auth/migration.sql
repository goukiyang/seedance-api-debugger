ALTER TABLE "User" ADD COLUMN "auth_origin" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "User" ADD COLUMN "email_verified_at" DATETIME;

CREATE TABLE "UserSession" (
  "token_digest" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "account_digest" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_activity_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" DATETIME NOT NULL,
  "revoked_at" DATETIME,
  "revoke_reason" TEXT,
  "browser" TEXT,
  "ip_prefix" TEXT,
  CONSTRAINT "UserSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UserSession_user_id_revoked_at_idx" ON "UserSession"("user_id", "revoked_at");
CREATE INDEX "UserSession_expires_at_idx" ON "UserSession"("expires_at");

CREATE TABLE "RegistrationChallenge" (
  "token_digest" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" DATETIME NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumed_at" DATETIME
);
CREATE INDEX "RegistrationChallenge_email_expires_at_idx" ON "RegistrationChallenge"("email", "expires_at");
CREATE INDEX "RegistrationChallenge_expires_at_idx" ON "RegistrationChallenge"("expires_at");
