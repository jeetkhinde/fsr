/**
 * SIGTERM must terminate the process even with a request still in flight.
 *
 * `listen()` registers a SIGTERM/SIGINT handler that stops the server and
 * exits. It used to call `app.stop()` with no argument, which waits for
 * in-flight requests to drain — and an SSE stream never drains. Any app with a
 * live field (LiveProp, Live.list) therefore hung on SIGTERM forever: measured
 * 2026-08-01 against apps/jags-list, ~10ms to exit with no subscriber, still
 * alive after 10s with one subscribed to /__kiln/fsr. Under an orchestrator
 * that means every rolling deploy stalls the full termination grace period and
 * then takes a SIGKILL, which drops the other in-flight requests the polite
 * wait was supposed to protect.
 *
 * The subject here is a request that never completes, which is what an SSE
 * stream *is* as far as `stop()`'s drain is concerned — and it needs neither
 * Postgres, Redis nor a baked route to set up. The real-SSE case is covered by
 * apps/jags-list/tests/live.integration.test.ts, whose afterAll cannot finish
 * if this regresses.
 *
 * Runs out-of-process: the handler under test calls `process.exit`, so an
 * in-process assertion would kill the test runner. The file re-executes itself
 * with `--serve` to be the subject.
 *
 * Plain script, not a `bun:test` suite, to match the other integration tests
 * run one-per-invocation by `bun run test:integration`.
 */
import { ElysiaAdapter } from './adapter.js';

const PORT = Number(process.env.KILN_SHUTDOWN_TEST_PORT ?? 3287);
const BASE = `http://localhost:${PORT}`;
/** Generous: the point is bounded-vs-unbounded, not a latency benchmark. */
const MUST_EXIT_WITHIN_MS = 3_000;

if (process.argv[2] === '--serve') {
  const adapter = new ElysiaAdapter();
  adapter.registerRaw('/health', () => new Response('ok'));
  // Never responds: an in-flight request that cannot drain.
  adapter.registerRaw('/hang', () => new Promise<Response>(() => {}));
  await adapter.listen(PORT);
  await new Promise(() => {}); // stay up until signalled
}

async function timeSigterm(holdRequest: boolean): Promise<number | null> {
  const proc = Bun.spawn(['bun', import.meta.path, '--serve'], {
    env: { ...process.env, KILN_SHUTDOWN_TEST_PORT: String(PORT) },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) {
          up = true;
          break;
        }
      } catch {}
      await Bun.sleep(50);
    }
    if (!up) throw new Error(`test server never came up on ${BASE}`);

    if (holdRequest) {
      // Deliberately not awaited — it never resolves. Swallow the abort that
      // lands when the server goes away.
      void fetch(`${BASE}/hang`).catch(() => {});
      await Bun.sleep(300); // let the server actually receive it
    }

    const t0 = Bun.nanoseconds();
    proc.kill(); // SIGTERM
    const TIMED_OUT = Symbol('timed-out');
    const outcome = await Promise.race([
      proc.exited,
      Bun.sleep(MUST_EXIT_WITHIN_MS).then(() => TIMED_OUT),
    ]);
    if (outcome === TIMED_OUT) return null;
    return (Bun.nanoseconds() - t0) / 1e6;
  } finally {
    proc.kill('SIGKILL');
    await proc.exited;
  }
}

const idle = await timeSigterm(false);
if (idle === null) {
  throw new Error(`SIGTERM did not terminate an idle server within ${MUST_EXIT_WITHIN_MS}ms`);
}
console.log(`SIGTERM, nothing in flight: exited in ${idle.toFixed(0)}ms`);

const inFlight = await timeSigterm(true);
if (inFlight === null) {
  throw new Error(
    `SIGTERM did not terminate a server with an in-flight request within ${MUST_EXIT_WITHIN_MS}ms — ` +
      'app.stop() is waiting for a request that never drains; it needs stop(true).',
  );
}
console.log(`SIGTERM, one never-draining request in flight: exited in ${inFlight.toFixed(0)}ms`);
console.log('adapter SIGTERM shutdown tests passed');
process.exit(0);
