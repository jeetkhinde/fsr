import { Elysia } from 'elysia';

/**
 * Maps handler timeouts to 408 responses. The deadline itself is enforced by
 * the adapter wrapping each page/action handler in `withTimeout` — an
 * app-level derive() cannot cancel a handler that is already running, so a
 * standalone timer here would fire into the void.
 */
export const timeout = () => (app: Elysia) =>
  app.onError(({ error, set }) => {
    const err = error as any;
    if (err?.message === 'Timeout' || err?.name === 'AbortError') {
      set.status = 408;
      return 'Request Timeout';
    }
  });

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}
