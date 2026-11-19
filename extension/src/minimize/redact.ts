export type PiiKind = "email" | "phone" | "sha256" | "hash_invalid";

const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HEX = /^[a-f0-9]+$/i;
const HASHY_KEY = /(sha|hash|email|phone|^em$|^ph$|^ud$)/i;
const PHONE_KEY = /(phone|tel|mobile|msisdn|^ph$)/i;
const PHONE_VAL = /^\+?[\d\s().-]{7,24}$/;

const digits = (s: string) => s.replace(/\D/g, "").length;

function looksLikePhone(key: string, v: string): boolean {
  if (!PHONE_VAL.test(v)) return false;
  const d = digits(v);
  if (d < 7 || d > 15) return false;
  // Bare digit strings (order numbers, SKUs) are only phones when the key says so.
  return PHONE_KEY.test(key) || /^\+\d/.test(v);
}

/** Which kinds of personal data does this (key, value) hold? Used by the PII rule. */
export function detectPii(key: string, value: string): PiiKind[] {
  const out: PiiKind[] = [];
  const v = value.trim();
  if (/^[a-f0-9]{64}$/i.test(v)) return ["sha256"];
  if (v.length >= 32 && HEX.test(v) && HASHY_KEY.test(key)) return ["hash_invalid"];
  if (looksLikePhone(key, v)) return ["phone"];
  if (new RegExp(EMAIL_G.source).test(v)) out.push("email");
  return out;
}

/** Replace personal data with a placeholder that keeps its shape (so the LLM can still judge it). */
export function redactString(key: string, value: string): string {
  const v = value.trim();
  if (/^[a-f0-9]{64}$/i.test(v)) return "[sha256:64hex]";
  if (v.length >= 32 && HEX.test(v) && HASHY_KEY.test(key)) return `[hash:invalid len=${v.length}]`;
  if (looksLikePhone(key, v)) return "[phone:plaintext]";
  return value.replace(EMAIL_G, "[email:plaintext]");
}

export function redactValue(key: string, value: string | number): string | number {
  return typeof value === "number" ? value : redactString(key, value);
}

/** `/products/12345` -> `/products/:id`. Opaque-looking segments become `:id`. */
export function normalizePath(path: string): string {
  return (
    path
      .split("/")
      .map((seg) => (isIdSegment(seg) ? ":id" : redactString("path", seg)))
      .join("/") || "/"
  );
}

function isIdSegment(seg: string): boolean {
  if (!seg) return false;
  if (/^\d+$/.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  if (/^[0-9a-f]{8,}$/i.test(seg)) return true;
  if (new RegExp(EMAIL_G.source).test(seg)) return true;
  // mixed letters+digits and long: looks like an opaque id (e.g. "A1B2C3D4E5")
  return seg.length >= 8 && /\d/.test(seg) && /[a-z]/i.test(seg) && !/[-_.]/.test(seg);
}
