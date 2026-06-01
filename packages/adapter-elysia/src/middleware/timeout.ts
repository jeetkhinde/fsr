import { Elysia } from 'elysia';

export const timeout = (timeoutMs = 30000) => (app: Elysia) => {
  return app
    .derive(() => {
      const controller = new AbortController();
      const id = setTimeout(() => {
        controller.abort(new Error('Timeout'));
      }, timeoutMs);

      return {
        abortController: controller,
        timeoutId: id,
      };
    })
    .onAfterResponse(({ timeoutId }) => {
      clearTimeout(timeoutId);
    })
    .onError(({ error, set }) => {
      const err = error as any;
      if (err.message === 'Timeout' || err.name === 'AbortError') {
        set.status = 408;
        return 'Request Timeout';
      }
    });
};

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
