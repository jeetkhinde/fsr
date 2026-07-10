import { createElement, type ComponentType } from 'react';
import { encodeSeed } from '@kiln/core';

export type HydrateStrategy = 'load' | 'idle' | 'visible';

export interface IslandOptions {
  /** When the client hydrates the island. Default 'load'. */
  hydrate?: HydrateStrategy;
}

/**
 * Declare a React island (ADR-014). The wrapped component SSRs into the
 * baked HTML inside a marker div; the client bootstrap (/_silcrow/islands.js)
 * finds the marker, loads the island's chunk by NAME through the manifest
 * (never by URL — that's the deploy-skew defense), and hydrates it as an
 * isolated React root.
 *
 * `name` must equal the island's file basename under the app's `islands/`
 * directory — the build keys chunks and the manifest by that name.
 *
 * Props are embedded at bake time via the seed codec and must be plain JSON
 * data. Live data inside an island comes from the store (`target: 'store'`
 * + `useLiveValue()`), never from silcrow DOM patches.
 */
export function island<P extends Record<string, unknown>>(
  Component: ComponentType<P>,
  name: string,
  opts: IslandOptions = {},
): ComponentType<P> {
  const hydrate = opts.hydrate ?? 'load';
  function IslandWrapper(props: P) {
    // The marker div is the hydration container: its children must be
    // exactly the component's SSR output (hydrateRoot matches against it),
    // so nothing else may ever be rendered inside. display:contents keeps
    // the wrapper out of layout. encodeSeed escapes '<'; React escapes
    // quotes/ampersands when serializing the attribute — both layers are
    // required, neither alone suffices.
    return createElement(
      'div',
      {
        'data-kiln-island': name,
        'data-kiln-hydrate': hydrate,
        'data-kiln-props': encodeSeed(props),
        style: { display: 'contents' },
      },
      createElement(Component, props),
    );
  }
  IslandWrapper.displayName = `Island(${name})`;
  return IslandWrapper;
}
