import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchBody } from "../../../src/rca/llm/body.js";

function newRepo(): string {
  return mkdtempSync(join(tmpdir(), "cgrca-llm-body-"));
}

describe("fetchBody", () => {
  it("returns the requested line range with language detected from extension", () => {
    const repo = newRepo();
    const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
    writeFileSync(join(repo, "foo.py"), lines, "utf8");

    const snip = fetchBody(repo, "foo.py", 5, 10, 30);
    expect(snip).not.toBeNull();
    expect(snip!.body).toBe("line5\nline6\nline7\nline8\nline9\nline10");
    expect(snip!.startLine).toBe(5);
    expect(snip!.endLine).toBe(10);
    expect(snip!.truncated).toBe(false);
    expect(snip!.language).toBe("python");
  });

  it("clips to maxLines and flags truncated", () => {
    const repo = newRepo();
    const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n");
    writeFileSync(join(repo, "long.ts"), lines, "utf8");

    const snip = fetchBody(repo, "long.ts", 10, 80, 5);
    expect(snip).not.toBeNull();
    expect(snip!.body.split("\n")).toHaveLength(5);
    expect(snip!.truncated).toBe(true);
    expect(snip!.endLine).toBe(14);
    expect(snip!.language).toBe("typescript");
  });

  it("clamps a beyond-end startLine to the file length", () => {
    const repo = newRepo();
    writeFileSync(join(repo, "tiny.py"), "a\nb\nc", "utf8");
    const snip = fetchBody(repo, "tiny.py", 999, 1000, 30);
    expect(snip).not.toBeNull();
    expect(snip!.body).toBe("c");
    expect(snip!.startLine).toBe(3);
  });

  it("returns null on missing file (e.g. moved between index and llm call)", () => {
    const repo = newRepo();
    expect(fetchBody(repo, "does-not-exist.py", 1, 10, 30)).toBeNull();
  });

  it("returns null for an empty path arg without throwing", () => {
    const repo = newRepo();
    expect(fetchBody(repo, "", 1, 10, 30)).toBeNull();
  });

  it("treats unknown extensions as text", () => {
    const repo = newRepo();
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "notes.txt"), "hello\nworld", "utf8");
    const snip = fetchBody(repo, "sub/notes.txt", 1, 2, 30);
    expect(snip!.language).toBe("text");
  });
});
