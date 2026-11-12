export type WaitForOptions = {
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  /** Names the condition in the timeout error. */
  readonly description: string;
};

/**
 * Polls `condition` until it returns a value other than `undefined` or
 * `false`, and returns that value. Errors thrown by the condition count as
 * "not yet" and are reported if the time runs out.
 */
export async function waitFor<T>(
  condition: () => Promise<T | undefined | false> | T | undefined | false,
  options: WaitForOptions,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.intervalMs ?? 50;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await condition();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(
        `Timed out after ${options.timeoutMs} ms waiting for ${options.description}${cause}`,
        { cause: lastError },
      );
    }
    await Bun.sleep(interval);
  }
}
