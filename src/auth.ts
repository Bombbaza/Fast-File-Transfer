import type { IncomingMessage } from "node:http";
import { safeEqual } from "./hash.js";

/** The authenticated caller. The id scopes storage quota. */
export interface Principal {
  id: string;
}

/**
 * Returns a Principal if the request is authorized, otherwise null.
 * Replace this to plug in your own scheme (JWT, mTLS, signed envelopes, ...).
 * The server depends only on this interface, never on a specific scheme.
 */
export type Authenticator = (req: IncomingMessage) => Principal | null;

/**
 * Default bearer-token authenticator.
 * - token === ""  -> auth disabled; every caller is "anonymous" (DEV ONLY).
 * - otherwise     -> requires `Authorization: Bearer <token>`, compared in constant time.
 */
export function bearerAuth(token: string): Authenticator {
  return (req: IncomingMessage): Principal | null => {
    if (token === "") return { id: "anonymous" };
    const header = req.headers["authorization"];
    if (!header || Array.isArray(header)) return null;
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return null;
    return safeEqual(m[1]!.trim(), token) ? { id: "default" } : null;
  };
}
