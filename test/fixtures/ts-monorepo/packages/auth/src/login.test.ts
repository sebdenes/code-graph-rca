import { describe, it, expect, vi } from "vitest";
import * as config from "@fixture/config";
import { login } from "./login";

describe("login", () => {
  it("rejects with timeout when AUTH_TIMEOUT_MS is unset", async () => {
    vi.spyOn(config, "getEnv").mockReturnValue(undefined);

    await expect(login("alice", "wrong")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("timeout"),
    });
  }, 100);
});
