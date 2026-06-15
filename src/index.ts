// Public library surface. Import what you need:
//   import { startServer, upload, download } from "fast-file-transfer";
//   import { startFederationGateway, sendToAgent } from "fast-file-transfer/federation";

export * from "./protocol.js";
export { loadConfig, type ServerConfig } from "./config.js";
export { bearerAuth, type Authenticator, type Principal } from "./auth.js";
export { Store, FftError } from "./store.js";
export { createServer, startServer, type ServerOptions } from "./server.js";
export {
  upload, download, HttpError,
  type UploadOptions, type DownloadOptions,
} from "./client.js";

// Federation mode — agent-addressed, consent-gated transfers.
export * from "./federation/index.js";
