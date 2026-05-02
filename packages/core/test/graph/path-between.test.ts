import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";
import { pathBetween } from "../../src/graph/queries.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "ts-dataflow");

describe("pathBetween", () => {
  it("returns parseRequest → handleRequest → save via CALLS edges", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const path = pathBetween(r.db, "parseRequest", "save");
    expect(path).not.toBeNull();
    const names = path!.map((s) => s.name);
    expect(names).toEqual(["parseRequest", "handleRequest", "save"]);
    expect(path![0]!.edgeKind).toBeNull();
    expect(path![1]!.edgeKind).toBe("CALLS");
    expect(path![2]!.edgeKind).toBe("CALLS");
  });

  it("returns null when there's no path within maxDepth", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    // `noParams` (a top-level symbol that exists but is unrelated) → save:
    // no caller chain.
    const path = pathBetween(r.db, "noParams", "save", { maxDepth: 5 });
    expect(path).toBeNull();
  });

  it("returns null when symbol names don't exist", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    expect(pathBetween(r.db, "doesNotExist", "save")).toBeNull();
    expect(pathBetween(r.db, "save", "alsoDoesNotExist")).toBeNull();
  });

  it("returns single-step path when from == to", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const path = pathBetween(r.db, "save", "save");
    expect(path).not.toBeNull();
    expect(path).toHaveLength(1);
    expect(path![0]!.name).toBe("save");
  });
});
