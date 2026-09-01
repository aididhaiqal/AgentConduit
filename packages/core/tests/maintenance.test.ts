import { describe, expect, it } from "vitest";
import { CoordinationStore } from "../src/store.js";
import type { GitWorkspaceSnapshot } from "../src/model.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function workspace(worktreeId: string): GitWorkspaceSnapshot {
  return {
    repositoryId: "repo_maintenance",
    worktreeId,
    rootPath: `/tmp/${worktreeId}`,
    commonGitDir: "/tmp/maintenance/.git",
    gitDir: `/tmp/maintenance/.git/worktrees/${worktreeId}`,
    branch: "main",
    headOid: "a".repeat(40),
    dirty: false,
    upstream: { status: "unavailable" },
    isBare: false,
    observedAt: new Date().toISOString(),
  };
}

function policy(now = Date.now()) {
  const cutoff = new Date(now - DAY_MS).toISOString();
  return {
    staleBefore: cutoff,
    acknowledgedMessagesBefore: cutoff,
    terminalIntegrationsBefore: cutoff,
    terminalJobsBefore: cutoff,
    auditEventsBefore: cutoff,
  };
}

describe("CoordinationStore maintenance", () => {
  it("previews an old safe stale agent without mutation and applies the same action", () => {
    const store = new CoordinationStore(":memory:", {
      heartbeatTimeoutMs: 1_000,
    });
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "safe-stale",
      workspace: workspace("wt_safe_stale"),
    });
    store.db
      .prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?")
      .run(new Date(Date.now() - 2 * DAY_MS).toISOString(), agent.agentId);

    const preview = store.runMaintenance(policy());

    expect(preview).toMatchObject({
      mode: "preview",
      staleAgents: {
        candidates: 1,
        blocked: 0,
        markedOffline: 1,
      },
      blockers: [],
    });
    expect(store.getAgent(agent.agentId).status).toBe("stale");

    const applied = store.runMaintenance(policy(), { apply: true });

    expect(applied).toMatchObject({
      mode: "applied",
      staleAgents: preview.staleAgents,
      blockers: preview.blockers,
      pruned: preview.pruned,
      expiredLeaseRecovery: preview.expiredLeaseRecovery,
    });
    expect(store.getAgent(agent.agentId).status).toBe("offline");
    store.close();
  });

  it("reports live generic leases and claimed integrations as blockers without releasing them", () => {
    const store = new CoordinationStore(":memory:", {
      heartbeatTimeoutMs: 1_000,
    });
    const genericHolder = store.registerAgent({
      runtime: "claude-code",
      sessionRef: "generic-lease-holder",
      workspace: workspace("wt_generic_holder"),
    });
    const claimant = store.registerAgent({
      runtime: "codex",
      sessionRef: "integration-claimant",
      workspace: workspace("wt_integration_claimant"),
    });
    const genericLease = store.acquireLease(
      "release:main",
      genericHolder.agentId,
      genericHolder.sessionToken,
      300,
    );
    const request = store.enqueueIntegration(
      {
        repositoryId: "repo_maintenance",
        sourceRef: "refs/heads/feature/claimed",
        sourceOid: "a".repeat(40),
        targetRef: "refs/heads/claimed-target",
        observedTargetOid: "b".repeat(40),
        requestedBy: claimant.agentId,
      },
      claimant.sessionToken,
    );
    const claimed = store.claimIntegration(
      request.requestId,
      claimant.agentId,
      claimant.sessionToken,
      "a".repeat(40),
      "b".repeat(40),
      300,
    );
    const oldHeartbeat = new Date(Date.now() - 2 * DAY_MS).toISOString();
    store.db
      .prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id IN (?, ?)")
      .run(oldHeartbeat, genericHolder.agentId, claimant.agentId);

    const result = store.runMaintenance(policy(), { apply: true });

    expect(result.staleAgents).toEqual({
      candidates: 2,
      blocked: 2,
      markedOffline: 0,
    });
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: genericHolder.agentId,
          leaseIds: [genericLease.leaseId],
          claimedIntegrationIds: [],
        }),
        expect.objectContaining({
          agentId: claimant.agentId,
          leaseIds: [claimed.leaseId],
          claimedIntegrationIds: [request.requestId],
        }),
      ]),
    );
    expect(store.getAgent(genericHolder.agentId).status).toBe("stale");
    expect(store.getAgent(claimant.agentId).status).toBe("stale");
    expect(
      store.db.prepare("SELECT lease_id FROM leases ORDER BY lease_id").all(),
    ).toEqual(
      expect.arrayContaining([
        { lease_id: genericLease.leaseId },
        { lease_id: claimed.leaseId },
      ]),
    );
    expect(store.getIntegration(request.requestId).status).toBe("claimed");
    store.close();
  });

  it("recovers an expired integration lease before reconciling its stale holder", () => {
    const store = new CoordinationStore(":memory:", {
      heartbeatTimeoutMs: 1_000,
    });
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "expired-integration-holder",
      workspace: workspace("wt_expired_holder"),
    });
    const request = store.enqueueIntegration(
      {
        repositoryId: "repo_maintenance",
        sourceRef: "refs/heads/feature/expired",
        sourceOid: "a".repeat(40),
        targetRef: "refs/heads/expired-target",
        observedTargetOid: "b".repeat(40),
        requestedBy: agent.agentId,
      },
      agent.sessionToken,
    );
    const claimed = store.claimIntegration(
      request.requestId,
      agent.agentId,
      agent.sessionToken,
      "a".repeat(40),
      "b".repeat(40),
      300,
    );
    const old = new Date(Date.now() - 2 * DAY_MS).toISOString();
    store.db
      .prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?")
      .run(old, agent.agentId);
    store.db
      .prepare("UPDATE leases SET expires_at = ? WHERE lease_id = ?")
      .run(old, claimed.leaseId);

    const preview = store.runMaintenance(policy());

    expect(preview).toMatchObject({
      mode: "preview",
      expiredLeaseRecovery: {
        leasesRemoved: 1,
        integrationsMarkedNeedsRefresh: 1,
      },
      staleAgents: { candidates: 1, blocked: 0, markedOffline: 1 },
    });
    expect(
      store.db
        .prepare(
          "SELECT status, claimed_by, lease_id FROM integration_requests WHERE request_id = ?",
        )
        .get(request.requestId),
    ).toEqual({
      status: "claimed",
      claimed_by: agent.agentId,
      lease_id: claimed.leaseId,
    });
    expect(
      store.db
        .prepare("SELECT lease_id FROM leases WHERE lease_id = ?")
        .get(claimed.leaseId),
    ).toEqual({ lease_id: claimed.leaseId });

    const applied = store.runMaintenance(policy(), { apply: true });

    expect(applied.expiredLeaseRecovery).toEqual(preview.expiredLeaseRecovery);
    expect(applied.staleAgents).toEqual(preview.staleAgents);
    expect(store.getAgent(agent.agentId).status).toBe("offline");
    expect(store.getIntegration(request.requestId)).toMatchObject({
      status: "needs_refresh",
    });
    expect(store.getIntegration(request.requestId)).not.toHaveProperty(
      "claimedBy",
    );
    expect(
      store.db
        .prepare("SELECT lease_id FROM leases WHERE lease_id = ?")
        .get(claimed.leaseId),
    ).toBeUndefined();
    store.close();
  });

  it("preserves an uncertain lease timestamp as a reconciliation blocker", () => {
    const store = new CoordinationStore(":memory:", {
      heartbeatTimeoutMs: 1_000,
    });
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "uncertain-lease-holder",
      workspace: workspace("wt_uncertain_holder"),
    });
    const lease = store.acquireLease(
      "release:uncertain",
      agent.agentId,
      agent.sessionToken,
      300,
    );
    store.db
      .prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?")
      .run(new Date(Date.now() - 2 * DAY_MS).toISOString(), agent.agentId);
    store.db
      .prepare("UPDATE leases SET expires_at = ? WHERE lease_id = ?")
      .run("", lease.leaseId);

    const applied = store.runMaintenance(policy(), { apply: true });

    expect(applied.expiredLeaseRecovery.leasesRemoved).toBe(0);
    expect(applied.staleAgents).toEqual({
      candidates: 1,
      blocked: 1,
      markedOffline: 0,
    });
    expect(applied.blockers[0]).toMatchObject({
      agentId: agent.agentId,
      leaseIds: [lease.leaseId],
    });
    expect(store.getAgent(agent.agentId).status).toBe("stale");
    expect(
      store.db
        .prepare("SELECT lease_id FROM leases WHERE lease_id = ?")
        .get(lease.leaseId),
    ).toEqual({ lease_id: lease.leaseId });
    store.close();
  });

  it("prunes only acknowledged and terminal old history while retaining unresolved state", () => {
    const store = new CoordinationStore();
    const sender = store.registerAgent({
      runtime: "claude-code",
      sessionRef: "retention-sender",
      workspace: workspace("wt_retention_sender"),
    });
    const recipient = store.registerAgent({
      runtime: "codex",
      sessionRef: "retention-recipient",
      workspace: workspace("wt_retention_recipient"),
    });
    const acknowledged = store.sendMessage(
      {
        senderAgentId: sender.agentId,
        recipientAgentId: recipient.agentId,
        body: "old and acknowledged",
      },
      sender.sessionToken,
    );
    store.acknowledgeMessage(
      recipient.agentId,
      recipient.sessionToken,
      acknowledged.messageId,
    );
    const unacknowledged = store.sendMessage(
      {
        senderAgentId: sender.agentId,
        recipientAgentId: recipient.agentId,
        body: "old but unresolved",
      },
      sender.sessionToken,
    );
    const terminal = store.enqueueIntegration(
      {
        repositoryId: "repo_maintenance",
        sourceRef: "refs/heads/feature/terminal",
        sourceOid: "a".repeat(40),
        targetRef: "refs/heads/terminal-target",
        observedTargetOid: "b".repeat(40),
        requestedBy: sender.agentId,
      },
      sender.sessionToken,
    );
    store.claimIntegration(
      terminal.requestId,
      sender.agentId,
      sender.sessionToken,
      "a".repeat(40),
      "b".repeat(40),
    );
    store.completeIntegration(
      terminal.requestId,
      sender.agentId,
      sender.sessionToken,
      { outcome: "failed", postTargetOid: "b".repeat(40) },
    );
    const unresolved = store.enqueueIntegration(
      {
        repositoryId: "repo_maintenance",
        sourceRef: "refs/heads/feature/unresolved",
        sourceOid: "c".repeat(40),
        targetRef: "refs/heads/unresolved-target",
        observedTargetOid: "d".repeat(40),
        requestedBy: sender.agentId,
      },
      sender.sessionToken,
    );
    const old = new Date(Date.now() - 2 * DAY_MS).toISOString();
    store.db
      .prepare(
        "UPDATE messages SET created_at = ?, acknowledged_at = ? WHERE message_id = ?",
      )
      .run(old, old, acknowledged.messageId);
    store.db
      .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
      .run(old, unacknowledged.messageId);
    store.db
      .prepare(
        "UPDATE integration_requests SET created_at = ?, updated_at = ?, completed_at = ? WHERE request_id = ?",
      )
      .run(old, old, old, terminal.requestId);
    store.db
      .prepare(
        "UPDATE integration_requests SET created_at = ?, updated_at = ? WHERE request_id = ?",
      )
      .run(old, old, unresolved.requestId);
    store.db.prepare("UPDATE audit_events SET created_at = ?").run(old);

    const preview = store.runMaintenance(policy());

    expect(preview.pruned).toMatchObject({
      acknowledgedMessages: 1,
      terminalIntegrations: 1,
    });
    expect(preview.pruned.auditEvents).toBeGreaterThan(0);
    expect(
      store.db.prepare("SELECT COUNT(*) AS count FROM messages").get(),
    ).toEqual({ count: 2 });
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM integration_requests")
        .get(),
    ).toEqual({ count: 2 });

    const applied = store.runMaintenance(policy(), { apply: true });

    expect(applied.pruned).toEqual(preview.pruned);
    expect(
      store.db
        .prepare("SELECT message_id FROM messages ORDER BY message_id")
        .all(),
    ).toEqual([{ message_id: unacknowledged.messageId }]);
    expect(
      store.db
        .prepare(
          "SELECT request_id, status FROM integration_requests ORDER BY request_id",
        )
        .all(),
    ).toEqual([{ request_id: unresolved.requestId, status: "queued" }]);
    expect(
      store.db.prepare("SELECT event_type FROM audit_events").all(),
    ).toEqual([{ event_type: "maintenance.completed" }]);
    store.close();
  });

  it("requires every maintenance cutoff to be a valid past timestamp", () => {
    const store = new CoordinationStore();
    const valid = policy();

    expect(() =>
      store.runMaintenance({ ...valid, staleBefore: "not-a-date" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.runMaintenance({
        ...valid,
        staleBefore: "2026-08-01T00:00:00Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.runMaintenance({
        ...valid,
        auditEventsBefore: new Date(Date.now() + DAY_MS).toISOString(),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    store.close();
  });
});
