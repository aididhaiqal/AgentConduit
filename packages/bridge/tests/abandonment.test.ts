import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoordinationService,
  CoordinationStore,
  type AgentRecord,
  type AgentRegistration,
  type AgentRegistrationInput,
  type MessageRecord,
} from "@agentconduit/core";
import { BridgeSupervisor, type BridgeClientLike } from "../src/index.js";

class DirectServiceClient implements BridgeClientLike {
  constructor(private readonly service: CoordinationService) {}

  register(input: AgentRegistrationInput): Promise<AgentRegistration> {
    return Promise.resolve(this.service.register(input));
  }

  heartbeat(
    agentId: string,
    sessionToken: string,
    workspacePath: string,
  ): Promise<AgentRecord> {
    return Promise.resolve(
      this.service.heartbeat(agentId, sessionToken, workspacePath),
    );
  }

  unregister(agentId: string, sessionToken: string): Promise<void> {
    this.service.unregister(agentId, sessionToken);
    return Promise.resolve();
  }

  listAgents(
    repositoryId?: string,
    activeOnly?: boolean,
  ): Promise<AgentRecord[]> {
    return Promise.resolve(
      this.service.listAgents(repositoryId, false, activeOnly ?? false),
    );
  }

  inbox(
    agentId: string,
    sessionToken: string,
    includeAcknowledged?: boolean,
  ): Promise<MessageRecord[]> {
    return Promise.resolve(
      this.service.inbox(agentId, sessionToken, includeAcknowledged),
    );
  }

  acknowledgeMessage(
    agentId: string,
    sessionToken: string,
    messageId: string,
  ): Promise<void> {
    this.service.acknowledgeMessage(agentId, sessionToken, messageId);
    return Promise.resolve();
  }

  sendMessage(
    senderAgentId: string,
    senderSessionToken: string,
    recipientAgentId: string,
    body: string,
    correlationId?: string,
  ): Promise<MessageRecord> {
    return Promise.resolve(
      this.service.sendMessage(
        senderAgentId,
        senderSessionToken,
        recipientAgentId,
        body,
        correlationId,
      ),
    );
  }
}

function makeRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentconduit-bridge-abandon-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "bridge@example.invalid"], {
    cwd: directory,
  });
  execFileSync("git", ["config", "user.name", "AgentConduit Bridge Test"], {
    cwd: directory,
  });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], {
    cwd: directory,
  });
  return directory;
}

describe("bridge abandonment boundary", () => {
  let repository: string | undefined;
  let service: CoordinationService | undefined;

  afterEach(() => {
    service?.close();
    service = undefined;
    if (repository) rmSync(repository, { recursive: true, force: true });
    repository = undefined;
  });

  it("keeps an abandoned row stale while a new chat receives a distinct active identity", async () => {
    repository = makeRepository();
    service = new CoordinationService({
      store: new CoordinationStore(":memory:", { heartbeatTimeoutMs: 1_000 }),
      heartbeatTimeoutMs: 1_000,
    });
    const client = new DirectServiceClient(service);
    const first = new BridgeSupervisor({
      client,
      registration: {
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "chat-label",
      },
    });
    const firstSnapshot = await first.start();
    service.store.db
      .prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?")
      .run(new Date(Date.now() - 10_000).toISOString(), firstSnapshot.agentId);

    expect(
      service
        .listAgents(firstSnapshot.repositoryId)
        .find((agent) => agent.agentId === firstSnapshot.agentId),
    ).toMatchObject({ status: "stale" });

    const second = new BridgeSupervisor({
      client,
      registration: {
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "chat-label",
      },
    });
    const secondSnapshot = await second.start();
    expect(secondSnapshot.agentId).not.toBe(firstSnapshot.agentId);
    expect(
      (await second.listActivePeers()).map((agent) => agent.agentId),
    ).not.toContain(firstSnapshot.agentId);
    expect(
      service
        .listAgents(firstSnapshot.repositoryId, false, true)
        .map((agent) => agent.agentId),
    ).toEqual([secondSnapshot.agentId]);
    await second.stop();
    // The first bridge is intentionally not stopped: this models a lost chat
    // or process. Its row remains available for explicit reconciliation.
  });
});
