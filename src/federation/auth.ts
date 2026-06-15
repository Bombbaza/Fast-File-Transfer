// Pluggable agent authentication for the relay gateway.
//
// The gateway depends only on the AgentAuthenticator interface — swap in any
// scheme (HMAC-signed envelopes, mTLS, JWT, etc.) by implementing one function.
//
// Default: a shared relay token (bearer) proves the caller is a member of the
// relay, and the agentId is taken from the X-Agent-Id request header.
// In a production deployment you would replace this with an authenticator that
// cryptographically binds the presented agentId to the caller.

import type { IncomingMessage } from "node:http";
import { safeEqual } from "../hash.js";

/** The result of successful agent authentication. */
export interface AgentPrincipal {
  agentId: string;
}

/**
 * Returns an AgentPrincipal if the request is authorized, otherwise null.
 *
 * Implement this interface to plug in your own authentication scheme:
 *
 * ```ts
 * import { createFederationGateway } from "fast-file-transfer/federation";
 *
 * const gateway = createFederationGateway({
 *   config,
 *   authenticateAgent: (req) => {
 *     const claims = verifyMyJwt(req.headers["authorization"]);
 *     return claims ? { agentId: claims.sub } : null;
 *   },
 * });
 * ```
 */
export type AgentAuthenticator = (req: IncomingMessage) => AgentPrincipal | null;

/**
 * Default bearer-token + X-Agent-Id authenticator.
 *
 * - relayToken === "" means auth is disabled; every caller is authenticated as
 *   the agent id they claim in X-Agent-Id. DEV / TESTING ONLY.
 * - Otherwise: requires Authorization: Bearer <relayToken> compared in
 *   constant time, plus a non-empty X-Agent-Id header.
 *
 * In production, replace this with an authenticator that cryptographically
 * binds each request to a specific agent identity (e.g. signed JWT, mTLS
 * client certificate, HMAC-signed registration challenge).
 */
export function bearerAgentAuth(relayToken: string): AgentAuthenticator {
  return (req: IncomingMessage): AgentPrincipal | null => {
    // agentId comes from the X-Agent-Id header.
    const rawId = req.headers["x-agent-id"];
    const agentId = (Array.isArray(rawId) ? rawId[0] : rawId)?.trim() ?? "";
    if (!agentId) return null;

    if (relayToken === "") {
      // Auth disabled: dev/test only.
      return { agentId };
    }

    const authHeader = req.headers["authorization"];
    if (!authHeader || Array.isArray(authHeader)) return null;
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!m) return null;
    return safeEqual(m[1]!.trim(), relayToken) ? { agentId } : null;
  };
}
