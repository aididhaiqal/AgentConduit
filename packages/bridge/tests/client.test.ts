import { describe, expect, it } from "vitest";
import {
  McpAgentConduitClient,
  McpBrokerError,
  parseMcpToolResult,
} from "../src/client.js";
import { parseBridgeCliArgs } from "../src/main.js";

describe("MCP bridge client", () => {
  it("prefers structured AgentConduit output and parses legacy text output", () => {
    expect(
      parseMcpToolResult<{ value: number }>({
        structuredContent: { result: { value: 7 } },
        content: [{ type: "text", text: '{"value": 1}' }],
      }),
    ).toEqual({ value: 7 });
    expect(
      parseMcpToolResult<{ value: number }>({
        content: [{ type: "text", text: '{"value": 8}' }],
      }),
    ).toEqual({ value: 8 });
  });

  it("turns structured tool failures into a broker error without losing its code", () => {
    expect(() =>
      parseMcpToolResult(
        {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "forbidden",
                message: "Agent session token is invalid",
              }),
            },
          ],
        },
        "agent.heartbeat",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<McpBrokerError>>({
        code: "forbidden",
        message: "Agent session token is invalid",
      }),
    );
  });

  it("redacts supplied secrets when parsing a standalone structured failure", () => {
    const secret = "acs_" + "3".repeat(64);
    expect(() =>
      parseMcpToolResult(
        {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `forbidden-${secret}`,
                message: `failed-${secret}`,
                details: { nested: `value-${secret}` },
              }),
            },
          ],
        },
        "agent.register",
        [secret],
      ),
    ).toThrowError(
      expect.objectContaining<Partial<McpBrokerError>>({
        code: "forbidden-[redacted]",
        message: "failed-[redacted]",
        details: { nested: "value-[redacted]" },
      }),
    );
  });

  it("routes typed calls through the dotted MCP tool names", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> =
      [];
    const fakeClient = {
      callTool: async (request: {
        name: string;
        arguments?: Record<string, unknown>;
      }) => {
        calls.push(request);
        if (request.name === "agent.register") {
          return {
            structuredContent: {
              result: {
                agentId: "agt_00000000000000000000000000000001",
                runtime: "test",
                workspace: {
                  repositoryId: "repo_test",
                  worktreeId: "wt_test",
                  rootPath: "/tmp/test",
                  commonGitDir: "/tmp/test/.git",
                  gitDir: "/tmp/test/.git",
                  headOid: "a".repeat(40),
                  dirty: false,
                  upstream: { status: "unavailable" },
                  isBare: false,
                  observedAt: new Date().toISOString(),
                },
                capabilities: [],
                status: "online",
                lastHeartbeat: new Date().toISOString(),
                registeredAt: new Date().toISOString(),
                sessionToken: "acs_" + "1".repeat(64),
              },
            },
          };
        }
        return { structuredContent: { result: [] } };
      },
      close: async () => undefined,
    };
    const client = new McpAgentConduitClient(fakeClient as never);
    await client.register({ runtime: "test", workspacePath: "/tmp/test" });
    await client.listAgents("repo_test");
    await client.listAgents("repo_test", true);
    await client.inbox(
      "agt_00000000000000000000000000000001",
      "acs_" + "1".repeat(64),
    );
    expect(calls.map((call) => call.name)).toEqual([
      "agent.register",
      "agent.list",
      "agent.list",
      "message.inbox",
    ]);
    expect(calls[0]?.arguments).not.toHaveProperty("sessionToken");
    expect(calls[2]?.arguments).toEqual({
      repositoryId: "repo_test",
      activeOnly: true,
    });
    await client.close();
  });

  it("redacts session and bearer secrets from structured error details", async () => {
    const sessionToken = "acs_" + "2".repeat(64);
    const bearerToken = "broker-secret-value";
    const fakeClient = {
      callTool: async () => ({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "forbidden",
              message: `request failed for ${sessionToken}`,
              details: {
                sessionToken,
                nested: `bearer=${bearerToken}`,
                authorization: bearerToken,
              },
            }),
          },
        ],
      }),
      close: async () => undefined,
    };
    const client = new McpAgentConduitClient(fakeClient as never, [
      bearerToken,
    ]);

    await expect(
      client.inbox("agt_00000000000000000000000000000001", sessionToken),
    ).rejects.toMatchObject({
      message: "request failed for [redacted]",
      details: {
        sessionToken: "[redacted]",
        nested: "bearer=[redacted]",
        authorization: "[redacted]",
      },
    });
  });

  it("reads the broker heartbeat timeout through server.info", async () => {
    const fakeClient = {
      callTool: async (request: { name: string }) => {
        expect(request.name).toBe("server.info");
        return {
          structuredContent: { result: { heartbeatTimeoutMs: 12_345 } },
        };
      },
      close: async () => undefined,
    };
    const client = new McpAgentConduitClient(fakeClient as never);
    await expect(client.serverInfo()).resolves.toEqual({
      heartbeatTimeoutMs: 12_345,
    });
  });
});

describe("bridge CLI argument parser", () => {
  it("requires one broker transport and keeps session tokens out of argv", () => {
    expect(
      parseBridgeCliArgs(["--url", "http://127.0.0.1:8787/mcp"]),
    ).toMatchObject({
      url: "http://127.0.0.1:8787/mcp",
      workspace: process.cwd(),
    });
    expect(() => parseBridgeCliArgs([])).toThrow("exactly one");
    expect(() =>
      parseBridgeCliArgs([
        "--url",
        "http://127.0.0.1:8787/mcp",
        "--stdio-command",
        "agentconduit-mcp",
      ]),
    ).toThrow("exactly one");
  });
});
