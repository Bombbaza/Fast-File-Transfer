// Relay gateway server: wraps the FFT store with agent registration and
// consent-gated, agent-addressed file transfer.
//
// Route summary (all under /v1):
//   POST   /v1/agents/register               register presence
//   POST   /v1/transfers                     declare a new transfer to a recipient
//   PATCH  /v1/uploads/:uploadId?offset=N    chunk upload (proxied to FFT store)
//   POST   /v1/uploads/:uploadId/commit      commit upload + mark transfer committed
//   GET    /v1/transfers/incoming            list pending transfers addressed to me
//   POST   /v1/transfers/:id/accept          consent-gate: recipient accepts
//   POST   /v1/transfers/:id/decline         recipient declines (bytes deleted)
//   GET    /v1/transfers/:id/content         download (only after accept)
//   GET    /healthz                          liveness (unauthenticated)
//
// The existing FFT routes (GET /v1/files/:id, etc.) are NOT exposed here;
// the federation gateway uses transfer ids as the only addressing layer so
// recipients cannot enumerate or download files they weren't addressed.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Store, FftError } from "../store.js";
import { API_BASE, type ErrorBody } from "../protocol.js";
import type { ServerConfig } from "../config.js";
import { bearerAgentAuth, type AgentAuthenticator, type AgentPrincipal } from "./auth.js";
import { FederationRegistry } from "./registry.js";
import type { DeclareTransferRequest, DeclareTransferResponse } from "./protocol.js";

const MAX_JSON_BODY = 64 * 1024;
const MAX_CHUNK_BODY = 64 * 1024 * 1024;

export interface GatewayOptions {
  config: ServerConfig;
  /**
   * Override agent authentication. Default: bearer relay token + X-Agent-Id header.
   * See src/federation/auth.ts for the interface contract.
   */
  authenticateAgent?: AgentAuthenticator;
  /** Inject a pre-built store and/or registry (useful in tests). */
  store?: Store;
  registry?: FederationRegistry;
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
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": data.length,
  });
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

export function createFederationGateway(opts: GatewayOptions): Server {
  const { config } = opts;
  const store = opts.store ?? new Store(config);
  const registry = opts.registry ?? new FederationRegistry();
  const authenticateAgent = opts.authenticateAgent ?? bearerAgentAuth(config.token);

  /** Authenticate and throw 401 if the agent is not recognized. */
  function requireAgent(req: IncomingMessage): AgentPrincipal {
    const principal = authenticateAgent(req);
    if (!principal) {
      throw new FftError(401, "unauthorized", "missing or invalid agent credentials");
    }
    return principal;
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter((p) => p.length > 0);
    const method = req.method ?? "GET";

    // GET /healthz — unauthenticated liveness probe
    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, protocol: API_BASE, mode: "federation" });
      return;
    }

    // ---- agent routes (/v1/agents/...) --------------------------------------

    // POST /v1/agents/register
    if (method === "POST" && parts.length === 3 &&
        parts[0] === "v1" && parts[1] === "agents" && parts[2] === "register") {
      const agent = requireAgent(req);
      // The body may optionally carry {agentId} but we trust the authenticated identity.
      await readBody(req, MAX_JSON_BODY); // drain
      const record = registry.registerAgent(agent.agentId);
      sendJson(res, 200, { agentId: record.agentId, registeredAt: record.registeredAt });
      return;
    }

    // ---- transfer declaration & upload (sender side) ------------------------

    // POST /v1/transfers
    if (method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "transfers") {
      const agent = requireAgent(req);
      // Ensure sender is registered.
      if (!registry.getAgent(agent.agentId)) {
        throw new FftError(403, "not_registered", "sender must register before declaring transfers");
      }
      const body = JSON.parse((await readBody(req, MAX_JSON_BODY)).toString("utf8")) as DeclareTransferRequest;
      // Create the backing FFT upload session.
      const principal = { id: agent.agentId };
      const initResp = await store.createUpload(principal, {
        name: body.name,
        size: body.size,
        sha256: body.sha256,
        chunkSize: body.chunkSize,
      });
      // Record the transfer in the registry.
      const transfer = registry.createTransfer({
        fromAgentId: agent.agentId,
        toAgentId: body.toAgentId,
        name: body.name,
        size: body.size,
        sha256: body.sha256,
        uploadId: initResp.uploadId,
      });
      const resp: DeclareTransferResponse = {
        transferId: transfer.transferId,
        uploadId: initResp.uploadId,
        uploadSecret: initResp.uploadSecret,
        chunkSize: initResp.chunkSize,
      };
      sendJson(res, 201, resp);
      return;
    }

    // PATCH /v1/uploads/:uploadId?offset=N  — chunk upload (sender)
    if (method === "PATCH" && parts.length === 3 && parts[0] === "v1" && parts[1] === "uploads") {
      const agent = requireAgent(req);
      if (!registry.getAgent(agent.agentId)) {
        throw new FftError(403, "not_registered", "sender must register before uploading");
      }
      const uploadId = parts[2]!;
      const offset = Number(url.searchParams.get("offset"));
      const data = await readBody(req, MAX_CHUNK_BODY);
      const statusResp = await store.writeChunk(uploadId, secretHeader(req), offset, data);
      sendJson(res, 200, statusResp);
      return;
    }

    // POST /v1/uploads/:uploadId/commit — finalize upload (sender)
    if (method === "POST" && parts.length === 4 &&
        parts[0] === "v1" && parts[1] === "uploads" && parts[3] === "commit") {
      const agent = requireAgent(req);
      if (!registry.getAgent(agent.agentId)) {
        throw new FftError(403, "not_registered", "sender must register before committing");
      }
      const uploadId = parts[2]!;
      const commitResp = await store.commit(uploadId, secretHeader(req));
      // Find the transfer that backs this upload and mark it committed.
      const backedTransfer = registry.findByUploadId(uploadId);
      if (backedTransfer) {
        registry.markCommitted(backedTransfer.transferId);
      }
      sendJson(res, 200, commitResp);
      return;
    }

    // ---- recipient routes (/v1/transfers/...) --------------------------------

    // GET /v1/transfers/incoming — list incoming transfers for this agent
    if (method === "GET" && parts.length === 3 &&
        parts[0] === "v1" && parts[1] === "transfers" && parts[2] === "incoming") {
      const agent = requireAgent(req);
      if (!registry.getAgent(agent.agentId)) {
        throw new FftError(403, "not_registered", "agent must register before listing transfers");
      }
      registry.touchAgent(agent.agentId);
      const statusFilter = url.searchParams.get("status") as Parameters<typeof registry.listIncoming>[1] | null;
      const list = registry.listIncoming(agent.agentId, statusFilter ?? undefined);
      sendJson(res, 200, { transfers: list });
      return;
    }

    // /v1/transfers/:id/...
    if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "transfers") {
      const transferId = parts[2]!;

      // POST /v1/transfers/:id/accept
      if (method === "POST" && parts.length === 4 && parts[3] === "accept") {
        const agent = requireAgent(req);
        await readBody(req, MAX_JSON_BODY); // drain
        const t = registry.acceptTransfer(transferId, agent.agentId);
        sendJson(res, 200, { transferId: t.transferId, status: t.status });
        return;
      }

      // POST /v1/transfers/:id/decline
      if (method === "POST" && parts.length === 4 && parts[3] === "decline") {
        const agent = requireAgent(req);
        await readBody(req, MAX_JSON_BODY); // drain
        const t = registry.declineTransfer(transferId, agent.agentId);
        // Best-effort cleanup of the backing file — ignore errors.
        try {
          await store.deleteFile(t.uploadId);
        } catch { /* ignore — file might not exist if sender never committed */ }
        sendJson(res, 200, { transferId: t.transferId, status: t.status });
        return;
      }

      // GET /v1/transfers/:id/content — download (consent-gate enforced)
      if (method === "GET" && parts.length === 4 && parts[3] === "content") {
        const agent = requireAgent(req);
        const t = registry.authorizeDownload(transferId, agent.agentId);
        const meta = await store.fileMeta(t.uploadId);
        if (!meta) throw new FftError(404, "not_found", "file not found or expired");
        const path = store.fileReadPath(t.uploadId);
        const size = meta.size;
        const range = parseRange(req.headers["range"], size);
        const baseHeaders: Record<string, string> = {
          "content-type": "application/octet-stream",
          "accept-ranges": "bytes",
          "etag": `"${meta.sha256}"`,
          "content-disposition": `attachment; filename="${meta.name.replace(/"/g, "")}"`,
          "x-content-sha256": meta.sha256,
          "x-transfer-id": t.transferId,
          "x-from-agent": t.fromAgentId,
        };
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

/** Convenience: build, init storage, and start listening. */
export async function startFederationGateway(opts: GatewayOptions): Promise<Server> {
  const store = opts.store ?? new Store(opts.config);
  await store.init();
  const server = createFederationGateway({ ...opts, store });
  await new Promise<void>((resolve) => server.listen(opts.config.port, opts.config.host, resolve));
  const registry = opts.registry ?? new FederationRegistry();
  const timer = setInterval(() => {
    void store.gc();
    registry.gc();
  }, 5 * 60_000);
  timer.unref();
  return server;
}
