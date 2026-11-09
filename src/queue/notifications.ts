import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config/env.ts';
import type { Logger } from '../observability/logger.ts';
import type { NotificationJob } from './delivery.ts';
import { withDeadline } from '../runtime/tasks.ts';

export const FEEDBACK_QUEUE = 'telegram-feedback-notification';

export type FeedbackJob = NotificationJob;

export type Notifications = {
  enqueueFeedback(feedbackId: string): Promise<void>;
  enqueueReply(replyId: string): Promise<void>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
};

/** No Redis means the bot still saves feedback; administrators can use /feedbacks. */
export function createNotifications(config: AppConfig, logger: Logger): Notifications | undefined {
  if (!config.REDIS_URL || !config.ADMIN_TELEGRAM_ID) {
    logger.info('Redis accelerator disabled; the independent Worker can dispatch from PostgreSQL');
    return undefined;
  }
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    enableOfflineQueue: false,
  });
  redis.on('error', (error: Error) => logger.error({ err: error }, 'Redis producer error'));

  let queue: Queue<FeedbackJob>;
  try {
    queue = new Queue<FeedbackJob>(FEEDBACK_QUEUE, {
      connection: redis,
      defaultJobOptions: {
        attempts: 6,
        backoff: { type: 'exponential', delay: 3_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 20_000 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    });
  } catch (error) {
    redis.disconnect();
    throw error;
  }
  queue.on('error', (error) => logger.warn({ err: error }, 'Notification queue unavailable'));
  return {
    async enqueueFeedback(feedbackId: string): Promise<void> {
      // A stable job ID deduplicates retries of a single Telegram update.
      if (redis.status !== 'ready') throw new Error('Notification queue not ready');
      await withDeadline(
        queue.add('notify-feedback', { feedbackId }, { jobId: `feedback_${feedbackId}` }),
        2_000,
      );
    },
    async enqueueReply(replyId: string): Promise<void> {
      if (redis.status !== 'ready') throw new Error('Notification queue not ready');
      await withDeadline(queue.add('notify-reply', { replyId }, { jobId: `reply_${replyId}` }), 2_000);
    },
    async isReady(): Promise<boolean> {
      try {
        return (await redis.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      try {
        await withDeadline(queue.close(), 1_000);
      } finally {
        redis.disconnect();
      }
    },
  };
}
