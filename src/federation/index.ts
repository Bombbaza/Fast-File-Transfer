// Federation mode public surface.
// Import the gateway server, client functions, and types from here.

export { createFederationGateway, startFederationGateway, type GatewayOptions } from "./gateway.js";
export { bearerAgentAuth, type AgentAuthenticator, type AgentPrincipal } from "./auth.js";
export { FederationRegistry } from "./registry.js";
export {
  registerAgent,
  sendToAgent,
  listIncoming,
  acceptTransfer,
  declineTransfer,
  downloadTransfer,
  type FederationClientOptions,
  type SendToAgentOptions,
  type IncomingOptions,
  type ConsentOptions,
  type DownloadTransferOptions,
} from "./client.js";
export type {
  AgentRecord,
  TransferRecord,
  TransferMeta,
  TransferStatus,
  RegisterRequest,
  RegisterResponse,
  DeclareTransferRequest,
  DeclareTransferResponse,
  AcceptResponse,
  DeclineResponse,
} from "./protocol.js";
