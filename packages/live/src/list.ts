export type LiveListKey = string | number;

export interface LiveListQueryContext {
  sql?: unknown;
  signal?: AbortSignal;
}

export interface LiveListOptions<T> {
  key(row: T): LiveListKey;
  dependsOn?: string | string[];
  initial?: T[];
  debounce?: number;
  revalidate?: number | false;
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
