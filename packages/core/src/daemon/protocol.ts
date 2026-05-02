/**
 * JSON-RPC 2.0 wire types and our daemon-specific method registry.
 *
 * Framing on the socket: 4-byte big-endian length prefix, then a UTF-8
 * JSON body. Length-prefix avoids the chunk-splitting headache of
 * line-delimited framing and lets us reject malformed input cheaply.
 */

export const JSONRPC_VERSION = "2.0";

export type RpcId = number | string | null;

export interface RpcRequest<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId;
  method: string;
  params?: P;
}

export interface RpcSuccess<R = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId;
  result: R;
}

export interface RpcError {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId;
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse<R = unknown> = RpcSuccess<R> | RpcError;

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RepoNotAllowed: -32000,
  Indexing: -32001,
  SchemaMismatch: -32002,
} as const;

/** Methods exposed by cgrcad. Param/result types live in server.ts. */
export const Methods = [
  "ping",
  "status",
  "stop",
  "index",
  "define",
  "callers",
  "callees",
  "changed",
  "rca",
] as const;
export type Method = (typeof Methods)[number];

/* ---------- framing ---------- */

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Pulls zero-or-more complete frames out of a rolling buffer. Returns the
 * frames decoded as objects and the remaining bytes (incomplete frame).
 */
export function decodeFrames(
  buf: Buffer,
): { frames: unknown[]; rest: Buffer } {
  const frames: unknown[] = [];
  let offset = 0;
  while (buf.length - offset >= 4) {
    const len = buf.readUInt32BE(offset);
    if (buf.length - offset - 4 < len) break;
    const body = buf.subarray(offset + 4, offset + 4 + len);
    offset += 4 + len;
    try {
      frames.push(JSON.parse(body.toString("utf8")));
    } catch {
      // Malformed body — push a sentinel; server replies with ParseError.
      frames.push({ __parseError: true });
    }
  }
  return { frames, rest: buf.subarray(offset) };
}
