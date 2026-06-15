// Server configuration, loaded from environment variables with safe defaults.
// See .env.example for documentation of each variable.

export interface ServerConfig {
  host: string;
  port: number;
  /** Shared bearer token clients must present. "" disables auth (dev only). */
  token: string;
  storageDir: string;
  /** Reject init above this many bytes (413). */
  maxFileBytes: number;
  /** Default chunk size handed to clients. */
  chunkBytes: number;
  /** Total storage quota per principal in bytes; -1 = unlimited. */
  quotaBytes: number;
  /** Days to retain a completed file; 0 = never expire. */
  retentionDays: number;
  /** Refuse an upload that would leave less than this much free disk. */
  diskMarginBytes: number;
  /** Abandon an in-progress session idle longer than this (frees its reservation). */
  sessionIdleMinutes: number;
}

const GiB = 1024 ** 3;
const MiB = 1024 * 1024;

function int(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.FFT_HOST?.trim() || "0.0.0.0",
    port: int(env.FFT_PORT, 8787),
    token: env.FFT_TOKEN ?? "",
    storageDir: env.FFT_STORAGE_DIR?.trim() || "./fft-data",
    maxFileBytes: int(env.FFT_MAX_FILE_BYTES, 20 * GiB),
    chunkBytes: int(env.FFT_CHUNK_BYTES, 8 * MiB),
    quotaBytes: int(env.FFT_QUOTA_BYTES, -1),
    retentionDays: int(env.FFT_RETENTION_DAYS, 30),
    diskMarginBytes: int(env.FFT_DISK_MARGIN_BYTES, 512 * MiB),
    sessionIdleMinutes: int(env.FFT_SESSION_IDLE_MINUTES, 60),
  };
}
