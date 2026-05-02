# cgrcad — persistent code-graph daemon

`cgrcad` is the long-lived process that ends cgrca's cold-start tax. Today
every CLI subcommand, every MCP request, every UI tab, and the GitHub App
all reopen `:memory:` and run a fresh `indexScope`. The architect's killer
change is to lift state out of the per-call lifecycle and into one daemon
per machine that owns one persistent sqlite per repo, keyed by the realpath
of the repo root and content-addressed by `git hash-object` of each file.

## Architecture

```
   ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌──────────────┐
   │  cgrca CLI │   │ MCP server │   │     UI     │   │ github-app   │
   └──────┬─────┘   └──────┬─────┘   └──────┬─────┘   └──────┬───────┘
          │                │                │                │
          │   JSON-RPC 2.0 over UDS (~/.cgrca/daemon.sock)    │
          └────────────────┴────────┬───────┴────────────────┘
                                    │
                            ┌───────▼────────┐
                            │     cgrcad     │   single writer, lockfile
                            │   (Node, net)  │
                            ├────────────────┤
                            │  RPC dispatch  │
                            │  repo registry │  realpath → sqlite handle
                            │  fs watchers   │  chokidar-free; node:fs.watch
                            │  idle timeout  │
                            └───────┬────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
        ~/.cgrca/repos/      ~/.cgrca/repos/      ~/.cgrca/repos/
         <sha>.sqlite         <sha>.sqlite         <sha>.sqlite
        files/symbols/       blob_cache            blob_cache
        edges/imports
```

One daemon per user, one sqlite per repo. Clients are dumb: they connect,
send a JSON-RPC call, print the response. If the daemon is unreachable
they fall back to in-process `indexScope` (current behavior).

## RPC surface

JSON-RPC 2.0 framing: 4-byte big-endian length prefix + UTF-8 JSON body.
Methods mirror the existing core API one-to-one:

| Method      | Params                                              | Returns                       |
| ----------- | --------------------------------------------------- | ----------------------------- |
| `ping`      | `{}`                                                | `{ pong: true, uptimeMs }`    |
| `status`    | `{}`                                                | `{ pid, repos, startedAt }`   |
| `stop`      | `{}`                                                | `{ stopping: true }`          |
| `index`     | `{ repoRoot }`                                      | `IndexResult` minus `db`      |
| `define`    | `{ repoRoot, name, opts? }`                         | `Definition[]`                |
| `callers`   | `{ repoRoot, name, depth? }`                        | `CallerTree`                  |
| `callees`   | `{ repoRoot, name, depth? }`                        | `CalleeTree`                  |
| `changed`   | `{ repoRoot, name, sinceDays? }`                    | `GitChange[]`                 |
| `rca`       | `{ repoRoot, failure, budget? }`                    | `RcaResult`                   |

Error codes follow the JSON-RPC convention: `-32700` parse, `-32600`
invalid request, `-32601` method not found, `-32602` invalid params,
`-32603` internal. Daemon-specific: `-32000` repo-not-allowed, `-32001`
indexing, `-32002` schema-version mismatch.

## Lifecycle

**Spawn.** `cgrca daemon start` shells out to `child_process.spawn` with
`detached: true`, `stdio: 'ignore'`, then `child.unref()`. The parent waits
on a one-shot UDS connection (`ping`) with a 3s budget; once the daemon
answers, it's ready.

**Lock acquisition.** On startup the daemon opens `~/.cgrca/daemon.lock`
with `O_CREAT | O_EXCL`. On `EEXIST` it reads the existing file
(`{pid, startedAt}` JSON), checks `process.kill(pid, 0)`. If the pid is
dead the lockfile is reclaimed; otherwise the new daemon exits 0 (the
existing one is healthy).

**Idle timeout.** Default 1 hour of no RPC activity. A `setTimeout` rolls
forward on every accepted request. On fire: graceful shutdown.

**Graceful shutdown.** Stop accepting connections, wait for in-flight
calls to drain (5s budget then forced close), close every sqlite handle,
unlink the socket and lockfile, exit 0. `SIGTERM` and `SIGINT` route here.

## Schema additions

Bumps `SCHEMA_VERSION` 4 → 5 (the data-flow agent took v4 for params /
arg_bindings; this slice adds the cache on top). New table:

```sql
CREATE TABLE IF NOT EXISTS blob_cache (
  file_path     TEXT PRIMARY KEY,
  blob_sha      TEXT NOT NULL,
  extracted_json TEXT NOT NULL,
  cached_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_cache_sha ON blob_cache(blob_sha);
```

On re-index, the orchestrator walks the file list, calls `git hash-object`
in batch, and joins against `blob_cache.blob_sha`. Hits are rehydrated
from `extracted_json`; misses go through tree-sitter and write back. On a
warm repo with one dirty file, this turns N tree-sitter parses into 1.

## Failure modes

- **Stale lockfile.** PID dead, `process.kill(pid, 0)` throws `ESRCH`. We
  unlink and retry. Race between two daemons starting at the same instant
  is handled by `O_EXCL`: only one wins.
- **Sqlite corruption.** `openDb` throws on schema mismatch. The daemon
  catches per-repo, marks the repo "unhealthy", and rejects further calls
  with `-32002` until the file is deleted.
- **fs-watcher overflow.** `node:fs.watch` on macOS uses FSEvents and is
  cheap; on Linux it's inotify with a per-user cap. We register one
  recursive watcher per repo; if `EMFILE`/`ENOSPC` fires we log once,
  disable watching for that repo, and fall back to a stat-on-query
  invalidation strategy.
- **Client disconnect mid-call.** Each connection gets its own `socket`;
  the dispatcher uses `socket.write` only. If the socket emits `error`
  or `close` mid-handler we let the handler run to completion (sqlite
  transaction commits) but skip the response.
- **Blob-cache poisoning.** Cache key is `(file_path, blob_sha)`. If
  someone hand-edits the file under us, the next `git hash-object` returns
  a new sha, which misses the cache, which rebuilds. Worst case: one extra
  parse.

## Out of scope (this slice)

- MCP integration (week 4 — same RPC client, different transport adapter).
- UI integration (week 4 — UI process becomes a thin RPC client too).
- Windows named pipes (the `net` API supports them; the path layout
  changes from `~/.cgrca/daemon.sock` to `\\.\pipe\cgrcad-<user>`).
- Multi-user daemon sharing (single-user `~/.cgrca` for now).
- Auth/transport encryption (UDS perms `0600` are the only gate).
