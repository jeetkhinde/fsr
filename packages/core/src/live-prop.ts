import type { LiveListOptions } from '@kiln/live';
import { createLiveList, type LiveList } from './list.js';

export interface DependencyKey {
  table: string;
  column: string;
  value: string;
}

export function depToString(key: DependencyKey): string {
  return `${key.table}:${key.column}=${key.value}`;
}

export type LiveTarget = 'dom' | 'dom-and-store' | 'store';

export class LiveProp<T> {
  public value: T;
  public dependsOn: string[];
  public patchDebounce?: number;
  public revalidateSeconds?: number | false;
  public deliveryTarget: LiveTarget = 'dom';

  constructor(
    value: T,
    dependsOn: (string | DependencyKey)[] = [],
    options?: { patchDebounce?: number; revalidate?: number | false; target?: LiveTarget }
  ) {
    this.value = value;
    this.dependsOn = dependsOn.map((dep) =>
      typeof dep === 'string' ? dep : depToString(dep)
    );
    this.patchDebounce = options?.patchDebounce;
    this.revalidateSeconds = options?.revalidate;
    if (options?.target) {
      this.deliveryTarget = options.target;
    }
  }

  static initial<T>(value: T): LiveProp<T> {
    return new LiveProp(value, []);
  }

  public debounce(seconds: number): this {
    this.patchDebounce = seconds;
    return this;
  }

  public target(target: LiveTarget): this {
    this.deliveryTarget = target;
    return this;
  }

  public revalidate(seconds: number | false): this {
    this.revalidateSeconds = seconds;
    return this;
  }
}

export const Live = {
  value<T>(
    value: T,
    dependsOn: (string | DependencyKey)[] = [],
    options?: { patchDebounce?: number; revalidate?: number | false; target?: LiveTarget }
  ): LiveProp<T> {
    return new LiveProp(value, dependsOn, options);
  },

  initial<T>(value: T): LiveProp<T> {
    return LiveProp.initial(value);
  },

  list<T>(options: LiveListOptions<T>): LiveList<T> {
    return createLiveList(options);
  },
};
