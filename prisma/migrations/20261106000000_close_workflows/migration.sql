ALTER TABLE "TelegramUser" ADD COLUMN "lastStateUpdateId" INTEGER,
  ADD COLUMN "lastStateUpdateAt" TIMESTAMP(3),
  ADD COLUMN "deleteNonce" VARCHAR(16), ADD COLUMN "deleteExpiresAt" TIMESTAMP(3);
ALTER TABLE "Feedback" ADD COLUMN "deliveryStatus" VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN "lastDeliveryErrorCode" INTEGER, ADD COLUMN "lastDeliveryErrorAt" TIMESTAMP(3),
  ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'open', ADD COLUMN "assignedTo" BIGINT,
  ADD COLUMN "resolvedAt" TIMESTAMP(3);
UPDATE "Feedback" SET "deliveryStatus" = 'sent' WHERE "notifiedAt" IS NOT NULL;
CREATE INDEX "Feedback_deliveryStatus_notifiedAt_createdAt_id_idx" ON "Feedback"("deliveryStatus", "notifiedAt", "createdAt", "id");
CREATE TABLE "CommandReceipt" ("updateId" INTEGER PRIMARY KEY, "result" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "CommandReceipt_createdAt_idx" ON "CommandReceipt"("createdAt");
CREATE TABLE "RuntimeHeartbeat" ("id" TEXT PRIMARY KEY, "kind" VARCHAR(16) NOT NULL, "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "RuntimeHeartbeat_kind_lastSeenAt_idx" ON "RuntimeHeartbeat"("kind", "lastSeenAt");
CREATE TABLE "FeedbackReply" (
  "id" TEXT PRIMARY KEY, "feedbackId" TEXT NOT NULL, "sourceUpdateId" INTEGER NOT NULL,
  "text" VARCHAR(2000) NOT NULL, "notifiedAt" TIMESTAMP(3), "deliveryLeaseToken" VARCHAR(36),
  "deliveryLeaseUntil" TIMESTAMP(3), "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  "deliveryStatus" VARCHAR(16) NOT NULL DEFAULT 'pending', "lastDeliveryErrorCode" INTEGER,
  "lastDeliveryErrorAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeedbackReply_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FeedbackReply_sourceUpdateId_key" ON "FeedbackReply"("sourceUpdateId");
CREATE INDEX "FeedbackReply_feedbackId_createdAt_id_idx" ON "FeedbackReply"("feedbackId", "createdAt", "id");
CREATE INDEX "FeedbackReply_deliveryStatus_notifiedAt_createdAt_id_idx" ON "FeedbackReply"("deliveryStatus", "notifiedAt", "createdAt", "id");
CREATE TABLE "FeedbackEvent" (
  "id" TEXT PRIMARY KEY, "feedbackId" TEXT NOT NULL, "action" VARCHAR(32) NOT NULL,
  "actorId" BIGINT NOT NULL, "sourceUpdateId" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeedbackEvent_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FeedbackEvent_sourceUpdateId_key" ON "FeedbackEvent"("sourceUpdateId");
CREATE INDEX "FeedbackEvent_feedbackId_createdAt_idx" ON "FeedbackEvent"("feedbackId", "createdAt");
