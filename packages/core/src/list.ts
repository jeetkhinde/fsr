import type { LiveListOptions, LiveListQueryContext } from '@kiln/live';
import { normalizeLiveListDependsOn } from '@kiln/live';

export interface KilnListRow {
  __key: string;
  __liveFields: string[];
  [field: string]: any;
}

export interface ListPatchEvent {
  list: string;
  key: string;
  changes: Record<string, any>;
}

export interface ListChunkCache {
  get(list: string, key: string): string | null;
  set(list: string, key: string, html: string): void;
  delete(list: string, key: string): void;
  deleteList(list: string): void;
}

export interface LiveListMeta<T = unknown> {
  kind: 'list';
  dependsOn: string[];
  keyOf(row: T): string;
  query(ctx: LiveListQueryContext): Promise<T[]> | T[];
}

export type LiveList<T> = T[] & {
  readonly __kilnLiveListBrand?: true;
};

export const LIVE_LIST_META = Symbol.for('kiln.live-list.meta');

export function createLiveList<T>(options: LiveListOptions<T>): LiveList<T> {
  const rows = [...(options.initial ?? [])] as LiveList<T>;
  const meta: LiveListMeta<T> = {
    kind: 'list',
    dependsOn: normalizeLiveListDependsOn(options.dependsOn),
    keyOf: (row) => String(options.key(row)),
    query: options.query,
  };

  Object.defineProperty(rows, LIVE_LIST_META, {
    value: meta,
    enumerable: false,
    configurable: false,
  });

  Object.defineProperty(rows, '__kilnLiveListBrand', {
    value: true,
    enumerable: false,
    configurable: false,
  });

  return rows;
}

export function isLiveList(value: unknown): value is LiveList<unknown> {
  return Array.isArray(value) && Boolean((value as any)[LIVE_LIST_META]);
}

export function getLiveListMeta<T>(value: LiveList<T> | unknown): LiveListMeta<T> | undefined {
  if (!isLiveList(value)) return undefined;
  return (value as any)[LIVE_LIST_META] as LiveListMeta<T>;
}

export function cloneLiveListRows<T>(source: LiveList<T>, rows: T[]): LiveList<T> {
  const meta = getLiveListMeta(source);
  if (!meta) {
    throw new Error('cloneLiveListRows requires a Live.list value');
  }

  const clone = [...rows] as LiveList<T>;
  Object.defineProperty(clone, LIVE_LIST_META, {
    value: meta,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(clone, '__kilnLiveListBrand', {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return clone;
}
