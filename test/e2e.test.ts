import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import { upload, download, HttpError } from "../src/client.js";
import { loadConfig } from "../src/config.js";

const TOKEN = "secret-token-abc";
let server: Server;
let base: string;
let dir: string;

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fft-e2e-"));
  const cfg = loadConfig({
    FFT_PORT: "0",
    FFT_HOST: "127.0.0.1",
    FFT_TOKEN: TOKEN,
    FFT_STORAGE_DIR: join(dir, "data"),
    FFT_CHUNK_BYTES: String(64 * 1024),
  } as NodeJS.ProcessEnv);
  server = await startServer({ config: cfg });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

test("healthz is public", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test("multi-chunk roundtrip preserves bytes + hash", async () => {
  const data = randomBytes(256 * 1024); // ~4 chunks at 64 KiB
  const src = join(dir, "src.bin");
  await writeFile(src, data);

  const committed = await upload({ server: base, token: TOKEN, file: src });
  assert.equal(committed.size, data.length);
  assert.equal(committed.sha256, sha(data));

  const dest = join(dir, "out.bin");
  const meta = await download({ server: base, token: TOKEN, id: committed.id, dest });
  assert.equal(meta.sha256, sha(data));
  const got = await readFile(dest);
  assert.ok(got.equals(data), "downloaded bytes match original");
});

test("wrong token is rejected (401)", async () => {
  const src = join(dir, "auth.bin");
  await writeFile(src, randomBytes(1024));
  await assert.rejects(
    () => upload({ server: base, token: "wrong", file: src }),
    (e: unknown) => e instanceof HttpError && e.status === 401,
  );
});

test("resume finishes a partially-uploaded file", async () => {
  const data = randomBytes(256 * 1024);
  const src = join(dir, "resume.bin");
  await writeFile(src, data);

  // Manually init + upload only the first 64 KiB chunk.
  const initRes = await fetch(`${base}/v1/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "resume.bin", size: data.length, sha256: sha(data), chunkSize: 64 * 1024 }),
  });
  assert.equal(initRes.status, 201);
  const init = (await initRes.json()) as { uploadId: string; uploadSecret: string };
  const patch = await fetch(`${base}/v1/uploads/${init.uploadId}?offset=0`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${TOKEN}`, "x-upload-secret": init.uploadSecret, "content-type": "application/octet-stream" },
    body: data.subarray(0, 64 * 1024),
  });
  assert.equal(patch.status, 200);

  // Resume via the client — it should skip chunk 0 and finish the rest.
  const committed = await upload({
    server: base, token: TOKEN, file: src, chunkSize: 64 * 1024,
    resume: { uploadId: init.uploadId, uploadSecret: init.uploadSecret },
  });
  assert.equal(committed.sha256, sha(data));

  const dest = join(dir, "resume-out.bin");
  await download({ server: base, token: TOKEN, id: committed.id, dest });
  const got = await readFile(dest);
  assert.ok(got.equals(data));
});

test("download reports progress and verifies integrity", async () => {
  const data = randomBytes(200 * 1024);
  const src = join(dir, "prog.bin");
  await writeFile(src, data);
  const committed = await upload({ server: base, token: TOKEN, file: src });

  let lastReceived = 0;
  const dest = join(dir, "prog-out.bin");
  await download({
    server: base, token: TOKEN, id: committed.id, dest,
    onProgress: (received) => { lastReceived = received; },
  });
  assert.equal(lastReceived, data.length);
});
