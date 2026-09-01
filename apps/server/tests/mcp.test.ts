import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationService, CoordinationStore } from "@agentconduit/core";
import { createMcpServer } from "../src/mcp.js";
import { git, makeGitRepository } from "./helpers.js";

const clients: Client[] = [];
const servers: ReturnType<typeof createMcpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    clients.splice(0).map((client) => client.close().catch(() => undefined)),
  );
  await Promise.all(
    servers.splice(0).map((server) => server.close().catch(() => undefined)),
  );
});

async function connectClient(
  service = new CoordinationService({ store: new CoordinationStore() }),
) {
  const server = createMcpServer(service);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "agentconduit-test-client",
    version: "0.1.0",
  });
  servers.push(server);
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, service };
}

function textOf(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  const content = result.content?.find((item) => item.type === "text");
  if (!content?.text) throw new Error("MCP result did not contain text");
  return content.text;
}

describe("AgentConduit MCP server", () => {
  it("advertises the coordination tools and server instructions", async () => {
    const { client } = await connectClient();
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("workspace.discover");
    expect(names).toContain("agent.register");
    expect(names).toContain("message.send");
    expect(names).toContain("job.create");
    expect(names).toContain("job.emit");
    expect(names).toContain("job.events");
    expect(names).toContain("integration.claim");
    expect(names).toContain("integration.renew");
    expect(
      tools.tools.every((tool) => tool.outputSchema?.type === "object"),
    ).toBe(true);
    expect(
      tools.tools.every((tool) =>
        Object.hasOwn(tool.outputSchema?.properties ?? {}, "result"),
      ),
    ).toBe(true);
    expect(
      tools.tools.find((tool) => tool.name === "integration.get")?.annotations
        ?.readOnlyHint,
    ).toBe(false);
    expect(
      tools.tools.find((tool) => tool.name === "integration.list")?.annotations
        ?.readOnlyHint,
    ).toBe(false);
    const info = await client.callTool({
      name: "server.info",
      arguments: {},
    });
    expect(JSON.parse(textOf(info))).toMatchObject({
      protocol: "agentconduit.v1",
      heartbeatTimeoutMs: 90_000,
      guarantees: expect.arrayContaining([
        "durable_job_events",
        "cursor_replay",
      ]),
    });
    expect(client.getServerVersion()?.name).toBe("agentconduit");
    expect(client.getInstructions()).toContain("integration.enqueue");
  });

  it("registers a real Git workspace and exchanges a message through MCP", async () => {
    const repository = makeGitRepository();
    const { client } = await connectClient();
    const registered = await client.callTool({
      name: "agent.register",
      arguments: {
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "mcp-session-1",
      },
    });
    expect(registered.isError, textOf(registered)).not.toBe(true);
    const agent = JSON.parse(textOf(registered)) as {
      agentId: string;
      sessionToken: string;
      workspace: { branch?: string; headOid: string };
    };
    expect(agent.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
    expect(agent.sessionToken).toMatch(/^acs_[0-9a-f]{64}$/);
    expect(agent.workspace.branch).toBe("main");
    expect(agent.workspace.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(registered.structuredContent).toEqual({
      result: JSON.parse(textOf(registered)),
    });

    git(repository, ["checkout", "-qb", "feature/mcp"]);
    const second = await client.callTool({
      name: "agent.register",
      arguments: {
        runtime: "claude-code",
        workspacePath: repository,
        sessionRef: "mcp-session-2",
      },
    });
    const recipient = JSON.parse(textOf(second)) as {
      agentId: string;
      sessionToken: string;
    };
    const message = await client.callTool({
      name: "message.send",
      arguments: {
        senderAgentId: agent.agentId,
        senderSessionToken: agent.sessionToken,
        recipientAgentId: recipient.agentId,
        body: "cross-runtime hello",
      },
    });
    expect(JSON.parse(textOf(message)).messageId).toMatch(/^msg_[0-9a-f]{32}$/);
    const inbox = await client.callTool({
      name: "message.inbox",
      arguments: {
        agentId: recipient.agentId,
        sessionToken: recipient.sessionToken,
      },
    });
    expect(JSON.parse(textOf(inbox))).toHaveLength(1);
    expect(inbox.structuredContent).toEqual({
      result: JSON.parse(textOf(inbox)),
    });
  });

  it("renews a claimed integration through the provider-neutral tool", async () => {
    const repository = makeGitRepository();
    git(repository, ["checkout", "-qb", "feature/mcp-renew"]);
    git(repository, ["commit", "--allow-empty", "-qm", "feature renew"]);
    git(repository, ["checkout", "main"]);
    const { client } = await connectClient();
    const registration = await client.callTool({
      name: "agent.register",
      arguments: {
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "mcp-renew-session",
      },
    });
    const agent = JSON.parse(textOf(registration)) as {
      agentId: string;
      sessionToken: string;
    };
    const enqueued = await client.callTool({
      name: "integration.enqueue",
      arguments: {
        agentId: agent.agentId,
        sessionToken: agent.sessionToken,
        workspacePath: repository,
        sourceRef: "feature/mcp-renew",
        targetRef: "main",
      },
    });
    const request = JSON.parse(textOf(enqueued)) as { requestId: string };
    const claimed = await client.callTool({
      name: "integration.claim",
      arguments: {
        agentId: agent.agentId,
        sessionToken: agent.sessionToken,
        requestId: request.requestId,
        workspacePath: repository,
      },
    });
    expect(JSON.parse(textOf(claimed)).status).toBe("claimed");
    const renewed = await client.callTool({
      name: "integration.renew",
      arguments: {
        agentId: agent.agentId,
        sessionToken: agent.sessionToken,
        requestId: request.requestId,
        workspacePath: repository,
        ttlSeconds: 60,
      },
    });
    expect(renewed.isError).not.toBe(true);
    expect(JSON.parse(textOf(renewed))).toMatchObject({
      requestId: request.requestId,
      status: "claimed",
    });
  });

  it("creates, advances, filters, and replays a durable job through MCP", async () => {
    const repository = makeGitRepository();
    const { client } = await connectClient();
    const registration = await client.callTool({
      name: "agent.register",
      arguments: {
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "mcp-job-session",
      },
    });
    const agent = JSON.parse(textOf(registration)) as {
      agentId: string;
      sessionToken: string;
    };
    const createdResult = await client.callTool({
      name: "job.create",
      arguments: {
        agentId: agent.agentId,
        sessionToken: agent.sessionToken,
        idempotencyKey: "create:mcp-job",
        kind: "analysis",
        displayName: "MCP durable job",
      },
    });
    const created = JSON.parse(textOf(createdResult)) as {
      jobId: string;
      lastEventCursor: number;
    };
    expect(created.jobId).toMatch(/^job_[0-9a-f]{32}$/);

    const emitted = await client.callTool({
      name: "job.emit",
      arguments: {
        agentId: agent.agentId,
        sessionToken: agent.sessionToken,
        jobId: created.jobId,
        idempotencyKey: "event:mcp-checkpoint",
        type: "checkpoint",
        phase: "review",
        summary: "MCP replay is connected",
      },
    });
    const progress = JSON.parse(textOf(emitted)) as {
      cursor: number;
      status: string;
    };
    expect(progress.status).toBe("running");

    const listed = await client.callTool({
      name: "job.list",
      arguments: {
        agentId: agent.agentId,
        sessionToken: agent.sessionToken,
        statuses: ["running"],
      },
    });
    expect(JSON.parse(textOf(listed))).toEqual([
      expect.objectContaining({ jobId: created.jobId, activity: "active" }),
    ]);
    const fetched = await client.callTool({
      name: "job.get",
      arguments: {
        agentId: agent.agentId,
        sessionToken: agent.sessionToken,
        jobId: created.jobId,
      },
    });
    expect(JSON.parse(textOf(fetched))).toMatchObject({
      jobId: created.jobId,
      status: "running",
      lastEventCursor: progress.cursor,
    });
    const replay = await client.callTool({
      name: "job.events",
      arguments: {
        agentId: agent.agentId,
        sessionToken: agent.sessionToken,
        jobId: created.jobId,
        afterCursor: created.lastEventCursor,
        limit: 10,
      },
    });
    expect(JSON.parse(textOf(replay))).toEqual([
      expect.objectContaining({
        cursor: progress.cursor,
        type: "checkpoint",
        summary: "MCP replay is connected",
      }),
    ]);
  });

  it("supports an explicit active-only presence view", async () => {
    const repository = git(makeGitRepository(), [
      "rev-parse",
      "--show-toplevel",
    ]);
    const service = new CoordinationService({
      store: new CoordinationStore(":memory:", { heartbeatTimeoutMs: 1_000 }),
      heartbeatTimeoutMs: 1_000,
    });
    const { client } = await connectClient(service);
    const first = await client.callTool({
      name: "agent.register",
      arguments: {
        runtime: "claude",
        workspacePath: repository,
        sessionRef: "active-only-stale",
      },
    });
    const stale = JSON.parse(textOf(first)) as { agentId: string };
    const second = await client.callTool({
      name: "agent.register",
      arguments: {
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "active-only-online",
      },
    });
    const online = JSON.parse(textOf(second)) as { agentId: string };
    service.store.db
      .prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?")
      .run(new Date(Date.now() - 10_000).toISOString(), stale.agentId);

    const active = await client.callTool({
      name: "agent.list",
      arguments: { activeOnly: true },
    });
    expect(
      JSON.parse(textOf(active)).map(
        (agent: { agentId: string }) => agent.agentId,
      ),
    ).toEqual([online.agentId]);
  });
});
