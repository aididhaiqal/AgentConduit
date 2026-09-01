import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentRecord,
  AgentRegistration,
  AgentRegistrationInput,
  GitWorkspaceSnapshot,
  MessageRecord,
} from "@agentconduit/core";
import {
  BridgeSupervisor,
  type BridgeClientLike,
  type OwnedRuntimeAdapter,
} from "../src/index.js";

function workspace(
  repositoryId = "repo_bridge",
  worktreeId = "wt_bridge",
): GitWorkspaceSnapshot {
  return {
    repositoryId,
    worktreeId,
    rootPath: "/tmp/bridge-worktree",
    commonGitDir: "/tmp/bridge-worktree/.git",
    gitDir: "/tmp/bridge-worktree/.git",
    branch: "main",
    headOid: "a".repeat(40),
    dirty: false,
    upstream: { status: "unavailable" },
    isBare: false,
    observedAt: new Date().toISOString(),
  };
}

interface FakeSession {
  input: AgentRegistrationInput;
  registration: AgentRegistration;
  status: AgentRecord["status"];
}

class FakeClient implements BridgeClientLike {
  readonly sessions: FakeSession[] = [];
  readonly inputs: AgentRegistrationInput[] = [];
  readonly messages: MessageRecord[] = [];
  readonly acknowledgements: string[] = [];
  readonly listAgentCalls: Array<{
    repositoryId?: string;
    activeOnly?: boolean;
  }> = [];
  unregisterCalls = 0;
  closeCalls = 0;
  failNextAcknowledgement = false;
  registerGate: Promise<void> | undefined;
  inboxGate: Promise<void> | undefined;
  inboxEntered: (() => void) | undefined;
  acknowledgementGate: Promise<void> | undefined;
  serverInfo: (() => Promise<{ heartbeatTimeoutMs: number }>) | undefined =
    undefined;
  private nextId = 1;

  addPeer(
    status: AgentRecord["status"],
    worktreeId = `wt_peer_${status}`,
  ): AgentRecord {
    const peer: AgentRecord = {
      agentId: `agt_${String(this.nextId++).padStart(32, "0")}`,
      runtime: "peer-runtime",
      workspace: workspace("repo_bridge", worktreeId),
      capabilities: [],
      status,
      lastHeartbeat: new Date().toISOString(),
      registeredAt: new Date().toISOString(),
    };
    const token = `acs_${String(this.nextId++).padStart(64, "0")}`;
    this.sessions.push({
      input: {
        runtime: peer.runtime,
        workspacePath: peer.workspace.rootPath,
        sessionRef: `peer-${peer.agentId}`,
      },
      registration: { ...peer, sessionToken: token },
      status,
    });
    return peer;
  }

  queueMessage(recipientAgentId: string, body: string): MessageRecord {
    const message: MessageRecord = {
      messageId: `msg_${String(this.nextId++).padStart(32, "0")}`,
      senderAgentId: "agt_sender",
      recipientAgentId,
      body,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    return message;
  }

  register(input: AgentRegistrationInput): Promise<AgentRegistration> {
    return (async () => {
      if (this.registerGate) await this.registerGate;
      this.inputs.push({ ...input });
      const existing = this.sessions.find(
        (session) =>
          session.input.runtime === input.runtime &&
          session.input.workspacePath === input.workspacePath &&
          session.input.sessionRef === input.sessionRef,
      );
      if (existing) {
        if (existing.registration.sessionToken !== input.sessionToken) {
          throw new Error("previous session token required");
        }
        const rotated = `acs_${String(this.nextId++).padStart(64, "0")}`;
        existing.registration = {
          ...existing.registration,
          sessionToken: rotated,
          status: "online",
        };
        existing.status = "online";
        return { ...existing.registration };
      }
      const id = `agt_${String(this.nextId++).padStart(32, "0")}`;
      const token = `acs_${String(this.nextId++).padStart(64, "0")}`;
      const registered: AgentRegistration = {
        agentId: id,
        runtime: input.runtime,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        workspace: workspace("repo_bridge", `wt_${id}`),
        capabilities: input.capabilities ?? [],
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        registeredAt: new Date().toISOString(),
        sessionToken: token,
      };
      this.sessions.push({
        input: { ...input },
        registration: registered,
        status: "online",
      });
      return { ...registered };
    })();
  }

  private session(agentId: string, token: string): FakeSession {
    const session = this.sessions.find(
      (candidate) => candidate.registration.agentId === agentId,
    );
    if (!session || session.registration.sessionToken !== token) {
      throw new Error("invalid session token");
    }
    return session;
  }

  heartbeat(agentId: string, token: string): Promise<AgentRecord> {
    const session = this.session(agentId, token);
    session.status = "online";
    session.registration = {
      ...session.registration,
      status: "online",
      lastHeartbeat: new Date().toISOString(),
    };
    return Promise.resolve({ ...session.registration });
  }

  unregister(agentId: string, token: string): Promise<void> {
    const session = this.session(agentId, token);
    session.status = "offline";
    session.registration = { ...session.registration, status: "offline" };
    this.unregisterCalls += 1;
    return Promise.resolve();
  }

  listAgents(
    repositoryId?: string,
    activeOnly?: boolean,
  ): Promise<AgentRecord[]> {
    this.listAgentCalls.push({ repositoryId, activeOnly });
    const agents = this.sessions.map(({ registration, status }) => ({
      ...registration,
      status,
    }));
    return Promise.resolve(
      activeOnly ? agents.filter((agent) => agent.status === "online") : agents,
    );
  }

  inbox(
    agentId: string,
    token: string,
    includeAcknowledged = false,
  ): Promise<MessageRecord[]> {
    return (async () => {
      this.session(agentId, token);
      this.inboxEntered?.();
      if (this.inboxGate) await this.inboxGate;
      return this.messages.filter(
        (message) =>
          message.recipientAgentId === agentId &&
          (includeAcknowledged || !message.acknowledgedAt),
      );
    })();
  }

  acknowledgeMessage(
    agentId: string,
    token: string,
    messageId: string,
  ): Promise<void> {
    return (async () => {
      this.session(agentId, token);
      if (this.acknowledgementGate) await this.acknowledgementGate;
      if (this.failNextAcknowledgement) {
        this.failNextAcknowledgement = false;
        throw new Error("ack response was lost");
      }
      const message = this.messages.find(
        (candidate) => candidate.messageId === messageId,
      );
      if (!message || message.recipientAgentId !== agentId) {
        throw new Error("message not found");
      }
      message.acknowledgedAt = new Date().toISOString();
      this.acknowledgements.push(messageId);
    })();
  }

  sendMessage(
    senderAgentId: string,
    token: string,
    recipientAgentId: string,
    body: string,
    correlationId?: string,
  ): Promise<MessageRecord> {
    this.session(senderAgentId, token);
    const message: MessageRecord = {
      messageId: `msg_${String(this.nextId++).padStart(32, "0")}`,
      senderAgentId,
      recipientAgentId,
      body,
      ...(correlationId ? { correlationId } : {}),
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    return Promise.resolve(message);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

function ownershipPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "agentconduit-bridge-test-")),
    "owner.json",
  );
}

function adapterFor(pushes: MessageRecord[]): OwnedRuntimeAdapter {
  return {
    name: "test-adapter",
    version: "test-1",
    identity: { kind: "process", id: "test-process" },
    isAlive: () => true,
    push: async (message) => {
      pushes.push(message);
      return { accepted: true, capability: "test.push" };
    },
  };
}

describe("BridgeSupervisor", () => {
  it("does not report a session active after its local heartbeat freshness window", async () => {
    const client = new FakeClient();
    let now = 1_000_000;
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "clocked",
        workspacePath: "/tmp/clocked-worktree",
      },
      heartbeatIntervalMs: 100,
      brokerHeartbeatTimeoutMs: 500,
      clock: () => now,
    });
    await bridge.start();
    expect(bridge.snapshot().active).toBe(true);
    now += 600;
    expect(bridge.snapshot()).toMatchObject({
      active: false,
      agentStatus: "online",
    });
    await bridge.runCycle();
    expect(bridge.snapshot().active).toBe(true);
    await bridge.stop();
  });

  it("treats a wall-clock rollback as stale and forces a heartbeat", async () => {
    const client = new FakeClient();
    let now = 2_000_000;
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "rollback",
        workspacePath: "/tmp/rollback-worktree",
      },
      heartbeatIntervalMs: 100,
      brokerHeartbeatTimeoutMs: 500,
      clock: () => now,
    });
    await bridge.start();
    now -= 10_000;
    expect(bridge.snapshot().active).toBe(false);
    await bridge.runCycle();
    expect(bridge.snapshot().active).toBe(true);
    await bridge.stop();
  });

  it("caps local active status at the broker-reported heartbeat timeout", async () => {
    const client = new FakeClient();
    client.serverInfo = async () => ({ heartbeatTimeoutMs: 200 });
    let now = 3_000_000;
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "broker-timeout-calibration",
        workspacePath: "/tmp/broker-timeout-calibration-worktree",
      },
      heartbeatIntervalMs: 100,
      brokerHeartbeatTimeoutMs: 1_000,
      clock: () => now,
    });
    await bridge.start();
    now += 250;
    expect(bridge.snapshot().active).toBe(false);
    await bridge.stop();
  });

  it("fails closed when its heartbeat cadence cannot satisfy the broker timeout", async () => {
    const client = new FakeClient();
    client.serverInfo = async () => ({ heartbeatTimeoutMs: 100 });
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "broker-timeout-too-short",
        workspacePath: "/tmp/broker-timeout-too-short-worktree",
      },
      heartbeatIntervalMs: 100,
      brokerHeartbeatTimeoutMs: 1_000,
    });

    await expect(bridge.start()).rejects.toThrow(
      "heartbeatIntervalMs must be shorter than the broker heartbeat timeout reported by server.info",
    );
    expect(bridge.snapshot()).toMatchObject({ state: "failed", active: false });
    expect(client.inputs).toHaveLength(0);
    await bridge.stop();
  });

  it("creates a fresh session and excludes stale peers from active routing", async () => {
    const client = new FakeClient();
    const stale = client.addPeer("stale");
    const online = client.addPeer("online");
    const marker = ownershipPath();
    const first = new BridgeSupervisor({
      client,
      registration: {
        runtime: "codex",
        workspacePath: "/tmp/actual-worktree",
        sessionRef: "chat",
      },
      ownershipFile: marker,
    });

    const started = await first.start();
    expect(started.active).toBe(true);
    expect(started.agentId).toBeDefined();
    expect(client.inputs[0]?.sessionRef).toMatch(/^chat-brg_[0-9a-f]{32}$/);
    const activePeers = await first.listActivePeers();
    expect(activePeers.map((peer) => peer.agentId)).toEqual([online.agentId]);
    expect(activePeers.map((peer) => peer.agentId)).not.toContain(
      stale.agentId,
    );
    expect(client.listAgentCalls.at(-1)).toMatchObject({ activeOnly: true });

    const markerText = readFileSync(marker, "utf8");
    expect(markerText).not.toContain("acs_");
    expect(JSON.parse(markerText)).toMatchObject({ state: "running" });
    await first.stop();
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      state: "stopped",
    });

    const second = new BridgeSupervisor({
      client,
      registration: {
        runtime: "codex",
        workspacePath: "/tmp/actual-worktree",
        sessionRef: "chat",
      },
    });
    const restarted = await second.start();
    expect(restarted.agentId).not.toBe(started.agentId);
    expect(client.inputs[1]?.sessionRef).not.toBe(client.inputs[0]?.sessionRef);
    await second.stop();
    rmSync(marker, { force: true });
  });

  it("reconnects only with the prior token and never exposes the rotated token", async () => {
    const client = new FakeClient();
    const capturedTokens: string[] = [];
    const first = new BridgeSupervisor({
      client,
      registration: {
        runtime: "claude-code",
        workspacePath: "/tmp/reconnect-worktree",
        sessionRef: "stable-chat",
      },
      onPrivateRegistration: (registration) => {
        capturedTokens.push(registration.sessionToken);
      },
    });
    const initial = await first.start();
    const session = client.sessions.find(
      (candidate) => candidate.registration.agentId === initial.agentId,
    )!;
    const priorToken = capturedTokens[0]!;
    expect(priorToken).toBe(session.registration.sessionToken);
    const exactRef = client.inputs[0]!.sessionRef!;
    await first.stop();

    const resumed = new BridgeSupervisor({
      client,
      registration: {
        runtime: "claude-code",
        workspacePath: "/tmp/reconnect-worktree",
        sessionRef: exactRef,
        sessionToken: priorToken,
      },
      onPrivateRegistration: (registration) => {
        capturedTokens.push(registration.sessionToken);
      },
    });
    const result = await resumed.start();
    expect(result.agentId).toBe(initial.agentId);
    expect(result.sessionRef).toBe(exactRef);
    expect(JSON.stringify(result)).not.toContain("acs_");
    expect(session.registration.sessionToken).not.toBe(priorToken);
    expect(capturedTokens).toHaveLength(2);
    await resumed.stop();
  });

  it("marks registration uncertainty instead of claiming a clean shutdown", async () => {
    const client = new FakeClient();
    client.register = () => Promise.reject(new Error("response lost"));
    const marker = ownershipPath();
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "uncertain",
        workspacePath: "/tmp/uncertain-worktree",
      },
      ownershipFile: marker,
    });
    await expect(bridge.start()).rejects.toThrow("response lost");
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      state: "unknown",
    });
    expect(bridge.snapshot()).toMatchObject({ state: "failed" });
    expect(bridge.snapshot()).not.toHaveProperty("brokerStatus");
    rmSync(marker, { force: true });
  });

  it("serializes a stop requested while registration is still pending", async () => {
    const client = new FakeClient();
    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let registrationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      registrationEntered = resolve;
    });
    const register = client.register.bind(client);
    client.register = async (input) => {
      registrationEntered();
      await registrationGate;
      return register(input);
    };
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "race",
        workspacePath: "/tmp/race-worktree",
      },
    });

    const starting = bridge.start();
    await entered;
    const stopping = bridge.stop();
    releaseRegistration();

    await starting;
    const result = await stopping;
    expect(result.state).toBe("stopped");
    expect(client.unregisterCalls).toBe(1);
    expect(client.sessions[0]?.status).toBe("offline");
  });

  it("does not reactivate after the owned runtime exits during startup", async () => {
    const client = new FakeClient();
    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let registrationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      registrationEntered = resolve;
    });
    const register = client.register.bind(client);
    client.register = async (input) => {
      registrationEntered();
      await registrationGate;
      return register(input);
    };
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "startup-runtime-exit",
        workspacePath: "/tmp/startup-runtime-exit-worktree",
      },
    });

    const starting = bridge.start();
    await entered;
    const failed = await bridge.notifyRuntimeExit(
      "runtime exited during startup",
    );
    expect(failed).toMatchObject({
      state: "degraded",
      active: false,
    });
    releaseRegistration();

    await expect(starting).rejects.toThrow("runtime exited during startup");
    expect(bridge.snapshot()).toMatchObject({
      state: "degraded",
      active: false,
      brokerStatus: "unknown",
    });
    expect(client.unregisterCalls).toBe(0);
    const preserved = await bridge.stop();
    expect(preserved.state).toBe("degraded");
    await bridge.stop({ forceUnregister: true });
    expect(client.unregisterCalls).toBe(1);
  });

  it("turns a re-entrant stop from the registration callback into a queued shutdown request", async () => {
    const client = new FakeClient();
    let bridge!: BridgeSupervisor;
    let callbackSnapshot: ReturnType<BridgeSupervisor["snapshot"]> | undefined;
    bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "callback-stop",
        workspacePath: "/tmp/callback-stop-worktree",
      },
      onPrivateRegistration: async () => {
        callbackSnapshot = await bridge.stop();
      },
    });

    await bridge.start();
    expect(callbackSnapshot?.state).toBe("starting");
    const final = await bridge.stop();
    expect(final.state).toBe("stopped");
    expect(client.unregisterCalls).toBe(1);
  });

  it("allows a message handler to request shutdown without deadlocking the cycle", async () => {
    const client = new FakeClient();
    let bridge!: BridgeSupervisor;
    bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "message-callback-stop",
        workspacePath: "/tmp/message-callback-stop-worktree",
      },
      onMessage: async () => {
        await bridge.stop();
        return "defer";
      },
    });
    const started = await bridge.start();
    client.queueMessage(started.agentId!, "shutdown");
    await bridge.pollNow();
    expect((await bridge.stop()).state).toBe("stopped");
    expect(client.unregisterCalls).toBe(1);
  });

  it("keeps an async handler's awaited shutdown non-blocking while it is pending", async () => {
    const client = new FakeClient();
    let bridge!: BridgeSupervisor;
    let callbackSnapshot: ReturnType<BridgeSupervisor["snapshot"]> | undefined;
    bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "async-callback-stop",
        workspacePath: "/tmp/async-callback-stop-worktree",
      },
      onMessage: async () => {
        await Promise.resolve();
        callbackSnapshot = await bridge.stop();
        return "defer";
      },
    });
    const started = await bridge.start();
    client.queueMessage(started.agentId!, "async shutdown");
    await bridge.pollNow();

    expect(callbackSnapshot?.state).toBe("running");
    expect((await bridge.stop()).state).toBe("stopped");
    expect(client.unregisterCalls).toBe(1);
  });

  it("waits for shutdown when a callback-created microtask stops after return", async () => {
    const client = new FakeClient();
    let bridge!: BridgeSupervisor;
    let deferredStop:
      Promise<ReturnType<BridgeSupervisor["snapshot"]>> | undefined;
    bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "message-microtask-stop",
        workspacePath: "/tmp/message-microtask-stop-worktree",
      },
      onMessage: () => {
        queueMicrotask(() => {
          deferredStop = bridge.stop();
        });
        return "defer";
      },
    });
    const started = await bridge.start();
    client.queueMessage(started.agentId!, "deferred shutdown");
    await bridge.pollNow();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(deferredStop).toBeDefined();
    await expect(deferredStop).resolves.toMatchObject({ state: "stopped" });
    expect(client.unregisterCalls).toBe(1);
  });

  it("does not leak pending async callback context to a post-return microtask", async () => {
    const client = new FakeClient();
    let bridge!: BridgeSupervisor;
    let deferredStop:
      Promise<ReturnType<BridgeSupervisor["snapshot"]>> | undefined;
    bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "async-message-microtask-stop",
        workspacePath: "/tmp/async-message-microtask-stop-worktree",
      },
      onMessage: async () => {
        queueMicrotask(() => {
          deferredStop = bridge.stop();
        });
        return "defer";
      },
    });
    const started = await bridge.start();
    client.queueMessage(started.agentId!, "async deferred shutdown");
    await bridge.pollNow();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(deferredStop).toBeDefined();
    await expect(deferredStop).resolves.toMatchObject({ state: "stopped" });
    expect(client.unregisterCalls).toBe(1);
  });

  it("keeps an uncertain registration degraded when no response returned", async () => {
    const client = new FakeClient();
    const register = client.register.bind(client);
    client.register = async (input) => {
      await register(input);
      throw new Error("registration response was lost");
    };
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "uncertain-register",
        workspacePath: "/tmp/uncertain-register-worktree",
      },
    });

    await expect(bridge.start()).rejects.toThrow(
      "registration response was lost",
    );
    const result = await bridge.stop();
    expect(result.state).toBe("degraded");
    expect(result.active).toBe(false);
    expect(client.unregisterCalls).toBe(0);
  });

  it("retains an owned client for forced cleanup after post-registration failure", async () => {
    const client = new FakeClient();
    const bridge = new BridgeSupervisor({
      client,
      ownsClient: true,
      registration: {
        runtime: "callback-failure",
        workspacePath: "/tmp/callback-failure-worktree",
      },
      onPrivateRegistration: () => {
        throw new Error("protected state unavailable");
      },
    });

    await expect(bridge.start()).rejects.toThrow("protected state unavailable");
    expect(client.closeCalls).toBe(0);
    const result = await bridge.stop({ forceUnregister: true });
    expect(result.state).toBe("stopped");
    expect(client.unregisterCalls).toBe(1);
    expect(client.closeCalls).toBe(1);
  });

  it("does not unregister after a cycle fails closed while stop is waiting", async () => {
    const client = new FakeClient();
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "cycle-race",
        workspacePath: "/tmp/cycle-race-worktree",
      },
      onMessage: async () => "acknowledge",
    });
    const started = await bridge.start();
    client.queueMessage(started.agentId!, "cycle uncertainty");
    let releaseInbox!: () => void;
    const inboxGate = new Promise<void>((resolve) => {
      releaseInbox = resolve;
    });
    client.inboxGate = inboxGate;
    let enteredCount = 0;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    client.inboxEntered = () => {
      enteredCount += 1;
      if (enteredCount === 1) resolveEntered();
    };
    client.failNextAcknowledgement = true;

    const cycle = bridge.runCycle();
    await entered;
    const stopping = bridge.stop();
    releaseInbox();

    await expect(cycle).rejects.toThrow("ack response was lost");
    const result = await stopping;
    expect(result.state).toBe("degraded");
    expect(result.brokerStatus).toBe("unknown");
    expect(client.unregisterCalls).toBe(0);
  });

  it("waits for an external heartbeat before unregistering and closing", async () => {
    const client = new FakeClient();
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "heartbeat-stop-race",
        workspacePath: "/tmp/heartbeat-stop-race-worktree",
      },
    });
    await bridge.start();
    const originalHeartbeat = client.heartbeat.bind(client);
    let heartbeatCalls = 0;
    let releaseHeartbeat!: () => void;
    const heartbeatGate = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    let heartbeatEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      heartbeatEntered = resolve;
    });
    client.heartbeat = async (agentId, token, workspacePath) => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) {
        heartbeatEntered();
        await heartbeatGate;
      }
      return originalHeartbeat(agentId, token, workspacePath);
    };

    const heartbeating = bridge.heartbeatNow();
    await entered;
    const stopping = bridge.stop();
    expect(client.unregisterCalls).toBe(0);
    releaseHeartbeat();
    await heartbeating;
    expect((await stopping).state).toBe("stopped");
    expect(client.unregisterCalls).toBe(1);
  });

  it("waits for an external send before unregistering", async () => {
    const client = new FakeClient();
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "send-stop-race",
        workspacePath: "/tmp/send-stop-race-worktree",
      },
    });
    const started = await bridge.start();
    const originalSend = client.sendMessage.bind(client);
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      sendEntered = resolve;
    });
    client.sendMessage = async (
      senderAgentId,
      token,
      recipientAgentId,
      body,
      correlationId,
    ) => {
      sendEntered();
      await sendGate;
      return originalSend(
        senderAgentId,
        token,
        recipientAgentId,
        body,
        correlationId,
      );
    };

    const sending = bridge.sendMessage("agt_recipient", "waited", "corr");
    await entered;
    const stopping = bridge.stop();
    expect(client.unregisterCalls).toBe(0);
    releaseSend();
    await expect(sending).resolves.toMatchObject({ body: "waited" });
    expect((await stopping).state).toBe("stopped");
    expect(client.unregisterCalls).toBe(1);
  });

  it("does not report peer discovery as successful after runtime exit", async () => {
    const client = new FakeClient();
    const peer = client.addPeer("online");
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "post-await-runtime-exit",
        workspacePath: "/tmp/post-await-runtime-exit-worktree",
      },
    });
    const started = await bridge.start();

    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listEntered!: () => void;
    const listEnteredPromise = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    const originalList = client.listAgents.bind(client);
    client.listAgents = async (repositoryId, activeOnly) => {
      listEntered();
      await listGate;
      return originalList(repositoryId, activeOnly);
    };
    const listing = bridge.listActivePeers();
    await listEnteredPromise;
    await bridge.notifyRuntimeExit("runtime exited during peer discovery");
    releaseList();
    await expect(listing).rejects.toThrow("bridge became inactive");
    expect(bridge.snapshot().state).toBe("degraded");

    // A degraded bridge cannot start another operation; force cleanup is the
    // explicit reconciliation boundary for the retained broker row.
    await bridge.stop({ forceUnregister: true });
    expect(client.unregisterCalls).toBe(1);
    expect(peer.agentId).toBeDefined();
    expect(started.agentId).toBeDefined();
  });

  it("does not report a send as successful after runtime exit", async () => {
    const client = new FakeClient();
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "send-runtime-exit",
        workspacePath: "/tmp/send-runtime-exit-worktree",
      },
    });
    await bridge.start();
    const originalSend = client.sendMessage.bind(client);
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendEntered!: () => void;
    const sendEnteredPromise = new Promise<void>((resolve) => {
      sendEntered = resolve;
    });
    client.sendMessage = async (
      senderAgentId,
      token,
      recipientAgentId,
      body,
      correlationId,
    ) => {
      sendEntered();
      await sendGate;
      return originalSend(
        senderAgentId,
        token,
        recipientAgentId,
        body,
        correlationId,
      );
    };

    const sending = bridge.sendMessage("agt_recipient", "uncertain-send");
    await sendEnteredPromise;
    await bridge.notifyRuntimeExit("runtime exited during send");
    releaseSend();
    await expect(sending).rejects.toThrow("bridge became inactive");
    expect(client.messages.map((message) => message.body)).toContain(
      "uncertain-send",
    );
    expect(bridge.snapshot().state).toBe("degraded");
    await bridge.stop({ forceUnregister: true });
    expect(client.unregisterCalls).toBe(1);
  });

  it("stops an in-flight inbox cycle before handling or acknowledging more messages after runtime exit", async () => {
    const client = new FakeClient();
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let enteredHandler!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      enteredHandler = resolve;
    });
    const handled: string[] = [];
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "in-flight-runtime-exit",
        workspacePath: "/tmp/in-flight-runtime-exit-worktree",
      },
      onMessage: async (message) => {
        handled.push(message.messageId);
        enteredHandler();
        await handlerGate;
        return "acknowledge";
      },
    });
    const started = await bridge.start();
    const first = client.queueMessage(started.agentId!, "first");
    const second = client.queueMessage(started.agentId!, "second");
    const polling = bridge.pollNow();
    await handlerEntered;
    await bridge.notifyRuntimeExit("runtime exited while handling inbox");
    releaseHandler();
    await polling;

    expect(handled).toEqual([first.messageId]);
    expect(handled).not.toContain(second.messageId);
    expect(client.acknowledgements).toEqual([]);
    expect(bridge.snapshot()).toMatchObject({
      state: "degraded",
      active: false,
      brokerStatus: "unknown",
    });
    await bridge.stop({ forceUnregister: true });
  });

  it("treats native push as a hint and acknowledges only on explicit handler consent", async () => {
    const client = new FakeClient();
    const pushes: MessageRecord[] = [];
    let handled = 0;
    const bridge = new BridgeSupervisor({
      client,
      registration: {
        runtime: "test-runtime",
        workspacePath: "/tmp/push-worktree",
      },
      runtimeAdapter: adapterFor(pushes),
      onMessage: async () => {
        handled += 1;
        return "defer";
      },
    });
    const started = await bridge.start();
    const deferred = client.queueMessage(started.agentId!, "wake me");
    await bridge.pollNow();
    expect(pushes.map((message) => message.messageId)).toEqual([
      deferred.messageId,
    ]);
    expect(client.acknowledgements).toEqual([]);
    expect(handled).toBe(1);

    let acknowledge = true;
    const acknowledging = new BridgeSupervisor({
      client,
      registration: { runtime: "another", workspacePath: "/tmp/push-worktree" },
      onMessage: async () => (acknowledge ? "acknowledge" : "defer"),
    });
    const other = await acknowledging.start();
    const message = client.queueMessage(other.agentId!, "process me");
    await acknowledging.pollNow();
    expect(client.acknowledgements).toContain(message.messageId);
    acknowledge = false;
    await bridge.stop();
    await acknowledging.stop();
  });

  it("fails closed on uncertain acknowledgement instead of replaying the handler", async () => {
    const client = new FakeClient();
    let handled = 0;
    const events: Array<{ type: string; phase?: string }> = [];
    const bridge = new BridgeSupervisor({
      client,
      registration: { runtime: "test", workspacePath: "/tmp/ack-worktree" },
      onMessage: async () => {
        handled += 1;
        return "acknowledge";
      },
      onEvent: (event) => events.push(event),
    });
    const started = await bridge.start();
    client.queueMessage(started.agentId!, "uncertain");
    client.failNextAcknowledgement = true;
    await expect(bridge.pollNow()).rejects.toThrow("ack response was lost");
    expect(bridge.snapshot()).toMatchObject({
      state: "degraded",
      active: false,
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", phase: "ack" }),
    );
    expect(handled).toBe(1);
    // A failed-closed bridge does not run a second handler attempt.
    await expect(bridge.pollNow()).resolves.toMatchObject({
      state: "degraded",
    });
  });

  it("preserves broker state when the owned runtime exits", async () => {
    const client = new FakeClient();
    const marker = ownershipPath();
    const bridge = new BridgeSupervisor({
      client,
      registration: { runtime: "test", workspacePath: "/tmp/runtime-worktree" },
      ownershipFile: marker,
    });
    await bridge.start();
    const failed = await bridge.notifyRuntimeExit("child process exited");
    expect(failed).toMatchObject({
      state: "degraded",
      active: false,
      brokerStatus: "unknown",
    });
    expect(client.unregisterCalls).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      state: "unknown",
    });
    const preserved = await bridge.stop();
    expect(preserved).toMatchObject({
      state: "degraded",
      brokerStatus: "unknown",
    });
    expect(client.unregisterCalls).toBe(0);
    await bridge.stop({ forceUnregister: true });
    expect(client.unregisterCalls).toBe(1);
    rmSync(marker, { force: true });
  });
});
