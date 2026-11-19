/**
 * Minimal JSON Schema validator. Ajv compiles validators with `new Function`, which the MV3
 * extension CSP blocks, so we validate by interpretation. Supports the subset our schemas use.
 */
type Schema = { [k: string]: unknown };

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === "number" && actual === "integer");
}

export function validate(schema: object, value: unknown, maxErrors = 20): string[] {
  const root = schema as Schema;
  const errors: string[] = [];

  const resolve = (s: Schema): Schema => {
    const ref = s.$ref;
    if (typeof ref !== "string") return s;
    const m = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
    const target = m ? ((root[m[1]] as Schema | undefined)?.[m[2]] as Schema | undefined) : undefined;
    if (!target) {
      errors.push(`unresolvable $ref ${ref}`);
      return {};
    }
    return resolve(target);
  };

  const walk = (rawSchema: Schema, v: unknown, path: string): void => {
    if (errors.length >= maxErrors) return;
    const s = resolve(rawSchema);
    const err = (msg: string) => { if (errors.length < maxErrors) errors.push(`${path}: ${msg}`); };

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => matchesType(v, t))) {
        err(`expected ${types.join("|")}, got ${typeOf(v)}`);
        return;
      }
    }
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(v)) err(`must equal ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
      err(`must be one of ${JSON.stringify(s.enum)}`);
    }
    if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) walk(sub, v, path);
    if (Array.isArray(s.anyOf)) {
      const ok = (s.anyOf as Schema[]).some((sub) => validate({ definitions: root.definitions, $defs: root.$defs, ...sub }, v, 1).length === 0);
      if (!ok) err("does not match any allowed shape");
    }
    if (Array.isArray(s.oneOf)) {
      const n = (s.oneOf as Schema[]).filter((sub) => validate({ definitions: root.definitions, $defs: root.$defs, ...sub }, v, 1).length === 0).length;
      if (n !== 1) err(`must match exactly one allowed shape (matched ${n})`);
    }

    if (typeof v === "string") {
      if (typeof s.minLength === "number" && v.length < s.minLength) err(`shorter than ${s.minLength}`);
      if (typeof s.maxLength === "number" && v.length > s.maxLength) err(`longer than ${s.maxLength}`);
      if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(v)) err(`does not match /${s.pattern}/`);
    }
    if (typeof v === "number") {
      if (typeof s.minimum === "number" && v < s.minimum) err(`below minimum ${s.minimum}`);
      if (typeof s.maximum === "number" && v > s.maximum) err(`above maximum ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems) err(`fewer than ${s.minItems} items`);
      if (typeof s.maxItems === "number" && v.length > s.maxItems) err(`more than ${s.maxItems} items`);
      if (s.items && typeof s.items === "object") v.forEach((x, i) => walk(s.items as Schema, x, `${path}[${i}]`));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const r of (s.required as string[] | undefined) ?? []) if (!(r in obj)) err(`missing required property "${r}"`);
      for (const [k, sub] of Object.entries(props)) if (k in obj) walk(sub, obj[k], `${path}.${k}`);
      for (const k of Object.keys(obj)) {
        if (k in props) continue;
        if (s.additionalProperties === false) err(`unexpected property "${k}"`);
        else if (s.additionalProperties && typeof s.additionalProperties === "object") {
          walk(s.additionalProperties as Schema, obj[k], `${path}.${k}`);
        }
      }
    }
  };

  walk(root, value, "$");
  return errors;
}

const UNSUPPORTED_KEYWORDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "maxItems", "uniqueItems", "default", "examples",
]);

/**
 * Providers' native structured-output modes accept only a subset of JSON Schema.
 * Strip what they reject and close objects; our own `validate` still enforces the full schema.
 */
export function sanitizeSchema<T>(schema: T): T {
  const clean = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(clean);
    if (!s || typeof s !== "object") return s;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYWORDS.has(k)) continue;
      if (k === "minItems" && typeof v === "number" && v > 1) continue;
      if (k === "properties" && v && typeof v === "object") {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, clean(pv)]));
      } else out[k] = clean(v);
    }
    if (out.type === "object" && out.additionalProperties === undefined) out.additionalProperties = false;
    return out;
  };
  return clean(schema) as T;
}

export function jsonInstruction(schema: object): string {
  return (
    "Respond with a single JSON object and nothing else: no prose, no markdown fences. " +
    "It must validate against this JSON Schema:\n" + JSON.stringify(schema)
  );
}
