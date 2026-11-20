/** What the page-side observer reports for one item pushed to a data layer. */
export interface RawPush {
  /** ms epoch when the push happened (or when it was found, for replayed items) */
  at: number;
  /** "gtag": a gtag() `arguments` object; "object": a plain object push; "other": arrays, strings, … */
  kind: "gtag" | "object" | "other";
  /** a JSON-safe, size-limited copy of what was pushed (not yet redacted) */
  payload: unknown;
  /** the item was already in the array when the observer hooked it */
  replayed?: boolean;
  /** the global the array lives on (dataLayer, or a renamed one from gtm.js?l=…) */
  layer?: string;
}

/**
 * Runs in the page's MAIN world via chrome.scripting.executeScript({ world: "MAIN", func }), so it is
 * serialised and must not reference anything outside its own body.
 *
 * It wraps `push` on `window.dataLayer` (and renamed layers named by `gtm.js?l=…` / `gtag/js?l=…`
 * or passed in `extra`) and reports every pushed item. `push` stays an accessor on the array, so
 * when GTM or gtag.js later assign their own `push`, it becomes the inner function and the wrapper
 * stays outermost. What the page's push returns or throws is passed through unchanged. Items already
 * in the array when it is hooked are reported as replayed, so nothing pushed before injection is lost.
 *
 * `emit` is for tests; in the page, items go to the extension's isolated-world relay via postMessage.
 */
export function installDataLayerObserver(extra: string[] = [], emit?: (p: RawPush) => void): boolean {
  const w = window as any;
  const KEY = "__intellitrack_dl";
  const fresh = !w[KEY];
  if (fresh) {
    Object.defineProperty(w, KEY, {
      configurable: true,
      enumerable: false,
      value: { names: {} as Record<string, true>, hooked: new WeakSet<object>(), seen: {} as Record<string, unknown> },
    });
  }
  const st = w[KEY] as { names: Record<string, true>; hooked: WeakSet<object>; seen: Record<string, unknown> };
  const send = emit ?? ((p: RawPush) => {
    try { window.postMessage({ source: "intellitrack-dl", push: p }, "*"); } catch { /* never break the page */ }
  });

  const isArgs = (x: unknown) => Object.prototype.toString.call(x) === "[object Arguments]";
  const clone = (v: unknown, depth: number, path: unknown[]): unknown => {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 500)}…` : v;
    if (v === undefined) return undefined;
    if (typeof v === "function") return "[function]";
    if (typeof v !== "object") return String(v);
    if (v instanceof Date) return Number.isNaN(+v) ? "[date]" : v.toISOString();
    if (typeof Node !== "undefined" && v instanceof Node) return `[element ${(v as Element).tagName?.toLowerCase() ?? v.nodeName}]`;
    if (v === window) return "[window]";
    if (path.includes(v)) return "[circular]";
    if (depth >= 6) return "[…]";
    const next = [...path, v];
    if (Array.isArray(v) || isArgs(v)) {
      return Array.from(v as ArrayLike<unknown>).slice(0, 50).map((x) => { const c = clone(x, depth + 1, next); return c === undefined ? null : c; });
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= 50) { out["…"] = "more keys"; break; }
      let x: unknown;
      try { x = (v as Record<string, unknown>)[k]; } catch { x = "[unreadable]"; }
      const c = clone(x, depth + 1, next);
      if (c !== undefined) out[k] = c;
    }
    return out;
  };

  const record = (item: unknown, layer: string, replayed: boolean) => {
    try {
      const kind = isArgs(item) ? "gtag" : item && typeof item === "object" && !Array.isArray(item) ? "object" : "other";
      const p: RawPush = { at: Date.now(), kind, payload: clone(item, 0, []), layer };
      if (replayed) p.replayed = true;
      send(p);
    } catch { /* never break the page */ }
  };

  const hook = (arr: unknown, layer: string) => {
    if (!arr || typeof arr !== "object" || st.hooked.has(arr)) return;
    const a = arr as { push?: unknown; length?: number };
    if (typeof a.push !== "function") return;
    st.hooked.add(arr);
    try { for (const item of Array.from(arr as ArrayLike<unknown>)) record(item, layer, true); } catch { /* not array-like */ }
    // chain[0] is the push the array had; later assignments (GTM, gtag.js) stack on top. GTM's own
    // push calls the one it found (our wrapper), so a nested call steps one level down the chain.
    const chain: ((...xs: unknown[]) => unknown)[] = [a.push as (...xs: unknown[]) => unknown];
    let level = 0;
    const wrapper = function (this: unknown, ...args: unknown[]) {
      level++;
      try {
        if (level === 1) for (const x of args) record(x, layer, false);
        const fn = chain[chain.length - level] ?? Array.prototype.push;
        return fn.apply(this, args);
      } finally {
        level--;
      }
    };
    try {
      Object.defineProperty(arr, "push", {
        configurable: true,
        enumerable: false,
        get: () => wrapper,
        set: (fn: unknown) => { if (typeof fn === "function" && fn !== wrapper) chain.push(fn as (...xs: unknown[]) => unknown); },
      });
    } catch { /* frozen array: leave it alone */ }
  };

  const watch = (name: string) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || st.names[name]) return;
    st.names[name] = true;
    const cur = w[name];
    if (cur !== undefined) hook(cur, name);
    st.seen[name] = cur;
    const d = Object.getOwnPropertyDescriptor(w, name);
    if (!d || d.configurable) {
      // a dataLayer created (or replaced) after injection is hooked when it is assigned
      let val = cur;
      try {
        Object.defineProperty(w, name, {
          configurable: true,
          enumerable: true,
          get: () => val,
          set: (v: unknown) => { val = v; hook(v, name); },
        });
      } catch { /* fall back to polling below */ }
    }
  };

  const LIB = /\/(?:gtm\.js|gtag\/js)\?(?:[^#]*&)?l=([A-Za-z_$][\w$]*)/;
  const fromScript = (n: Node) => {
    const src = (n as HTMLScriptElement).src;
    const m = typeof src === "string" ? LIB.exec(src) : null;
    if (m) watch(m[1]);
  };

  watch("dataLayer");
  for (const n of extra) watch(n);
  if (fresh) {
    try { document.querySelectorAll("script[src]").forEach(fromScript); } catch { /* no document yet */ }
    try {
      new MutationObserver((ms) => {
        for (const m of ms) m.addedNodes.forEach((n) => { if (n.nodeName === "SCRIPT") fromScript(n); });
      }).observe(document, { childList: true, subtree: true });
    } catch { /* no document yet */ }
    // a `var dataLayer` declared before injection can't be turned into an accessor: watch for replacement
    setInterval(() => {
      for (const name of Object.keys(st.names)) {
        const v = w[name];
        if (v !== st.seen[name]) { st.seen[name] = v; hook(v, name); }
      }
    }, 1000);
  }
  return fresh;
}

/**
 * Runs in the extension's ISOLATED world on the same page and forwards what the MAIN-world observer
 * posts to the background. Self-contained for the same reason as the observer.
 */
export function installDataLayerRelay(): void {
  const w = window as any;
  if (w.__intellitrack_relay) return;
  w.__intellitrack_relay = true;
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data as { source?: string; push?: unknown } | null;
    if (!d || d.source !== "intellitrack-dl" || !d.push) return;
    try { void chrome.runtime.sendMessage({ type: "dataLayerPush", push: d.push }).catch(() => undefined); } catch { /* extension reloaded */ }
  });
}
