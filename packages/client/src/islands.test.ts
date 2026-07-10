import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// Install the test-hooks window BEFORE importing the module so its auto-boot
// block (guarded by typeof document) stays inert and hooks resolve lazily.
const memoryStorage = new Map<string, string>();
const state: {
  manifest: any;
  manifestError: Error | null;
  imported: string[];
  hydrateCalls: Array<{ el: any; props: any }>;
  moduleError: Error | null;
  reloads: number;
  errors: any[];
} = {
  manifest: { version: 'v1', islands: {} },
  manifestError: null,
  imported: [],
  hydrateCalls: [],
  moduleError: null,
  reloads: 0,
  errors: [],
};

(globalThis as any).window = {
  location: { pathname: '/demo' },
  __KILN_ISLANDS_TEST_HOOKS: {
    disableAutoBoot: true,
    fetchManifest: async () => {
      if (state.manifestError) throw state.manifestError;
      return state.manifest;
    },
    importModule: async (url: string) => {
      state.imported.push(url);
      if (state.moduleError) throw state.moduleError;
      return { hydrate: (el: any, props: any) => state.hydrateCalls.push({ el, props }) };
    },
    reload: () => {
      state.reloads += 1;
    },
    storage: {
      get: (k: string) => memoryStorage.get(k) ?? null,
      set: (k: string, v: string) => void memoryStorage.set(k, v),
      remove: (k: string) => void memoryStorage.delete(k),
    },
    emitError: (detail: any) => {
      state.errors.push(detail);
    },
  },
};

const islands = await import('./islands.js');

function fakeMarker(attrs: Record<string, string>): any {
  return {
    attrs,
    set: new Map<string, string>(),
    parentElement: null,
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name: string, value: string) {
      this.set.set(name, value);
    },
  };
}

beforeEach(() => {
  state.manifest = { version: 'v1', islands: { Counter: '/_kiln/client/islands/Counter-abc.js' } };
  state.manifestError = null;
  state.imported = [];
  state.hydrateCalls = [];
  state.moduleError = null;
  state.reloads = 0;
  state.errors = [];
  memoryStorage.clear();
  islands.__resetForTests();
});

afterEach(() => {
  islands.__resetForTests();
});

describe('islands bootstrap', () => {
  it('hydrates a marker with decoded props via the manifest-resolved chunk', async () => {
    const el = fakeMarker({
      'data-kiln-island': 'Counter',
      'data-kiln-props': '{"start":41,"label":"a\\u003c/b"}',
    });
    await islands.hydrateIsland(el);

    expect(state.imported).toEqual(['/_kiln/client/islands/Counter-abc.js']);
    expect(state.hydrateCalls.length).toBe(1);
    expect(state.hydrateCalls[0].el).toBe(el);
    expect(state.hydrateCalls[0].props).toEqual({ start: 41, label: 'a</b' });
    expect(el.set.get('data-kiln-hydrated')).toBe('');
    expect(state.reloads).toBe(0);
    expect(state.errors).toEqual([]);
  });

  it('is idempotent per element', async () => {
    const el = fakeMarker({ 'data-kiln-island': 'Counter', 'data-kiln-props': '{}' });
    await islands.hydrateIsland(el);
    await islands.hydrateIsland(el);
    expect(state.hydrateCalls.length).toBe(1);
  });

  it('reloads once for a missing island (deploy skew), then fails static with an event', async () => {
    state.manifest = { version: 'v2', islands: {} };

    const first = fakeMarker({ 'data-kiln-island': 'Counter', 'data-kiln-props': '{}' });
    await islands.hydrateIsland(first);
    expect(state.reloads).toBe(1);
    expect(state.errors).toEqual([]);

    // Same page after the guarded reload: still missing → no second reload,
    // baked HTML stays, error event emitted (I-6/I-7).
    islands.__resetForTests();
    const second = fakeMarker({ 'data-kiln-island': 'Counter', 'data-kiln-props': '{}' });
    await islands.hydrateIsland(second);
    expect(state.reloads).toBe(1);
    expect(state.errors.length).toBe(1);
    expect(state.errors[0].name).toBe('Counter');
    expect(second.set.has('data-kiln-hydrated')).toBe(false);
  });

  it('clears the reload guard after a successful hydration', async () => {
    memoryStorage.set(islands.reloadGuardKey(), '1');
    const el = fakeMarker({ 'data-kiln-island': 'Counter', 'data-kiln-props': '{}' });
    await islands.hydrateIsland(el);
    expect(memoryStorage.has(islands.reloadGuardKey())).toBe(false);
  });

  it('treats a chunk without a hydrate export as a failure', async () => {
    memoryStorage.set(islands.reloadGuardKey(), '1'); // already reloaded once
    (globalThis as any).window.__KILN_ISLANDS_TEST_HOOKS.importModule = async () => ({});
    const el = fakeMarker({ 'data-kiln-island': 'Counter', 'data-kiln-props': '{}' });
    await islands.hydrateIsland(el);
    expect(state.errors.length).toBe(1);
    expect(String(state.errors[0].error)).toContain('no hydrate() export');
    // restore shared hook for later tests
    (globalThis as any).window.__KILN_ISLANDS_TEST_HOOKS.importModule = async (url: string) => {
      state.imported.push(url);
      if (state.moduleError) throw state.moduleError;
      return { hydrate: (el2: any, props: any) => state.hydrateCalls.push({ el: el2, props }) };
    };
  });

  it('re-fetches the manifest after a failed fetch instead of caching the failure', async () => {
    state.manifestError = new Error('offline');
    memoryStorage.set(islands.reloadGuardKey(), '1'); // suppress reload path
    await islands.hydrateIsland(fakeMarker({ 'data-kiln-island': 'Counter', 'data-kiln-props': '{}' }));
    expect(state.errors.length).toBe(1);

    state.manifestError = null;
    const el = fakeMarker({ 'data-kiln-island': 'Counter', 'data-kiln-props': '{}' });
    await islands.hydrateIsland(el);
    expect(state.hydrateCalls.length).toBe(1);
    expect(state.hydrateCalls[0].el).toBe(el);
  });

  it('decodeProps returns {} for missing or corrupt payloads', () => {
    expect(islands.decodeProps(fakeMarker({}))).toEqual({});
    expect(islands.decodeProps(fakeMarker({ 'data-kiln-props': '{oops' }))).toEqual({});
  });

  it('schedule falls back to immediate hydration when observers are unavailable', async () => {
    const el = fakeMarker({
      'data-kiln-island': 'Counter',
      'data-kiln-hydrate': 'visible',
      'data-kiln-props': '{}',
    });
    islands.schedule(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.hydrateCalls.length).toBe(1);
  });
});
