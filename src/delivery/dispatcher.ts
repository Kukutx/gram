import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AbortController } from 'abort-controller';
import { claimDeliveries } from '../db/outbox.ts';
import { deliveryOutcomes } from '../observability/metrics.ts';
import { sendDelivery, type SenderDeps } from './sender.ts';

export const OUTBOX_CHANNEL = 'gram_outbox';

export type DispatcherOptions = {
  concurrency: number;
  pollMs: number;
  /** Enables LISTEN/NOTIFY wake-ups; omit to rely on polling only. */
  listenUrl?: string;
  onError: (error: unknown) => void;
  /** Called after every scan, successful or empty: used for the dispatch heartbeat. */
  onCycle?: () => Promise<void>;
};

export type Dispatcher = {
  start(): void;
  wake(): void;
  /** One scan: claims up to `concurrency` due deliveries and sends them. */
  runOnce(): Promise<number>;
  stop(): Promise<void>;
};

/**
 * Outbox dispatcher: wakes on NOTIFY (new deliveries) or every `pollMs` (retries,
 * missed notifications), then drains due rows in batches of distinct chats.
 */
export function createDispatcher(deps: SenderDeps, options: DispatcherOptions): Dispatcher {
  const abort = new AbortController();
  let stopped = false;
  let running: Promise<void> | undefined;
  let wakeUp: (() => void) | undefined;
  let pending = false;
  let listener: pg.Client | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;

  const wake = () => {
    pending = true;
    wakeUp?.();
  };

  const sleep = () =>
    new Promise<void>((resolve) => {
      if (pending || stopped) return resolve();
      const timer = setTimeout(done, options.pollMs);
      function done() {
        clearTimeout(timer);
        wakeUp = undefined;
        resolve();
      }
      wakeUp = done;
    });

  async function runOnce(): Promise<number> {
    const token = randomUUID();
    const ids = await claimDeliveries(deps.db, token, options.concurrency);
    await Promise.all(
      ids.map((id) =>
        sendDelivery(deps, id, token, abort.signal).then(
          (outcome) => deliveryOutcomes.inc({ outcome }),
          (error: unknown) => {
            deliveryOutcomes.inc({ outcome: 'error' });
            options.onError(error);
          },
        ),
      ),
    );
    return ids.length;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      pending = false;
      let claimed = 0;
      try {
        claimed = await runOnce();
        await options.onCycle?.();
      } catch (error) {
        options.onError(error);
      }
      // A full batch means more work is probably waiting: continue immediately.
      if (!stopped && claimed < options.concurrency) await sleep();
    }
  }

  function listen(): void {
    if (!options.listenUrl || stopped) return;
    const client = new pg.Client({
      connectionString: options.listenUrl,
      connectionTimeoutMillis: 5_000,
    });
    listener = client;
    const retry = () => {
      if (stopped || listener !== client) return;
      listener = undefined;
      client.removeAllListeners();
      client.on('error', () => {}); // A late socket error must not crash the process.
      void client.end().catch(() => {});
      reconnect = setTimeout(listen, 5_000);
    };
    client.on('notification', wake);
    client.on('error', (error) => {
      options.onError(error);
      retry();
    });
    client.on('end', retry);
    client
      .connect()
      .then(() => client.query(`LISTEN ${OUTBOX_CHANNEL}`))
      .then(wake) // Catch up on anything inserted while disconnected.
      .catch((error: unknown) => {
        options.onError(error);
        retry();
      });
  }

  return {
    start() {
      if (running) return;
      listen();
      running = loop();
    },
    wake,
    runOnce,
    async stop() {
      stopped = true;
      abort.abort();
      wakeUp?.();
      if (reconnect) clearTimeout(reconnect);
      const client = listener;
      listener = undefined;
      client?.removeAllListeners();
      client?.on('error', () => {});
      await Promise.all([running, client?.end().catch(() => {})]);
    },
  };
}
