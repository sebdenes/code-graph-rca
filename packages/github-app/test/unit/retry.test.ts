import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../../src/retry.js";

describe("withRetry", () => {
  it("retries on 500 then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          const e: Error & { status?: number } = new Error("Internal Server Error");
          e.status = 500;
          throw e;
        }
        return { data: { id: 42 } };
      },
      { name: "test", maxRetries: 3, backoffBase: 0.01 },
    );
    expect(calls).toBe(3);
    expect(result.data.id).toBe(42);
  });

  it("retries on EPIPE network error", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) {
          const e: Error & { code?: string } = new Error("write EPIPE");
          e.code = "EPIPE";
          throw e;
        }
        return "ok";
      },
      { name: "test", maxRetries: 3, backoffBase: 0.01 },
    );
    expect(calls).toBe(2);
    expect(result).toBe("ok");
  });

  it("does NOT retry on 404", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          const e: Error & { status?: number } = new Error("Not Found");
          e.status = 404;
          throw e;
        },
        { name: "test", maxRetries: 3, backoffBase: 0.01 },
      ),
    ).rejects.toThrow("Not Found");
    expect(calls).toBe(1);
  });

  it("re-raises after max retries on persistent 500", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          const e: Error & { status?: number } = new Error("Internal Server Error");
          e.status = 500;
          throw e;
        },
        { name: "test", maxRetries: 2, backoffBase: 0.01 },
      ),
    ).rejects.toThrow("Internal Server Error");
    expect(calls).toBe(3); // 1 + 2 retries
  });
});
