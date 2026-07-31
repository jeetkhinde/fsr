export type LiveListKey = string | number;

export interface LiveListQueryContext {
  sql?: unknown;
  signal?: AbortSignal;
}

/**
 * Where a list's patches are delivered. Mirrors `LiveTarget` for scalars.
 *
 * - `'dom'` (default): the server marks the rendered rows and silcrow patches
 *   them in place. Never applies inside a React island — the island owns that
 *   subtree (ADR-014 I-3).
 * - `'store'`: no DOM marking at all; patches go to the client store, where
 *   `useLiveList()` applies them. This is how a list inside an island updates.
 * - `'dom-and-store'`: both, for a list rendered outside an island whose data
 *   an island also reads.
 */
export type LiveListDelivery = 'dom' | 'dom-and-store' | 'store';

export interface LiveListOptions<T> {
  key(row: T): LiveListKey;
  dependsOn?: string | string[];
  initial?: T[];
  debounce?: number;
  revalidate?: number | false;
  target?: LiveListDelivery;
  query(ctx: LiveListQueryContext): Promise<T[]> | T[];
}

export interface LiveListTarget<T = unknown> {
  kind: "list";
  route: string;
  name: string;
  dependsOn: string[];
  debounce?: number;
  revalidate?: number | false;
  keyOf(row: T): string;
  query(ctx: LiveListQueryContext): Promise<T[]> | T[];
}

export function normalizeLiveListDependsOn(dependsOn: string | string[] | undefined): string[] {
  if (dependsOn === undefined) return [];
  return Array.isArray(dependsOn) ? dependsOn : [dependsOn];
}
