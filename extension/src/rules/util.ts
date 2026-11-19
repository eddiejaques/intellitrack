import type { Finding, NormalizedEvent, Severity } from "../shared/types";

export type RawFinding = Omit<Finding, "id" | "source">;

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export const CONVERSION_EVENTS = new Set(["purchase", "generate_lead", "sign_up", "refund"]);

export const ids = (evs: NormalizedEvent[], cap = 20): string[] => evs.slice(0, cap).map((e) => e.id);

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function hasParam(e: NormalizedEvent, name: string): boolean {
  if (name === "items") return e.items.length > 0;
  const v = e.params[name];
  return v !== undefined && v !== "";
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
