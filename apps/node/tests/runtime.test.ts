import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoordinationError,
  type DeviceRecord,
  type NodeRpcOperation,
} from "@agentconduit/core";
import type { StructuredLogger } from "@agentconduit/server";
import type { HubClient } from "../src/client.js";
import type { NodeRuntimeConfig } from "../src/config.js";
import { runNodeStdio, startNodeRuntime } from "../src/runtime.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const logger: StructuredLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function device(deviceId: string): DeviceRecord {
  return {
    deviceId,
    name: "PC One",
    platform: "linux",
    architecture: "x64",
    nodeVersion: "0.1.0",
    capabilities: ["mcp", "git-discovery", "event-stream"],
    health: {
      status: "healthy",
      uptimeSeconds: 1,
      memoryUsedPercent: 1,
    },
    status: "online",
    enrolledAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
  };
}

function runtimeConfig(): NodeRuntimeConfig {
  const root = mkdtempSync("/tmp/agentconduit-node-runtime-");
  directories.push(root);
  chmodSync(root, 0o700);
  return {
    version: 1,
    profile: "node-production",
    configPath: join(root, "node.json"),
    name: "PC One",
    deviceId: `dev_${"a".repeat(32)}`,
    hubUrl: "https://hub.example.test",
    deviceTokenFile: join(root, "device-token"),
    deviceToken: `acd_${"b".repeat(64)}`,
    localTokenFile: join(root, "local-token"),
    localToken: `acn_${"c".repeat(64)}`,
    eventCursorFile: join(root, "event-cursor"),
    allowedRoots: [root],
    pathLabels: {},
    host: "127.0.0.1",
    port: 0,
    deviceHeartbeatIntervalMs: 10,
    hubRequestTimeoutMs: 1_000,
  };
}

class FakeHubClient {
  heartbeatCalls = 0;
  revokeAfter = Number.POSITIVE_INFINITY;

  constructor(readonly deviceId: string) {}

  async rpc(operation: NodeRpcOperation): Promise<unknown> {
    if (operation !== "device.heartbeat") throw new Error("unexpected RPC");
    this.heartbeatCalls += 1;
    if (this.heartbeatCalls >= this.revokeAfter) {
      throw new CoordinationError("forbidden", "Device credential is revoked");
    }
    return device(this.deviceId);
  }

  async openEventStream(
    _cursor: number,
    signal: AbortSignal,
  ): Promise<Response> {
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  }
}

describe("Node runtime", () => {
  it("serves authenticated loopback MCP and becomes unready after revocation", async () => {
    const config = runtimeConfig();
    const client = new FakeHubClient(config.deviceId);
    client.revokeAfter = 2;
    const runtime = await startNodeRuntime({
      config,
      logger,
      client: client as unknown as HubClient,
    });
    try {
      const origin = runtime.endpoint.replace(/\/mcp$/, "");
      await vi.waitFor(() =>
        expect(client.heartbeatCalls).toBeGreaterThanOrEqual(2),
      );
      const readiness = await fetch(`${origin}/readyz`);
      expect(readiness.status).toBe(503);
      const unauthorized = await fetch(runtime.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);
    } finally {
      await runtime.close("test");
    }
  });

  it("keeps device heartbeats alive during stdio and drains them on exit", async () => {
    const config = runtimeConfig();
    const client = new FakeHubClient(config.deviceId);
    await runNodeStdio(
      config,
      logger,
      client as unknown as HubClient,
      async () => {
        await vi.waitFor(() =>
          expect(client.heartbeatCalls).toBeGreaterThanOrEqual(2),
        );
      },
    );
    const stoppedAt = client.heartbeatCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.heartbeatCalls).toBe(stoppedAt);
  });

  it("rejects a credential that resolves to another device before binding", async () => {
    const config = runtimeConfig();
    const client = new FakeHubClient(`dev_${"f".repeat(32)}`);
    await expect(
      startNodeRuntime({
        config,
        logger,
        client: client as unknown as HubClient,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
