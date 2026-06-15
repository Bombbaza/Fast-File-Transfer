# Fast File Transfer — Design

A small, dependency-free protocol for moving large files over HTTP reliably:
chunked, resumable, and integrity-verified end to end.

## Goals

- Move arbitrarily large files without buffering them in memory (constant RAM).
- Survive network interruptions on both upload and download (resume, don't restart).
- Guarantee the bytes that arrive are exactly the bytes that were sent (sha256).
- Stay dependency-free and easy to self-host.
- Keep auth pluggable so it drops into any environment.

## Non-goals (v1)

- End-to-end encryption (transfer is integrity-checked, not confidential — run behind TLS).
- A recipient/mailbox model (files are addressed by id; bring your own sharing flow).
- Horizontal multi-process scale-out (single process per storage dir; see Future work).

## Protocol

A transfer is a four-call lifecycle. All control messages are small JSON; chunk
and file bodies are raw bytes.

1. **Init** — `POST /v1/uploads` with `{ name, size, sha256, chunkSize? }`.
   The server validates the size against its cap, checks quota and disk headroom,
   creates a sparse `.partial` file, and returns `{ uploadId, uploadSecret, chunkSize }`.
   `uploadSecret` is a fresh capability token required for every subsequent write.

2. **Chunk** — `PATCH /v1/uploads/:id?offset=N` with the raw chunk as the body and
   `X-Upload-Secret`. The server writes the bytes at offset `N`, fsyncs, and records
   the covered byte range. Chunks may arrive in any order and may be retried/re-sent
   idempotently. A chunk extending past the declared size is rejected (`range_overflow`).

3. **Commit** — `POST /v1/uploads/:id/commit`. The server checks the recorded ranges
   cover `[0, size)` exactly, verifies the on-disk size, **re-hashes the whole file**
   and compares to the declared sha256. On match it atomically renames `.partial` into
   the served file set and writes its metadata; on mismatch it deletes the partial and
   returns `hash_mismatch`. Commit is the only path that publishes a file.

4. **Download** — `GET /v1/files/:id`, optionally with a `Range` header. The server
   streams the file and advertises `Accept-Ranges` + an sha256 `ETag`. The client
   re-hashes after download and fails if it doesn't match.

## Integrity model

Integrity is enforced at three independent points:

- **Per chunk:** bounds checking prevents writing past the declared size.
- **At commit:** the complete file is re-hashed server-side; a wrong digest, wrong
  size, or any missing range blocks publication. A file is never servable unless its
  bytes match the hash declared at init.
- **At download:** the client re-hashes the received bytes against the server's
  advertised digest.

Because the declared sha256 is fixed at init and verified at commit, neither a buggy
client, a flaky network, nor a partial write can produce a published file that differs
from what was intended.

## Resumability

The server tracks committed byte ranges per upload session (merged into a minimal
set). `GET /v1/uploads/:id` returns them, so a client can compute which chunks are
missing and send only those — across process restarts, given the `uploadId` and
`uploadSecret`. Downloads resume via standard HTTP `Range`: the client requests
`bytes=<localSize>-` and appends.

## Security model

- **Authentication** is pluggable; the server depends only on
  `(req) => Principal | null`. The bundled default is a constant-time bearer-token
  check. The returned `Principal.id` scopes storage quota.
- **Per-upload capability:** init returns an `uploadSecret`; chunk, status, and commit
  require it (compared in constant time against a stored hash — the raw secret is never
  persisted). This binds mutation of an in-flight upload to the initiator, so sharing a
  bearer token among clients does not let one hijack or corrupt another's upload.
- **Principle applied:** authorization is bound to the authenticated principal and the
  per-upload secret — never to a client-supplied, spoofable identity header. Quotas and
  ownership therefore can't be bypassed by forging a header.
- **Path safety:** filenames are reduced to a basename; ids are server-generated random
  tokens, so no client input reaches the filesystem path.

## Resource safety

- **Constant memory:** chunks are written directly to an fd at their offset; commit
  re-hashes by streaming; downloads stream with backpressure. No operation buffers a
  whole file.
- **Disk headroom:** init refuses an upload that would drop free space below a margin.
  In-flight uploads' *declared-but-unwritten* bytes are counted as reserved, so many
  concurrent inits cannot collectively over-commit the volume.
- **Quota:** an optional per-principal byte budget (committed + reserved).
- **Expiry + GC:** completed files can carry a TTL; a periodic sweep removes expired
  files and abandons idle upload sessions (releasing their reservation).

## Storage layout

```
<FFT_STORAGE_DIR>/
  sessions/<id>.partial   in-progress bytes (sparse, grows as chunks land)
  sessions/<id>.json      session metadata (size, sha256, secret hash, ranges, ...)
  files/<id>              committed file
  files/<id>.json         file metadata (name, size, sha256, createdAt, expiresAt)
```

Per-session metadata mutations are serialized by an in-memory promise chain keyed on
the upload id, so concurrent chunk writes can't lose range updates.

## Future work

- Consent gate: surface offer metadata (name/size/hash) and require recipient acceptance
  before bytes are downloadable.
- Consume-on-download: one-time files deleted after first successful fetch.
- End-to-end encryption (client-side, server stores ciphertext).
- Pluggable storage backends (S3-compatible object stores).
- Multi-process / horizontal scale-out with a shared reservation fence.
