import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoordinationError } from "../src/errors.js";
import { CoordinationStore } from "../src/store.js";
import type { GitWorkspaceSnapshot } from "../src/model.js";

function workspace(
  repositoryId = "repo_test",
  worktreeId = "wt_test",
): GitWorkspaceSnapshot {
  return {
    repositoryId,
    worktreeId,
    rootPath: "/tmp/example-worktree",
    commonGitDir: "/tmp/example/.git",
    gitDir: "/tmp/example/.git",
    branch: "main",
    headOid: "a".repeat(40),
    dirty: false,
    upstream: { status: "unavailable" },
    isBare: false,
    observedAt: new Date().toISOString(),
  };
}

describe("CoordinationStore", () => {
  it("reports database integrity and creates a verified non-overwriting backup", async () => {
    const temporaryRoot = process.platform === "win32" ? tmpdir() : "/tmp";
    const directory = mkdtempSync(join(temporaryRoot, "agentconduit-backup-"));
    const databasePath = join(directory, "coordination.db");
    const backupPath = join(directory, "coordination.backup.db");
    let store: CoordinationStore | undefined;
    try {
      store = new CoordinationStore(databasePath);
      const registered = store.registerAgent({
        runtime: "codex",
        sessionRef: "backup-session",
        workspace: workspace("repo_backup", "wt_backup"),
      });

      expect(store.healthCheck()).toMatchObject({
        status: "ok",
        schemaVersion: 4,
        quickCheck: "ok",
        foreignKeyViolations: 0,
      });
      await expect(store.backupTo(backupPath)).resolves.toMatchObject({
        destinationPath: backupPath,
        schemaVersion: 4,
        quickCheck: "ok",
        foreignKeyViolations: 0,
      });
      expect(existsSync(backupPath)).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(backupPath).mode & 0o077).toBe(0);
      }

      const backup = new CoordinationStore(backupPath, {
        migrations: "require-current",
      });
      expect(backup.getAgent(registered.agentId)).toMatchObject({
        agentId: registered.agentId,
        runtime: "codex",
      });
      backup.close();

      await expect(store.backupTo(backupPath)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(store.backupTo("relative.db")).rejects.toMatchObject({
        code: "invalid_input",
      });
    } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("round-trips upstream availability and comparison evidence", () => {
    const store = new CoordinationStore();
    const unavailable = workspace("repo_upstream", "wt_unavailable");
    const available = {
      ...workspace("repo_upstream", "wt_available"),
      observedAt: new Date(Date.now() + 1).toISOString(),
      upstream: {
        status: "available" as const,
        ref: "origin/main",
        ahead: 2,
        behind: 3,
      },
    };

    store.upsertWorkspace(unavailable);
    store.upsertWorkspace(available);

    expect(store.listWorkspaces("repo_upstream")).toEqual([
      available,
      unavailable,
    ]);
    store.close();
  });

  it("keeps registration idempotent for a session and preserves Git evidence", () => {
    const store = new CoordinationStore();
    const first = store.registerAgent({
      runtime: "codex",
      sessionRef: "session-1",
      workspace: workspace(),
      capabilities: ["messaging"],
    });
    const second = store.registerAgent({
      runtime: "codex",
      sessionRef: "session-1",
      sessionToken: first.sessionToken,
      workspace: { ...workspace(), headOid: "b".repeat(40), dirty: true },
      capabilities: ["messaging", "leases"],
    });

    expect(second.agentId).toBe(first.agentId);
    expect(second.workspace.headOid).toBe("b".repeat(40));
    expect(second.workspace.dirty).toBe(true);
    expect(second.capabilities).toEqual(["messaging", "leases"]);
    store.close();
  });

  it("exposes stale presence explicitly and can filter to fresh online agents", () => {
    const store = new CoordinationStore(":memory:", {
      heartbeatTimeoutMs: 1_000,
    });
    const stale = store.registerAgent({
      runtime: "claude",
      sessionRef: "stale-presence",
      workspace: workspace("repo_presence", "wt_stale"),
    });
    const online = store.registerAgent({
      runtime: "codex",
      sessionRef: "online-presence",
      workspace: workspace("repo_presence", "wt_online"),
    });
    store.db
      .prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?")
      .run(new Date(Date.now() - 10_000).toISOString(), stale.agentId);

    expect(
      store
        .listAgents("repo_presence")
        .map((agent) => [agent.agentId, agent.status]),
    ).toEqual([
      [stale.agentId, "stale"],
      [online.agentId, "online"],
    ]);
    expect(
      store
        .listAgents("repo_presence", false, true)
        .map((agent) => agent.agentId),
    ).toEqual([online.agentId]);
    store.close();
  });

  it("does not treat a future heartbeat timestamp as fresh after a clock rollback", () => {
    const store = new CoordinationStore(":memory:", {
      heartbeatTimeoutMs: 1_000,
    });
    const future = store.registerAgent({
      runtime: "codex",
      sessionRef: "future-heartbeat",
      workspace: workspace("repo_clock", "wt_future"),
    });
    store.db
      .prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?")
      .run(new Date(Date.now() + 60_000).toISOString(), future.agentId);

    expect(
      store
        .listAgents("repo_clock")
        .find((agent) => agent.agentId === future.agentId),
    ).toMatchObject({ status: "stale" });
    expect(store.listAgents("repo_clock", false, true)).toEqual([]);
    store.close();
  });

  it("does not let a tokenless legacy row be reclaimed", () => {
    const store = new CoordinationStore();
    const original = store.registerAgent({
      runtime: "codex",
      sessionRef: "legacy-session",
      workspace: workspace("repo_legacy", "wt_legacy"),
    });

    // Simulate the nullable credential left by the supported v0 migration.
    store.db
      .prepare(
        "UPDATE agents SET session_secret_hash = NULL WHERE agent_id = ?",
      )
      .run(original.agentId);

    expect(() =>
      store.registerAgent({
        runtime: "codex",
        sessionRef: "legacy-session",
        workspace: workspace("repo_legacy", "wt_legacy"),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "forbidden",
        details: {
          reason: "legacy_session_without_token",
          action: "re_enroll_with_new_session_ref",
        },
      }),
    );

    const reenrolled = store.registerAgent({
      runtime: "codex",
      sessionRef: "new-session-after-legacy",
      workspace: workspace("repo_legacy", "wt_legacy"),
    });
    expect(reenrolled.agentId).not.toBe(original.agentId);
    store.close();
  });

  it("does not update workspace evidence when a reconnect token is wrong", () => {
    const store = new CoordinationStore();
    const originalWorkspace = workspace("repo_auth", "wt_auth");
    const original = store.registerAgent({
      runtime: "codex",
      sessionRef: "auth-session",
      workspace: originalWorkspace,
    });

    expect(() =>
      store.registerAgent({
        runtime: "codex",
        sessionRef: "auth-session",
        sessionToken: "acs_" + "0".repeat(64),
        workspace: {
          ...originalWorkspace,
          headOid: "b".repeat(40),
          dirty: true,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));

    expect(store.getAgent(original.agentId).workspace).toEqual(
      originalWorkspace,
    );
    store.close();
  });

  it("does not rebind a session to another worktree at the persistence boundary", () => {
    const store = new CoordinationStore();
    const originalWorkspace = workspace("repo_bound", "wt_bound");
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "bound-session",
      workspace: originalWorkspace,
    });

    expect(() =>
      store.heartbeat(
        agent.agentId,
        agent.sessionToken,
        workspace("repo_bound", "wt_other"),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "forbidden",
        details: {
          registeredWorktreeId: "wt_bound",
          requestedWorktreeId: "wt_other",
        },
      }),
    );
    expect(store.getAgent(agent.agentId).workspace).toEqual(originalWorkspace);
    store.close();
  });

  it("delivers durable messages and enforces repository scope", () => {
    const store = new CoordinationStore();
    const sender = store.registerAgent({
      runtime: "claude",
      sessionRef: "sender",
      workspace: workspace("repo_a", "wt_a"),
    });
    const recipient = store.registerAgent({
      runtime: "codex",
      sessionRef: "recipient",
      workspace: workspace("repo_a", "wt_b"),
    });
    const message = store.sendMessage(
      {
        senderAgentId: sender.agentId,
        recipientAgentId: recipient.agentId,
        body: "ready for review",
        correlationId: "task-7",
      },
      sender.sessionToken,
    );
    expect(store.inbox(recipient.agentId, recipient.sessionToken)).toHaveLength(
      1,
    );
    expect(
      store.inbox(recipient.agentId, recipient.sessionToken)[0]?.messageId,
    ).toBe(message.messageId);
    store.acknowledgeMessage(
      recipient.agentId,
      recipient.sessionToken,
      message.messageId,
    );
    expect(store.inbox(recipient.agentId, recipient.sessionToken)).toHaveLength(
      0,
    );
    const other = store.registerAgent({
      runtime: "other",
      sessionRef: "other",
      workspace: workspace("repo_b", "wt_c"),
    });
    expect(() =>
      store.sendMessage(
        {
          senderAgentId: sender.agentId,
          recipientAgentId: other.agentId,
          body: "no",
        },
        sender.sessionToken,
      ),
    ).toThrow(CoordinationError);
    store.close();
  });

  it("binds integration operations to the requesting agent's repository", () => {
    const store = new CoordinationStore();
    const local = store.registerAgent({
      runtime: "codex",
      sessionRef: "local-integration",
      workspace: workspace("repo_local", "wt_local"),
    });
    const foreign = store.registerAgent({
      runtime: "claude",
      sessionRef: "foreign-integration",
      workspace: workspace("repo_foreign", "wt_foreign"),
    });

    expect(() =>
      store.enqueueIntegration(
        {
          repositoryId: "repo_foreign",
          sourceRef: "feature/foreign",
          sourceOid: "b".repeat(40),
          targetRef: "main",
          observedTargetOid: "a".repeat(40),
          requestedBy: local.agentId,
        },
        local.sessionToken,
      ),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));

    const request = store.enqueueIntegration(
      {
        repositoryId: "repo_local",
        sourceRef: "feature/local",
        sourceOid: "b".repeat(40),
        targetRef: "main",
        observedTargetOid: "a".repeat(40),
        requestedBy: local.agentId,
      },
      local.sessionToken,
    );
    expect(() =>
      store.claimIntegration(
        request.requestId,
        foreign.agentId,
        foreign.sessionToken,
        "b".repeat(40),
        "a".repeat(40),
      ),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    store.close();
  });

  it("rejects non-branch integration targets at the persistence boundary", () => {
    const store = new CoordinationStore();
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "target-validation",
      workspace: workspace("repo_target", "wt_target"),
    });
    for (const targetRef of [
      "HEAD",
      "main^",
      "refs/tags/v1",
      "refs/notes/commits",
      "refs/heads/main..other",
    ]) {
      expect(() =>
        store.enqueueIntegration(
          {
            repositoryId: "repo_target",
            sourceRef: "feature/source",
            sourceOid: "b".repeat(40),
            targetRef,
            observedTargetOid: "a".repeat(40),
            requestedBy: agent.agentId,
          },
          agent.sessionToken,
        ),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    }
    store.close();
  });

  it("serializes leases and advances fencing tokens", () => {
    const store = new CoordinationStore();
    const first = store.registerAgent({
      runtime: "claude",
      sessionRef: "lease-a",
      workspace: workspace("repo_l", "wt_l1"),
    });
    const second = store.registerAgent({
      runtime: "codex",
      sessionRef: "lease-b",
      workspace: workspace("repo_l", "wt_l2"),
    });
    const lease = store.acquireLease(
      "test:repo_l:resource",
      first.agentId,
      first.sessionToken,
      60,
    );
    expect(() =>
      store.acquireLease(
        lease.resource,
        second.agentId,
        second.sessionToken,
        60,
      ),
    ).toThrow(CoordinationError);
    store.releaseLease(lease.leaseId, first.agentId, first.sessionToken);
    const next = store.acquireLease(
      lease.resource,
      second.agentId,
      second.sessionToken,
      60,
    );
    expect(next.fencingToken).toBeGreaterThan(lease.fencingToken);
    store.close();
  });

  it("preserves malformed generic lease expiry as uncertain authority", () => {
    const store = new CoordinationStore();
    const first = store.registerAgent({
      runtime: "claude",
      sessionRef: "malformed-lease-holder",
      workspace: workspace("repo_malformed_lease", "wt_malformed_lease_1"),
    });
    const second = store.registerAgent({
      runtime: "codex",
      sessionRef: "malformed-lease-waiter",
      workspace: workspace("repo_malformed_lease", "wt_malformed_lease_2"),
    });
    const lease = store.acquireLease(
      "test:repo_malformed_lease:resource",
      first.agentId,
      first.sessionToken,
      60,
    );
    store.db
      .prepare("UPDATE leases SET expires_at = ? WHERE lease_id = ?")
      .run("2026-01-01T00:00:00Z", lease.leaseId);
    const expected = store.db
      .prepare(
        "SELECT lease_id, resource, holder_agent_id, fencing_token, expires_at FROM leases WHERE lease_id = ?",
      )
      .get(lease.leaseId);
    const expectPreserved = () => {
      expect(
        store.db
          .prepare(
            "SELECT lease_id, resource, holder_agent_id, fencing_token, expires_at FROM leases WHERE lease_id = ?",
          )
          .get(lease.leaseId),
      ).toEqual(expected);
    };
    const expectStorageError = (operation: () => unknown) => {
      expect(operation).toThrowError(
        expect.objectContaining({
          code: "storage_error",
          details: expect.objectContaining({
            reason: "invalid_lease_expiry",
            leaseId: lease.leaseId,
          }),
        }),
      );
      expectPreserved();
    };

    expectStorageError(() =>
      store.acquireLease(
        lease.resource,
        second.agentId,
        second.sessionToken,
        60,
      ),
    );
    expectStorageError(() =>
      store.acquireLease(lease.resource, first.agentId, first.sessionToken, 60),
    );
    expectStorageError(() =>
      store.renewLease(lease.leaseId, first.agentId, first.sessionToken, 60),
    );
    expectStorageError(() =>
      store.releaseLease(lease.leaseId, first.agentId, first.sessionToken),
    );
    store.close();
  });

  it("preserves malformed lease authority when its holder unregisters", () => {
    const store = new CoordinationStore();
    const agent = store.registerAgent({
      runtime: "claude",
      sessionRef: "malformed-lease-unregister",
      workspace: workspace(
        "repo_malformed_unregister",
        "wt_malformed_unregister",
      ),
    });
    const lease = store.acquireLease(
      "test:repo_malformed_unregister:resource",
      agent.agentId,
      agent.sessionToken,
      60,
    );
    store.db
      .prepare("UPDATE leases SET expires_at = ? WHERE lease_id = ?")
      .run("not-a-timestamp", lease.leaseId);

    expect(() =>
      store.unregisterAgent(agent.agentId, agent.sessionToken),
    ).toThrowError(
      expect.objectContaining({
        code: "storage_error",
        details: expect.objectContaining({
          reason: "invalid_lease_expiry",
          leaseId: lease.leaseId,
        }),
      }),
    );
    expect(
      store.db
        .prepare("SELECT unregistered_at FROM agents WHERE agent_id = ?")
        .get(agent.agentId),
    ).toEqual({ unregistered_at: null });
    expect(
      store.db
        .prepare(
          "SELECT holder_agent_id, fencing_token, expires_at FROM leases WHERE lease_id = ?",
        )
        .get(lease.leaseId),
    ).toEqual({
      holder_agent_id: agent.agentId,
      fencing_token: lease.fencingToken,
      expires_at: "not-a-timestamp",
    });
    store.close();
  });

  it("reserves integration lease resources and never adopts a pre-existing lease", () => {
    const store = new CoordinationStore();
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "reserved-lease",
      workspace: workspace("repo_reserved", "wt_reserved"),
    });
    const resource = "git:repo_reserved:ref:refs/heads/main";
    expect(() =>
      store.acquireLease(resource, agent.agentId, agent.sessionToken, 60),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));

    const request = store.enqueueIntegration(
      {
        repositoryId: "repo_reserved",
        sourceRef: "feature/reserved",
        sourceOid: "b".repeat(40),
        targetRef: "main",
        observedTargetOid: "a".repeat(40),
        requestedBy: agent.agentId,
      },
      agent.sessionToken,
    );
    const legacyLeaseId = "lea_legacy_reserved";
    store.db
      .prepare(
        `INSERT INTO leases
          (lease_id, resource, holder_agent_id, fencing_token, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyLeaseId,
        resource,
        agent.agentId,
        1,
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      );

    expect(() =>
      store.claimIntegration(
        request.requestId,
        agent.agentId,
        agent.sessionToken,
        "b".repeat(40),
        "a".repeat(40),
      ),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(store.getIntegration(request.requestId).status).toBe("queued");
    store.db
      .prepare("UPDATE leases SET expires_at = ? WHERE lease_id = ?")
      .run("not-a-timestamp", legacyLeaseId);
    expect(() =>
      store.claimIntegration(
        request.requestId,
        agent.agentId,
        agent.sessionToken,
        "b".repeat(40),
        "a".repeat(40),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "storage_error",
        details: expect.objectContaining({
          reason: "invalid_lease_expiry",
          leaseId: legacyLeaseId,
        }),
      }),
    );
    expect(store.getIntegration(request.requestId).status).toBe("queued");
    expect(
      store.db
        .prepare("SELECT expires_at FROM leases WHERE lease_id = ?")
        .get(legacyLeaseId),
    ).toEqual({ expires_at: "not-a-timestamp" });
    store.db
      .prepare("DELETE FROM leases WHERE lease_id = ?")
      .run(legacyLeaseId);
    const claimed = store.claimIntegration(
      request.requestId,
      agent.agentId,
      agent.sessionToken,
      "b".repeat(40),
      "a".repeat(40),
    );
    expect(claimed.status).toBe("claimed");
    expect(claimed.leaseId).not.toBe(legacyLeaseId);
    expect(claimed.lease?.fencingToken).toBeDefined();
    const claimedExpiry = Date.parse(claimed.lease?.expiresAt ?? "");
    const renewed = store.renewIntegration(
      request.requestId,
      agent.agentId,
      agent.sessionToken,
      900,
    );
    expect(renewed.status).toBe("claimed");
    expect(renewed.lease?.leaseId).toBe(claimed.leaseId);
    expect(Date.parse(renewed.lease?.expiresAt ?? "")).toBeGreaterThan(
      claimedExpiry,
    );
    expect(() =>
      store.renewLease(claimed.leaseId!, agent.agentId, agent.sessionToken, 60),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.releaseLease(claimed.leaseId!, agent.agentId, agent.sessionToken),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    store.close();
  });

  it("preserves a claimed integration when its lease expiry is malformed", () => {
    const store = new CoordinationStore();
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "malformed-integration-lease",
      workspace: workspace(
        "repo_malformed_integration",
        "wt_malformed_integration",
      ),
    });
    const request = store.enqueueIntegration(
      {
        repositoryId: "repo_malformed_integration",
        sourceRef: "feature/malformed-integration",
        sourceOid: "b".repeat(40),
        targetRef: "main",
        observedTargetOid: "a".repeat(40),
        requestedBy: agent.agentId,
      },
      agent.sessionToken,
    );
    const claimed = store.claimIntegration(
      request.requestId,
      agent.agentId,
      agent.sessionToken,
      "b".repeat(40),
      "a".repeat(40),
    );
    store.db
      .prepare("UPDATE leases SET expires_at = ? WHERE lease_id = ?")
      .run("not-a-timestamp", claimed.leaseId);
    const expectPreserved = () => {
      expect(store.getIntegration(request.requestId)).toMatchObject({
        status: "claimed",
        claimedBy: agent.agentId,
        leaseId: claimed.leaseId,
      });
      expect(
        store.db
          .prepare("SELECT expires_at FROM leases WHERE lease_id = ?")
          .get(claimed.leaseId),
      ).toEqual({ expires_at: "not-a-timestamp" });
    };
    const expectStorageError = (operation: () => unknown) => {
      expect(operation).toThrowError(
        expect.objectContaining({
          code: "storage_error",
          details: expect.objectContaining({
            reason: "invalid_lease_expiry",
            leaseId: claimed.leaseId,
          }),
        }),
      );
      expectPreserved();
    };

    expectStorageError(() =>
      store.renewIntegration(
        request.requestId,
        agent.agentId,
        agent.sessionToken,
        60,
      ),
    );
    expectStorageError(() =>
      store.completeIntegration(
        request.requestId,
        agent.agentId,
        agent.sessionToken,
        { outcome: "merged", postTargetOid: "c".repeat(40) },
      ),
    );
    expectStorageError(() =>
      store.cancelIntegration(
        request.requestId,
        agent.agentId,
        agent.sessionToken,
      ),
    );
    store.close();
  });

  it("requires the observed target to remain current before claiming integration", () => {
    const store = new CoordinationStore();
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "integrator",
      workspace: workspace("repo_i", "wt_i"),
    });
    const request = store.enqueueIntegration(
      {
        repositoryId: "repo_i",
        sourceRef: "refs/heads/feature",
        sourceOid: "b".repeat(40),
        targetRef: "refs/heads/main",
        observedTargetOid: "a".repeat(40),
        requestedBy: agent.agentId,
      },
      agent.sessionToken,
    );
    expect(() =>
      store.claimIntegration(
        request.requestId,
        agent.agentId,
        agent.sessionToken,
        "b".repeat(40),
        "c".repeat(40),
      ),
    ).toThrow(CoordinationError);
    expect(store.getIntegration(request.requestId).status).toBe(
      "needs_refresh",
    );
    expect(() =>
      store.claimIntegration(
        request.requestId,
        agent.agentId,
        agent.sessionToken,
        "b".repeat(40),
        "a".repeat(40),
      ),
    ).toThrow(CoordinationError);
    const refreshed = store.refreshIntegration(
      request.requestId,
      agent.agentId,
      agent.sessionToken,
      "b".repeat(40),
      "c".repeat(40),
    );
    expect(refreshed.status).toBe("queued");
    store.close();
  });

  it("requires the observed source to remain current before claiming integration", () => {
    const store = new CoordinationStore();
    const agent = store.registerAgent({
      runtime: "codex",
      sessionRef: "source-boundary",
      workspace: workspace("repo_source", "wt_source"),
    });
    const request = store.enqueueIntegration(
      {
        repositoryId: "repo_source",
        sourceRef: "refs/heads/feature",
        sourceOid: "b".repeat(40),
        targetRef: "refs/heads/main",
        observedTargetOid: "a".repeat(40),
        requestedBy: agent.agentId,
      },
      agent.sessionToken,
    );

    expect(() =>
      store.claimIntegration(
        request.requestId,
        agent.agentId,
        agent.sessionToken,
        "c".repeat(40),
        "a".repeat(40),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "conflict",
        details: {
          expectedSourceOid: "b".repeat(40),
          currentSourceOid: "c".repeat(40),
        },
      }),
    );
    expect(store.getIntegration(request.requestId).status).toBe(
      "needs_refresh",
    );
    store.close();
  });

  it("keeps integration queue order and requires a valid completion lease", () => {
    const store = new CoordinationStore();
    const firstAgent = store.registerAgent({
      runtime: "claude",
      sessionRef: "first",
      workspace: workspace("repo_q", "wt_q1"),
    });
    const secondAgent = store.registerAgent({
      runtime: "codex",
      sessionRef: "second",
      workspace: workspace("repo_q", "wt_q2"),
    });
    const base = "a".repeat(40);
    const first = store.enqueueIntegration(
      {
        repositoryId: "repo_q",
        sourceRef: "feature/one",
        sourceOid: "b".repeat(40),
        targetRef: "main",
        observedTargetOid: base,
        requestedBy: firstAgent.agentId,
      },
      firstAgent.sessionToken,
    );
    const second = store.enqueueIntegration(
      {
        repositoryId: "repo_q",
        sourceRef: "feature/two",
        sourceOid: "c".repeat(40),
        targetRef: "main",
        observedTargetOid: base,
        requestedBy: secondAgent.agentId,
      },
      secondAgent.sessionToken,
    );
    const otherTarget = store.enqueueIntegration(
      {
        repositoryId: "repo_q",
        sourceRef: "feature/three",
        sourceOid: "e".repeat(40),
        targetRef: "develop",
        observedTargetOid: base,
        requestedBy: secondAgent.agentId,
      },
      secondAgent.sessionToken,
    );
    expect(
      store
        .listIntegrations("repo_q", "main")
        .map((request) => request.requestId),
    ).toEqual([first.requestId, second.requestId]);
    expect(
      store
        .listIntegrations(undefined, "main")
        .map((request) => request.requestId),
    ).toEqual([first.requestId, second.requestId]);
    expect(
      store
        .listIntegrations(undefined, "develop")
        .map((request) => request.requestId),
    ).toEqual([otherTarget.requestId]);
    expect(
      store
        .listIntegrations("repo_q", "refs/heads/main")
        .map((request) => request.requestId),
    ).toEqual([first.requestId, second.requestId]);
    expect(() =>
      store.claimIntegration(
        second.requestId,
        secondAgent.agentId,
        secondAgent.sessionToken,
        "c".repeat(40),
        base,
      ),
    ).toThrow(CoordinationError);
    const claimed = store.claimIntegration(
      first.requestId,
      firstAgent.agentId,
      firstAgent.sessionToken,
      "b".repeat(40),
      base,
    );
    expect(claimed.status).toBe("claimed");
    expect(claimed.leaseId).toBeDefined();
    expect(() =>
      store.completeIntegration(
        first.requestId,
        firstAgent.agentId,
        firstAgent.sessionToken,
        {
          outcome: "invented",
          postTargetOid: "d".repeat(40),
        } as never,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.completeIntegration(
        first.requestId,
        firstAgent.agentId,
        firstAgent.sessionToken,
        { outcome: "merged" } as never,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.completeIntegration(
        first.requestId,
        firstAgent.agentId,
        firstAgent.sessionToken,
        { outcome: "failed" } as never,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.completeIntegration(
        first.requestId,
        firstAgent.agentId,
        firstAgent.sessionToken,
        { outcome: "merged", postTargetOid: "not-an-oid" },
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.completeIntegration(
        first.requestId,
        secondAgent.agentId,
        secondAgent.sessionToken,
        { outcome: "merged", postTargetOid: "d".repeat(40) },
      ),
    ).toThrow(CoordinationError);
    const completed = store.completeIntegration(
      first.requestId,
      firstAgent.agentId,
      firstAgent.sessionToken,
      { outcome: "merged", postTargetOid: "d".repeat(40) },
    );
    expect(completed.status).toBe("completed");
    const cancelledClaim = store.claimIntegration(
      otherTarget.requestId,
      secondAgent.agentId,
      secondAgent.sessionToken,
      "e".repeat(40),
      base,
    );
    const cancelled = store.completeIntegration(
      cancelledClaim.requestId,
      secondAgent.agentId,
      secondAgent.sessionToken,
      { outcome: "cancelled" },
    );
    expect(cancelled.status).toBe("cancelled");
    store.close();
  });
});
