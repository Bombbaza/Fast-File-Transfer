// Client library: resumable chunked upload and resumable, sha256-verified
// download. Zero dependencies — uses global fetch + node streams. Memory stays
// bounded: uploads send one chunk at a time; downloads stream with backpressure.

import { open, stat, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { sha256File } from "./hash.js";
import {
  coveredBytes, type Range,
  type InitResponse, type StatusResponse, type CommitResponse, type FileMeta,
} from "./protocol.js";

export interface UploadOptions {
  /** Base URL of the server, e.g. "http://localhost:8787". */
  server: string;
  token?: string;
  /** Local path of the file to send. */
  file: string;
  /** Override the filename advertised to the server. */
  name?: string;
  chunkSize?: number;
  /** Resume a previously-started upload instead of initialising a new one. */
  resume?: { uploadId: string; uploadSecret: string };
  onProgress?: (uploaded: number, total: number) => void;
}

export interface DownloadOptions {
  server: string;
  token?: string;
  /** File id returned by a commit. */
  id: string;
  /** Local destination path. Defaults to the stored filename in cwd. */
  dest?: string;
  onProgress?: (received: number, total: number) => void;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

const DEFAULT_CHUNK = 8 * 1024 * 1024;

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function toError(res: Response): Promise<HttpError> {
  let code = `http_${res.status}`;
  let message = res.statusText || "request failed";
  try {
    const b = (await res.json()) as { error?: string; message?: string };
    if (b.error) code = b.error;
    if (b.message) message = b.message;
  } catch { /* non-JSON body */ }
  return new HttpError(res.status, code, message);
}

async function reqJson<T>(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Retry transient failures (network errors + 5xx) with linear backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e instanceof HttpError ? e.status : 0;
      const transient = status === 0 || status >= 500;
      if (!transient || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

function isCovered(ranges: Range[], start: number, end: number): boolean {
  return ranges.some(([s, e]) => s <= start && e >= end);
}

export async function upload(o: UploadOptions): Promise<CommitResponse> {
  const st = await stat(o.file);
  const size = st.size;
  const sha256 = await sha256File(o.file);
  const name = o.name ?? basename(o.file);
  const base = o.server.replace(/\/+$/, "");
  const auth = authHeaders(o.token);

  let uploadId: string;
  let uploadSecret: string;
  let chunkSize: number;
  let ranges: Range[];

  if (o.resume) {
    uploadId = o.resume.uploadId;
    uploadSecret = o.resume.uploadSecret;
    const s = await reqJson<StatusResponse>("GET", `${base}/v1/uploads/${uploadId}`, { ...auth, "x-upload-secret": uploadSecret });
    if (s.size !== size) throw new HttpError(409, "size_mismatch", "resumed upload size differs from local file");
    chunkSize = o.chunkSize ?? DEFAULT_CHUNK;
    ranges = s.ranges;
  } else {
    const init = await reqJson<InitResponse>("POST", `${base}/v1/uploads`, auth, { name, size, sha256, chunkSize: o.chunkSize });
    uploadId = init.uploadId;
    uploadSecret = init.uploadSecret;
    chunkSize = init.chunkSize;
    ranges = init.ranges;
  }

  const chunkHeaders = { ...auth, "x-upload-secret": uploadSecret, "content-type": "application/octet-stream" };
  const fh = await open(o.file, "r");
  try {
    let uploaded = coveredBytes(ranges);
    o.onProgress?.(uploaded, size);
    for (let offset = 0; offset < size; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, size) - 1;
      if (isCovered(ranges, offset, end)) continue; // already on the server
      const len = end - offset + 1;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      await withRetry(async () => {
        const res = await fetch(`${base}/v1/uploads/${uploadId}?offset=${offset}`, {
          method: "PATCH", headers: chunkHeaders, body: buf,
        });
        if (!res.ok) throw await toError(res);
      });
      uploaded += len;
      o.onProgress?.(uploaded, size);
    }
  } finally {
    await fh.close();
  }

  const commit = await reqJson<CommitResponse>("POST", `${base}/v1/uploads/${uploadId}/commit`, { ...auth, "x-upload-secret": uploadSecret });
  if (commit.sha256 !== sha256) {
    throw new HttpError(409, "hash_mismatch", "server committed a different sha256 than the local file");
  }
  return commit;
}

export async function download(o: DownloadOptions): Promise<FileMeta> {
  const base = o.server.replace(/\/+$/, "");
  const auth = authHeaders(o.token);
  const meta = await reqJson<FileMeta>("GET", `${base}/v1/files/${o.id}/meta`, auth);
  const dest = resolve(o.dest ?? meta.name);
  await mkdir(dirname(dest), { recursive: true }).catch(() => {});

  // Resume if a partial file already exists locally.
  let start = 0;
  try {
    const s = await stat(dest);
    if (s.size > meta.size) {
      start = 0; // local file is larger than expected — restart cleanly
    } else if (s.size === meta.size) {
      const actual = await sha256File(dest);
      if (actual === meta.sha256) { o.onProgress?.(meta.size, meta.size); return meta; }
      start = 0; // same size, wrong content — restart
    } else {
      start = s.size;
    }
  } catch { /* no local file yet */ }

  const headers: Record<string, string> = { ...auth };
  if (start > 0) headers["range"] = `bytes=${start}-`;
  const res = await fetch(`${base}/v1/files/${o.id}`, { headers });
  if (!res.ok) throw await toError(res);
  if (!res.body) throw new HttpError(res.status, "empty_body", "server returned no body");

  let received = start;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (c: Buffer) => { received += c.length; o.onProgress?.(received, meta.size); });
  await pipeline(body, createWriteStream(dest, { flags: start > 0 ? "a" : "w" }));

  const actual = await sha256File(dest);
  if (actual !== meta.sha256) {
    throw new HttpError(409, "hash_mismatch", `downloaded sha256 ${actual} != expected ${meta.sha256}`);
  }
  return meta;
}
