import { describe, expect, it } from "vitest";
import { repositoryIdForProjectId } from "../src/git.js";
import type { DeviceHealth, GitWorkspaceSnapshot } from "../src/model.js";
import { attestWorkspaceForDevice } from "../src/remote.js";
import { CoordinationStore } from "../src/store.js";

const HEALTHY: DeviceHealth = {
  status: "healthy",
  uptimeSeconds: 120,
  memoryUsedPercent: 41.2,
  loadAverage1: 0.45,
};

function enroll(store: CoordinationStore, name = "Workshop PC") {
  const enrollment = store.createDeviceEnrollment({
    nameHint: name,
    ttlSeconds: 600,
  });
  return {
    enrollment,
    credential: store.enrollDevice(enrollment.enrollmentCode, {
      name,
      platform: "linux",
      architecture: "x64",
      nodeVersion: "0.1.0",
      capabilities: ["mcp", "git-discovery"],
      health: HEALTHY,
    }),
  };
}

function remoteWorkspace(
  projectId: string,
  worktreeId: string,
): GitWorkspaceSnapshot {
  return {
    repositoryId: repositoryIdForProjectId(projectId),
    projectId,
    worktreeId,
    rootPath: "/private/local/path/that-must-not-leave-the-node",
    commonGitDir: "/private/local/repository/.git",
    gitDir: "/private/local/repository/.git/worktrees/feature",
    remoteUrl: "github.com/example/project",
    branch: "feature/device",
    headOid: "a".repeat(40),
    dirty: false,
    upstream: {
      status: "available",
      ref: "origin/feature/device",
      ahead: 1,
      behind: 0,
    },
    isBare: false,
    observedAt: "2000-01-01T00:00:00.000Z",
  };
}

describe("single-owner remote coordination state", () => {
  it("removes every local path at the Node attestation boundary", () => {
    const local = {
      ...remoteWorkspace(
        "agentconduit.attestation-test",
        `wt_${"0".repeat(32)}`,
      ),
      remoteUrl: "file:///private/local/origin.git",
    };
    const deviceId = `dev_${"a".repeat(32)}`;
    const attestation = attestWorkspaceForDevice(
      local,
      deviceId,
      "payments-main",
    );

    expect(attestation.pathLabel).toBe("payments-main");
    expect(attestation.snapshot.rootPath).toMatch(/^device:\/\//);
    expect(attestation.snapshot.remoteUrl).toBeUndefined();
    expect(JSON.stringify(attestation)).not.toContain("/private/local");
    expect(() =>
      attestWorkspaceForDevice(local, deviceId, "/private/local/checkout"),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("enrolls once, stores only credential hashes, rotates, and revokes", () => {
    const store = new CoordinationStore();
    const { enrollment, credential } = enroll(store);

    expect(credential.deviceId).toMatch(/^dev_[0-9a-f]{32}$/);
    expect(credential.deviceToken).toMatch(/^acd_[0-9a-f]{64}$/);
    expect(credential.status).toBe("online");
    expect(() =>
      store.enrollDevice(enrollment.enrollmentCode, {
        name: "Replay PC",
        platform: "linux",
        architecture: "x64",
        nodeVersion: "0.1.0",
        health: HEALTHY,
      }),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));

    const stored = store.db
      .prepare("SELECT token_hash FROM devices WHERE device_id = ?")
      .get(credential.deviceId) as { token_hash: string };
    const storedEnrollment = store.db
      .prepare(
        "SELECT code_hash FROM device_enrollments WHERE enrollment_id = ?",
      )
      .get(enrollment.enrollmentId) as { code_hash: string };
    expect(stored.token_hash).not.toContain(credential.deviceToken);
    expect(storedEnrollment.code_hash).not.toContain(enrollment.enrollmentCode);

    const heartbeat = store.heartbeatDevice(credential.deviceToken, {
      nodeVersion: "0.1.1",
      capabilities: ["mcp", "git-discovery", "event-stream"],
      health: { ...HEALTHY, uptimeSeconds: 180 },
    });
    expect(heartbeat).toMatchObject({
      deviceId: credential.deviceId,
      nodeVersion: "0.1.1",
      status: "online",
    });

    const rotated = store.rotateDeviceCredential(credential.deviceId);
    expect(rotated.deviceToken).not.toBe(credential.deviceToken);
    expect(() => store.authenticateDevice(credential.deviceToken)).toThrowError(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(store.authenticateDevice(rotated.deviceToken).deviceId).toBe(
      credential.deviceId,
    );

    expect(store.revokeDevice(credential.deviceId).status).toBe("revoked");
    expect(() => store.authenticateDevice(rotated.deviceToken)).toThrowError(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(store.listDevices()).toHaveLength(1);
    expect(store.listDevices(false)).toEqual([]);
    store.close();
  });

  it("redacts remote paths, requires explicit project identity, and binds workspaces to devices", () => {
    const store = new CoordinationStore();
    const first = enroll(store, "Desk PC").credential;
    const second = enroll(store, "Travel PC").credential;
    const projectId = "agentconduit.remote-test";
    const firstSnapshot = remoteWorkspace(projectId, `wt_${"1".repeat(32)}`);
    const secondSnapshot = remoteWorkspace(projectId, `wt_${"2".repeat(32)}`);

    const registered = store.upsertRemoteWorkspace(
      first.deviceToken,
      firstSnapshot,
      "agentconduit-feature",
    );
    store.upsertRemoteWorkspace(
      second.deviceToken,
      secondSnapshot,
      "agentconduit-main",
    );

    expect(registered.workspace.rootPath).toBe(
      `device://${first.deviceId}/workspaces/${firstSnapshot.worktreeId}`,
    );
    expect(JSON.stringify(registered)).not.toContain("/private/local");
    expect(registered.workspace.observedAt).not.toBe(firstSnapshot.observedAt);
    expect(store.listRemoteWorkspaces(firstSnapshot.repositoryId)).toHaveLength(
      2,
    );
    expect(
      store.verifyDeviceOwnsWorkspace(
        first.deviceToken,
        firstSnapshot.worktreeId,
      ).deviceId,
    ).toBe(first.deviceId);
    expect(() =>
      store.verifyDeviceOwnsWorkspace(
        second.deviceToken,
        firstSnapshot.worktreeId,
      ),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));

    expect(() =>
      store.upsertRemoteWorkspace(
        first.deviceToken,
        { ...firstSnapshot, projectId: undefined },
        "invalid",
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.upsertRemoteWorkspace(
        first.deviceToken,
        { ...firstSnapshot, repositoryId: `repo_${"f".repeat(32)}` },
        "invalid",
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    const localRemote = store.upsertRemoteWorkspace(
      first.deviceToken,
      {
        ...firstSnapshot,
        worktreeId: `wt_${"4".repeat(32)}`,
        remoteUrl: "/private/local/origin.git",
      },
      "redacted-remote",
    );
    expect(localRemote.workspace.remoteUrl).toBeUndefined();
    expect(() =>
      store.upsertRemoteWorkspace(
        first.deviceToken,
        { ...firstSnapshot, worktreeId: `wt_${"5".repeat(32)}` },
        "C:\\private\\checkout",
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    store.close();
  });

  it("delivers owner messages and keeps claimed authority during revocation and reconciliation", () => {
    const store = new CoordinationStore();
    const device = enroll(store).credential;
    const snapshot = remoteWorkspace(
      "agentconduit.authority-test",
      `wt_${"3".repeat(32)}`,
    );
    const remote = store.upsertRemoteWorkspace(
      device.deviceToken,
      snapshot,
      "authority-worktree",
    );
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "remote-authority-agent",
      workspace: remote.workspace,
    });
    expect(
      store.verifyDeviceOwnsAgent(device.deviceToken, agent.agentId).deviceId,
    ).toBe(device.deviceId);

    const operatorMessage = store.sendOperatorMessage(
      agent.agentId,
      "Please reconcile the target ref before continuing.",
    );
    expect(operatorMessage.senderKind).toBe("owner");
    expect(store.operatorInbox(agent.agentId, agent.sessionToken)).toEqual([
      operatorMessage,
    ]);
    store.acknowledgeOperatorMessage(
      agent.agentId,
      agent.sessionToken,
      operatorMessage.messageId,
    );
    expect(store.operatorInbox(agent.agentId, agent.sessionToken)).toEqual([]);

    const cancellable = store.enqueueIntegration(
      {
        repositoryId: snapshot.repositoryId,
        sourceRef: "feature/cancel",
        sourceOid: "b".repeat(40),
        targetRef: "main",
        observedTargetOid: "a".repeat(40),
        requestedBy: agent.agentId,
      },
      agent.sessionToken,
    );
    expect(
      store.adminCancelUnclaimedIntegration(cancellable.requestId).status,
    ).toBe("cancelled");

    const claimed = store.enqueueIntegration(
      {
        repositoryId: snapshot.repositoryId,
        sourceRef: "feature/claimed",
        sourceOid: "c".repeat(40),
        targetRef: "main",
        observedTargetOid: "a".repeat(40),
        requestedBy: agent.agentId,
      },
      agent.sessionToken,
    );
    const active = store.claimIntegration(
      claimed.requestId,
      agent.agentId,
      agent.sessionToken,
      "c".repeat(40),
      "a".repeat(40),
    );
    expect(active.status).toBe("claimed");
    expect(() =>
      store.adminCancelUnclaimedIntegration(claimed.requestId),
    ).toThrowError(
      expect.objectContaining({
        code: "conflict",
        details: expect.objectContaining({ authorityPreserved: true }),
      }),
    );

    const reconciliation = store.openReconciliation(
      agent.agentId,
      "Device is being retired; inspect the external Git operation.",
    );
    expect(reconciliation.claimedIntegrationIds).toEqual([claimed.requestId]);
    expect(reconciliation.leaseIds).toEqual([active.leaseId]);
    expect(store.openReconciliation(agent.agentId, "repeat")).toEqual(
      reconciliation,
    );

    store.revokeDevice(device.deviceId);
    expect(store.getIntegration(claimed.requestId)).toMatchObject({
      status: "claimed",
      leaseId: active.leaseId,
    });
    expect(store.listLeases(snapshot.repositoryId)).toHaveLength(1);
    expect(store.listReconciliations("open")).toEqual([reconciliation]);
    store.close();
  });

  it("provides monotonic durable event cursors without reusing pruned cursors", () => {
    const store = new CoordinationStore();
    const first = store.recordAuditEvent("hub.started", "hub", {
      profile: "test",
    });
    const second = store.recordAuditEvent("hub.ready", "hub");
    expect(second.cursor).toBe(first.cursor + 1);
    expect(store.listAuditEvents(first.cursor)).toEqual([second]);

    store.db.prepare("DELETE FROM audit_events").run();
    const afterPrune = store.recordAuditEvent("hub.after_prune", "hub");
    expect(afterPrune.cursor).toBe(second.cursor + 1);
    expect(store.latestAuditCursor()).toBe(afterPrune.cursor);
    expect(store.listAuditEvents(0)).toEqual([afterPrune]);
    store.close();
  });
});
