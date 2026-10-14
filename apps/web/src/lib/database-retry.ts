/** Retry only a whole, idempotent operation after PostgreSQL aborts it. */
export async function retryDatabaseConflict<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error;
      await wait(50 * (attempt + 1));
    }
  }
}
