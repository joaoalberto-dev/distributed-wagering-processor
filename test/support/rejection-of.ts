/**
 * Resolves with what `promise` rejects with, or fails if it fulfills.
 * Use `expect(await rejectionOf(p)).toBeInstanceOf(X)` instead of
 * `expect(p).rejects`, which bun-types declares as synchronous.
 */
export async function rejectionOf(
  promise: PromiseLike<unknown>,
): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it fulfilled');
}
