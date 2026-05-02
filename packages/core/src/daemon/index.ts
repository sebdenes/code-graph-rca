export { startDaemon } from "./server.js";
export type { DaemonHandle, DaemonOptions } from "./server.js";
export { callDaemon, isDaemonUp, DaemonError } from "./client.js";
export {
  encodeFrame,
  decodeFrames,
  JSONRPC_VERSION,
  ErrorCodes,
  Methods,
} from "./protocol.js";
export type { Method, RpcRequest, RpcResponse } from "./protocol.js";
export { acquireLock, releaseLock, isLiveLock, readLock } from "./lockfile.js";
export { ROOT, REPOS_DIR, SOCKET_PATH, LOCK_PATH, repoDbPath, ensureRoot } from "./state.js";
export { getCached, putCached, batchHashObjects } from "./cache.js";
