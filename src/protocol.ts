// Wire contracts + small pure helpers shared by client and server.
// No I/O here — keep this module trivially testable and dependency-free.

export const PROTOCOL_VERSION = "1";
export const API_BASE = "/v1";

/** Inclusive byte range [start, end]. */
export type Range = [number, number];

export interface InitRequest {
  /** Original filename. Server stores the basename only. */
  name: string;
  /** Total file size in bytes (>= 0). */
  size: number;
  /** Lowercase-hex sha256 of the whole file. */
  sha256: string;
  /** Client's preferred chunk size; the server may clamp it. */
  chunkSize?: number;
}

export interface InitResponse {
  uploadId: string;
  /** Capability token required for every write/status/commit on this upload. */
  uploadSecret: string;
  /** Authoritative chunk size the client should use. */
  chunkSize: number;
  /** Bytes already stored (supports resuming an interrupted upload). */
  received: number;
  ranges: Range[];
}

export interface StatusResponse {
  uploadId: string;
  name: string;
  size: number;
  received: number;
  ranges: Range[];
  /** True once ranges cover [0, size). */
  complete: boolean;
}

export interface CommitResponse {
  id: string;
  name: string;
  size: number;
  sha256: string;
  /** Epoch ms when the file auto-expires, or null if it never expires. */
  expiresAt: number | null;
}

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  sha256: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface ErrorBody {
  /** Stable machine-readable code, e.g. "file_too_large". */
  error: string;
  /** Human-readable message. */
  message: string;
}

// ---- pure range helpers (no I/O) ------------------------------------------

/** Merge overlapping/adjacent inclusive ranges into a sorted, minimal set. */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].map((r): Range => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push([cur[0], cur[1]]);
    }
  }
  return out;
}

/** Total bytes covered by a set of inclusive ranges. */
export function coveredBytes(ranges: Range[]): number {
  return mergeRanges(ranges).reduce((n, [s, e]) => n + (e - s + 1), 0);
}

/** True if the merged ranges fully cover [0, size). A 0-byte file is complete. */
export function isComplete(ranges: Range[], size: number): boolean {
  if (size === 0) return true;
  const merged = mergeRanges(ranges);
  return merged.length === 1 && merged[0]![0] === 0 && merged[0]![1] === size - 1;
}

/** Reduce an arbitrary filename to a safe basename (no path traversal, no NUL). */
export function safeName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/\0/g, "").trim();
  if (!base || base === "." || base === "..") return "download.bin";
  return base.slice(0, 255);
}

/** Validate a lowercase-hex sha256 string. */
export function isSha256Hex(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
