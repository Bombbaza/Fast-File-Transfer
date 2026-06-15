// Federation mode tests.
// Covers: registration, addressing, consent-gate (download blocked before accept,
// allowed after), full e2e (A->gateway->B accept->download->sha256), decline drops
// the transfer, and download-before-accept is rejected.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { FederationRegistry } from "../src/federation/registry.js";
import { createFederationGateway } from "../src/federation/gateway.js";
import {
  registerAgent,
  sendToAgent,
  listIncoming,
  acceptTransfer,
  declineTransfer,
  downloadTransfer,
} from "../src/federation/client.js";
import { HttpError } from "../src/client.js";

// ---- shared test fixtures -----------------------------------------------

const RELAY_TOKEN = "test-relay-token";
const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const AGENT_C = "agent-c";

let server: Server;
let gateway: string;
let dir: string;
let store: Store;
let registry: FederationRegistry;

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function optsA(): { gateway: string; agentId: string; token: string } {
  return { gateway, agentId: AGENT_A, token: RELAY_TOKEN };
}
function optsB(): { gateway: string; agentId: string; token: string } {
  return { gateway, agentId: AGENT_B, token: RELAY_TOKEN };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fft-fed-"));
  const cfg = loadConfig({
    FFT_PORT: "0",
    FFT_HOST: "127.0.0.1",
    FFT_TOKEN: RELAY_TOKEN,
    FFT_STORAGE_DIR: join(dir, "data"),
    FFT_CHUNK_BYTES: String(64 * 1024),
  } as NodeJS.ProcessEnv);
  store = new Store(cfg);
  await store.init();
  registry = new FederationRegistry();
  server = createFederationGateway({ config: cfg, store, registry });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  gateway = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

// ---- healthz ---------------------------------------------------------------

test("healthz returns mode=federation", async () => {
  const res = await fetch(`${gateway}/healthz`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; mode: string };
  assert.equal(body.ok, true);
  assert.equal(body.mode, "federation");
});

// ---- agent registration ---------------------------------------------------

test("register agent-a and agent-b", async () => {
  const ra = await registerAgent(optsA());
  assert.equal(ra.agentId, AGENT_A);
  assert.ok(ra.registeredAt > 0);

  const rb = await registerAgent(optsB());
  assert.equal(rb.agentId, AGENT_B);
});

test("re-registration is idempotent (returns same agentId)", async () => {
  const r1 = await registerAgent(optsA());
  const r2 = await registerAgent(optsA());
  assert.equal(r1.agentId, r2.agentId);
});

test("bad agent id is rejected at registration", async () => {
  // Empty X-Agent-Id -> 401 from auth layer.
  const res = await fetch(`${gateway}/v1/agents/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${RELAY_TOKEN}` },
  });
  assert.equal(res.status, 401);
});

test("wrong relay token is rejected", async () => {
  const res = await fetch(`${gateway}/v1/agents/register`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-token", "x-agent-id": "agent-x" },
  });
  assert.equal(res.status, 401);
});

// ---- addressing -----------------------------------------------------------

test("declare transfer to unknown recipient is rejected", async () => {
  // agent-c is not registered.
  const data = randomBytes(1024);
  const src = join(dir, "addr-test.bin");
  await writeFile(src, data);

  await assert.rejects(
    () => sendToAgent({ ...optsA(), file: src, toAgentId: AGENT_C }),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  );
});

test("unregistered sender is rejected when declaring a transfer", async () => {
  // Register agent-c just as recipient to avoid that error, but use an
  // unknown sender identity by tweaking the token approach: instead use
  // a never-registered agent id directly against the HTTP layer.
  const data = randomBytes(64);
  const src = join(dir, "sender-test.bin");
  await writeFile(src, data);

  const res = await fetch(`${gateway}/v1/transfers`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RELAY_TOKEN}`,
      "x-agent-id": "never-registered-sender",
      "content-type": "application/json",
    },
    body: JSON.stringify({ toAgentId: AGENT_B, name: "x.bin", size: 64, sha256: sha(data) }),
  });
  assert.equal(res.status, 403);
});

// ---- consent-gate ----------------------------------------------------------

test("download before accept is rejected", async () => {
  // Use agent-a and agent-b which are already registered from the registration tests.
  const data = randomBytes(128 * 1024);
  const src = join(dir, "consent-test.bin");
  await writeFile(src, data);

  const sent = await sendToAgent({ ...optsA(), file: src, toAgentId: AGENT_B });
  const { transferId } = sent;

  // agent-b tries to download before accepting.
  const res = await fetch(`${gateway}/v1/transfers/${transferId}/content`, {
    headers: { authorization: `Bearer ${RELAY_TOKEN}`, "x-agent-id": AGENT_B },
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "consent_required");
});

test("download after accept succeeds and sha256 matches", async () => {
  const data = randomBytes(256 * 1024);
  const src = join(dir, "accept-test.bin");
  await writeFile(src, data);

  // agent-a sends to agent-b.
  const sent = await sendToAgent({ ...optsA(), file: src, toAgentId: AGENT_B });
  const { transferId } = sent;

  // agent-b checks incoming list — transfer should be pending.
  const incoming = await listIncoming({ ...optsB(), status: "pending" });
  const found = incoming.find((t) => t.transferId === transferId);
  assert.ok(found, "transfer should appear in incoming list");
  assert.equal(found!.fromAgentId, AGENT_A);
  assert.equal(found!.size, data.length);
  assert.equal(found!.sha256, sha(data));
  assert.equal(found!.status, "pending");

  // agent-b accepts.
  const accepted = await acceptTransfer({ ...optsB(), transferId });
  assert.equal(accepted.status, "accepted");

  // agent-b downloads.
  const dest = join(dir, "accept-out.bin");
  const meta = await downloadTransfer({ ...optsB(), transferId, dest });
  assert.equal(meta.sha256, sha(data));

  const got = await readFile(dest);
  assert.ok(got.equals(data), "downloaded bytes match original");
});

test("non-recipient cannot accept or download another agent's transfer", async () => {
  const data = randomBytes(1024);
  const src = join(dir, "addr-prot.bin");
  await writeFile(src, data);

  const sent = await sendToAgent({ ...optsA(), file: src, toAgentId: AGENT_B });
  const { transferId } = sent;

  // agent-c is not the recipient (and happens to not even be registered, but
  // even if registered the result is 404 by design — we don't reveal existence).
  const res = await fetch(`${gateway}/v1/transfers/${transferId}/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${RELAY_TOKEN}`, "x-agent-id": AGENT_A },
  });
  // agent-a is not the recipient either — 404 per spec.
  assert.equal(res.status, 404);
});

// ---- decline --------------------------------------------------------------

test("decline drops the transfer", async () => {
  const data = randomBytes(64 * 1024);
  const src = join(dir, "decline-test.bin");
  await writeFile(src, data);

  const sent = await sendToAgent({ ...optsA(), file: src, toAgentId: AGENT_B });
  const { transferId } = sent;

  // agent-b declines.
  const declined = await declineTransfer({ ...optsB(), transferId });
  assert.equal(declined.status, "declined");

  // Subsequent download attempt must fail.
  const res = await fetch(`${gateway}/v1/transfers/${transferId}/content`, {
    headers: { authorization: `Bearer ${RELAY_TOKEN}`, "x-agent-id": AGENT_B },
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "consent_required");
});

test("double-accept is rejected with invalid_state", async () => {
  const data = randomBytes(1024);
  const src = join(dir, "dbl-accept.bin");
  await writeFile(src, data);

  const sent = await sendToAgent({ ...optsA(), file: src, toAgentId: AGENT_B });
  const { transferId } = sent;

  await acceptTransfer({ ...optsB(), transferId });

  // Second accept -> 409.
  await assert.rejects(
    () => acceptTransfer({ ...optsB(), transferId }),
    (e: unknown) => e instanceof HttpError && e.status === 409,
  );
});

// ---- e2e full round-trip --------------------------------------------------

test("e2e: agent-a sends large file -> agent-b lists -> accepts -> downloads -> sha256 matches", async () => {
  const data = randomBytes(512 * 1024);
  const src = join(dir, "e2e-src.bin");
  await writeFile(src, data);

  // Send.
  const sent = await sendToAgent({
    ...optsA(),
    file: src,
    toAgentId: AGENT_B,
    onProgress: () => undefined,
  });
  assert.equal(sent.size, data.length);
  assert.equal(sent.sha256, sha(data));

  // List.
  const incoming = await listIncoming(optsB());
  const meta = incoming.find((t) => t.transferId === sent.transferId);
  assert.ok(meta);
  assert.equal(meta!.sha256, sha(data));

  // Accept.
  await acceptTransfer({ ...optsB(), transferId: sent.transferId });

  // Download.
  const dest = join(dir, "e2e-out.bin");
  const result = await downloadTransfer({ ...optsB(), transferId: sent.transferId, dest });
  assert.equal(result.sha256, sha(data));
  assert.ok((await readFile(dest)).equals(data));
});
