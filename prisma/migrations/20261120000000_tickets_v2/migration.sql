-- v2: tickets with two-way messages, attachments and a single delivery outbox.
-- Existing feedback, replies and audit events are migrated in place before the
-- old tables are dropped. Apply with the bot and worker stopped (see docs/OPERATIONS.md).

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('open', 'in_progress', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'sent', 'blocked', 'paused', 'dismissed');

-- AlterTable
ALTER TABLE "TelegramUser" ADD COLUMN     "bannedAt" TIMESTAMP(3),
ALTER COLUMN "language" SET DATA TYPE VARCHAR(8);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "assignedTo" BIGINT,
    "adminThreadId" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "authorId" BIGINT NOT NULL,
    "sourceUpdateId" INTEGER,
    "text" VARCHAR(4096),
    "attachmentType" VARCHAR(16),
    "attachmentId" VARCHAR(256),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" VARCHAR(36),
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" INTEGER,
    "lastErrorAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentMessageId" INTEGER,
    "sentHeaderMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketEvent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "actorId" BIGINT NOT NULL,
    "sourceUpdateId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "TicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_number_key" ON "Ticket"("number");

-- CreateIndex
CREATE INDEX "Ticket_userId_createdAt_idx" ON "Ticket"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Ticket_status_lastMessageAt_idx" ON "Ticket"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Ticket_lastMessageAt_idx" ON "Ticket"("lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "TicketMessage_sourceUpdateId_key" ON "TicketMessage"("sourceUpdateId");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_createdAt_id_idx" ON "TicketMessage"("ticketId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Delivery_status_chatId_createdAt_idx" ON "Delivery"("status", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "Delivery_chatId_sentMessageId_idx" ON "Delivery"("chatId", "sentMessageId");

-- CreateIndex
CREATE INDEX "Delivery_chatId_sentHeaderMessageId_idx" ON "Delivery"("chatId", "sentHeaderMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_messageId_chatId_key" ON "Delivery"("messageId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketEvent_sourceUpdateId_key" ON "TicketEvent"("sourceUpdateId");

-- CreateIndex
CREATE INDEX "TicketEvent_ticketId_createdAt_idx" ON "TicketEvent"("ticketId", "createdAt");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "TelegramUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TicketMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Data migration ──────────────────────────────────────────────────────────
-- Tickets keep their old IDs so links in logs and exports still resolve; numbers follow creation order.
INSERT INTO "Ticket" ("id", "userId", "status", "assignedTo", "resolvedAt", "lastMessageAt", "createdAt", "updatedAt")
SELECT f."id", f."userId",
       CASE WHEN f."status" IN ('open', 'in_progress', 'resolved', 'closed') THEN f."status"::"TicketStatus" ELSE 'open' END,
       f."assignedTo", f."resolvedAt",
       GREATEST(f."createdAt", COALESCE((SELECT max(r."createdAt") FROM "FeedbackReply" r WHERE r."feedbackId" = f."id"), f."createdAt")),
       f."createdAt", CURRENT_TIMESTAMP
FROM "Feedback" f
ORDER BY f."createdAt", f."id";

-- The original feedback text becomes the ticket's first inbound message.
INSERT INTO "TicketMessage" ("id", "ticketId", "direction", "authorId", "sourceUpdateId", "text", "createdAt")
SELECT 'm' || f."id", f."id", 'inbound', u."telegramId", f."sourceUpdateId", f."text", f."createdAt"
FROM "Feedback" f JOIN "TelegramUser" u ON u."id" = f."userId";

-- Undelivered admin notices are parked on chat 0; the worker expands them to the
-- currently configured admin recipients at startup (the admin ID lives in config, not SQL).
INSERT INTO "Delivery" ("id", "messageId", "chatId", "status", "attempts", "lastErrorCode", "lastErrorAt", "createdAt")
SELECT gen_random_uuid()::text, 'm' || f."id", 0, f."deliveryStatus"::"DeliveryStatus",
       f."deliveryAttempts", f."lastDeliveryErrorCode", f."lastDeliveryErrorAt", f."createdAt"
FROM "Feedback" f
WHERE f."notifiedAt" IS NULL AND f."deliveryStatus" IN ('pending', 'blocked', 'paused');

-- Admin replies become outbound messages with their delivery state to the user.
INSERT INTO "TicketMessage" ("id", "ticketId", "direction", "authorId", "sourceUpdateId", "text", "createdAt")
SELECT r."id", r."feedbackId", 'outbound', COALESCE(e."actorId", 0), r."sourceUpdateId", r."text", r."createdAt"
FROM "FeedbackReply" r
LEFT JOIN "FeedbackEvent" e ON e."sourceUpdateId" = r."sourceUpdateId" AND e."action" = 'reply_queued';

INSERT INTO "Delivery" ("id", "messageId", "chatId", "status", "attempts", "lastErrorCode", "lastErrorAt", "sentAt", "createdAt")
SELECT gen_random_uuid()::text, r."id", u."telegramId",
       CASE WHEN r."deliveryStatus" IN ('pending', 'sent', 'blocked', 'paused', 'dismissed') THEN r."deliveryStatus"::"DeliveryStatus" ELSE 'pending' END,
       r."deliveryAttempts", r."lastDeliveryErrorCode", r."lastDeliveryErrorAt", r."notifiedAt", r."createdAt"
FROM "FeedbackReply" r
JOIN "Feedback" f ON f."id" = r."feedbackId"
JOIN "TelegramUser" u ON u."id" = f."userId";

INSERT INTO "TicketEvent" ("id", "ticketId", "action", "actorId", "sourceUpdateId", "createdAt")
SELECT e."id", e."feedbackId", e."action", e."actorId", e."sourceUpdateId", e."createdAt"
FROM "FeedbackEvent" e;

-- ── Drop v1 tables ──────────────────────────────────────────────────────────
-- DropForeignKey
ALTER TABLE "Feedback" DROP CONSTRAINT "Feedback_userId_fkey";

-- DropForeignKey
ALTER TABLE "FeedbackEvent" DROP CONSTRAINT "FeedbackEvent_feedbackId_fkey";

-- DropForeignKey
ALTER TABLE "FeedbackReply" DROP CONSTRAINT "FeedbackReply_feedbackId_fkey";

-- DropTable
DROP TABLE "Feedback";

-- DropTable
DROP TABLE "FeedbackEvent";

-- DropTable
DROP TABLE "FeedbackReply";

-- ── Low-latency dispatch ────────────────────────────────────────────────────
-- Wakes LISTENing workers after new deliveries commit. Polling remains the
-- fallback (e.g. behind a transaction-mode connection pooler without LISTEN).
CREATE FUNCTION "gram_notify_outbox"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('gram_outbox', '');
  RETURN NULL;
END
$$;

CREATE TRIGGER "Delivery_notify_insert" AFTER INSERT ON "Delivery"
  FOR EACH STATEMENT EXECUTE FUNCTION "gram_notify_outbox"();
