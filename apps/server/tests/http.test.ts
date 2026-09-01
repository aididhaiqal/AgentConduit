import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CoordinationService, CoordinationStore } from "@agentconduit/core";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp, type HttpAppOptions } from "../src/http.js";
import { git, makeGitRepository } from "./helpers.js";

const clients: Client[] = [];
const listeners: Server[] = [];
const services: CoordinationService[] = [];

afterEach(async () => {
  await Promise.all(
    clients.splice(0).map((client) => client.close().catch(() => undefined)),
  );
  await Promise.all(
    listeners.splice(0).map(
      (listener) =>
        new Promise<void>((resolve, reject) => {
          listener.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  services.splice(0).forEach((service) => service.close());
});

async function startHttpServer(
  token?: string,
  options: Omit<HttpAppOptions, "host" | "token"> = {},
): Promise<string> {
  const service = new CoordinationService({ store: new CoordinationStore() });
  const app = createHttpApp(service, {
    host: "127.0.0.1",
    ...(token ? { token } : {}),
    ...options,
  });
  services.push(service);

  const listener = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  listeners.push(listener);

  const address = listener.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function connectHttpClient(
  baseUrl: string,
  token?: string,
  authScheme = "Bearer",
): Promise<Client> {
  const client = new Client({
    name: "agentconduit-http-test-client",
    version: "0.1.0",
  });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      ...(token
        ? {
            requestInit: {
              headers: { authorization: `${authScheme} ${token}` },
            },
          }
        : {}),
    },
  );
  await client.connect(transport);
  return client;
}

function textOf(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  const content = result.content?.find((item) => item.type === "text");
  if (!content?.text) throw new Error("MCP result did not contain text");
  return content.text;
}

describe("AgentConduit Streamable HTTP transport", () => {
  it("rejects non-loopback binding even when a bearer token is configured", () => {
    const service = new CoordinationService({ store: new CoordinationStore() });
    services.push(service);

    expect(() =>
      createHttpApp(service, {
        host: "0.0.0.0",
        token: "a-token-cannot-enable-remote-exposure",
      }),
    ).toThrow(
      "AgentConduit v1 only supports loopback HTTP binding; a bearer token does not enable remote exposure",
    );
  });

  it("fails closed when an empty bearer token is explicitly configured", () => {
    const service = new CoordinationService({ store: new CoordinationStore() });
    services.push(service);

    expect(() =>
      createHttpApp(service, { host: "127.0.0.1", token: "" }),
    ).toThrow("bearer token configuration must be non-empty");
  });

  it("rejects non-loopback Host headers to prevent DNS rebinding", async () => {
    const baseUrl = await startHttpServer();
    const url = new URL(`${baseUrl}/livez`);
    const response = await new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((resolveResponse, rejectResponse) => {
      const request = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: { host: "attacker.example" },
        },
        (incoming) => {
          incoming.setEncoding("utf8");
          let body = "";
          incoming.on("data", (chunk: string) => {
            body += chunk;
          });
          incoming.on("end", () => {
            resolveResponse({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body,
            });
          });
        },
      );
      request.once("error", rejectResponse);
      request.end();
    });

    expect(response.status).toBe(403);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(JSON.parse(response.body)).toMatchObject({
      error: { message: "Invalid Host: attacker.example" },
    });
  });

  it("exposes liveness, dependency readiness, request IDs, and security headers", async () => {
    let ready = true;
    const baseUrl = await startHttpServer(undefined, {
      readiness: () => {
        if (!ready) throw new Error("database unavailable");
      },
      requestId: () => "req_test_1",
    });

    const live = await fetch(`${baseUrl}/livez`);
    expect(live.status).toBe(200);
    expect(live.headers.get("x-request-id")).toBe("req_test_1");
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(live.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(live.json()).resolves.toMatchObject({ status: "alive" });

    const healthy = await fetch(`${baseUrl}/readyz`);
    expect(healthy.status).toBe(200);
    await expect(healthy.json()).resolves.toMatchObject({ status: "ready" });

    ready = false;
    const unavailable = await fetch(`${baseUrl}/readyz`);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      name: "agentconduit",
      version: "0.1.0",
      status: "not_ready",
    });
  });

  it("rate-limits the authenticated MCP surface without limiting health probes", async () => {
    const token = "agentconduit-rate-limit-token";
    const baseUrl = await startHttpServer(token, {
      limits: {
        rateLimitMaxRequests: 1,
        rateLimitWindowMs: 60_000,
      },
    });
    const headers = { authorization: `Bearer ${token}` };

    const unauthorized = await fetch(`${baseUrl}/mcp`);
    expect(unauthorized.status).toBe(401);
    const first = await fetch(`${baseUrl}/mcp`, { headers });
    expect(first.status).toBe(405);
    const limited = await fetch(`${baseUrl}/mcp`, { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });

    const live = await fetch(`${baseUrl}/livez`);
    expect(live.status).toBe(200);
  });

  it("returns bounded JSON errors for malformed and oversized request bodies", async () => {
    const token = "agentconduit-body-limit-token";
    const baseUrl = await startHttpServer(token, {
      limits: { bodyLimitBytes: 32 },
    });
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toContain("application/json");
    await expect(malformed.json()).resolves.toEqual({ error: "invalid_json" });

    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ payload: "x".repeat(128) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: "request_too_large",
    });
  });

  it("initializes over HTTP and preserves coordination state across tool requests", async () => {
    const repository = makeGitRepository();
    const baseUrl = await startHttpServer();

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      name: "agentconduit",
      version: "0.1.0",
      status: "ok",
    });

    const client = await connectHttpClient(baseUrl);
    expect(client.getServerVersion()?.name).toBe("agentconduit");

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("agent.register");

    const registered = await client.callTool({
      name: "agent.register",
      arguments: {
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "http-session-1",
      },
    });
    const agent = JSON.parse(textOf(registered)) as {
      agentId: string;
      sessionToken: string;
      workspace: { branch?: string };
    };
    expect(agent.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
    expect(agent.sessionToken).toMatch(/^acs_[0-9a-f]{64}$/);
    expect(agent.workspace.branch).toBe("main");

    const listed = await client.callTool({
      name: "agent.list",
      arguments: {},
    });
    const agents = JSON.parse(textOf(listed)) as Array<{ agentId: string }>;
    expect(agents.map((candidate) => candidate.agentId)).toContain(
      agent.agentId,
    );
  });

  it("protects MCP requests with bearer authentication while keeping health public", async () => {
    const repository = makeGitRepository();
    const token = "agentconduit-test-token";
    const baseUrl = await startHttpServer(token);

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "unauthorized-test-client", version: "0.1.0" },
        },
      }),
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({
      error: "unauthorized",
    });

    const incorrect = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { authorization: "Bearer incorrect-token" },
    });
    expect(incorrect.status).toBe(401);

    const client = await connectHttpClient(baseUrl, token);
    const result = await client.callTool({
      name: "server.info",
      arguments: {},
    });
    expect(JSON.parse(textOf(result))).toMatchObject({
      name: "agentconduit",
      protocol: "agentconduit.v1",
    });

    const registered = await client.callTool({
      name: "agent.register",
      arguments: {
        runtime: "claude-code",
        workspacePath: repository,
        sessionRef: "authenticated-http-session",
      },
    });
    const agent = JSON.parse(textOf(registered)) as {
      agentId: string;
      sessionToken: string;
    };

    const missingSessionToken = await client.callTool({
      name: "agent.heartbeat",
      arguments: {
        agentId: agent.agentId,
        workspacePath: repository,
      },
    });
    expect(missingSessionToken.isError).toBe(true);
    expect(textOf(missingSessionToken)).toContain("sessionToken");

    const invalidSessionToken = await client.callTool({
      name: "agent.heartbeat",
      arguments: {
        agentId: agent.agentId,
        sessionToken: `acs_${"0".repeat(64)}`,
        workspacePath: repository,
      },
    });
    expect(invalidSessionToken.isError).toBe(true);
    expect(JSON.parse(textOf(invalidSessionToken))).toMatchObject({
      error: "forbidden",
      message: "Agent session token is invalid",
    });

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
      status: "online",
    });
  });

  it("accepts the HTTP bearer authentication scheme case-insensitively", async () => {
    const token = "agentconduit-case-insensitive-token";
    const baseUrl = await startHttpServer(token);
    const client = await connectHttpClient(baseUrl, token, "bEaReR");

    const result = await client.callTool({
      name: "server.info",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({
      name: "agentconduit",
      protocol: "agentconduit.v1",
    });
  });

  it("coordinates two MCP clients from separate linked worktrees", async () => {
    const repository = makeGitRepository();
    const linkedWorktree = mkdtempSync(
      join(tmpdir(), "agentconduit-http-linked-"),
    );
    rmSync(linkedWorktree, { recursive: true });
    git(repository, ["checkout", "-qb", "feature/http-shared"]);
    git(repository, ["commit", "--allow-empty", "-qm", "shared feature"]);
    git(repository, ["checkout", "main"]);
    git(repository, [
      "worktree",
      "add",
      "-qb",
      "codex/http-linked",
      linkedWorktree,
    ]);

    const baseUrl = await startHttpServer();
    const claude = await connectHttpClient(baseUrl);
    const codex = await connectHttpClient(baseUrl);
    try {
      const claudeRegistration = await claude.callTool({
        name: "agent.register",
        arguments: {
          runtime: "claude-code",
          workspacePath: repository,
          sessionRef: "http-claude-linked-test",
        },
      });
      const claudeAgent = JSON.parse(textOf(claudeRegistration)) as {
        agentId: string;
        sessionToken: string;
        workspace: { repositoryId: string; worktreeId: string };
      };

      const codexRegistration = await codex.callTool({
        name: "agent.register",
        arguments: {
          runtime: "codex",
          workspacePath: linkedWorktree,
          sessionRef: "http-codex-linked-test",
        },
      });
      const codexAgent = JSON.parse(textOf(codexRegistration)) as {
        agentId: string;
        sessionToken: string;
        workspace: { repositoryId: string; worktreeId: string };
      };

      expect(codexAgent.workspace.repositoryId).toBe(
        claudeAgent.workspace.repositoryId,
      );
      expect(codexAgent.workspace.worktreeId).not.toBe(
        claudeAgent.workspace.worktreeId,
      );

      const listed = await claude.callTool({
        name: "agent.list",
        arguments: { repositoryId: claudeAgent.workspace.repositoryId },
      });
      expect(
        JSON.parse(textOf(listed)).map(
          (agent: { runtime: string }) => agent.runtime,
        ),
      ).toEqual(expect.arrayContaining(["claude-code", "codex"]));

      const sent = await claude.callTool({
        name: "message.send",
        arguments: {
          senderAgentId: claudeAgent.agentId,
          senderSessionToken: claudeAgent.sessionToken,
          recipientAgentId: codexAgent.agentId,
          body: "linked worktree handoff",
          correlationId: "http-linked-handoff",
        },
      });
      expect(sent.isError).not.toBe(true);

      const inbox = await codex.callTool({
        name: "message.inbox",
        arguments: {
          agentId: codexAgent.agentId,
          sessionToken: codexAgent.sessionToken,
        },
      });
      const messages = JSON.parse(textOf(inbox)) as Array<{
        messageId: string;
        body: string;
      }>;
      expect(messages).toEqual([
        expect.objectContaining({ body: "linked worktree handoff" }),
      ]);
      await codex.callTool({
        name: "message.ack",
        arguments: {
          agentId: codexAgent.agentId,
          sessionToken: codexAgent.sessionToken,
          messageId: messages[0]!.messageId,
        },
      });

      const first = await claude.callTool({
        name: "integration.enqueue",
        arguments: {
          agentId: claudeAgent.agentId,
          sessionToken: claudeAgent.sessionToken,
          workspacePath: repository,
          sourceRef: "feature/http-shared",
          targetRef: "main",
        },
      });
      const firstRequest = JSON.parse(textOf(first)) as { requestId: string };
      const second = await codex.callTool({
        name: "integration.enqueue",
        arguments: {
          agentId: codexAgent.agentId,
          sessionToken: codexAgent.sessionToken,
          workspacePath: linkedWorktree,
          sourceRef: "feature/http-shared",
          targetRef: "main",
        },
      });
      const secondRequest = JSON.parse(textOf(second)) as { requestId: string };

      const claimed = await claude.callTool({
        name: "integration.claim",
        arguments: {
          agentId: claudeAgent.agentId,
          sessionToken: claudeAgent.sessionToken,
          requestId: firstRequest.requestId,
          workspacePath: repository,
        },
      });
      expect(JSON.parse(textOf(claimed))).toMatchObject({
        requestId: firstRequest.requestId,
        status: "claimed",
      });

      const blocked = await codex.callTool({
        name: "integration.claim",
        arguments: {
          agentId: codexAgent.agentId,
          sessionToken: codexAgent.sessionToken,
          requestId: secondRequest.requestId,
          workspacePath: linkedWorktree,
        },
      });
      expect(blocked.isError).toBe(true);
      expect(JSON.parse(textOf(blocked))).toMatchObject({ error: "conflict" });
    } finally {
      await Promise.all([
        claude.close().catch(() => undefined),
        codex.close().catch(() => undefined),
      ]);
      git(repository, ["worktree", "remove", "--force", linkedWorktree]);
    }
  }, 60_000);
});
