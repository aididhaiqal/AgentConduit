import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationStore } from "@agentconduit/core";
import { createHubApp, HubEventNotifier, HubService } from "@agentconduit/hub";
import { NodeCoordinationBackend } from "../src/backend.js";
import { HubClient } from "../src/client.js";

const listeners: Server[] = [];
const stores: CoordinationStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    listeners
      .splice(0)
      .map(
        (listener) =>
          new Promise<void>((resolve) => listener.close(() => resolve())),
      ),
  );
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repositories(): { root: string; first: string; second: string } {
  const root = mkdtempSync("/tmp/agentconduit-node-backend-");
  directories.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "agentconduit@example.invalid"]);
  git(source, ["config", "user.name", "AgentConduit Test"]);
  mkdirSync(join(source, ".agentconduit"));
  writeFileSync(
    join(source, ".agentconduit", "project.json"),
    `${JSON.stringify({ projectId: "agentconduit.node-e2e" })}\n`,
  );
  writeFileSync(join(source, "README.md"), "initial\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "initial"]);
  const first = join(root, "pc-one");
  const second = join(root, "pc-two");
  git(root, ["clone", "-q", source, first]);
  git(root, ["clone", "-q", source, second]);
  for (const path of [first, second]) {
    git(path, ["config", "user.email", "agentconduit@example.invalid"]);
    git(path, ["config", "user.name", "AgentConduit Test"]);
  }
  git(first, ["checkout", "-qb", "feature/one"]);
  git(first, ["commit", "--allow-empty", "-qm", "feature one"]);
  git(first, ["checkout", "-q", "main"]);
  git(second, ["checkout", "-qb", "feature/two"]);
  git(second, ["commit", "--allow-empty", "-qm", "feature two"]);
  git(second, ["checkout", "-q", "main"]);
  return { root, first, second };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function hub() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const store = new CoordinationStore();
  stores.push(store);
  const service = new HubService(store);
  const app = createHubApp({
    service,
    ownerToken: `aco_${"f".repeat(64)}`,
    allowedOrigin: origin,
    secureCookies: false,
    notifier: new HubEventNotifier(),
  });
  const listener = app.listen(port, "127.0.0.1");
  listeners.push(listener);
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const device = (name: string) => {
    const enrollment = store.createDeviceEnrollment();
    return store.enrollDevice(enrollment.enrollmentCode, {
      name,
      platform: "linux",
      architecture: "x64",
      nodeVersion: "0.1.0",
      capabilities: ["mcp", "git-discovery", "event-stream"],
      health: {
        status: "healthy",
        uptimeSeconds: 10,
        memoryUsedPercent: 10,
      },
    });
  };
  return { origin, store, service, device };
}

describe("NodeCoordinationBackend", () => {
  it("redacts local facts before network I/O and globally serializes two independent clones", async () => {
    const repositoriesFixture = repositories();
    const remote = await hub();
    const firstDevice = remote.device("PC One");
    const secondDevice = remote.device("PC Two");
    const outboundBodies: string[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body === "string") outboundBodies.push(init.body);
      return await fetch(input, init);
    };
    const firstBackend = new NodeCoordinationBackend({
      client: new HubClient({
        baseUrl: remote.origin,
        deviceToken: firstDevice.deviceToken,
        allowInsecureLoopback: true,
        fetch: recordingFetch,
      }),
      deviceId: firstDevice.deviceId,
      allowedRoots: [repositoriesFixture.root],
      pathLabels: { [repositoriesFixture.root]: "PC One projects" },
    });
    const secondBackend = new NodeCoordinationBackend({
      client: new HubClient({
        baseUrl: remote.origin,
        deviceToken: secondDevice.deviceToken,
        allowInsecureLoopback: true,
        fetch: recordingFetch,
      }),
      deviceId: secondDevice.deviceId,
      allowedRoots: [repositoriesFixture.second],
    });

    const codex = await firstBackend.register({
      runtime: "codex",
      sessionRef: "pc-one-codex",
      workspacePath: repositoriesFixture.first,
    });
    const claude = await secondBackend.register({
      runtime: "claude-code",
      sessionRef: "pc-two-claude",
      workspacePath: repositoriesFixture.second,
    });
    expect(codex.workspace.repositoryId).toBe(claude.workspace.repositoryId);
    expect(codex.workspace.worktreeId).not.toBe(claude.workspace.worktreeId);
    expect(JSON.stringify(outboundBodies)).not.toContain(
      repositoriesFixture.first,
    );
    expect(JSON.stringify(outboundBodies)).not.toContain(
      repositoriesFixture.second,
    );
    expect(
      outboundBodies.some((body) =>
        body.includes('"pathLabel":"PC One projects"'),
      ),
    ).toBe(true);

    const sent = await firstBackend.sendMessage(
      codex.agentId,
      codex.sessionToken,
      claude.agentId,
      "Cross-PC review is ready.",
    );
    expect(
      await secondBackend.inbox(claude.agentId, claude.sessionToken),
    ).toContainEqual(sent);
    await secondBackend.acknowledgeMessage(
      claude.agentId,
      claude.sessionToken,
      sent.messageId,
    );

    const job = await firstBackend.createJob(
      codex.agentId,
      codex.sessionToken,
      {
        idempotencyKey: "create:node-job",
        kind: "review",
        displayName: "Cross-PC review",
      },
    );
    const progress = await firstBackend.emitJobEvent(
      codex.agentId,
      codex.sessionToken,
      job.jobId,
      {
        idempotencyKey: "event:node-checkpoint",
        type: "checkpoint",
        summary: "Remote review is ready",
      },
    );
    await expect(
      secondBackend.getJob(claude.agentId, claude.sessionToken, job.jobId),
    ).resolves.toMatchObject({
      status: "running",
      lastEventCursor: progress.cursor,
    });
    await expect(
      secondBackend.listJobs(claude.agentId, claude.sessionToken, {
        statuses: ["running"],
      }),
    ).resolves.toEqual([expect.objectContaining({ jobId: job.jobId })]);
    await expect(
      secondBackend.jobEvents(
        claude.agentId,
        claude.sessionToken,
        job.jobId,
        job.lastEventCursor,
        1,
      ),
    ).resolves.toEqual([progress]);

    const firstRequest = await firstBackend.enqueueIntegration(
      codex.agentId,
      codex.sessionToken,
      repositoriesFixture.first,
      "feature/one",
      "main",
    );
    const secondRequest = await secondBackend.enqueueIntegration(
      claude.agentId,
      claude.sessionToken,
      repositoriesFixture.second,
      "feature/two",
      "main",
    );
    const winner = await firstBackend.claimIntegration(
      codex.agentId,
      codex.sessionToken,
      firstRequest.requestId,
      repositoriesFixture.first,
    );
    expect(winner.status).toBe("claimed");
    await expect(
      secondBackend.claimIntegration(
        claude.agentId,
        claude.sessionToken,
        secondRequest.requestId,
        repositoriesFixture.second,
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    const snapshot = remote.service.snapshot();
    expect(snapshot.devices).toHaveLength(2);
    expect(snapshot.agents).toHaveLength(2);
    expect(snapshot.integrations).toHaveLength(2);
    expect(snapshot.jobs).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain(repositoriesFixture.first);
    expect(JSON.stringify(snapshot)).not.toContain(repositoriesFixture.second);
  });

  it("fails closed when the Hub is unavailable", async () => {
    const repositoriesFixture = repositories();
    const client = new HubClient({
      baseUrl: "http://127.0.0.1:9",
      deviceToken: `acd_${"a".repeat(64)}`,
      allowInsecureLoopback: true,
      requestTimeoutMs: 100,
    });
    const backend = new NodeCoordinationBackend({
      client,
      deviceId: `dev_${"b".repeat(32)}`,
      allowedRoots: [repositoriesFixture.first],
    });
    await expect(
      backend.register({
        runtime: "codex",
        workspacePath: repositoriesFixture.first,
      }),
    ).rejects.toMatchObject({
      code: "storage_error",
      details: { reason: "hub_unavailable", coordinated: false },
    });
  });

  it("bounds cursor replay even when a job has more than one Hub page", async () => {
    const repositoriesFixture = repositories();
    const remote = await hub();
    const device = remote.device("Replay PC");
    const backend = new NodeCoordinationBackend({
      client: new HubClient({
        baseUrl: remote.origin,
        deviceToken: device.deviceToken,
        allowInsecureLoopback: true,
      }),
      deviceId: device.deviceId,
      allowedRoots: [repositoriesFixture.first],
    });
    const agent = await backend.register({
      runtime: "codex",
      sessionRef: "bounded-job-replay",
      workspacePath: repositoriesFixture.first,
    });
    const job = await backend.createJob(agent.agentId, agent.sessionToken, {
      idempotencyKey: "create:bounded-replay",
      kind: "test",
      displayName: "Bounded replay",
    });
    for (let index = 0; index < 125; index += 1) {
      remote.store.appendJobEvent(
        agent.agentId,
        agent.sessionToken,
        job.jobId,
        {
          idempotencyKey: `event:bounded-${String(index).padStart(3, "0")}`,
          type: "working",
          summary: `Bounded event ${String(index)}`,
        },
      );
    }

    const first = await backend.jobEvents(
      agent.agentId,
      agent.sessionToken,
      job.jobId,
      0,
      120,
    );
    expect(first).toHaveLength(120);
    expect(first.map((event) => event.sequence)).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 1),
    );
    const remainder = await backend.jobEvents(
      agent.agentId,
      agent.sessionToken,
      job.jobId,
      first.at(-1)!.cursor,
      120,
    );
    expect(remainder).toHaveLength(6);
    expect(remainder[0]?.sequence).toBe(121);
    expect(remainder.at(-1)?.sequence).toBe(126);
  });

  it("drains a durable mixed inbox larger than one bounded Hub response", async () => {
    const repositoriesFixture = repositories();
    const remote = await hub();
    const senderDevice = remote.device("Sender PC");
    const recipientDevice = remote.device("Recipient PC");
    const sender = new NodeCoordinationBackend({
      client: new HubClient({
        baseUrl: remote.origin,
        deviceToken: senderDevice.deviceToken,
        allowInsecureLoopback: true,
      }),
      deviceId: senderDevice.deviceId,
      allowedRoots: [repositoriesFixture.first],
    });
    const recipient = new NodeCoordinationBackend({
      client: new HubClient({
        baseUrl: remote.origin,
        deviceToken: recipientDevice.deviceToken,
        allowInsecureLoopback: true,
      }),
      deviceId: recipientDevice.deviceId,
      allowedRoots: [repositoriesFixture.second],
    });
    const senderAgent = await sender.register({
      runtime: "codex",
      sessionRef: "large-inbox-sender",
      workspacePath: repositoriesFixture.first,
    });
    const recipientAgent = await recipient.register({
      runtime: "claude-code",
      sessionRef: "large-inbox-recipient",
      workspacePath: repositoriesFixture.second,
    });
    const expectedIds = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const prefix = `agent-${String(index).padStart(2, "0")}:`;
      const message = remote.store.sendMessage(
        {
          senderAgentId: senderAgent.agentId,
          recipientAgentId: recipientAgent.agentId,
          body: `${prefix}${"a".repeat(32 * 1_024 - prefix.length)}`,
        },
        senderAgent.sessionToken,
      );
      expectedIds.add(message.messageId);
      const ownerPrefix = `owner-${String(index).padStart(2, "0")}:`;
      const ownerMessage = remote.service.sendOperatorMessage(
        recipientAgent.agentId,
        `${ownerPrefix}${"o".repeat(32 * 1_024 - ownerPrefix.length)}`,
      );
      expectedIds.add(ownerMessage.messageId);
    }

    const inbox = await recipient.inbox(
      recipientAgent.agentId,
      recipientAgent.sessionToken,
    );
    expect(inbox).toHaveLength(40);
    expect(new Set(inbox.map((message) => message.messageId))).toEqual(
      expectedIds,
    );
  });
});
