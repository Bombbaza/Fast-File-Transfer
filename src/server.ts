// HTTP server: maps the wire protocol onto the storage engine. Bodies are read
// with hard caps so a hostile client can't exhaust memory. Downloads stream and
// honour Range requests so an interrupted download can resume.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { Store, FftError } from "./store.js";
import { bearerAuth, type Authenticator } from "./auth.js";
import { API_BASE, type ErrorBody, type InitRequest } from "./protocol.js";
import type { ServerConfig } from "./config.js";

const MAX_JSON_BODY = 64 * 1024;          // control messages are tiny
const MAX_CHUNK_BODY = 64 * 1024 * 1024;  // matches store MAX_CHUNK

export interface ServerOptions {
  config: ServerConfig;
  /** Override the default bearer-token auth with any scheme you like. */
  authenticate?: Authenticator;
  store?: Store;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    total += c.length;
    if (total > limit) {
      req.destroy();
      throw new FftError(413, "payload_too_large", "request body exceeds limit");
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
  res.end(data);
}

function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof FftError) {
    const body: ErrorBody = { error: e.code, message: e.message };
    sendJson(res, e.status, body);
  } else {
    const body: ErrorBody = { error: "internal_error", message: "unexpected server error" };
    sendJson(res, 500, body);
  }
}

function secretHeader(req: IncomingMessage): string {
  const h = req.headers["x-upload-secret"];
  return Array.isArray(h) ? (h[0] ?? "") : (h ?? "");
}

export function createServer(opts: ServerOptions): Server {
  const { config } = opts;
  const store = opts.store ?? new Store(config);
  const authenticate = opts.authenticate ?? bearerAuth(config.token);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter((p) => p.length > 0); // e.g. ["v1","uploads","ID"]
    const method = req.method ?? "GET";

    // Health check — unauthenticated.
    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, protocol: API_BASE });
      return;
    }

    // Everything else requires authentication.
    const principal = authenticate(req);
    if (!principal) {
      res.setHeader("www-authenticate", "Bearer");
      throw new FftError(401, "unauthorized", "missing or invalid credentials");
    }

    // POST /v1/uploads — init
    if (method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "uploads") {
      const body = JSON.parse((await readBody(req, MAX_JSON_BODY)).toString("utf8")) as InitRequest;
      sendJson(res, 201, await store.createUpload(principal, body));
      return;
    }

    // /v1/uploads/:id ...
    if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "uploads") {
      const id = parts[2]!;

      // PATCH /v1/uploads/:id?offset=N — chunk
      if (method === "PATCH" && parts.length === 3) {
        const offset = Number(url.searchParams.get("offset"));
        const data = await readBody(req, MAX_CHUNK_BODY);
        sendJson(res, 200, await store.writeChunk(id, secretHeader(req), offset, data));
        return;
      }
      // GET /v1/uploads/:id — status (resume)
      if (method === "GET" && parts.length === 3) {
        sendJson(res, 200, await store.status(id, secretHeader(req)));
        return;
      }
      // POST /v1/uploads/:id/commit — finalize
      if (method === "POST" && parts.length === 4 && parts[3] === "commit") {
        sendJson(res, 200, await store.commit(id, secretHeader(req)));
        return;
      }
    }

    // /v1/files/:id ...
    if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "files") {
      const id = parts[2]!;
      const meta = await store.fileMeta(id);
      if (!meta) throw new FftError(404, "not_found", "file not found or expired");

      // GET /v1/files/:id/meta
      if (method === "GET" && parts.length === 4 && parts[3] === "meta") {
        sendJson(res, 200, {
          id: meta.id, name: meta.name, size: meta.size, sha256: meta.sha256,
          createdAt: meta.createdAt, expiresAt: meta.expiresAt,
        });
        return;
      }
      // GET /v1/files/:id — download (with optional Range)
      if (method === "GET" && parts.length === 3) {
        downloadFile(req, res, store.fileReadPath(id), meta.size, meta.name, meta.sha256);
        return;
      }
    }

    throw new FftError(404, "not_found", "no such route");
  };

  const server = createHttpServer((req, res) => {
    handler(req, res).catch((e) => {
      if (!res.headersSent) sendError(res, e);
      else res.destroy();
    });
  });
  return server;
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header || !header.startsWith("bytes=")) return null;
  const spec = header.slice(6).split(",")[0]?.trim() ?? "";
  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const startStr = spec.slice(0, dash);
  const endStr = spec.slice(dash + 1);
  let start: number;
  let end: number;
  if (startStr === "") {
    // suffix range: last N bytes
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end > size - 1) return null;
  return { start, end };
}

function downloadFile(
  req: IncomingMessage, res: ServerResponse,
  path: string, size: number, name: string, sha256: string,
): void {
  const baseHeaders: Record<string, string> = {
    "content-type": "application/octet-stream",
    "accept-ranges": "bytes",
    "etag": `"${sha256}"`,
    "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
    "x-content-sha256": sha256,
  };
  const range = parseRange(req.headers["range"], size);
  if (range) {
    const len = range.end - range.start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
      "content-length": len,
    });
    createReadStream(path, { start: range.start, end: range.end }).pipe(res);
  } else {
    res.writeHead(200, { ...baseHeaders, "content-length": size });
    createReadStream(path).pipe(res);
  }
}

/** Convenience: build, init storage, and start listening. Returns the running server. */
export async function startServer(opts: ServerOptions): Promise<Server> {
  const store = opts.store ?? new Store(opts.config);
  await store.init();
  const server = createServer({ ...opts, store });
  await new Promise<void>((resolve) => server.listen(opts.config.port, opts.config.host, resolve));
  // Periodic GC of idle sessions + expired files.
  const timer = setInterval(() => { void store.gc(); }, 5 * 60_000);
  timer.unref();
  return server;
}
