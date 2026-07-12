import { Elysia } from 'elysia';

// request is the same Fetch API Request instance across onRequest and
// onAfterResponse for a given request, so caching the parsed pathname on it
// avoids parsing the URL twice per request.
function getPathname(request: Request): string {
  const cached = (request as any).__kilnPathname;
  if (cached) return cached;
  const pathname = new URL(request.url).pathname;
  (request as any).__kilnPathname = pathname;
  return pathname;
}

export const tracing = () => (app: Elysia) =>
  app.use(
    new Elysia({ name: 'kiln-tracing' })
      .onRequest(({ request }) => {
        console.log(`→ ${request.method} ${getPathname(request)}`);
      })
      .onAfterResponse(({ request, set }) => {
        console.log(`← ${request.method} ${getPathname(request)} ${set.status ?? 200}`);
      })
  );
