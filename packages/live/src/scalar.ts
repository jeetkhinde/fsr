export type LiveDependency = string;

export interface ScalarLiveTarget<T = unknown> {
  kind: "scalar";
  route: string;
  field: string;
  dependsOn: LiveDependency[];
  queryId: string;
  value: T;
}

export interface ScalarPatch<T = unknown> {
  kind: "scalar";
  route: string;
  field: string;
  value: T;
}

export function createScalarPatch<T>(route: string, field: string, value: T): ScalarPatch<T> {
  return { kind: "scalar", route, field, value };
}

export function isScalarPatch(value: unknown): value is ScalarPatch {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "scalar" && typeof candidate.route === "string" && typeof candidate.field === "string" && "value" in candidate;
}
