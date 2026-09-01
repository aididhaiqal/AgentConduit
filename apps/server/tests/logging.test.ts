import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createJsonLogger, safeErrorMessage } from "../src/logging.js";

describe("structured logging", () => {
  it("redacts configured secrets and sensitive fields", () => {
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk) => {
      output += String(chunk);
    });
    const logger = createJsonLogger({
      stream,
      clock: () => Date.parse("2026-09-01T00:00:00.000Z"),
      secrets: ["top-secret-token"],
    });

    logger.error("test.failure", {
      authorization: "Bearer top-secret-token",
      nested: { sessionToken: "top-secret-token" },
      error: "request failed for top-secret-token",
    });

    expect(output).not.toContain("top-secret-token");
    expect(JSON.parse(output)).toEqual({
      timestamp: "2026-09-01T00:00:00.000Z",
      level: "error",
      event: "test.failure",
      authorization: "[redacted]",
      nested: { sessionToken: "[redacted]" },
      error: "request failed for [redacted]",
    });
  });

  it("bounds and redacts error messages", () => {
    expect(
      safeErrorMessage(new Error(`failed: ${"secret-value"}`), [
        "secret-value",
      ]),
    ).toBe("failed: [redacted]");
  });
});
