import type { LiveListQueryContext } from '@kiln/live';

export interface RegisteredLiveListTarget<T = unknown> {
  route: string;
  name: string;
  dependsOn: string[];
  keyOf(row: T): string;
  query(ctx: LiveListQueryContext): Promise<T[]> | T[];
  renderRows(rows: T[]): Promise<Map<string, string>>;
}

export function liveListTargetKey(route: string, name: string): string {
  return `${route}\0${name}`;
}
