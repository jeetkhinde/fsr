import {
  createContext,
  use,
  useActionState,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  createElement,
} from "react";
import {
  type SilcrowSubmitOptions,
  type SilcrowActionOptions,
  type SilcrowSubmitResult,
  submitSilcrow,
} from "./submit.js";

export type KilnReactContextValue = {
  actionBase?: string;
};

export const KilnReactContext = createContext<KilnReactContextValue>({});

export function KilnReactProvider({
  value,
  children,
}: {
  value: KilnReactContextValue;
  children: ReactNode;
}) {
  return createElement(KilnReactContext.Provider, { value }, children);
}

function appendActionName(base: string, name: string): string {
  if (/^https?:\/\//.test(name) || name.startsWith("/") || name.startsWith("?/")) {
    return name;
  }
  const cleanBase = base || (typeof window !== "undefined" ? window.location.pathname : "/");
  const separator = cleanBase.includes("?") ? "&" : "?";
  return `${cleanBase}${separator}/${encodeURIComponent(name)}`;
}

export function resolveKilnAction(name: string, base?: string): string {
  return appendActionName(base ?? "", name);
}

/**
 * Subscribe a React component to a Silcrow atom scope.
 */
export function useSilcrowAtom<T>(scope: string, fallback: T): T {
  const read = (): T => {
    if (typeof window === 'undefined') return fallback;
    return window.Silcrow?.snapshot?.<T>(scope) ?? fallback;
  };
  return useSyncExternalStore<T>(
    (notify) => (typeof window === 'undefined' ? () => {} : window.Silcrow?.subscribe?.(scope, notify) ?? (() => {})),
    read,
    read,
  );
}

/**
 * Patch a Silcrow atom scope.
 */
export function publishSilcrowAtom<T>(scope: string, data: T): void {
  window.Silcrow?.publish?.(scope, data);
}

/**
 * Read a live field inside a React island (ADR-014 store bridge).
 *
 * Declare the field in load() with target: 'store' — it then has no s-live
 * DOM slot; SSE patches publish { value } to the `live:<field>` atom scope
 * and this hook re-renders. Read order: live atom (freshest) → baked seed
 * (window.__kiln_seed) → fallback. During server bake there is no window,
 * so pass the bake-time value as `fallback` (usually the island prop) to
 * keep SSR output and first client render identical.
 */
export function useLiveValue<T>(field: string, fallback?: T): T {
  const read = (): T => {
    if (typeof window === 'undefined') return fallback as T;
    const snap = window.Silcrow?.snapshot?.<{ value: T }>('live:' + field);
    if (snap && typeof snap === 'object' && 'value' in snap) {
      return (snap as { value: T }).value;
    }
    const seed = (window as any).__kiln_seed;
    if (seed && typeof seed === 'object' && field in seed) {
      return seed[field] as T;
    }
    return fallback as T;
  };
  return useSyncExternalStore<T>(
    (notify) => window.Silcrow?.subscribe?.('live:' + field, notify) ?? (() => {}),
    read,
    read,
  );
}

/**
 * Prefetch a route and return Silcrow's memoized promise for React `use()`.
 */
export function useSilcrowPrefetch<T>(path: string): Promise<T> {
  return useMemo(
    () =>
      (typeof window === 'undefined' ? undefined : window.Silcrow?.prefetch?.<T>(path)) ??
      Promise.reject(new Error("Silcrow is not loaded")),
    [path],
  );
}

/**
 * Read a route atom by path.
 */
export function useSilcrowRoute<T>(path: string, fallback: T): T {
  return useSilcrowAtom<T>(`route:${path}`, fallback);
}

/**
 * Create a React 19 form action backed by Silcrow transport.
 */
export function useSilcrowAction<State>(
  url: string,
  initialState = { ok: true } as State,
  options?: SilcrowActionOptions,
) {
  const submitOptions = options
    ? {
        method: options.method,
        scope: options.scope,
        headers: options.headers,
        optimistic: options.optimistic,
      }
    : undefined;
  return useActionState(
    submitSilcrow<any>(url, submitOptions),
    initialState as any,
    options?.permalink,
  ) as unknown as [State, (payload: FormData) => void, boolean];
}

/**
 * React 19 action wrapper that resolves a Kiln page/fragment named action.
 */
export function useKilnNamedAction<State>(
  name: string,
  initialState = { ok: true } as State,
  options?: SilcrowActionOptions & { base?: string },
) {
  const context = useContext(KilnReactContext);
  const url = resolveKilnAction(name, options?.base ?? context.actionBase);
  return useSilcrowAction<State>(url, initialState, options);
}

/**
 * Prefetch a route, suspend until ready, then subscribe to live updates.
 */
export function useSilcrowResource<T>(path: string, fallback: T): T {
  const initial = use(useSilcrowPrefetch<T>(path));
  return useSilcrowRoute<T>(path, initial ?? fallback);
}

/**
 * Shared form state shape expected by `useSilcrowForm`.
 */
export type SilcrowFormState = {
  ok: boolean;
  message?: string;
  errors?: Record<string, string>;
};

export type SilcrowFormResult<State extends SilcrowFormState> = {
  state: State;
  action: (formData: FormData) => void;
  pending: boolean;
  ok: State["ok"];
  message: State["message"];
  errors: State["errors"];
};

/**
 * Object-style wrapper over `useSilcrowAction` for simple native forms.
 */
export function useSilcrowForm<State extends SilcrowFormState = SilcrowFormState>(
  url: string,
  initialState = { ok: true } as State,
  options?: SilcrowActionOptions,
): SilcrowFormResult<State> {
  const [state, action, pending] = useSilcrowAction<State>(url, initialState, options);
  return useMemo(
    () => ({
      state,
      action,
      pending,
      ok: state.ok,
      message: state.message,
      errors: state.errors,
    }),
    [state, action, pending],
  );
}

/**
 * Options for `useSilcrowMutation`.
 */
export type SilcrowMutationOptions<Data = unknown> = {
  /** URL to POST to. */
  url: string;
  /** HTTP method (default: `"POST"`). */
  method?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Optimistic update to apply immediately before the round-trip. */
  optimistic?: {
    scope: string;
    data: Data;
    mutationId?: string;
  };
  /** Called when the server confirms success. */
  onSuccess?: (result: SilcrowSubmitResult<Data>) => void;
  /** Called when the server returns an error response or network failure. */
  onError?: (error: unknown) => void;
};

/**
 * State returned by `useSilcrowMutation`.
 */
export type SilcrowMutationState<Data = unknown> = {
  mutate: (body?: BodyInit | object | null) => Promise<SilcrowSubmitResult<Data>>;
  pending: boolean;
  error: unknown;
  data: Data | null;
  reset: () => void;
};

/**
 * A simple mutation hook that wraps `Silcrow.submit` with optional optimistic updates.
 */
export function useSilcrowMutation<Data = unknown>(
  options: SilcrowMutationOptions<Data>,
): SilcrowMutationState<Data> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [data, setData] = useState<Data | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const pendingCountRef = useRef(0);

  const reset = useCallback(() => {
    setPending(false);
    setError(null);
    setData(null);
  }, []);

  const mutate = useCallback(async (body?: BodyInit | object | null) => {
    const { url, method, headers, optimistic, onSuccess, onError } = optionsRef.current;
    if (!window.Silcrow?.submit) {
      const err = new Error("Silcrow is not loaded");
      setError(err);
      onError?.(err);
      throw err;
    }
    pendingCountRef.current += 1;
    if (pendingCountRef.current === 1) setPending(true);
    setError(null);
    try {
      const result = await window.Silcrow.submit<Data>(url, body ?? null, {
        method: method ?? "POST",
        headers,
        optimistic,
      });
      if (result.ok) {
        setData(result.data);
        onSuccess?.(result);
      } else {
        const err = new Error("Request failed with status " + result.status);
        setError(err);
        onError?.(err);
      }
      return result;
    } catch (err) {
      setError(err);
      onError?.(err);
      throw err;
    } finally {
      pendingCountRef.current -= 1;
      if (pendingCountRef.current === 0) setPending(false);
    }
  }, []);

  return { mutate, pending, error, data, reset };
}
