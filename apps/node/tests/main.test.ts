import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceCredential } from "@agentconduit/core";
import type { StructuredLogger } from "@agentconduit/server";
import { HubClient } from "../src/client.js";
import { loadNodeConfig } from "../src/config.js";
import {
  parseNodeCliArgs,
  runNodeCli,
  type NodeCliDependencies,
} from "../src/main.js";

const directories: string[] = [];
const silentLogger: StructuredLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function credential(): DeviceCredential {
  return {
    deviceId: `dev_${"1".repeat(32)}`,
    deviceToken: `acd_${"2".repeat(64)}`,
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

function enrollmentFixture() {
  const root = mkdtempSync("/tmp/agentconduit-node-cli-");
  directories.push(root);
  chmodSync(root, 0o700);
  const projects = join(root, "projects");
  mkdirSync(projects, { mode: 0o700 });
  const codeFile = join(root, "enrollment-code");
  const code = `ace_${"3".repeat(48)}`;
  writeFileSync(codeFile, `${code}\n`, { mode: 0o600 });
  const configPath = join(root, "config", "node.json");
  const argv = [
    "enroll",
    "--config",
    configPath,
    "--state-dir",
    join(root, "state"),
    "--hub",
    "https://hub.example.test",
    "--enrollment-code-file",
    codeFile,
    "--name",
    "PC One",
    "--allowed-root",
    projects,
    "--path-label",
    `${projects}=Work projects`,
  ];
  return { root, projects, codeFile, code, configPath, argv };
}

function unusedDependencies(
  enroll: NodeCliDependencies["enroll"],
): NodeCliDependencies {
  return {
    enroll,
    client: () => {
      throw new Error("client was not expected");
    },
    logger: () => silentLogger,
    startRuntime: async () => {
      throw new Error("runtime was not expected");
    },
    runStdio: async () => {
      throw new Error("stdio was not expected");
    },
    waitForTermination: async () => "SIGTERM",
  };
}

describe("Node CLI", () => {
  it("parses a bounded enrollment command and rejects production-command drift", () => {
    const fixture = enrollmentFixture();
    expect(parseNodeCliArgs(fixture.argv, {})).toMatchObject({
      command: "enroll",
      configPath: fixture.configPath,
      allowedRoots: [fixture.projects],
      pathLabels: { [fixture.projects]: "Work projects" },
    });
    expect(() =>
      parseNodeCliArgs(
        ["serve", "--config", fixture.configPath, "--port", "9999"],
        {},
      ),
    ).toThrow("serve accepts only --config");
  });

  it("enrolls and prints only a token-free protected configuration summary", async () => {
    const fixture = enrollmentFixture();
    const output: string[] = [];
    const enroll = vi.fn<NodeCliDependencies["enroll"]>(async (_url, input) => {
      expect(input.enrollmentCode).toBe(fixture.code);
      return credential();
    });
    await expect(
      runNodeCli(
        parseNodeCliArgs(fixture.argv, {}),
        { stdout: (value) => output.push(value), stderr: () => undefined },
        unusedDependencies(enroll),
      ),
    ).resolves.toBe(0);
    const serialized = output.join("\n");
    expect(serialized).not.toContain(fixture.code);
    expect(serialized).not.toContain(credential().deviceToken);
    expect(serialized).not.toContain("acn_");
    expect(loadNodeConfig(fixture.configPath).deviceId).toBe(
      credential().deviceId,
    );
  });

  it("preflights local destinations before consuming the one-time enrollment", async () => {
    const fixture = enrollmentFixture();
    mkdirSync(join(fixture.root, "config"), { mode: 0o700 });
    writeFileSync(fixture.configPath, "already configured\n", { mode: 0o600 });
    const enroll = vi.fn<NodeCliDependencies["enroll"]>(async () =>
      credential(),
    );
    await expect(
      runNodeCli(
        parseNodeCliArgs(fixture.argv, {}),
        { stdout: () => undefined, stderr: () => undefined },
        unusedDependencies(enroll),
      ),
    ).rejects.toThrow("Node configuration file already exists");
    expect(enroll).not.toHaveBeenCalled();
  });

  it("doctor authenticates the enrolled device without printing credentials", async () => {
    const fixture = enrollmentFixture();
    await runNodeCli(
      parseNodeCliArgs(fixture.argv, {}),
      { stdout: () => undefined, stderr: () => undefined },
      unusedDependencies(async () => credential()),
    );
    const output: string[] = [];
    const client = new HubClient({
      baseUrl: "https://hub.example.test",
      deviceToken: credential().deviceToken,
      fetch: async () => Response.json({ result: credential() }),
    });
    const dependencies: NodeCliDependencies = {
      ...unusedDependencies(async () => credential()),
      client: () => client,
    };
    await runNodeCli(
      parseNodeCliArgs(["doctor", "--config", fixture.configPath], {}),
      { stdout: (value) => output.push(value), stderr: () => undefined },
      dependencies,
    );
    expect(output.join("\n")).toContain('"status": "ready"');
    expect(output.join("\n")).not.toContain(credential().deviceToken);
    expect(output.join("\n")).not.toContain(
      loadNodeConfig(fixture.configPath).localToken,
    );
  });
});
