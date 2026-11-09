/** One execution per task, independent schedules, bounded shutdown. */
export function scheduleTask(
  operation: () => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void,
) {
  let active: Promise<void> | undefined;
  let stopped = false;
  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (!active)
      active = operation()
        .catch(onError)
        .finally(() => {
          active = undefined;
        });
    return active;
  };
  const interval = setInterval(() => {
    void run();
  }, intervalMs);
  return {
    run,
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    settled: () => active ?? Promise.resolve(),
  };
}

export async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Operation deadline exceeded')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
