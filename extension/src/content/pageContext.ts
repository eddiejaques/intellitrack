export interface PageContext {
  domain: string;
  path_pattern: string;
  title: string;
  meta_description: string;
  og_type: string;
  schema_types: string[];
  forms: { field_types: string[] }[];
  headings: string[];
  nav_labels: string[];
  /** filled in by the background from captured events, not by the page */
  vendors_detected?: { vendor: string; property: string }[];
}

/**
 * Runs inside the page via chrome.scripting.executeScript({ func }), so it is serialised and must
 * not reference anything outside its own body. It collects structure only: no form values, no
 * input names, no URL query, no cookies. Emails in visible text are masked.
 */
export function extractPageContext(): PageContext {
  const mask = (s: string, n: number) =>
    s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]").replace(/\s+/g, " ").trim().slice(0, n);
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];

  const path = location.pathname
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || (seg.length >= 8 && /\d/.test(seg) && /[a-z]/i.test(seg) && !/[-_.]/.test(seg)) ? ":id" : mask(seg, 40)))
    .join("/") || "/";

  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content ?? "";

  const types: string[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string") types.push(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.push(x));
    for (const v of Object.values(o)) if (v && typeof v === "object") collect(v);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try { collect(JSON.parse(s.textContent ?? "")); } catch { /* ignore malformed JSON-LD */ }
  });
  document.querySelectorAll("[itemtype]").forEach((el) => {
    const it = el.getAttribute("itemtype") ?? "";
    const m = /schema\.org\/(\w+)/.exec(it);
    if (m) types.push(m[1]);
  });

  const forms = [...document.forms].slice(0, 6).map((f) => ({
    field_types: [...f.elements]
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === "input") return (el as HTMLInputElement).type || "text";
        return tag; // select, textarea, button
      })
      .filter((t) => t !== "hidden" && t !== "button" && t !== "submit")
      .slice(0, 20),
  }));

  const headings = [...document.querySelectorAll("h1, h2")].map((h) => mask(h.textContent ?? "", 80)).filter(Boolean).slice(0, 8);
  const navRoots = document.querySelectorAll('nav, [role="navigation"], header');
  const nav_labels = uniq(
    [...navRoots].flatMap((n) => [...n.querySelectorAll("a, button")].map((a) => mask(a.textContent ?? "", 30))).filter((t) => t && t.length > 1),
  ).slice(0, 12);

  return {
    domain: location.hostname,
    path_pattern: path,
    title: mask(document.title, 120),
    meta_description: mask(meta('meta[name="description"]'), 200),
    og_type: meta('meta[property="og:type"]').slice(0, 40),
    schema_types: uniq(types).slice(0, 15),
    forms,
    headings,
    nav_labels,
  };
}
