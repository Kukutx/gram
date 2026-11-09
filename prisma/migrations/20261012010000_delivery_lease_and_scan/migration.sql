-- Backward-compatible columns; safe to apply before rolling out bot and worker.
ALTER TABLE "Feedback"
  ADD COLUMN "deliveryLeaseToken" VARCHAR(36),
  ADD COLUMN "deliveryLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Feedback_notifiedAt_createdAt_id_idx"
  ON "Feedback"("notifiedAt", "createdAt", "id");
