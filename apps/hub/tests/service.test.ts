import { describe, expect, it } from "vitest";
import {
  AGENTCONDUIT_NODE_PROTOCOL,
  CoordinationStore,
} from "@agentconduit/core";
import { HubService } from "../src/service.js";
import { parseNodeRpcRequest } from "../src/protocol.js";
import { enrollDevice, workspace } from "./helpers.js";

describe("HubService", () => {
  it("validates bounded provider-neutral job RPC payloads", () => {
    expect(
      parseNodeRpcRequest({
        protocol: AGENTCONDUIT_NODE_PROTOCOL,
        operation: "job.emit",
        params: {
          agentId: `agt_${"a".repeat(32)}`,
          sessionToken: `acs_${"b".repeat(64)}`,
          jobId: `job_${"c".repeat(32)}`,
          event: {
            idempotencyKey: "event:validated",
            type: "checkpoint",
            summary: "Bounded progress",
          },
        },
      }),
    ).toMatchObject({ operation: "job.emit" });
    expect(() =>
      parseNodeRpcRequest({
        protocol: AGENTCONDUIT_NODE_PROTOCOL,
        operation: "job.emit",
        params: {
          agentId: `agt_${"a".repeat(32)}`,
          sessionToken: `acs_${"b".repeat(64)}`,
          jobId: `job_${"c".repeat(32)}`,
          event: {
            idempotencyKey: "event:raw-stream",
            type: "checkpoint",
            summary: "raw\nprovider stream",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseNodeRpcRequest({
        protocol: AGENTCONDUIT_NODE_PROTOCOL,
        operation: "job.events",
        params: {
          agentId: `agt_${"a".repeat(32)}`,
          sessionToken: `acs_${"b".repeat(64)}`,
          jobId: `job_${"c".repeat(32)}`,
          limit: 101,
        },
      }),
    ).toThrow();
  });

  it("coordinates independent devices through one global message and integration authority", () => {
    const store = new CoordinationStore();
    const service = new HubService(store);
    const desk = enrollDevice(store, "Desk PC");
    const travel = enrollDevice(store, "Travel PC");
    const projectId = "agentconduit.multi-pc-service";
    const deskWorkspace = workspace(
      desk.deviceId,
      projectId,
      "1",
      "feature/desk",
      "b".repeat(40),
    );
    const travelWorkspace = workspace(
      travel.deviceId,
      projectId,
      "2",
      "feature/travel",
      "c".repeat(40),
    );

    const codex = service.execute(desk.deviceToken, "agent.register", {
      runtime: "codex",
      sessionRef: "desk-codex",
      workspace: deskWorkspace,
    });
    const claude = service.execute(travel.deviceToken, "agent.register", {
      runtime: "claude-code",
      sessionRef: "travel-claude",
      workspace: travelWorkspace,
    });
    expect(codex.workspace.rootPath).not.toContain("/home/");
    expect(claude.workspace.repositoryId).toBe(codex.workspace.repositoryId);

    const message = service.execute(desk.deviceToken, "message.send", {
      senderAgentId: codex.agentId,
      senderSessionToken: codex.sessionToken,
      recipientAgentId: claude.agentId,
      body: "Desk work is ready for review.",
    });
    expect(
      service.execute(travel.deviceToken, "message.inbox", {
        agentId: claude.agentId,
        sessionToken: claude.sessionToken,
      }).items,
    ).toContainEqual(message);

    const job = service.execute(desk.deviceToken, "job.create", {
      agentId: codex.agentId,
      sessionToken: codex.sessionToken,
      input: {
        idempotencyKey: "create:cross-device-job",
        kind: "review",
        displayName: "Review across PCs",
      },
    });
    const progress = service.execute(desk.deviceToken, "job.emit", {
      agentId: codex.agentId,
      sessionToken: codex.sessionToken,
      jobId: job.jobId,
      event: {
        idempotencyKey: "event:cross-device-checkpoint",
        type: "checkpoint",
        summary: "Review evidence is ready",
      },
    });
    expect(
      service.execute(travel.deviceToken, "job.get", {
        agentId: claude.agentId,
        sessionToken: claude.sessionToken,
        jobId: job.jobId,
      }),
    ).toMatchObject({ status: "running", lastEventCursor: progress.cursor });
    expect(
      service.execute(travel.deviceToken, "job.list", {
        agentId: claude.agentId,
        sessionToken: claude.sessionToken,
        statuses: ["running"],
      }).items,
    ).toEqual([expect.objectContaining({ jobId: job.jobId })]);
    const firstEventPage = service.execute(travel.deviceToken, "job.events", {
      agentId: claude.agentId,
      sessionToken: claude.sessionToken,
      jobId: job.jobId,
      limit: 1,
    });
    expect(firstEventPage.items).toEqual([
      expect.objectContaining({ type: "created", sequence: 1 }),
    ]);
    expect(firstEventPage.nextCursor).toBe(String(job.lastEventCursor));
    expect(
      service.execute(travel.deviceToken, "job.events", {
        agentId: claude.agentId,
        sessionToken: claude.sessionToken,
        jobId: job.jobId,
        cursor: firstEventPage.nextCursor,
        limit: 1,
      }).items,
    ).toEqual([progress]);
    expect(() =>
      service.execute(travel.deviceToken, "job.emit", {
        agentId: claude.agentId,
        sessionToken: claude.sessionToken,
        jobId: job.jobId,
        event: {
          idempotencyKey: "event:not-owner",
          type: "working",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));

    const first = service.execute(desk.deviceToken, "integration.enqueue", {
      agentId: codex.agentId,
      sessionToken: codex.sessionToken,
      workspace: deskWorkspace,
      sourceRef: "feature/desk",
      sourceOid: "b".repeat(40),
      targetRef: "main",
      observedTargetOid: "a".repeat(40),
    });
    const second = service.execute(travel.deviceToken, "integration.enqueue", {
      agentId: claude.agentId,
      sessionToken: claude.sessionToken,
      workspace: travelWorkspace,
      sourceRef: "feature/travel",
      sourceOid: "c".repeat(40),
      targetRef: "main",
      observedTargetOid: "a".repeat(40),
    });
    const claimed = service.execute(desk.deviceToken, "integration.claim", {
      agentId: codex.agentId,
      sessionToken: codex.sessionToken,
      requestId: first.requestId,
      workspace: deskWorkspace,
      currentSourceOid: "b".repeat(40),
      currentTargetOid: "a".repeat(40),
    });
    expect(claimed.status).toBe("claimed");
    expect(() =>
      service.execute(travel.deviceToken, "integration.claim", {
        agentId: claude.agentId,
        sessionToken: claude.sessionToken,
        requestId: second.requestId,
        workspace: travelWorkspace,
        currentSourceOid: "c".repeat(40),
        currentTargetOid: "a".repeat(40),
      }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));

    store.revokeDevice(desk.deviceId);
    expect(() =>
      service.execute(desk.deviceToken, "agent.list", {}),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(store.getIntegration(first.requestId)).toMatchObject({
      status: "claimed",
      leaseId: claimed.leaseId,
    });
    store.close();
  });

  it("exposes owner-wide snapshots and only the four bounded controls", () => {
    const store = new CoordinationStore();
    const service = new HubService(store);
    const device = enrollDevice(store, "Control PC");
    const observed = workspace(
      device.deviceId,
      "agentconduit.dashboard-service",
      "3",
      "main",
    );
    const agent = service.execute(device.deviceToken, "agent.register", {
      runtime: "codex",
      workspace: observed,
      sessionRef: "dashboard-agent",
    });
    const operator = service.sendOperatorMessage(
      agent.agentId,
      "Check the integration evidence.",
    );
    const reconciliation = service.openReconciliation(
      agent.agentId,
      "Agent session is stale in the UI.",
    );
    const job = service.execute(device.deviceToken, "job.create", {
      agentId: agent.agentId,
      sessionToken: agent.sessionToken,
      input: {
        idempotencyKey: "create:dashboard-job",
        kind: "analysis",
        displayName: "Dashboard job",
      },
    });

    const snapshot = service.snapshot();
    expect(snapshot.protocol).toBe(AGENTCONDUIT_NODE_PROTOCOL);
    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.messages).toContainEqual(operator);
    expect(snapshot.jobs).toContainEqual(job);
    expect(snapshot.reconciliations).toContainEqual(reconciliation);
    expect(JSON.stringify(snapshot)).not.toContain("deviceToken");
    expect(JSON.stringify(snapshot)).not.toContain("sessionToken");
    expect(JSON.stringify(snapshot)).not.toContain("/home/");
    store.close();
  });

  it("cursor-pages every Node collection at the protocol record limit", () => {
    const store = new CoordinationStore();
    const service = new HubService(store);
    const device = enrollDevice(store, "Paged PC");
    const projectId = "agentconduit.paged-workspaces";
    for (let index = 1; index <= 105; index += 1) {
      const observed = workspace(
        device.deviceId,
        projectId,
        "a",
        `feature/${index}`,
      );
      const worktreeId = `wt_${index.toString(16).padStart(32, "0")}`;
      const rootPath = `device://${device.deviceId}/workspaces/${worktreeId}`;
      observed.snapshot.worktreeId = worktreeId;
      observed.snapshot.rootPath = rootPath;
      observed.snapshot.gitDir = `${rootPath}/git`;
      observed.pathLabel = `workspace-${index}`;
      service.execute(device.deviceToken, "workspace.register", {
        workspace: observed,
      });
    }

    const first = service.execute(device.deviceToken, "workspace.list", {});
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toMatch(/^[1-9][0-9]*$/);
    const second = service.execute(device.deviceToken, "workspace.list", {
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.worktreeId))
        .size,
    ).toBe(105);
    store.close();
  });
});
