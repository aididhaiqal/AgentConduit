import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { resolveDatabasePath } from "../src/main.js";
import { waitForStdioShutdown } from "../src/stdio.js";
import { makeGitRepository } from "./helpers.js";

function textOf(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  const content = result.content?.find((item) => item.type === "text");
  if (!content?.text) throw new Error("MCP result did not contain text");
  return content.text;
}

function spawnedProcess(transport: StdioClientTransport): ChildProcess {
  // The SDK exposes the PID but not the process completion status. Retain the
  // spawned process solely so this transport test can distinguish a clean EOF
  // shutdown from the SDK's SIGTERM/SIGKILL fallback.
  const child = (
    transport as unknown as {
      _process?: ChildProcess;
    }
  )._process;
  if (!child) throw new Error("stdio transport did not spawn a child process");
  return child;
}

describe("stdio broker lifecycle", () => {
  it("serves real MCP calls through the built stdio launcher and exits cleanly on EOF", async () => {
    const repository = makeGitRepository();
    const stateDirectory = mkdtempSync(
      join(tmpdir(), "agentconduit-stdio-state-"),
    );
    const databasePath = join(stateDirectory, "coordination.db");
    const launcher = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    const stderr: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        launcher,
        "--stdio",
        "--db",
        databasePath,
        "--allowed-root",
        repository,
      ],
      env: {
        TMPDIR: "/tmp",
        TEMP: "/tmp",
        TMP: "/tmp",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(chunk.toString());
    });
    const client = new Client({
      name: "agentconduit-stdio-test-client",
      version: "0.1.0",
    });

    await client.connect(transport);
    const child = spawnedProcess(transport);
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      expect(client.getServerVersion()?.name).toBe("agentconduit");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "workspace.discover",
          "agent.register",
          "agent.heartbeat",
        ]),
      );

      const registration = await client.callTool({
        name: "agent.register",
        arguments: {
          runtime: "codex",
          workspacePath: repository,
          sessionRef: "stdio-e2e-session",
        },
      });
      expect(registration.isError).not.toBe(true);
      const agent = JSON.parse(textOf(registration)) as {
        agentId: string;
        sessionToken: string;
        workspace: { branch?: string; headOid: string };
      };
      expect(agent.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
      expect(agent.sessionToken).toMatch(/^acs_[0-9a-f]{64}$/);
      expect(agent.workspace).toMatchObject({ branch: "main" });

      const heartbeat = await client.callTool({
        name: "agent.heartbeat",
        arguments: {
          agentId: agent.agentId,
          sessionToken: agent.sessionToken,
          workspacePath: repository,
        },
      });
      expect(heartbeat.isError).not.toBe(true);
      expect(JSON.parse(textOf(heartbeat))).toMatchObject({
        agentId: agent.agentId,
        workspace: {
          branch: "main",
          headOid: agent.workspace.headOid,
        },
      });
    } finally {
      // StdioClientTransport closes the child's stdin before waiting for exit.
      await client.close();
    }

    const closeResult = await closed;
    expect(closeResult, stderr.join("")).toEqual({ code: 0, signal: null });
  });

  it("stops once when stdin ends, ignoring a following close event", async () => {
    const processEvents = new EventEmitter();
    const stdin = new EventEmitter();
    let resolved = 0;
    const stopped = waitForStdioShutdown({ processEvents, stdin }).then(() => {
      resolved += 1;
    });

    stdin.emit("end");
    stdin.emit("close");
    await stopped;

    expect(resolved).toBe(1);
    expect(processEvents.listenerCount("SIGINT")).toBe(0);
    expect(stdin.listenerCount("end")).toBe(0);
  });

  it("stops on a termination signal and detaches stdin listeners", async () => {
    const processEvents = new EventEmitter();
    const stdin = new EventEmitter();
    const stopped = waitForStdioShutdown({ processEvents, stdin });

    processEvents.emit("SIGTERM");
    await stopped;

    expect(processEvents.listenerCount("SIGTERM")).toBe(0);
    expect(stdin.listenerCount("close")).toBe(0);
  });

  it("requires a shared absolute database path for stdio", () => {
    expect(() => resolveDatabasePath(undefined, true, "/workspace")).toThrow(
      "absolute --db path or AGENTCONDUIT_DB",
    );
    expect(() =>
      resolveDatabasePath("relative.db", true, "/workspace"),
    ).toThrow("absolute --db path or AGENTCONDUIT_DB");
    expect(resolveDatabasePath("/var/lib/agentconduit/state.db", true)).toBe(
      "/var/lib/agentconduit/state.db",
    );
  });

  it("keeps the existing HTTP default database location", () => {
    expect(resolveDatabasePath(undefined, false, "/workspace")).toBe(
      "/workspace/.agentconduit/coordination.db",
    );
  });
});
