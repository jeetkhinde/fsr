/**
 * Kiln islands bootstrap (ADR-014). Served at /_silcrow/islands.js as a
 * module script on pages containing data-kiln-island markers.
 *
 * React-free by design: island chunks (see routekit's virtual:kiln-island
 * wrappers) export hydrate(el, props); this module only finds markers,
 * resolves island NAMES through the always-fresh manifest, and schedules
 * hydration. Names-not-URLs in markers is the deploy-skew defense (I-6):
 * week-old cached HTML hydrates against today's build.
 *
 * Failure contract (I-7): the baked HTML always stays on screen. A failed
 * chunk gets exactly one guarded full reload (deploy skew), after which the
 * island stays static and a `kiln:island-error` CustomEvent fires on window.
 *
 * Test hooks: set window.__KILN_ISLANDS_TEST_HOOKS = { fetchManifest,
 * importModule, reload, storage, emitError, disableAutoBoot } before import.
 * Hooks are read lazily per call so tests can swap them between cases.
 */

function hooks() {
  return (typeof window !== 'undefined' && window.__KILN_ISLANDS_TEST_HOOKS) || {};
}

function fetchManifest() {
  const custom = hooks().fetchManifest;
  if (custom) return custom();
  return fetch('/_kiln/islands.json', { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error('islands manifest fetch failed: ' + r.status);
    return r.json();
  });
}

function importModule(url) {
  const custom = hooks().importModule;
  if (custom) return custom(url);
  return import(url);
}

function reloadPage() {
  const custom = hooks().reload;
  if (custom) return custom();
  window.location.reload();
}

function storageGet(key) {
  const custom = hooks().storage;
  if (custom) return custom.get(key);
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  const custom = hooks().storage;
  if (custom) return custom.set(key, value);
  try { window.sessionStorage.setItem(key, value); } catch { /* private mode */ }
}

function storageRemove(key) {
  const custom = hooks().storage;
  if (custom) return custom.remove(key);
  try { window.sessionStorage.removeItem(key); } catch { /* private mode */ }
}

function emitError(detail) {
  const custom = hooks().emitError;
  if (custom) return custom(detail);
  console.error('[kiln] island hydration failed:', detail.name, detail.error);
  try {
    window.dispatchEvent(new CustomEvent('kiln:island-error', { detail }));
  } catch { /* CustomEvent unavailable */ }
}

let manifestPromise = null;

export function getManifest() {
  if (!manifestPromise) {
    // Memoized per page load; forgotten on failure so a later island (or a
    // retry after transient network trouble) re-fetches.
    manifestPromise = Promise.resolve()
      .then(fetchManifest)
      .catch((err) => {
        manifestPromise = null;
        throw err;
      });
  }
  return manifestPromise;
}

export function reloadGuardKey() {
  const path = typeof window !== 'undefined' && window.location ? window.location.pathname : '';
  return 'kiln-island-reload:' + path;
}

export function decodeProps(el) {
  const raw = el.getAttribute('data-kiln-props');
  if (!raw) return {};
  // Written via encodeSeed at bake time; the DOM API returns the attribute
  // already HTML-unescaped, and JSON.parse reads the codec's escapes
  // transparently.
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function hydrateIsland(el) {
  if (el.__kilnHydrated) return;
  el.__kilnHydrated = true;
  const name = el.getAttribute('data-kiln-island');
  try {
    const manifest = await getManifest();
    const url = manifest && manifest.islands ? manifest.islands[name] : undefined;
    if (!url) throw new Error('island "' + name + '" not in manifest');
    const mod = await importModule(url);
    if (typeof mod.hydrate !== 'function') {
      throw new Error('island chunk for "' + name + '" has no hydrate() export');
    }
    mod.hydrate(el, decodeProps(el));
    storageRemove(reloadGuardKey());
    el.setAttribute('data-kiln-hydrated', '');
  } catch (err) {
    const key = reloadGuardKey();
    if (!storageGet(key)) {
      storageSet(key, '1');
      reloadPage();
      return;
    }
    emitError({ name, error: String(err) });
  }
}

export function schedule(el) {
  const strategy = el.getAttribute('data-kiln-hydrate') || 'load';
  if (strategy === 'visible' && typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          io.disconnect();
          hydrateIsland(el);
          return;
        }
      }
    });
    io.observe(el);
    return;
  }
  if (strategy === 'idle' && typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => hydrateIsland(el));
    return;
  }
  hydrateIsland(el);
}

export function boot(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope) return;
  scope.querySelectorAll('[data-kiln-island]').forEach((el) => {
    // v1: nested islands unsupported — the outermost marker owns the subtree.
    if (el.parentElement && el.parentElement.closest && el.parentElement.closest('[data-kiln-island]')) {
      return;
    }
    schedule(el);
  });
}

/** Test-only: forget the memoized manifest between cases. */
export function __resetForTests() {
  manifestPromise = null;
}

if (typeof document !== 'undefined' && !hooks().disableAutoBoot) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot());
  } else {
    boot();
  }
  // Re-scan after silcrow's enhanced navigation swaps fragments in — it
  // always drives history, so history transitions are the re-boot signal
  // (mirrors live-client-script's subscription strategy).
  window.addEventListener('popstate', () => queueMicrotask(() => boot()));
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args) {
    origPush(...args);
    queueMicrotask(() => boot());
  };
  history.replaceState = function (...args) {
    origReplace(...args);
    queueMicrotask(() => boot());
  };
}
