// In-memory registry of agents and federated transfers.
// All mutation is synchronous and guarded by the calling async context —
// single-process only (same as the core FFT store). Persistence is a noted
// future extension.

import { randomId } from "../hash.js";
import { safeName, isSha256Hex } from "../protocol.js";
import { FftError } from "../store.js";
import {
  isValidAgentId,
  type AgentRecord,
  type TransferRecord,
  type TransferMeta,
  type TransferStatus,
} from "./protocol.js";

export class FederationRegistry {
  /** agentId -> record */
  private readonly agents = new Map<string, AgentRecord>();
  /** transferId -> record */
  private readonly transfers = new Map<string, TransferRecord>();

  // ---- agent registration --------------------------------------------------

  registerAgent(agentId: string): AgentRecord {
    if (!isValidAgentId(agentId)) {
      throw new FftError(400, "bad_agent_id", "agentId must be 1-64 printable ASCII characters");
    }
    const now = Date.now();
    const existing = this.agents.get(agentId);
    if (existing) {
      existing.lastSeenAt = now;
      return existing;
    }
    const record: AgentRecord = { agentId, registeredAt: now, lastSeenAt: now };
    this.agents.set(agentId, record);
    return record;
  }

  getAgent(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  touchAgent(agentId: string): void {
    const rec = this.agents.get(agentId);
    if (rec) rec.lastSeenAt = Date.now();
  }

  // ---- transfer lifecycle --------------------------------------------------

  /**
   * Create a new pending transfer declaration.
   * The caller is expected to have already created the FFT upload session
   * (so uploadId + uploadSecret come from the store).
   */
  createTransfer(params: {
    fromAgentId: string;
    toAgentId: string;
    name: string;
    size: number;
    sha256: string;
    uploadId: string;
  }): TransferRecord {
    if (!isValidAgentId(params.toAgentId)) {
      throw new FftError(400, "bad_agent_id", "toAgentId must be 1-64 printable ASCII characters");
    }
    if (!this.agents.has(params.toAgentId)) {
      throw new FftError(404, "agent_not_found", `recipient agent '${params.toAgentId}' is not registered`);
    }
    if (!Number.isInteger(params.size) || params.size < 0) {
      throw new FftError(400, "bad_request", "size must be a non-negative integer");
    }
    if (!isSha256Hex(params.sha256)) {
      throw new FftError(400, "bad_request", "sha256 must be 64 lowercase hex chars");
    }
    const transferId = randomId(16);
    const now = Date.now();
    const record: TransferRecord = {
      transferId,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      name: safeName(params.name),
      size: params.size,
      sha256: params.sha256,
      uploadId: params.uploadId,
      committed: false,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.transfers.set(transferId, record);
    return record;
  }

  /**
   * Mark the transfer's backing upload as committed (sender called /commit).
   * Called by the gateway after the FFT commit succeeds.
   */
  markCommitted(transferId: string): void {
    const t = this.transfers.get(transferId);
    if (!t) throw new FftError(404, "transfer_not_found", "transfer not found");
    t.committed = true;
    t.updatedAt = Date.now();
  }

  /**
   * Recipient calls accept. Only works for transfers addressed to this agent
   * that are in "pending" state and whose bytes are committed.
   */
  acceptTransfer(transferId: string, recipientAgentId: string): TransferRecord {
    const t = this.requireTransferForRecipient(transferId, recipientAgentId);
    if (t.status !== "pending") {
      throw new FftError(409, "invalid_state", `transfer is already '${t.status}'`);
    }
    if (!t.committed) {
      throw new FftError(409, "upload_not_complete", "sender has not finished uploading yet");
    }
    t.status = "accepted";
    t.updatedAt = Date.now();
    return t;
  }

  /**
   * Recipient declines. The gateway should delete the backing file after this.
   */
  declineTransfer(transferId: string, recipientAgentId: string): TransferRecord {
    const t = this.requireTransferForRecipient(transferId, recipientAgentId);
    if (t.status !== "pending") {
      throw new FftError(409, "invalid_state", `transfer is already '${t.status}'`);
    }
    t.status = "declined";
    t.updatedAt = Date.now();
    return t;
  }

  /** Verify that the download is permissible (accepted + committed). */
  authorizeDownload(transferId: string, recipientAgentId: string): TransferRecord {
    const t = this.requireTransferForRecipient(transferId, recipientAgentId);
    if (t.status !== "accepted") {
      throw new FftError(403, "consent_required", "transfer must be accepted before downloading");
    }
    if (!t.committed) {
      throw new FftError(409, "upload_not_complete", "sender has not finished uploading yet");
    }
    return t;
  }

  /**
   * List transfers pending/accepted/declined for a given recipient agent.
   * Returns only metadata — no bytes, no download path.
   */
  listIncoming(recipientAgentId: string, filter?: TransferStatus): TransferMeta[] {
    const out: TransferMeta[] = [];
    for (const t of this.transfers.values()) {
      if (t.toAgentId !== recipientAgentId) continue;
      if (filter !== undefined && t.status !== filter) continue;
      out.push({
        transferId: t.transferId,
        fromAgentId: t.fromAgentId,
        name: t.name,
        size: t.size,
        sha256: t.sha256,
        status: t.status,
        createdAt: t.createdAt,
      });
    }
    // Newest first.
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  getTransfer(transferId: string): TransferRecord | undefined {
    return this.transfers.get(transferId);
  }

  /**
   * Find the transfer that backs a given FFT uploadId.
   * Used by the gateway after a commit to mark the transfer committed.
   */
  findByUploadId(uploadId: string): TransferRecord | undefined {
    for (const t of this.transfers.values()) {
      if (t.uploadId === uploadId) return t;
    }
    return undefined;
  }

  /**
   * Remove declined or expired transfers from memory.
   * Call periodically alongside the FFT GC.
   */
  gc(maxAgeMs = 7 * 24 * 60 * 60_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, t] of this.transfers) {
      if ((t.status === "declined" || t.status === "expired") && t.updatedAt < cutoff) {
        this.transfers.delete(id);
      }
    }
  }

  // ---- private helpers -----------------------------------------------------

  private requireTransferForRecipient(transferId: string, recipientAgentId: string): TransferRecord {
    const t = this.transfers.get(transferId);
    if (!t) throw new FftError(404, "transfer_not_found", "transfer not found");
    if (t.toAgentId !== recipientAgentId) {
      // Return 404 rather than 403 — do not reveal that the transfer exists to non-recipients.
      throw new FftError(404, "transfer_not_found", "transfer not found");
    }
    return t;
  }
}
