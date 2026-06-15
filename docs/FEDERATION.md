# Fast File Transfer — Federation Mode

Federation mode adds agent-addressed, consent-gated file transfer on top of the
FFT chunked/sha256 engine. Instead of uploading directly to one server, agents
connect to a shared **relay gateway** and send files **to each other by agent ID**.
The recipient must **explicitly accept** before any bytes are delivered.

## Concepts

| Term | Meaning |
|------|---------|
| **Agent** | A participant registered on the relay gateway (`agentId` is an arbitrary printable ASCII string, max 64 chars). |
| **Relay gateway** | An FFT server running in federation mode. Holds the bytes and enforces the consent-gate. |
| **Transfer** | A file declared by a sender to a specific recipient agent. Has its own `transferId`. |
| **Consent-gate** | The rule: bytes are **never** delivered until the recipient calls `/accept`. |

## Protocol flow

```
agent-a (sender)                gateway                      agent-b (recipient)
     |                             |                                |
     |-- POST /v1/agents/register >|                                |
     |<- {agentId, registeredAt} --|                                |
     |                             |<-- POST /v1/agents/register ---|
     |                             |--- {agentId, registeredAt} --->|
     |                             |                                |
     |-- POST /v1/transfers ------>|  (declare {toAgentId, name,    |
     |   {toAgentId, name, size,   |   size, sha256})               |
     |    sha256}                  |                                |
     |<- {transferId, uploadId,    |                                |
     |    uploadSecret, chunkSize} |                                |
     |                             |                                |
     |-- PATCH /v1/uploads/:id --->|  (chunk 0)                     |
     |-- PATCH /v1/uploads/:id --->|  (chunk 1, ...)                |
     |-- POST /v1/uploads/:id/     |                                |
     |   commit ------------------>|  (sha256 verified + stored)    |
     |<- {id, sha256, ...} --------|                                |
     |                             |                                |
     |                             |<-- GET /v1/transfers/incoming--|
     |                             |--- [{transferId, from, name,   |
     |                             |     size, sha256, status}] --->|
     |                             |                                |
     |                             |<-- POST /v1/transfers/:id/     |
     |                             |    accept ---------------------|
     |                             |--- {transferId, status:        |
     |                             |     "accepted"} -------------->|
     |                             |                                |
     |                             |<-- GET /v1/transfers/:id/      |
     |                             |    content --------------------|
     |                             |--- byte stream (Range ok) ---->|
```

## Consent-gate invariant

The gateway enforces the following at the download endpoint:

1. The requesting agent must be the declared recipient (`toAgentId`).
2. The transfer status must be `"accepted"` — never `"pending"` or `"declined"`.
3. The sender must have committed the upload (sha256 verified by the store).

Violating any condition returns HTTP 403 `consent_required` or 404, never
silently delivering bytes.

## Transfer states

```
declared by sender -> pending
   pending + recipient accept -> accepted -> download allowed
   pending + recipient decline -> declined -> bytes deleted
```

Once declined the transfer stays declined; the recipient cannot re-accept.

## API reference

All routes use `/v1` prefix. Authenticate with `Authorization: Bearer <relay-token>`
plus `X-Agent-Id: <your-agent-id>`.

### Agent registration

```
POST /v1/agents/register
-> 200 { agentId, registeredAt }
```

Idempotent. Re-registration refreshes `lastSeenAt`.

### Declare a transfer (sender)

```
POST /v1/transfers
Body: { toAgentId, name, size, sha256, chunkSize? }
-> 201 { transferId, uploadId, uploadSecret, chunkSize }
```

The sender then chunk-uploads against the standard FFT upload routes using the
returned `uploadId` and `uploadSecret`:

```
PATCH /v1/uploads/:uploadId?offset=N    (with X-Upload-Secret)
POST  /v1/uploads/:uploadId/commit      (with X-Upload-Secret)
```

Committing the upload marks the transfer as `committed`, making it available for
the recipient to download after acceptance.

### List incoming (recipient)

```
GET /v1/transfers/incoming[?status=pending|accepted|declined]
-> 200 { transfers: [ { transferId, fromAgentId, name, size, sha256, status, createdAt }, ... ] }
```

Returns **metadata only** — the bytes are never included.

### Accept a transfer (recipient)

```
POST /v1/transfers/:id/accept
-> 200 { transferId, status: "accepted" }
```

Enables the download endpoint for this transfer.

### Decline a transfer (recipient)

```
POST /v1/transfers/:id/decline
-> 200 { transferId, status: "declined" }
```

The gateway deletes the backing file (best-effort).

### Download (recipient, after accept)

```
GET /v1/transfers/:id/content
Supports Range header for resumable downloads.
-> 200/206 byte stream
Response headers include:
   X-Content-SHA256: <sha256>
   X-Transfer-Id: <id>
   X-From-Agent: <sender agentId>
```

## Pluggable agent authentication

The gateway accepts a single `authenticateAgent(req) => { agentId } | null`
function. The default is bearer token + `X-Agent-Id` header. Replace it for
production:

```ts
import { createFederationGateway } from "fast-file-transfer";

const gateway = createFederationGateway({
  config,
  authenticateAgent: (req) => {
    const claims = verifyMyJwt(req.headers["authorization"]);
    return claims ? { agentId: claims.sub } : null;
  },
});
```

See `src/federation/auth.ts` for the full interface contract and a note on when
you should replace the default.

## Security notes

- **Run behind TLS.** The gateway speaks plain HTTP; terminate TLS at a reverse proxy.
- **The relay token is a shared credential.** In the default authenticator every
  holder who also supplies a valid `X-Agent-Id` is accepted as that agent. For
  stronger isolation, replace `authenticateAgent` with a scheme that
  cryptographically binds each request to a specific agent identity.
- **Consent-gate is server-enforced**, not client-enforced. The download endpoint
  re-checks the transfer status on every request; there is no bypass path.
- **agentIds are not secret.** Do not use them as passwords; use the auth layer.
- **No auto-receive.** The gateway never pushes bytes to an agent; the recipient
  must pull.

## Persistence note

The agent registry and transfer state are in-memory in the current implementation.
A gateway restart clears them. Persistence (SQLite, a JSON file, or an external
store) is a noted future extension. The backing file bytes survive a restart
because they live in the FFT store's filesystem.
