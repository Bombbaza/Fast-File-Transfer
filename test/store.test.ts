import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store, FftError } from "../src/store.js";
import { loadConfig } from "../src/config.js";

const P = { id: "default" };

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function freshStore(over: Record<string, string> = {}): Promise<{ store: Store; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fft-store-"));
  const cfg = loadConfig({ FFT_STORAGE_DIR: join(dir, "data"), ...over } as NodeJS.ProcessEnv);
  const store = new Store(cfg);
  await store.init();
  return { store, dir };
}

async function expectFft(fn: () => Promise<unknown>, code: string, status: number): Promise<void> {
  try {
    await fn();
    assert.fail(`expected FftError ${code}`);
  } catch (e) {
    assert.ok(e instanceof FftError, `expected FftError, got ${e}`);
    assert.equal((e as FftError).code, code);
    assert.equal((e as FftError).status, status);
  }
}

test("roundtrip: out-of-order chunks then commit", async () => {
  const { store, dir } = await freshStore();
  const data = Buffer.from("hello fast file transfer ".repeat(2000)); // ~50 KB
  const init = await store.createUpload(P, { name: "a.txt", size: data.length, sha256: sha(data), chunkSize: 1024 });
  const cs = init.chunkSize;
  const offsets: number[] = [];
  for (let o = 0; o < data.length; o += cs) offsets.push(o);
  offsets.reverse(); // out of order
  for (const o of offsets) {
    const end = Math.min(o + cs, data.length);
    await store.writeChunk(init.uploadId, init.uploadSecret, o, data.subarray(o, end));
  }
  const st = await store.status(init.uploadId, init.uploadSecret);
  assert.equal(st.complete, true);
  assert.equal(st.received, data.length);
  const c = await store.commit(init.uploadId, init.uploadSecret);
  assert.equal(c.sha256, sha(data));
  assert.equal(c.size, data.length);
  const meta = await store.fileMeta(init.uploadId);
  assert.ok(meta);
  assert.equal(meta.size, data.length);
  await rm(dir, { recursive: true, force: true });
});

test("range overflow rejected", async () => {
  const { store, dir } = await freshStore();
  const data = Buffer.alloc(100, 7);
  const init = await store.createUpload(P, { name: "x", size: 100, sha256: sha(data) });
  await expectFft(() => store.writeChunk(init.uploadId, init.uploadSecret, 90, Buffer.alloc(20)), "range_overflow", 409);
  await rm(dir, { recursive: true, force: true });
});

test("incomplete commit rejected", async () => {
  const { store, dir } = await freshStore();
  const data = Buffer.alloc(100, 7);
  const init = await store.createUpload(P, { name: "x", size: 100, sha256: sha(data) });
  await store.writeChunk(init.uploadId, init.uploadSecret, 0, data.subarray(0, 50));
  await expectFft(() => store.commit(init.uploadId, init.uploadSecret), "upload_incomplete", 409);
  await rm(dir, { recursive: true, force: true });
});

test("hash mismatch rejected at commit", async () => {
  const { store, dir } = await freshStore();
  const real = Buffer.alloc(100, 7);
  const declared = sha(Buffer.alloc(100, 9)); // wrong digest
  const init = await store.createUpload(P, { name: "x", size: 100, sha256: declared });
  await store.writeChunk(init.uploadId, init.uploadSecret, 0, real);
  await expectFft(() => store.commit(init.uploadId, init.uploadSecret), "hash_mismatch", 409);
  await rm(dir, { recursive: true, force: true });
});

test("wrong upload secret rejected", async () => {
  const { store, dir } = await freshStore();
  const data = Buffer.alloc(10, 1);
  const init = await store.createUpload(P, { name: "x", size: 10, sha256: sha(data) });
  await expectFft(() => store.writeChunk(init.uploadId, "deadbeef", 0, data), "forbidden", 403);
  await rm(dir, { recursive: true, force: true });
});

test("file too large rejected at init", async () => {
  const { store, dir } = await freshStore({ FFT_MAX_FILE_BYTES: "100" });
  await expectFft(() => store.createUpload(P, { name: "x", size: 101, sha256: sha(Buffer.alloc(1)) }), "file_too_large", 413);
  await rm(dir, { recursive: true, force: true });
});

test("quota enforced across files", async () => {
  const { store, dir } = await freshStore({ FFT_QUOTA_BYTES: "150" });
  const d1 = Buffer.alloc(100, 1);
  const i1 = await store.createUpload(P, { name: "a", size: 100, sha256: sha(d1) });
  await store.writeChunk(i1.uploadId, i1.uploadSecret, 0, d1);
  await store.commit(i1.uploadId, i1.uploadSecret);
  // second 100-byte file would exceed the 150-byte quota
  await expectFft(() => store.createUpload(P, { name: "b", size: 100, sha256: sha(Buffer.alloc(100, 2)) }), "quota_exceeded", 413);
  await rm(dir, { recursive: true, force: true });
});

test("empty (0-byte) file commits", async () => {
  const { store, dir } = await freshStore();
  const init = await store.createUpload(P, { name: "empty", size: 0, sha256: sha(Buffer.alloc(0)) });
  const st = await store.status(init.uploadId, init.uploadSecret);
  assert.equal(st.complete, true);
  const c = await store.commit(init.uploadId, init.uploadSecret);
  assert.equal(c.size, 0);
  await rm(dir, { recursive: true, force: true });
});
