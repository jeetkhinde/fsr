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
  public deliveryTarget: LiveTarget = 'dom';

  constructor(
    value: T,
    dependsOn: (string | DependencyKey)[] = [],
    options?: { patchDebounce?: number; target?: LiveTarget }
  ) {
    this.value = value;
    this.dependsOn = dependsOn.map((dep) =>
      typeof dep === 'string' ? dep : depToString(dep)
    );
    this.patchDebounce = options?.patchDebounce;
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
}
