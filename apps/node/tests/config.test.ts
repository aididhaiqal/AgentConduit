import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceCredential } from "@agentconduit/core";
import {
  initializeNodeConfigFromCredential,
  loadNodeConfig,
} from "../src/config.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function credential(): DeviceCredential {
  return {
    deviceId: `dev_${"d".repeat(32)}`,
    deviceToken: `acd_${"e".repeat(64)}`,
    name: "PC One",
    platform: "linux",
    architecture: "x64",
    nodeVersion: "0.1.0",
    capabilities: ["mcp"],
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

describe("Node production configuration", () => {
  it("creates protected secret, config, and cursor files without serializing tokens", () => {
    const root = mkdtempSync("/tmp/agentconduit-node-config-");
    directories.push(root);
    chmodSync(root, 0o700);
    const projects = join(root, "projects");
    mkdirSync(projects, { mode: 0o700 });
    const configPath = join(root, "config", "node.json");
    const summary = initializeNodeConfigFromCredential(
      {
        configPath,
        stateDirectory: join(root, "state"),
        name: "PC One",
        hubUrl: "https://hub.example.test",
        allowedRoots: [projects],
        pathLabels: { [projects]: "Work projects" },
      },
      credential(),
    );
    const serialized = readFileSync(configPath, "utf8");
    expect(serialized).not.toContain(credential().deviceToken);
    expect(JSON.stringify(summary)).not.toContain(credential().deviceToken);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(summary.deviceTokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(summary.localTokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(summary.eventCursorFile).mode & 0o777).toBe(0o600);
    const loaded = loadNodeConfig(configPath);
    expect(loaded.deviceToken).toBe(credential().deviceToken);
    expect(loaded.localToken).toMatch(/^acn_[0-9a-f]{64}$/);
    expect(loaded.pathLabels).toEqual({ [projects]: "Work projects" });
  });

  it("fails closed when protected configuration becomes group-readable", () => {
    const root = mkdtempSync("/tmp/agentconduit-node-config-");
    directories.push(root);
    chmodSync(root, 0o700);
    const projects = join(root, "projects");
    mkdirSync(projects, { mode: 0o700 });
    const configPath = join(root, "config", "node.json");
    initializeNodeConfigFromCredential(
      {
        configPath,
        stateDirectory: join(root, "state"),
        name: "PC One",
        hubUrl: "https://hub.example.test",
        allowedRoots: [projects],
      },
      credential(),
    );
    chmodSync(configPath, 0o640);
    expect(() => loadNodeConfig(configPath)).toThrow(
      "Node configuration file must be owned and private",
    );
  });
});
