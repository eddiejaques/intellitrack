/** Concatenate the byte chunks of webRequest requestBody.raw and decode as UTF-8. */
export function decodeRawBody(raw: { bytes?: ArrayBuffer }[] | undefined): string | undefined {
  if (!raw || raw.length === 0) return undefined;
  const chunks = raw.filter((c) => c.bytes).map((c) => new Uint8Array(c.bytes!));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return new TextDecoder("utf-8").decode(all);
}

/**
 * B5: the request body as text, whichever way Chrome reports it. Form-encoded and multipart POSTs
 * (sendBeacon with FormData, form submits) come as `formData`, not `raw`: re-encode those as
 * `k=v&…` so parsers read them like a query string.
 */
export function decodeBody(rb: { raw?: { bytes?: ArrayBuffer }[]; formData?: Record<string, string[]> } | undefined): string | undefined {
  if (!rb) return undefined;
  const raw = decodeRawBody(rb.raw);
  if (raw !== undefined) return raw;
  if (!rb.formData) return undefined;
  const q = new URLSearchParams();
  for (const [k, vs] of Object.entries(rb.formData)) for (const v of vs) q.append(k, v);
  return q.toString();
}
