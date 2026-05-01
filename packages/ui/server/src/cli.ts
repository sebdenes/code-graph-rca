#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import open from "open";
import chokidar from "chokidar";
import { createServer } from "./index.js";

interface CliArgs {
  pathArg: string | undefined;
  port: number;
  noOpen: boolean;
  watch: string | undefined;
  dev: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    pathArg: undefined,
    port: 7331,
    noOpen: false,
    watch: undefined,
    dev: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--dev") out.dev = true;
    else if (a === "--port") {
      const v = argv[++i];
      if (v !== undefined) out.port = parseInt(v, 10);
    } else if (a === "--watch") {
      out.watch = argv[++i];
    } else if (!a.startsWith("--")) {
      if (out.pathArg === undefined) out.pathArg = a;
    }
  }
  return out;
}

const USAGE = `cgrca-view [<sqlite-path-or-dir>] [--port N] [--no-open] [--watch <repo>] [--dev]

Args:
  <sqlite-path-or-dir>  A *.sqlite session file or a directory of them.
                        Defaults to ~/.cgrca/sessions plus the current dir.

Options:
  --port N      Listen port (default 7331). Auto-increments to 7340.
  --no-open     Do not launch the system browser on start.
  --watch DIR   Watch a repo for file changes (broadcasts LiveEvents).
  --dev         API-only mode (no SPA static serving).
`;

async function listenWithFallback(
  fastify: import("fastify").FastifyInstance,
  startPort: number,
): Promise<number> {
  for (let p = startPort; p <= 7340; p++) {
    try {
      await fastify.listen({ port: p, host: "127.0.0.1" });
      return p;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`no free port in 7331..7340`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.pathArg !== undefined) {
    const abs = resolve(args.pathArg);
    if (!existsSync(abs)) {
      process.stderr.write(`cgrca-view: path not found: ${abs}\n`);
      return 2;
    }
  }

  const handle = await createServer({
    ...(args.pathArg !== undefined ? { path: args.pathArg } : {}),
    dev: args.dev,
  });
  const port = await listenWithFallback(handle.fastify, args.port);

  const url = `http://127.0.0.1:${port}`;
  const count = handle.sessions.size;
  process.stdout.write(
    `cgrca-view listening on ${url}  (${count} session${count === 1 ? "" : "s"} loaded)\n`,
  );

  if (args.watch) {
    const watchAbs = resolve(args.watch);
    if (existsSync(watchAbs) && statSync(watchAbs).isDirectory()) {
      const watcher = chokidar.watch(watchAbs, {
        ignoreInitial: true,
        ignored: /(^|\/)(node_modules|\.git|dist|\.next|build|target)\//,
      });
      // Broadcast file changes to every loaded session.
      const onChange = (path: string): void => {
        for (const id of handle.sessions.keys()) {
          handle.broadcast(id, { kind: "file-changed", path });
        }
      };
      watcher.on("add", onChange);
      watcher.on("change", onChange);
      watcher.on("unlink", onChange);
      process.stdout.write(`watching ${watchAbs} (re-index TBD)\n`);
    } else {
      process.stderr.write(`--watch path not a directory: ${watchAbs}\n`);
    }
  }

  if (!args.noOpen) {
    void open(url).catch(() => {
      // ignore — user can open manually
    });
  }

  // Hold the process open. Fastify keeps the event loop alive, but we also
  // wire SIGINT for clean exit so DB handles get released.
  const shutdown = async (): Promise<void> => {
    try {
      await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
