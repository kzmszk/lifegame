// Returns null once the byte budget is exceeded. The stream is read in chunks and
// cancelled rather than buffered, so an oversized POST cannot make the isolate
// materialize it first. Both callers are paths a client reaches without an Access
// login (/csp-report is unauthenticated, /sync is Bearer-only), so the bound is
// applied before the body is held in memory rather than after.
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
