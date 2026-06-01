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
