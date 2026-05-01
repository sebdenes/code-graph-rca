/**
 * MCP-side bridge client.
 *
 * Discovery is by-convention: when `cgrca-view` runs, it writes a small lock
 * file at `~/.cgrca/bridge.json` containing `{ url, port, pid, sessionsDir }`.
 * The MCP server reads it on startup, opens an HTTP-only client (no WS — the
 * MCP side never needs to subscribe; it just publishes/reads on demand), and
 * exposes the endpoints to the agent through `cgrca_currentSelection` and
 * `cgrca_publishSelection` plus implicit publish on every targeted query.
 *
 * Failure-tolerant: if the lock file is missing, malformed, or the HTTP call
 * fails, the BridgeClient's methods resolve to `null` / no-op and log a
 * single line to stderr. MCP must work exactly as before with no peer.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface BridgeLock {
  url: string;
  port?: number;
  pid?: number;
  sessionsDir?: string;
}

export interface BridgeSelection {
  name: string;
  file: string;
  line: number;
  subsystem?: string;
}

function bridgeLockPath(): string {
  // Allow tests / unusual deployments to override HOME.
  return join(homedir(), ".cgrca", "bridge.json");
}

/**
 * Read the bridge lock file. Returns null when the file is missing or
 * malformed. Never throws.
 */
export function discoverBridge(): BridgeLock | null {
  const path = bridgeLockPath();
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<BridgeLock>;
    if (typeof parsed.url !== "string" || parsed.url.length === 0) return null;
    const lock: BridgeLock = { url: parsed.url };
    if (typeof parsed.port === "number") lock.port = parsed.port;
    if (typeof parsed.pid === "number") lock.pid = parsed.pid;
    if (typeof parsed.sessionsDir === "string") lock.sessionsDir = parsed.sessionsDir;
    return lock;
  } catch (err) {
    process.stderr.write(
      `cgrca-bridge: failed to read ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

export class BridgeClient {
  readonly url: string;
  constructor(lock: BridgeLock) {
    // Strip trailing slashes so `${url}/api/...` is always well-formed.
    this.url = lock.url.replace(/\/+$/, "");
  }

  /**
   * Read the current selection from the UI. Returns null when the bridge
   * is unreachable or has no selection.
   */
  async getSelection(): Promise<BridgeSelection | null> {
    try {
      const res = await fetch(`${this.url}/api/bridge/select`);
      if (!res.ok) return null;
      const body = (await res.json()) as
        | { none: true }
        | (BridgeSelection & { none?: false });
      if ("none" in body && body.none === true) return null;
      const sel = body as BridgeSelection;
      if (
        typeof sel.name !== "string" ||
        typeof sel.file !== "string" ||
        typeof sel.line !== "number"
      ) {
        return null;
      }
      return sel;
    } catch (err) {
      process.stderr.write(
        `cgrca-bridge: getSelection failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return null;
    }
  }

  /**
   * Publish a selection to the UI. Best-effort — never throws.
   * Returns true on a 2xx response.
   */
  async postSelection(payload: BridgeSelection | null): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/bridge/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch (err) {
      process.stderr.write(
        `cgrca-bridge: postSelection failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return false;
    }
  }
}

/**
 * Convenience: construct a client if a bridge lock is present, else null.
 */
export function tryConnectBridge(): BridgeClient | null {
  const lock = discoverBridge();
  if (!lock) return null;
  return new BridgeClient(lock);
}
