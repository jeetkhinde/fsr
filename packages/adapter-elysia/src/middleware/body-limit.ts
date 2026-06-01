import { Elysia } from 'elysia';

export const bodyLimit = (limitBytes = 2 * 1024 * 1024) => (app: Elysia) => {
  return app.onBeforeHandle(({ request, set }) => {
    const contentLength = request.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > limitBytes) {
        set.status = 413;
        return 'Payload Too Large';
      }
    }
  });
};
