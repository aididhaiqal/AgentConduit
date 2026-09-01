import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitWorkspaceSnapshot } from "../src/model.js";
import { CoordinationStore } from "../src/store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function workspace(
  repositoryId: string,
  worktreeId: string,
): GitWorkspaceSnapshot {
  return {
    repositoryId,
    worktreeId,
    rootPath: `/tmp/${worktreeId}`,
    commonGitDir: `/tmp/${repositoryId}/.git`,
    gitDir: `/tmp/${repositoryId}/.git/worktrees/${worktreeId}`,
    branch: "main",
    headOid: "a".repeat(40),
    dirty: false,
    upstream: { status: "unavailable" },
    isBare: false,
    observedAt: new Date().toISOString(),
  };
}

function register(
  store: CoordinationStore,
  runtime: string,
  repositoryId: string,
  worktreeId: string,
) {
  return store.registerAgent({
    runtime,
    sessionRef: `${runtime}-${worktreeId}`,
    workspace: workspace(repositoryId, worktreeId),
  });
}

function retentionPolicy(now = Date.now()) {
  const cutoff = new Date(now - DAY_MS).toISOString();
  return {
    staleBefore: cutoff,
    acknowledgedMessagesBefore: cutoff,
    terminalIntegrationsBefore: cutoff,
    terminalJobsBefore: cutoff,
    auditEventsBefore: cutoff,
  };
}

describe("CoordinationStore durable jobs", () => {
  it("idempotently creates a server-bound job and one cursor-addressable created event", () => {
    const store = new CoordinationStore();
    const owner = register(store, "codex", "repo_jobs", "wt_job_owner");
    const before = store.latestAuditCursor();

    const created = store.createJob(owner.agentId, owner.sessionToken, {
      idempotencyKey: "create:analysis-1",
      kind: "collaboration.analysis",
      displayName: "Review the integration boundary",
      correlationId: "handoff-42",
    });

    expect(created).toMatchObject({
      ownerAgentId: owner.agentId,
      repositoryId: "repo_jobs",
      worktreeId: "wt_job_owner",
      kind: "collaboration.analysis",
      displayName: "Review the integration boundary",
      correlationId: "handoff-42",
      status: "queued",
      activity: "active",
      lastEventSequence: 1,
    });
    expect(created.jobId).toMatch(/^job_[0-9a-f]{32}$/);

    const [event] = store.listJobEvents(created.jobId);
    expect(event).toMatchObject({
      jobId: created.jobId,
      cursor: created.lastEventCursor,
      sequence: 1,
      type: "created",
      status: "queued",
    });
    expect(event?.cursor).toBeGreaterThan(before);
    expect(
      store
        .listAuditEvents(before)
        .find((entry) => entry.eventId === event?.eventId),
    ).toMatchObject({
      cursor: event?.cursor,
      eventType: "job.event.created",
      actorAgentId: owner.agentId,
      resourceId: created.jobId,
    });

    const cursorAfterCreate = store.latestAuditCursor();
    expect(
      store.createJob(owner.agentId, owner.sessionToken, {
        idempotencyKey: "create:analysis-1",
        kind: "collaboration.analysis",
        displayName: "Review the integration boundary",
        correlationId: "handoff-42",
      }),
    ).toEqual(created);
    expect(store.latestAuditCursor()).toBe(cursorAfterCreate);
    expect(store.listJobEvents(created.jobId)).toHaveLength(1);

    expect(() =>
      store.createJob(owner.agentId, owner.sessionToken, {
        idempotencyKey: "create:analysis-1",
        kind: "collaboration.analysis",
        displayName: "Different input",
      }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    store.close();
  });

  it("orders lifecycle events globally and per job without inferring terminal state", () => {
    const store = new CoordinationStore();
    const owner = register(
      store,
      "claude-code",
      "repo_lifecycle",
      "wt_lifecycle",
    );
    const job = store.createJob(owner.agentId, owner.sessionToken, {
      idempotencyKey: "create:lifecycle",
      kind: "implementation",
      displayName: "Implement lifecycle",
    });

    const started = store.appendJobEvent(
      owner.agentId,
      owner.sessionToken,
      job.jobId,
      { idempotencyKey: "event:started", type: "started", phase: "startup" },
    );
    const waiting = store.appendJobEvent(
      owner.agentId,
      owner.sessionToken,
      job.jobId,
      {
        idempotencyKey: "event:waiting",
        type: "waiting_for_input",
        summary: "Awaiting an operator choice",
      },
    );
    const heartbeat = store.appendJobEvent(
      owner.agentId,
      owner.sessionToken,
      job.jobId,
      { idempotencyKey: "event:heartbeat", type: "heartbeat" },
    );
    const checkpoint = store.appendJobEvent(
      owner.agentId,
      owner.sessionToken,
      job.jobId,
      {
        idempotencyKey: "event:checkpoint",
        type: "checkpoint",
        phase: "implementation",
        summary: "Core state machine is implemented",
      },
    );
    const operation = store.appendJobEvent(
      owner.agentId,
      owner.sessionToken,
      job.jobId,
      {
        idempotencyKey: "event:operation",
        type: "operation_started",
        operation: "focused-tests",
      },
    );
    const completed = store.appendJobEvent(
      owner.agentId,
      owner.sessionToken,
      job.jobId,
      {
        idempotencyKey: "event:completed",
        type: "completed",
        summary: "Focused tests passed",
      },
    );

    expect(started.status).toBe("running");
    expect(waiting.status).toBe("waiting");
    expect(heartbeat.status).toBe("waiting");
    expect(checkpoint.status).toBe("running");
    expect(operation.status).toBe("running");
    expect(completed.status).toBe("succeeded");
    expect(store.getJob(job.jobId)).toMatchObject({
      status: "succeeded",
      activity: "terminal",
      lastEventCursor: completed.cursor,
      lastEventSequence: completed.sequence,
      completedAt: completed.createdAt,
    });

    const events = store.listJobEvents(job.jobId);
    expect(events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(events.map((event) => event.cursor)).toEqual(
      [...events.map((event) => event.cursor)].sort(
        (left, right) => left - right,
      ),
    );
    expect(store.listJobEvents(job.jobId, waiting.cursor)).toEqual(
      events.filter((event) => event.cursor > waiting.cursor),
    );

    const cursorAfterCompletion = store.latestAuditCursor();
    expect(
      store.appendJobEvent(owner.agentId, owner.sessionToken, job.jobId, {
        idempotencyKey: "event:completed",
        type: "completed",
        summary: "Focused tests passed",
      }),
    ).toEqual(completed);
    expect(store.latestAuditCursor()).toBe(cursorAfterCompletion);
    expect(() =>
      store.appendJobEvent(owner.agentId, owner.sessionToken, job.jobId, {
        idempotencyKey: "event:after-terminal",
        type: "heartbeat",
      }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    store.close();
  });

  it("enforces safe event shapes, ownership, and same-repository reads", () => {
    const store = new CoordinationStore();
    const owner = register(store, "codex", "repo_scope", "wt_scope_owner");
    const peer = register(store, "claude-code", "repo_scope", "wt_scope_peer");
    const outsider = register(store, "codex", "repo_other", "wt_scope_other");
    const job = store.createJob(owner.agentId, owner.sessionToken, {
      idempotencyKey: "create:scoped",
      kind: "analysis",
      displayName: "Scoped analysis",
    });

    expect(
      store.getJobForAgent(peer.agentId, peer.sessionToken, job.jobId),
    ).toEqual(job);
    expect(store.listJobsForAgent(peer.agentId, peer.sessionToken)).toEqual([
      job,
    ]);
    expect(
      store.listJobEventsForAgent(peer.agentId, peer.sessionToken, job.jobId),
    ).toHaveLength(1);
    expect(() =>
      store.getJobForAgent(outsider.agentId, outsider.sessionToken, job.jobId),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(() =>
      store.appendJobEvent(peer.agentId, peer.sessionToken, job.jobId, {
        idempotencyKey: "event:not-owner",
        type: "working",
      }),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));

    expect(() =>
      store.appendJobEvent(owner.agentId, owner.sessionToken, job.jobId, {
        idempotencyKey: "event:heartbeat-summary",
        type: "heartbeat",
        summary: "This must not masquerade as progress",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.appendJobEvent(owner.agentId, owner.sessionToken, job.jobId, {
        idempotencyKey: "event:empty-checkpoint",
        type: "checkpoint",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.appendJobEvent(owner.agentId, owner.sessionToken, job.jobId, {
        idempotencyKey: "event:unsafe-summary",
        type: "checkpoint",
        summary: "raw\nprovider stream",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.appendJobEvent(owner.agentId, owner.sessionToken, job.jobId, {
        idempotencyKey: "event:no-operation",
        type: "operation_started",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));

    expect(() =>
      store.createJob(owner.agentId, owner.sessionToken, {
        idempotencyKey: "create:cross-parent",
        kind: "analysis",
        displayName: "Invalid child",
        parentJobId: store.createJob(outsider.agentId, outsider.sessionToken, {
          idempotencyKey: "create:outside-parent",
          kind: "analysis",
          displayName: "Outside parent",
        }).jobId,
      }),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    store.close();
  });

  it("derives stale activity without abandoning a job and recovers on a valid event", () => {
    const store = new CoordinationStore(":memory:", {
      jobActivityTimeoutMs: 1_000,
    });
    const owner = register(store, "codex", "repo_stale_job", "wt_stale_job");
    const job = store.createJob(owner.agentId, owner.sessionToken, {
      idempotencyKey: "create:stale",
      kind: "implementation",
      displayName: "Potentially abandoned work",
    });
    const old = new Date(Date.now() - 10_000).toISOString();
    store.db
      .prepare(
        "UPDATE jobs SET last_activity_at = ?, updated_at = ? WHERE job_id = ?",
      )
      .run(old, old, job.jobId);

    expect(store.getJob(job.jobId)).toMatchObject({
      status: "queued",
      activity: "stale",
    });
    expect(
      store.listJobs("repo_stale_job", { activity: "stale" }),
    ).toHaveLength(1);
    expect(store.listJobs("repo_stale_job", { activity: "terminal" })).toEqual(
      [],
    );

    store.appendJobEvent(owner.agentId, owner.sessionToken, job.jobId, {
      idempotencyKey: "event:recovered",
      type: "working",
      summary: "Work resumed after reconnect",
    });
    expect(store.getJob(job.jobId)).toMatchObject({
      status: "running",
      activity: "active",
    });

    store.db
      .prepare("UPDATE jobs SET last_activity_at = ? WHERE job_id = ?")
      .run(new Date(Date.now() + 60_000).toISOString(), job.jobId);
    expect(store.getJob(job.jobId).activity).toBe("stale");

    store.appendJobEvent(owner.agentId, owner.sessionToken, job.jobId, {
      idempotencyKey: "event:terminal",
      type: "failed",
      summary: "Provider exited",
    });
    expect(store.getJob(job.jobId)).toMatchObject({
      status: "failed",
      activity: "terminal",
    });
    store.close();
  });

  it("persists jobs across restart and prunes only old terminal jobs with their events", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentconduit-jobs-"));
    const databasePath = join(directory, "coordination.sqlite");
    let store: CoordinationStore | undefined;
    try {
      store = new CoordinationStore(databasePath);
      const owner = register(
        store,
        "codex",
        "repo_retained_jobs",
        "wt_retained_jobs",
      );
      const terminal = store.createJob(owner.agentId, owner.sessionToken, {
        idempotencyKey: "create:terminal-retention",
        kind: "test",
        displayName: "Old terminal job",
      });
      store.appendJobEvent(owner.agentId, owner.sessionToken, terminal.jobId, {
        idempotencyKey: "event:terminal-retention",
        type: "completed",
      });
      const unresolved = store.createJob(owner.agentId, owner.sessionToken, {
        idempotencyKey: "create:unresolved-retention",
        kind: "test",
        displayName: "Old unresolved job",
      });
      store.appendJobEvent(
        owner.agentId,
        owner.sessionToken,
        unresolved.jobId,
        {
          idempotencyKey: "event:waiting-retention",
          type: "waiting_for_input",
          summary: "Awaiting safe operator input",
        },
      );
      const old = new Date(Date.now() - 2 * DAY_MS).toISOString();
      store.db
        .prepare(
          `UPDATE jobs SET created_at = ?, updated_at = ?, last_activity_at = ?,
             completed_at = CASE WHEN job_id = ? THEN ? ELSE NULL END
           WHERE job_id IN (?, ?)`,
        )
        .run(
          old,
          old,
          old,
          terminal.jobId,
          old,
          terminal.jobId,
          unresolved.jobId,
        );
      store.db
        .prepare("UPDATE job_events SET created_at = ? WHERE job_id IN (?, ?)")
        .run(old, terminal.jobId, unresolved.jobId);

      store.close();
      store = new CoordinationStore(databasePath, {
        migrations: "require-current",
      });
      expect(store.getJob(terminal.jobId)).toMatchObject({
        status: "succeeded",
      });
      expect(store.getJob(unresolved.jobId)).toMatchObject({
        status: "waiting",
        activity: "stale",
      });

      const preview = store.runMaintenance(retentionPolicy());
      expect(preview.pruned.terminalJobs).toBe(1);
      expect(store.listJobs("repo_retained_jobs")).toHaveLength(2);

      const applied = store.runMaintenance(retentionPolicy(), { apply: true });
      expect(applied.pruned.terminalJobs).toBe(1);
      expect(store.listJobs("repo_retained_jobs")).toEqual([
        expect.objectContaining({ jobId: unresolved.jobId, status: "waiting" }),
      ]);
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id = ?")
          .get(terminal.jobId),
      ).toEqual({ count: 0 });
      expect(store.listJobEvents(unresolved.jobId)).toHaveLength(2);
    } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
