/*
 * The Scratchwork deploy bundle — a tiny, dependency-free archive format shared
 * by the CLI (`scratchwork publish`, which packs) and the server (which unpacks).
 *
 * Why not zip/tar? The whole point of Scratchwork is to stay light: the CLI is a
 * zero-dependency Bun binary and the server is a zero-dependency Worker. A zip
 * library on each side (jszip + unzipit, as the legacy tool used) is exactly the
 * kind of dependency we're cutting. This format needs ~40 lines on each end and
 * uses only built-ins. Compression is plain gzip (RFC 1952), so the bytes are
 * interchangeable no matter which runtime packed or unpacked them — Bun uses its
 * sync `Bun.gzipSync`, while Workers and Node use the Web `CompressionStream`.
 *
 * Wire format (then gzipped as a whole):
 *
 *   "SWB1"                       4-byte magic
 *   headerLen                    uint32 little-endian
 *   header                       JSON utf8: { v: 1, files: [{ path, size }] }
 *   payload                      every file's raw bytes, concatenated in order
 *
 * gzip (via CompressionStream) collapses the per-route renderer-shell copies the
 * publish step bakes — they're byte-identical, so they compress to almost
 * nothing — which is what keeps uploads small without de-duping logic.
 */

const MAGIC = "SWB1";

// gzip/gunzip using whatever the runtime offers: Bun's sync zlib, else the Web
// CompressionStream (Cloudflare Workers, Node 18+). Output is standard gzip
// either way, so a bundle packed in one runtime unpacks in any other.
async function gzip(bytes) {
  if (typeof Bun !== "undefined" && Bun.gzipSync) return Bun.gzipSync(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decompress, enforcing an uncompressed-size cap so a gzip bomb can't exhaust
// memory (critical on Workers, which have ~128 MB). On the streaming path we
// abort as soon as the cap is crossed — we never buffer the full bomb.
async function gunzip(bytes, maxBytes) {
  if (typeof Bun !== "undefined" && Bun.gunzipSync) {
    const out = Bun.gunzipSync(bytes);
    if (maxBytes && out.length > maxBytes) throw new Error("bundle exceeds uncompressed size limit");
    return out;
  }
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (maxBytes && total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error("bundle exceeds uncompressed size limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

// Pack files (each { path, data: Uint8Array }) into a single gzipped bundle.
export async function packBundle(files) {
  const enc = new TextEncoder();
  const header = enc.encode(
    JSON.stringify({ v: 1, files: files.map((f) => ({ path: f.path, size: f.data.length })) }),
  );
  const magic = enc.encode(MAGIC);

  let total = magic.length + 4 + header.length;
  for (const f of files) total += f.data.length;

  const out = new Uint8Array(total);
  let o = 0;
  out.set(magic, o);
  o += magic.length;
  new DataView(out.buffer).setUint32(o, header.length, true);
  o += 4;
  out.set(header, o);
  o += header.length;
  for (const f of files) {
    out.set(f.data, o);
    o += f.data.length;
  }
  return gzip(out);
}

// Unpack a gzipped bundle (Uint8Array or ArrayBuffer) back into files.
// Returns [{ path, data: Uint8Array }]. Throws on a malformed bundle, or if the
// decompressed size exceeds opts.maxBytes (when given) — a gzip-bomb guard.
export async function unpackBundle(input, opts = {}) {
  const raw = await gunzip(input instanceof Uint8Array ? input : new Uint8Array(input), opts.maxBytes);
  const dec = new TextDecoder();

  if (raw.length < 8 || dec.decode(raw.subarray(0, 4)) !== MAGIC) {
    throw new Error("not a Scratchwork bundle");
  }
  const headerLen = new DataView(raw.buffer, raw.byteOffset + 4, 4).getUint32(0, true);
  const headerStart = 8;
  const headerEnd = headerStart + headerLen;
  if (headerEnd > raw.length) throw new Error("corrupt bundle header");

  const header = JSON.parse(dec.decode(raw.subarray(headerStart, headerEnd)));
  if (!header || !Array.isArray(header.files)) throw new Error("corrupt bundle header");

  const files = [];
  let o = headerEnd;
  for (const f of header.files) {
    const size = f.size | 0;
    if (o + size > raw.length) throw new Error("corrupt bundle payload");
    files.push({ path: f.path, data: raw.subarray(o, o + size) });
    o += size;
  }
  return files;
}
