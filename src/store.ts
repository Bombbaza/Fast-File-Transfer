// Server-side storage engine: upload sessions, offset-addressed chunk writes,
// resumable range bookkeeping, reserve-aware disk/quota gating, sha256-verified
// atomic commit, and garbage collection. Constant memory — never buffers a whole
// file (chunks are written straight to an fd at their offset; commit re-hashes by
// streaming; download streams).

import { open, mkdir, rename, stat, readFile, writeFile, unlink, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { sha256File, randomId, safeEqual, sha256Buffer } from "./hash.js";
import {
  mergeRanges, coveredBytes, isComplete, safeName, isSha256Hex,
  type Range, type InitRequest, type InitResponse, type StatusResponse,
  type CommitResponse, type FileMeta,
} from "./protocol.js";
import type { ServerConfig } from "./config.js";
import type { Principal } from "./auth.js";

/** Carries an HTTP status + machine code so the server can render it verbatim. */
export class FftError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "FftError";
  }
}

interface Session {
  uploadId: string;
  principalId: string;
  name: string;
  size: number;
  sha256: string;
  /** sha256 of the upload secret — the raw secret is never persisted. */
  secretHash: string;
  chunkSize: number;
  ranges: Range[];
  createdAt: number;
  updatedAt: number;
}

const MIN_CHUNK = 64 * 1024;          // 64 KiB
const MAX_CHUNK = 64 * 1024 * 1024;   // 64 MiB

export class Store {
  private readonly sessionsDir: string;
  private readonly filesDir: string;
  /** Per-key promise chain — serializes mutations to one session's metadata. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly cfg: ServerConfig) {
    this.sessionsDir = join(cfg.storageDir, "sessions");
    this.filesDir = join(cfg.storageDir, "files");
  }

  async init(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.filesDir, { recursive: true });
  }

  // ---- serialization -------------------------------------------------------

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  // ---- paths / persistence -------------------------------------------------

  private partialPath(id: string): string { return join(this.sessionsDir, `${id}.partial`); }
  private sessionPath(id: string): string { return join(this.sessionsDir, `${id}.json`); }
  private filePath(id: string): string { return join(this.filesDir, id); }
  private fileMetaPath(id: string): string { return join(this.filesDir, `${id}.json`); }

  private async readSession(id: string): Promise<Session | null> {
    try {
      return JSON.parse(await readFile(this.sessionPath(id), "utf8")) as Session;
    } catch {
      return null;
    }
  }

  private async writeSession(s: Session): Promise<void> {
    await writeFile(this.sessionPath(s.uploadId), JSON.stringify(s), "utf8");
  }

  private requireSecret(s: Session, secret: string): void {
    // Constant-time compare of the secret's hash binds writes to the initiator,
    // even when many callers share the same bearer token.
    if (!safeEqual(s.secretHash, sha256Buffer(Buffer.from(secret, "utf8")) )) {
      throw new FftError(403, "forbidden", "invalid upload secret");
    }
  }

  // ---- capacity accounting -------------------------------------------------

  private async freeDiskBytes(): Promise<number | null> {
    try {
      const s = await statfs(this.cfg.storageDir);
      return s.bavail * s.bsize;
    } catch {
      return null; // fail-open (e.g. Windows / unsupported fs)
    }
  }

  /** Open sessions: committed file bytes + reserved (declared-but-unwritten) bytes. */
  private async usageAndReserved(principalId: string): Promise<{ committed: number; reserved: number }> {
    let committed = 0;
    let reserved = 0;
    let metaNames: string[] = [];
    try { metaNames = await readdir(this.filesDir); } catch { /* none yet */ }
    for (const n of metaNames) {
      if (!n.endsWith(".json")) continue;
      try {
        const m = JSON.parse(await readFile(join(this.filesDir, n), "utf8")) as FileMeta & { principalId: string };
        if (m.principalId === principalId) committed += m.size;
      } catch { /* skip unreadable */ }
    }
    let sessNames: string[] = [];
    try { sessNames = await readdir(this.sessionsDir); } catch { /* none */ }
    for (const n of sessNames) {
      if (!n.endsWith(".json")) continue;
      const s = await this.readSession(n.slice(0, -5));
      if (s && s.principalId === principalId) reserved += Math.max(0, s.size - coveredBytes(s.ranges));
    }
    return { committed, reserved };
  }

  /** Bytes reserved (declared-but-unwritten) across ALL principals — disk is global. */
  private async globalReservedBytes(): Promise<number> {
    let total = 0;
    let names: string[] = [];
    try { names = await readdir(this.sessionsDir); } catch { return 0; }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const s = await this.readSession(n.slice(0, -5));
      if (s) total += Math.max(0, s.size - coveredBytes(s.ranges));
    }
    return total;
  }

  // ---- upload lifecycle ----------------------------------------------------

  async createUpload(principal: Principal, req: InitRequest): Promise<InitResponse> {
    if (!Number.isInteger(req.size) || req.size < 0) {
      throw new FftError(400, "bad_request", "size must be a non-negative integer");
    }
    if (req.size > this.cfg.maxFileBytes) {
      throw new FftError(413, "file_too_large", `file exceeds max of ${this.cfg.maxFileBytes} bytes`);
    }
    if (!isSha256Hex(req.sha256)) {
      throw new FftError(400, "bad_request", "sha256 must be 64 lowercase hex chars");
    }

    const chunkSize = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, req.chunkSize ?? this.cfg.chunkBytes));

    // Quota (per principal): committed + reserved + this file must fit.
    if (this.cfg.quotaBytes >= 0) {
      const { committed, reserved } = await this.usageAndReserved(principal.id);
      if (committed + reserved + req.size > this.cfg.quotaBytes) {
        throw new FftError(413, "quota_exceeded", "storage quota exceeded for this principal");
      }
    }

    // Disk headroom (global): account every in-flight reservation so concurrent
    // inits can't collectively over-commit the volume.
    const free = await this.freeDiskBytes();
    if (free !== null) {
      const need = req.size + (await this.globalReservedBytes());
      if (free - need < this.cfg.diskMarginBytes) {
        throw new FftError(507, "insufficient_storage", "not enough free disk for this upload");
      }
    }

    const uploadId = randomId(16);
    const uploadSecret = randomId(24);
    const now = Date.now();
    const session: Session = {
      uploadId,
      principalId: principal.id,
      name: safeName(req.name),
      size: req.size,
      sha256: req.sha256,
      secretHash: sha256Buffer(Buffer.from(uploadSecret, "utf8")),
      chunkSize,
      ranges: [],
      createdAt: now,
      updatedAt: now,
    };
    // Pre-create the (sparse) partial file so chunk writes can seek into it.
    const fh = await open(this.partialPath(uploadId), "w");
    await fh.close();
    await this.writeSession(session);

    return { uploadId, uploadSecret, chunkSize, received: 0, ranges: [] };
  }

  async writeChunk(uploadId: string, secret: string, offset: number, data: Buffer): Promise<StatusResponse> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new FftError(400, "bad_request", "offset must be a non-negative integer");
    }
    return this.withLock(uploadId, async () => {
      const s = await this.readSession(uploadId);
      if (!s) throw new FftError(404, "not_found", "upload session not found");
      this.requireSecret(s, secret);
      if (data.length === 0) throw new FftError(400, "bad_request", "empty chunk");
      const end = offset + data.length - 1;
      if (end > s.size - 1) {
        throw new FftError(409, "range_overflow", "chunk extends past declared file size");
      }
      const fh = await open(this.partialPath(uploadId), "r+");
      try {
        await fh.write(data, 0, data.length, offset);
        await fh.sync();
      } finally {
        await fh.close();
      }
      s.ranges = mergeRanges([...s.ranges, [offset, end]]);
      s.updatedAt = Date.now();
      await this.writeSession(s);
      return this.toStatus(s);
    });
  }

  async status(uploadId: string, secret: string): Promise<StatusResponse> {
    const s = await this.readSession(uploadId);
    if (!s) throw new FftError(404, "not_found", "upload session not found");
    this.requireSecret(s, secret);
    return this.toStatus(s);
  }

  private toStatus(s: Session): StatusResponse {
    return {
      uploadId: s.uploadId,
      name: s.name,
      size: s.size,
      received: coveredBytes(s.ranges),
      ranges: mergeRanges(s.ranges),
      complete: isComplete(s.ranges, s.size),
    };
  }

  async commit(uploadId: string, secret: string): Promise<CommitResponse> {
    return this.withLock(uploadId, async () => {
      const s = await this.readSession(uploadId);
      if (!s) throw new FftError(404, "not_found", "upload session not found");
      this.requireSecret(s, secret);
      if (!isComplete(s.ranges, s.size)) {
        throw new FftError(409, "upload_incomplete", "not all byte ranges have been uploaded");
      }
      const partial = this.partialPath(uploadId);
      const onDisk = await stat(partial);
      if (onDisk.size !== s.size) {
        throw new FftError(409, "size_mismatch", `on-disk size ${onDisk.size} != declared ${s.size}`);
      }
      const actual = await sha256File(partial);
      if (!safeEqual(actual, s.sha256)) {
        await unlink(partial).catch(() => {});
        await unlink(this.sessionPath(uploadId)).catch(() => {});
        throw new FftError(409, "hash_mismatch", "uploaded content does not match declared sha256");
      }
      const expiresAt = this.cfg.retentionDays > 0
        ? s.createdAt + this.cfg.retentionDays * 86_400_000
        : null;
      const meta: FileMeta & { principalId: string } = {
        id: uploadId, name: s.name, size: s.size, sha256: s.sha256,
        principalId: s.principalId, createdAt: Date.now(), expiresAt,
      };
      await rename(partial, this.filePath(uploadId));
      await writeFile(this.fileMetaPath(uploadId), JSON.stringify(meta), "utf8");
      await unlink(this.sessionPath(uploadId)).catch(() => {});
      return { id: uploadId, name: s.name, size: s.size, sha256: s.sha256, expiresAt };
    });
  }

  // ---- download ------------------------------------------------------------

  async fileMeta(id: string): Promise<(FileMeta & { principalId: string }) | null> {
    try {
      const m = JSON.parse(await readFile(this.fileMetaPath(id), "utf8")) as FileMeta & { principalId: string };
      if (m.expiresAt !== null && m.expiresAt < Date.now()) return null;
      return m;
    } catch {
      return null;
    }
  }

  fileReadPath(id: string): string { return this.filePath(id); }

  // ---- garbage collection --------------------------------------------------

  /** Remove idle sessions (frees their reservation) and expired files. Returns counts. */
  async gc(): Promise<{ sessions: number; files: number }> {
    const idleCutoff = Date.now() - this.cfg.sessionIdleMinutes * 60_000;
    let sessions = 0;
    let files = 0;
    let sNames: string[] = [];
    try { sNames = await readdir(this.sessionsDir); } catch { /* none */ }
    for (const n of sNames) {
      if (!n.endsWith(".json")) continue;
      const id = n.slice(0, -5);
      const s = await this.readSession(id);
      if (s && s.updatedAt < idleCutoff) {
        await unlink(this.partialPath(id)).catch(() => {});
        await unlink(this.sessionPath(id)).catch(() => {});
        sessions++;
      }
    }
    let fNames: string[] = [];
    try { fNames = await readdir(this.filesDir); } catch { /* none */ }
    for (const n of fNames) {
      if (!n.endsWith(".json")) continue;
      const id = n.slice(0, -5);
      try {
        const m = JSON.parse(await readFile(join(this.filesDir, n), "utf8")) as FileMeta;
        if (m.expiresAt !== null && m.expiresAt < Date.now()) {
          await unlink(this.filePath(id)).catch(() => {});
          await unlink(this.fileMetaPath(id)).catch(() => {});
          files++;
        }
      } catch { /* skip */ }
    }
    return { sessions, files };
  }
}
