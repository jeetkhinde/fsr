import { Elysia } from 'elysia';

export const tracing = () => (app: Elysia) =>
  app.use(
    new Elysia({ name: 'kiln-tracing' })
      .onRequest(({ request }) => {
        console.log(`→ ${request.method} ${new URL(request.url).pathname}`);
      })
      .onAfterResponse(({ request, set }) => {
        console.log(`← ${request.method} ${new URL(request.url).pathname} ${set.status ?? 200}`);
      })
  );
