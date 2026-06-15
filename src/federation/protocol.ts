// Federation wire contracts: agent registration, transfer declarations, consent-gate.
// Pure types + small helpers — no I/O, trivially testable.

/** Identifies an agent on the relay gateway. */
export interface AgentIdentity {
  agentId: string;
}

/** Stored record of a registered agent. */
export interface AgentRecord {
  agentId: string;
  registeredAt: number;
  lastSeenAt: number;
}

/** Lifecycle state of a federated transfer. */
export type TransferStatus = "pending" | "accepted" | "declined" | "expired";

/** Full transfer record kept by the gateway. Includes the backing uploadId. */
export interface TransferRecord {
  transferId: string;
  /** agentId of the sender. */
  fromAgentId: string;
  /** agentId of the intended recipient. */
  toAgentId: string;
  /** Human-readable filename (safe-basename). */
  name: string;
  /** Declared file size in bytes. */
  size: number;
  /** Declared sha256 of the content. */
  sha256: string;
  /** Backing FFT upload / file id (same as the file id after commit). */
  uploadId: string;
  /** True once the sender has committed the upload to the store. */
  committed: boolean;
  status: TransferStatus;
  createdAt: number;
  updatedAt: number;
}

/** Metadata returned to the recipient in the incoming list — NO bytes, NO download path. */
export interface TransferMeta {
  transferId: string;
  fromAgentId: string;
  name: string;
  size: number;
  sha256: string;
  status: TransferStatus;
  createdAt: number;
}

// ---- request / response bodies -------------------------------------------

export interface RegisterRequest {
  agentId: string;
}
export interface RegisterResponse {
  agentId: string;
  registeredAt: number;
}

export interface DeclareTransferRequest {
  /** Recipient agent id. */
  toAgentId: string;
  name: string;
  size: number;
  sha256: string;
  chunkSize?: number;
}
export interface DeclareTransferResponse {
  transferId: string;
  /** The FFT uploadId the sender uses to chunk-upload against (exactly like a direct upload). */
  uploadId: string;
  /** FFT upload secret — passed to PATCH /v1/uploads/:id and POST /v1/uploads/:id/commit. */
  uploadSecret: string;
  /** Authoritative chunk size. */
  chunkSize: number;
}

export interface AcceptResponse {
  transferId: string;
  status: "accepted";
}
export interface DeclineResponse {
  transferId: string;
  status: "declined";
}

/** Validate an agentId: 1–64 printable ASCII, no whitespace. */
export function isValidAgentId(id: string): boolean {
  return /^[\x21-\x7E]{1,64}$/.test(id);
}
