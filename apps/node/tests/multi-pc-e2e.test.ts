import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CoordinationStore, type DeviceCredential } from "@agentconduit/core";
import {
  createHubApp,
  HubEventNotifier,
  HubService,
  type HubLogger,
} from "@agentconduit/hub";
import type { StructuredLogger } from "@agentconduit/server";
import { afterEach, describe, expect, it } from "vitest";
import { HubClient, enrollWithHub } from "../src/client.js";
import type { NodeRuntimeConfig } from "../src/config.js";
import { startNodeRuntime, type NodeRuntime } from "../src/runtime.js";

const temporaryDirectories: string[] = [];
const mcpClients: Client[] = [];
const nodeRuntimes: NodeRuntime[] = [];
const listeners: Server[] = [];
const stores: CoordinationStore[] = [];

afterEach(async () => {
  await Promise.all(
    mcpClients.splice(0).map((client) => client.close().catch(() => undefined)),
  );
  await Promise.all(
    nodeRuntimes.splice(0).map((runtime) => runtime.close("test_cleanup")),
  );
  await Promise.all(
    listeners.splice(0).map(
      (listener) =>
        new Promise<void>((resolve) => {
          listener.closeAllConnections?.();
          listener.close(() => resolve());
        }),
    ),
  );
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeIndependentClones(): { first: string; second: string } {
  const root = mkdtempSync(join(tmpdir(), "agentconduit-multi-pc-e2e-"));
  temporaryDirectories.push(root);
  chmodSync(root, 0o700);
  const seed = join(root, "seed");
  const first = join(root, "studio-clone");
  const second = join(root, "travel-clone");
  mkdirSync(seed);
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.email", "agentconduit-test@example.invalid"]);
  git(seed, ["config", "user.name", "AgentConduit Test"]);
  mkdirSync(join(seed, ".agentconduit"));
  writeFileSync(
    join(seed, ".agentconduit", "project.json"),
    '{"projectId":"multi-pc-e2e"}\n',
  );
  writeFileSync(join(seed, "README.md"), "# Multi-PC fixture\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-qm", "initial"]);
  git(seed, ["switch", "-qc", "feature/shared"]);
  writeFileSync(join(seed, "feature.txt"), "shared feature\n");
  git(seed, ["add", "feature.txt"]);
  git(seed, ["commit", "-qm", "shared feature"]);
  git(seed, ["switch", "-q", "main"]);
  git(root, ["clone", "-q", "--no-local", seed, first]);
  git(root, ["clone", "-q", "--no-local", seed, second]);
  for (const clone of [first, second]) {
    // Retain the fetched refs while ensuring no filesystem remote can become
    // Hub metadata in this privacy-boundary test.
    git(clone, [
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/owner/multi-pc-e2e.git",
    ]);
  }
  return { first, second };
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function startHub() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const ownerToken = `aco_${"1".repeat(64)}`;
  const store = new CoordinationStore(undefined, {
    deviceHeartbeatTimeoutMs: 1_000,
  });
  stores.push(store);
  const service = new HubService(store);
  const notifier = new HubEventNotifier();
  const logEntries: Array<{ event: string; fields?: Record<string, unknown> }> =
    [];
  const logger: HubLogger = {
    info: (event, fields) =>
      logEntries.push({ event, ...(fields ? { fields } : {}) }),
    warn: (event, fields) =>
      logEntries.push({ event, ...(fields ? { fields } : {}) }),
    error: (event, fields) =>
      logEntries.push({ event, ...(fields ? { fields } : {}) }),
  };
  const app = createHubApp({
    service,
    ownerToken,
    allowedOrigin: origin,
    secureCookies: false,
    notifier,
    logger,
  });
  const listener = app.listen(port, "127.0.0.1");
  listeners.push(listener);
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  return { origin, ownerToken, service, store, logEntries };
}

async function enroll(
  origin: string,
  service: HubService,
  name: string,
): Promise<DeviceCredential> {
  const enrollment = service.createEnrollment(name);
  return await enrollWithHub(
    origin,
    {
      enrollmentCode: enrollment.enrollmentCode,
      name,
      platform: "linux",
      architecture: "x64",
      nodeVersion: "0.1.0",
      capabilities: ["mcp", "git-discovery", "event-stream"],
      health: {
        status: "healthy",
        uptimeSeconds: 60,
        memoryUsedPercent: 20,
      },
    },
    { allowInsecureLoopback: true },
  );
}

function nodeConfig(
  root: string,
  origin: string,
  credential: DeviceCredential,
  name: string,
  localTokenCharacter: string,
): NodeRuntimeConfig {
  const state = join(root, `.node-${name.toLowerCase().replaceAll(" ", "-")}`);
  mkdirSync(state, { mode: 0o700 });
  const cursor = join(state, "event-cursor");
  writeFileSync(cursor, "0\n", { mode: 0o600 });
  return {
    version: 1,
    profile: "node-production",
    configPath: join(state, "config.json"),
    name,
    deviceId: credential.deviceId,
    hubUrl: origin,
    deviceTokenFile: join(state, "device-token"),
    deviceToken: credential.deviceToken,
    localTokenFile: join(state, "local-token"),
    localToken: `acn_${localTokenCharacter.repeat(64)}`,
    eventCursorFile: cursor,
    allowedRoots: [root],
    pathLabels: { [root]: `${name} workspace` },
    host: "127.0.0.1",
    port: 0,
    deviceHeartbeatIntervalMs: 200,
    hubRequestTimeoutMs: 3_000,
  };
}

const nodeLogger: StructuredLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function startNode(config: NodeRuntimeConfig): Promise<NodeRuntime> {
  const runtime = await startNodeRuntime({
    config,
    logger: nodeLogger,
    client: new HubClient({
      baseUrl: config.hubUrl,
      deviceToken: config.deviceToken,
      allowInsecureLoopback: true,
      requestTimeoutMs: config.hubRequestTimeoutMs,
    }),
  });
  nodeRuntimes.push(runtime);
  return runtime;
}

async function connectNode(
  endpoint: string,
  localToken: string,
): Promise<Client> {
  const client = new Client({
    name: "agentconduit-multi-pc-e2e",
    version: "0.1.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { authorization: `Bearer ${localToken}` },
    },
  });
  await client.connect(transport);
  mcpClients.push(client);
  return client;
}

function textOf(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  const content = result.content?.find((item) => item.type === "text");
  if (!content?.text) throw new Error("MCP result did not contain text");
  return content.text;
}

async function ownerSession(origin: string, ownerToken: string) {
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token: ownerToken }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { csrfToken: string };
  };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return { cookie: cookie!, csrf: body.result.csrfToken };
}

async function ownerMutation(
  origin: string,
  owner: { cookie: string; csrf: string },
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: owner.cookie,
      origin,
      "x-agentconduit-csrf": owner.csrf,
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("Condition did not become true before timeout");
}

describe("single-owner multi-PC retained boundary", () => {
  it("coordinates two independent clones through real Hub and Node MCP endpoints", async () => {
    const clones = makeIndependentClones();
    const hub = await startHub();
    const [studioCredential, travelCredential] = await Promise.all([
      enroll(hub.origin, hub.service, "Studio PC"),
      enroll(hub.origin, hub.service, "Travel PC"),
    ]);
    const studioConfig = nodeConfig(
      clones.first,
      hub.origin,
      studioCredential,
      "Studio PC",
      "2",
    );
    const travelConfig = nodeConfig(
      clones.second,
      hub.origin,
      travelCredential,
      "Travel PC",
      "3",
    );
    const [studioNode, travelNode] = await Promise.all([
      startNode(studioConfig),
      startNode(travelConfig),
    ]);
    const [claude, codex] = await Promise.all([
      connectNode(studioNode.endpoint, studioConfig.localToken),
      connectNode(travelNode.endpoint, travelConfig.localToken),
    ]);

    const claudeRegistration = await claude.callTool({
      name: "agent.register",
      arguments: {
        runtime: "claude-code",
        workspacePath: clones.first,
        sessionRef: "multi-pc-claude",
        displayName: "Claude Studio",
      },
    });
    const claudeAgent = JSON.parse(textOf(claudeRegistration)) as {
      agentId: string;
      sessionToken: string;
      workspace: {
        repositoryId: string;
        worktreeId: string;
        rootPath: string;
      };
    };
    const codexRegistration = await codex.callTool({
      name: "agent.register",
      arguments: {
        runtime: "codex",
        workspacePath: clones.second,
        sessionRef: "multi-pc-codex",
        displayName: "Codex Travel",
      },
    });
    const codexAgent = JSON.parse(
      textOf(codexRegistration),
    ) as typeof claudeAgent;
    expect(codexAgent.workspace.repositoryId).toBe(
      claudeAgent.workspace.repositoryId,
    );
    expect(codexAgent.workspace.worktreeId).not.toBe(
      claudeAgent.workspace.worktreeId,
    );
    expect(claudeAgent.workspace.rootPath).toMatch(
      new RegExp(`^device://${studioCredential.deviceId}/workspaces/`),
    );
    expect(codexAgent.workspace.rootPath).toMatch(
      new RegExp(`^device://${travelCredential.deviceId}/workspaces/`),
    );

    const visible = await claude.callTool({
      name: "agent.list",
      arguments: { repositoryId: claudeAgent.workspace.repositoryId },
    });
    expect(
      (JSON.parse(textOf(visible)) as Array<{ runtime: string }>).map(
        (agent) => agent.runtime,
      ),
    ).toEqual(expect.arrayContaining(["claude-code", "codex"]));

    const sent = await claude.callTool({
      name: "message.send",
      arguments: {
        senderAgentId: claudeAgent.agentId,
        senderSessionToken: claudeAgent.sessionToken,
        recipientAgentId: codexAgent.agentId,
        body: "Cross-PC handoff is ready",
        correlationId: "multi-pc-e2e-handoff",
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
      expect.objectContaining({ body: "Cross-PC handoff is ready" }),
    ]);
    await codex.callTool({
      name: "message.ack",
      arguments: {
        agentId: codexAgent.agentId,
        sessionToken: codexAgent.sessionToken,
        messageId: messages[0]!.messageId,
      },
    });
    const emptyInbox = await codex.callTool({
      name: "message.inbox",
      arguments: {
        agentId: codexAgent.agentId,
        sessionToken: codexAgent.sessionToken,
      },
    });
    expect(JSON.parse(textOf(emptyInbox))).toEqual([]);

    const firstEnqueue = await claude.callTool({
      name: "integration.enqueue",
      arguments: {
        agentId: claudeAgent.agentId,
        sessionToken: claudeAgent.sessionToken,
        workspacePath: clones.first,
        sourceRef: "refs/remotes/origin/feature/shared",
        targetRef: "refs/heads/main",
      },
    });
    const firstRequest = JSON.parse(textOf(firstEnqueue)) as {
      requestId: string;
    };
    const secondEnqueue = await codex.callTool({
      name: "integration.enqueue",
      arguments: {
        agentId: codexAgent.agentId,
        sessionToken: codexAgent.sessionToken,
        workspacePath: clones.second,
        sourceRef: "refs/remotes/origin/feature/shared",
        targetRef: "refs/heads/main",
      },
    });
    const secondRequest = JSON.parse(textOf(secondEnqueue)) as {
      requestId: string;
    };
    const [firstClaim, secondClaim] = await Promise.all([
      claude.callTool({
        name: "integration.claim",
        arguments: {
          agentId: claudeAgent.agentId,
          sessionToken: claudeAgent.sessionToken,
          requestId: firstRequest.requestId,
          workspacePath: clones.first,
        },
      }),
      codex.callTool({
        name: "integration.claim",
        arguments: {
          agentId: codexAgent.agentId,
          sessionToken: codexAgent.sessionToken,
          requestId: secondRequest.requestId,
          workspacePath: clones.second,
        },
      }),
    ]);
    expect([firstClaim.isError === true, secondClaim.isError === true]).toEqual(
      [false, true],
    );
    expect(JSON.parse(textOf(firstClaim))).toMatchObject({
      requestId: firstRequest.requestId,
      status: "claimed",
    });
    expect(JSON.parse(textOf(secondClaim))).toMatchObject({
      error: "conflict",
    });

    const deviceStreamClient = new HubClient({
      baseUrl: hub.origin,
      deviceToken: travelCredential.deviceToken,
      allowInsecureLoopback: true,
    });
    const streamAbort = new AbortController();
    const replay = await deviceStreamClient.openEventStream(
      0,
      streamAbort.signal,
    );
    const replayChunk = await replay.body!.getReader().read();
    streamAbort.abort();
    const replayText = new TextDecoder().decode(replayChunk.value);
    expect(replayText).toContain("event: coordination");
    expect(replayText).toContain("message.sent");
    expect(replayText).toContain("integration.claimed");

    const owner = await ownerSession(hub.origin, hub.ownerToken);
    const operatorMessage = await ownerMutation(
      hub.origin,
      owner,
      "/api/v1/admin/messages",
      {
        recipientAgentId: claudeAgent.agentId,
        body: "Owner requests a status check",
      },
    );
    expect(operatorMessage.status).toBe(200);
    const operatorInbox = await claude.callTool({
      name: "message.inbox",
      arguments: {
        agentId: claudeAgent.agentId,
        sessionToken: claudeAgent.sessionToken,
      },
    });
    expect(JSON.parse(textOf(operatorInbox))).toEqual([
      expect.objectContaining({ body: "Owner requests a status check" }),
    ]);

    const cannotCancelClaim = await ownerMutation(
      hub.origin,
      owner,
      "/api/v1/admin/integrations/cancel",
      { requestId: firstRequest.requestId },
    );
    expect(cannotCancelClaim.status).toBe(409);
    const cancelQueued = await ownerMutation(
      hub.origin,
      owner,
      "/api/v1/admin/integrations/cancel",
      { requestId: secondRequest.requestId },
    );
    expect(cancelQueued.status).toBe(200);
    expect(
      (await cancelQueued.json()) as { result: { status: string } },
    ).toMatchObject({ result: { status: "cancelled" } });

    const reconciliation = await ownerMutation(
      hub.origin,
      owner,
      "/api/v1/admin/reconciliations",
      {
        agentId: claudeAgent.agentId,
        reason: "Verify retained cross-PC claim after the test handoff",
      },
    );
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({
      result: {
        status: "open",
        claimedIntegrationIds: [firstRequest.requestId],
      },
    });

    const preservedLease = await codex.callTool({
      name: "lease.acquire",
      arguments: {
        agentId: codexAgent.agentId,
        sessionToken: codexAgent.sessionToken,
        resource: "multi-pc-e2e:revocation-preserves-authority",
        ttlSeconds: 300,
      },
    });
    expect(preservedLease.isError).not.toBe(true);
    const revoke = await ownerMutation(
      hub.origin,
      owner,
      "/api/v1/admin/devices/revoke",
      { deviceId: travelCredential.deviceId },
    );
    expect(revoke.status).toBe(200);
    const rejectedAfterRevoke = await codex.callTool({
      name: "agent.list",
      arguments: { repositoryId: codexAgent.workspace.repositoryId },
    });
    expect(rejectedAfterRevoke.isError).toBe(true);
    expect(JSON.parse(textOf(rejectedAfterRevoke))).toMatchObject({
      error: "forbidden",
    });
    await waitFor(
      async () =>
        (await fetch(`${travelNode.endpoint.replace(/\/mcp$/, "")}/readyz`))
          .status === 503,
    );

    const snapshotBeforeStale = hub.service.snapshot();
    expect(snapshotBeforeStale.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: travelCredential.deviceId,
          status: "revoked",
        }),
      ]),
    );
    expect(snapshotBeforeStale.leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ holderAgentId: codexAgent.agentId }),
      ]),
    );

    const serializedBoundary = JSON.stringify({
      snapshot: snapshotBeforeStale,
      logs: hub.logEntries,
    });
    expect(serializedBoundary).not.toContain(clones.first);
    expect(serializedBoundary).not.toContain(clones.second);
    expect(serializedBoundary).not.toContain(temporaryDirectories[0]!);
    expect(serializedBoundary).not.toContain(studioCredential.deviceToken);
    expect(serializedBoundary).not.toContain(travelCredential.deviceToken);
    expect(serializedBoundary).not.toContain(hub.ownerToken);

    await claude.close();
    mcpClients.splice(mcpClients.indexOf(claude), 1);
    await studioNode.close("stale_device_test");
    nodeRuntimes.splice(nodeRuntimes.indexOf(studioNode), 1);
    await waitFor(
      () =>
        hub.store
          .listDevices()
          .some(
            (device) =>
              device.deviceId === studioCredential.deviceId &&
              device.status === "stale",
          ),
      3_000,
    );
    const afterStale = hub.service.snapshot();
    expect(afterStale.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: firstRequest.requestId,
          status: "claimed",
          claimedBy: claudeAgent.agentId,
        }),
      ]),
    );
  }, 60_000);
});
