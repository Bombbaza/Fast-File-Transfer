// Federation client library: agent registration, transfer declaration,
// consent-gate operations, and chunked upload/download to a relay gateway.
// Zero dependencies — uses global fetch + Node streams, same as the core client.

import { open, stat, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { sha256File } from "../hash.js";
import { coveredBytes, type Range, type FileMeta } from "../protocol.js";
import { HttpError } from "../client.js";
import type {
  RegisterResponse,
  DeclareTransferResponse,
  TransferMeta,
  AcceptResponse,
  DeclineResponse,
} from "./protocol.js";

export interface FederationClientOptions {
  /** Base URL of the relay gateway, e.g. "https://gateway.example.com". */
  gateway: string;
  /** Shared relay token presented as a Bearer token. */
  token?: string;
  /** This agent's identity, sent as X-Agent-Id. */
  agentId: string;
}

// ---- shared helpers -------------------------------------------------------

function authHeaders(opts: FederationClientOptions): Record<string, string> {
  const h: Record<string, string> = { "x-agent-id": opts.agentId };
  if (opts.token) h["authorization"] = `Bearer ${opts.token}`;
  return h;
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

async function reqJson<T>(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

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

// ---- public API -----------------------------------------------------------

/**
 * Register this agent on the relay gateway. Re-registration is idempotent
 * and refreshes the last-seen timestamp.
 */
export async function registerAgent(opts: FederationClientOptions): Promise<RegisterResponse> {
  const base = opts.gateway.replace(/\/+$/, "");
  return reqJson<RegisterResponse>("POST", `${base}/v1/agents/register`, authHeaders(opts));
}

export interface SendToAgentOptions extends FederationClientOptions {
  /** Local file path to send. */
  file: string;
  /** Recipient agent id. */
  toAgentId: string;
  /** Override the filename advertised to the recipient. */
  name?: string;
  chunkSize?: number;
  onProgress?: (uploaded: number, total: number) => void;
}

/**
 * Upload a file to the relay gateway addressed to a recipient agent.
 * The recipient must call acceptTransfer before downloading.
 * Returns the transferId and integrity info.
 */
export async function sendToAgent(
  o: SendToAgentOptions,
): Promise<{ transferId: string; sha256: string; size: number }> {
  const st = await stat(o.file);
  const size = st.size;
  const sha256 = await sha256File(o.file);
  const name = o.name ?? basename(o.file);
  const base = o.gateway.replace(/\/+$/, "");
  const ah = authHeaders(o);

  // Declare the transfer; gateway allocates the backing FFT upload session.
  const decl = await reqJson<DeclareTransferResponse>(
    "POST",
    `${base}/v1/transfers`,
    ah,
    { toAgentId: o.toAgentId, name, size, sha256, chunkSize: o.chunkSize },
  );

  const { uploadId, uploadSecret, chunkSize } = decl;
  const chunkHeaders = {
    ...ah,
    "x-upload-secret": uploadSecret,
    "content-type": "application/octet-stream",
  };

  const fh = await open(o.file, "r");
  try {
    const ranges: Range[] = [];
    o.onProgress?.(0, size);
    for (let offset = 0; offset < size; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, size) - 1;
      if (isCovered(ranges, offset, end)) continue;
      const len = end - offset + 1;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      await withRetry(async () => {
        const res = await fetch(`${base}/v1/uploads/${uploadId}?offset=${offset}`, {
          method: "PATCH",
          headers: chunkHeaders,
          body: buf,
        });
        if (!res.ok) throw await toError(res);
        const status = (await res.json()) as { ranges?: Range[] };
        if (status.ranges) {
          for (const r of status.ranges) ranges.push(r);
        }
      });
      o.onProgress?.(coveredBytes(ranges), size);
    }
    if (size === 0) o.onProgress?.(0, 0);
  } finally {
    await fh.close();
  }

  // Commit — gateway marks the backing transfer as committed.
  await reqJson<unknown>(
    "POST",
    `${base}/v1/uploads/${uploadId}/commit`,
    { ...ah, "x-upload-secret": uploadSecret },
  );

  return { transferId: decl.transferId, sha256, size };
}

export interface IncomingOptions extends FederationClientOptions {
  /** Filter by transfer status. */
  status?: "pending" | "accepted" | "declined";
}

/** List transfers addressed to this agent (metadata only — no bytes). */
export async function listIncoming(o: IncomingOptions): Promise<TransferMeta[]> {
  const base = o.gateway.replace(/\/+$/, "");
  const qs = o.status ? `?status=${encodeURIComponent(o.status)}` : "";
  const resp = await reqJson<{ transfers: TransferMeta[] }>(
    "GET",
    `${base}/v1/transfers/incoming${qs}`,
    authHeaders(o),
  );
  return resp.transfers;
}

export interface ConsentOptions extends FederationClientOptions {
  transferId: string;
}

/** Accept a pending transfer — enables the recipient to download it. */
export async function acceptTransfer(o: ConsentOptions): Promise<AcceptResponse> {
  const base = o.gateway.replace(/\/+$/, "");
  return reqJson<AcceptResponse>(
    "POST",
    `${base}/v1/transfers/${o.transferId}/accept`,
    authHeaders(o),
  );
}

/** Decline a pending transfer — gateway drops the backing bytes. */
export async function declineTransfer(o: ConsentOptions): Promise<DeclineResponse> {
  const base = o.gateway.replace(/\/+$/, "");
  return reqJson<DeclineResponse>(
    "POST",
    `${base}/v1/transfers/${o.transferId}/decline`,
    authHeaders(o),
  );
}

export interface DownloadTransferOptions extends FederationClientOptions {
  transferId: string;
  /** Local destination path. Defaults to the stored filename in cwd. */
  dest?: string;
  onProgress?: (received: number, total: number) => void;
}

/**
 * Download an accepted transfer. Streams the content and verifies sha256
 * client-side after the full file is received.
 */
export async function downloadTransfer(
  o: DownloadTransferOptions,
): Promise<FileMeta & { transferId: string }> {
  const base = o.gateway.replace(/\/+$/, "");
  const ah = authHeaders(o);

  const res = await fetch(`${base}/v1/transfers/${o.transferId}/content`, { headers: ah });
  if (!res.ok) throw await toError(res);
  if (!res.body) throw new HttpError(res.status, "empty_body", "server returned no body");

  const sha256 = res.headers.get("x-content-sha256") ?? "";
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  const disposition = res.headers.get("content-disposition") ?? "";
  const fnMatch = /filename="([^"]+)"/.exec(disposition);
  const storedName = fnMatch ? fnMatch[1]! : `transfer-${o.transferId}`;
  const dest = resolve(o.dest ?? storedName);
  await mkdir(dirname(dest), { recursive: true }).catch(() => {});

  let received = 0;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (c: Buffer) => {
    received += c.length;
    o.onProgress?.(received, contentLength);
  });
  await pipeline(body, createWriteStream(dest));

  if (sha256) {
    const actual = await sha256File(dest);
    if (actual !== sha256) {
      throw new HttpError(409, "hash_mismatch", `downloaded sha256 ${actual} != expected ${sha256}`);
    }
  }

  return {
    id: o.transferId,
    transferId: o.transferId,
    name: storedName,
    size: contentLength,
    sha256,
    createdAt: Date.now(),
    expiresAt: null,
  };
}
