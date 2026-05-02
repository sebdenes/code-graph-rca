import { createConnection, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { SOCKET_PATH } from "./state.js";
import {
  decodeFrames,
  encodeFrame,
  JSONRPC_VERSION,
  type RpcResponse,
} from "./protocol.js";

/**
 * Thin JSON-RPC 2.0 client. One call per connection — the daemon also
 * supports request pipelining on a long-lived socket, but the CLI doesn't
 * benefit and the simpler shape is easier to reason about.
 */

export interface ClientOptions {
  socketPath?: string;
  /** Connect/round-trip budget in ms. */
  timeoutMs?: number;
}

export class DaemonError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "DaemonError";
  }
}

let nextId = 1;

export async function callDaemon<R = unknown>(
  method: string,
  params: unknown,
  opts: ClientOptions = {},
): Promise<R> {
  const sock = opts.socketPath ?? SOCKET_PATH;
  const timeout = opts.timeoutMs ?? 5_000;

  return new Promise<R>((resolve, reject) => {
    const id = nextId++;
    let buf: Buffer = Buffer.alloc(0);
    const conn: Socket = createConnection(sock);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new DaemonError(-32603, `daemon call ${method} timed out after ${timeout}ms`));
    }, timeout);

    conn.on("connect", () => {
      conn.write(encodeFrame({ jsonrpc: JSONRPC_VERSION, id, method, params }));
    });
    conn.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]) as Buffer;
      const { frames, rest } = decodeFrames(buf);
      buf = rest as Buffer;
      for (const f of frames) {
        const resp = f as RpcResponse<R>;
        if (resp.id !== id) continue;
        clearTimeout(timer);
        conn.end();
        if ("error" in resp) {
          reject(new DaemonError(resp.error.code, resp.error.message));
        } else {
          resolve(resp.result);
        }
        return;
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.on("close", () => {
      clearTimeout(timer);
    });
  });
}

/** Quick is-it-up probe — used by the CLI to decide warm vs. cold path. */
export async function isDaemonUp(socketPath: string = SOCKET_PATH): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    await callDaemon("ping", {}, { socketPath, timeoutMs: 500 });
    return true;
  } catch {
    return false;
  }
}
