/**
 * The LISTEN client's 'error' handling.
 *
 * pg emits TWO 'error' events when a backend is terminated under an in-flight
 * query: one from the query, then 'Connection terminated unexpectedly' from
 * the connection. The handler was registered with `once`, so it had already
 * detached when the second arrived — and an EventEmitter with no 'error'
 * listener throws on emit. Bun printed a stack from inside pg's client.js and
 * carried on (measured exit code 0), which is why it was filed as log noise;
 * on Node the same path throws.
 *
 * These use a bare EventEmitter rather than a real pg.Client on purpose: the
 * contract under test is "one reconnect, and never an unhandled error event",
 * which is EventEmitter semantics, not database behaviour.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { attachListenerErrorHandler } from './db-notify.js';

describe('attachListenerErrorHandler', () => {
  test('a second error event does not go unhandled', () => {
    const client = new EventEmitter();
    attachListenerErrorHandler(client, () => {});

    client.emit('error', new Error('terminating connection due to administrator command'));
    // With `once`, the listener is gone by now and this throws the error
    // itself — EventEmitter's unhandled-'error' behaviour.
    expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
  });

  test('only the first error triggers the reconnect', () => {
    const client = new EventEmitter();
    const seen: string[] = [];
    attachListenerErrorHandler(client, (err) => seen.push(err.message));

    client.emit('error', new Error('first'));
    client.emit('error', new Error('second'));
    client.emit('error', new Error('third'));

    // A plain `on` with no latch would schedule three reconnects and leave
    // three live clients behind — worse than the noise it fixed.
    expect(seen).toEqual(['first']);
  });

  test('the handler stays attached after firing', () => {
    const client = new EventEmitter();
    attachListenerErrorHandler(client, () => {});
    client.emit('error', new Error('first'));

    expect(client.listenerCount('error')).toBe(1);
  });
});
