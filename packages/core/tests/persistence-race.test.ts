import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoordinationError } from "../src/errors.js";
import type { GitWorkspaceSnapshot } from "../src/model.js";
import { CoordinationStore } from "../src/store.js";
import {
  runConcurrentStoreOperations,
  startStaleMessageOperation,
  type RaceResult,
} from "./support/store-race.js";

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

function temporaryDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "agentconduit-store-"));
  return { directory, path: join(directory, "coordination.sqlite") };
}

function expectOneWinner(results: [RaceResult, RaceResult]): RaceResult {
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0]?.error).toMatchObject({
    name: "CoordinationError",
    code: "conflict",
  });
  return winners[0]!;
}

describe("CoordinationStore durability", () => {
  it("restores agents, messages, leases, queue state, and fencing counters after restart", () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    try {
      store = new CoordinationStore(database.path);
      const claude = store.registerAgent({
        runtime: "claude",
        sessionRef: "durable-claude",
        workspace: workspace("repo_durable", "wt_claude"),
      });
      const codex = store.registerAgent({
        runtime: "codex",
        sessionRef: "durable-codex",
        workspace: workspace("repo_durable", "wt_codex"),
      });
      const acknowledged = store.sendMessage(
        {
          senderAgentId: claude.agentId,
          recipientAgentId: codex.agentId,
          body: "already handled",
        },
        claude.sessionToken,
      );
      const pending = store.sendMessage(
        {
          senderAgentId: claude.agentId,
          recipientAgentId: codex.agentId,
          body: "survive restart",
          correlationId: "handoff-1",
        },
        claude.sessionToken,
      );
      store.acknowledgeMessage(
        codex.agentId,
        codex.sessionToken,
        acknowledged.messageId,
      );

      const durableLease = store.acquireLease(
        "test:durable-resource",
        claude.agentId,
        claude.sessionToken,
        60,
      );
      const request = store.enqueueIntegration(
        {
          repositoryId: "repo_durable",
          sourceRef: "feature/durable",
          sourceOid: "b".repeat(40),
          targetRef: "main",
          observedTargetOid: "a".repeat(40),
          requestedBy: claude.agentId,
        },
        claude.sessionToken,
      );
      const claimed = store.claimIntegration(
        request.requestId,
        claude.agentId,
        claude.sessionToken,
        "b".repeat(40),
        "a".repeat(40),
      );
      store.close();
      store = undefined;

      store = new CoordinationStore(database.path);
      expect(
        store.listAgents("repo_durable").map((agent) => agent.agentId),
      ).toEqual([claude.agentId, codex.agentId]);
      expect(store.inbox(codex.agentId, codex.sessionToken)).toEqual([
        expect.objectContaining({
          messageId: pending.messageId,
          body: "survive restart",
          correlationId: "handoff-1",
        }),
      ]);
      const allMessages = store.inbox(codex.agentId, codex.sessionToken, true);
      expect(allMessages.map((message) => message.messageId)).toEqual(
        [acknowledged, pending]
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.messageId.localeCompare(right.messageId),
          )
          .map((message) => message.messageId),
      );
      expect(
        allMessages.find(
          (message) => message.messageId === acknowledged.messageId,
        ),
      ).toEqual(
        expect.objectContaining({ acknowledgedAt: expect.any(String) }),
      );
      expect(store.getIntegration(request.requestId)).toMatchObject({
        status: "claimed",
        claimedBy: claude.agentId,
        leaseId: claimed.leaseId,
      });
      expect(() =>
        store!.acquireLease(
          "test:durable-resource",
          codex.agentId,
          codex.sessionToken,
          60,
        ),
      ).toThrow(CoordinationError);

      store.releaseLease(
        durableLease.leaseId,
        claude.agentId,
        claude.sessionToken,
      );
      const nextLease = store.acquireLease(
        "test:durable-resource",
        codex.agentId,
        codex.sessionToken,
        60,
      );
      expect(nextLease.fencingToken).toBeGreaterThan(durableLease.fencingToken);

      expect(() =>
        store!.registerAgent({
          runtime: "claude",
          sessionRef: "durable-claude",
          workspace: workspace("repo_durable", "wt_claude"),
        }),
      ).toThrowError(expect.objectContaining({ code: "forbidden" }));
      expect(() =>
        store!.registerAgent({
          runtime: "claude",
          sessionRef: "durable-claude",
          sessionToken: "acs_wrong",
          workspace: workspace("repo_durable", "wt_claude"),
        }),
      ).toThrowError(expect.objectContaining({ code: "forbidden" }));
      const reconnected = store.registerAgent({
        runtime: "claude",
        sessionRef: "durable-claude",
        sessionToken: claude.sessionToken,
        workspace: workspace("repo_durable", "wt_claude"),
      });
      expect(reconnected.agentId).toBe(claude.agentId);
    } finally {
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });
});

describe("CoordinationStore process races", () => {
  it("normalizes exhausted SQLite writer contention without masking unrelated failures", () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    let blocker: CoordinationStore | undefined;
    try {
      store = new CoordinationStore(database.path);
      const agent = store.registerAgent({
        runtime: "codex",
        sessionRef: "busy-error-agent",
        workspace: workspace("repo_busy_error", "wt_busy_error"),
      });
      const recipient = store.registerAgent({
        runtime: "claude",
        sessionRef: "busy-error-recipient",
        workspace: workspace("repo_busy_error", "wt_busy_recipient"),
      });
      const message = store.sendMessage(
        {
          senderAgentId: agent.agentId,
          recipientAgentId: recipient.agentId,
          body: "ack after lock",
        },
        agent.sessionToken,
      );
      blocker = new CoordinationStore(database.path);
      blocker.db.exec("BEGIN IMMEDIATE");
      store.db.pragma("busy_timeout = 10");

      let contention: unknown;
      try {
        store.acquireLease(
          "test:busy-resource",
          agent.agentId,
          agent.sessionToken,
          60,
        );
      } catch (error) {
        contention = error;
      }
      expect(contention).toBeInstanceOf(CoordinationError);
      expect(contention).toMatchObject({
        code: "conflict",
        details: { sqliteCode: "SQLITE_BUSY", operation: "lease.acquire" },
      });

      for (const [operation, action] of [
        [
          "workspace.upsert",
          () => store!.upsertWorkspace(workspace("repo_busy_error", "wt_new")),
        ],
        [
          "agent.heartbeat",
          () =>
            store!.heartbeat(
              agent.agentId,
              agent.sessionToken,
              workspace("repo_busy_error", "wt_busy_error"),
            ),
        ],
        [
          "message.send",
          () =>
            store!.sendMessage(
              {
                senderAgentId: agent.agentId,
                recipientAgentId: recipient.agentId,
                body: "blocked",
              },
              agent.sessionToken,
            ),
        ],
        [
          "message.ack",
          () =>
            store!.acknowledgeMessage(
              recipient.agentId,
              recipient.sessionToken,
              message.messageId,
            ),
        ],
      ] as const) {
        let writeContention: unknown;
        try {
          action();
        } catch (error) {
          writeContention = error;
        }
        expect(writeContention).toMatchObject({
          code: "conflict",
          details: { sqliteCode: "SQLITE_BUSY", operation },
        });
      }

      blocker.db.exec("ROLLBACK");
      blocker.close();
      blocker = undefined;
      store.db.exec("DROP TABLE leases");

      let unrelated: unknown;
      try {
        store.acquireLease(
          "test:broken-storage",
          agent.agentId,
          agent.sessionToken,
          60,
        );
      } catch (error) {
        unrelated = error;
      }
      expect(unrelated).not.toBeInstanceOf(CoordinationError);
      expect(unrelated).toMatchObject({
        name: "SqliteError",
        code: "SQLITE_ERROR",
      });
    } finally {
      if (blocker?.db.inTransaction) blocker.db.exec("ROLLBACK");
      blocker?.close();
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("allows exactly one process to acquire a resource lease", async () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    try {
      store = new CoordinationStore(database.path);
      const first = store.registerAgent({
        runtime: "claude",
        sessionRef: "lease-racer-a",
        workspace: workspace("repo_lease_race", "wt_lease_a"),
      });
      const second = store.registerAgent({
        runtime: "codex",
        sessionRef: "lease-racer-b",
        workspace: workspace("repo_lease_race", "wt_lease_b"),
      });
      store.close();
      store = undefined;

      const resource = "test:repo_lease_race:resource";
      const winner = expectOneWinner(
        await runConcurrentStoreOperations([
          {
            kind: "lease",
            databasePath: database.path,
            agentId: first.agentId,
            sessionToken: first.sessionToken,
            resource,
            ttlSeconds: 60,
          },
          {
            kind: "lease",
            databasePath: database.path,
            agentId: second.agentId,
            sessionToken: second.sessionToken,
            resource,
            ttlSeconds: 60,
          },
        ]),
      );

      store = new CoordinationStore(database.path);
      const winningLease = winner.value as {
        holderAgentId: string;
        fencingToken: number;
      };
      const losingAgent =
        winningLease.holderAgentId === first.agentId
          ? second.agentId
          : first.agentId;
      const losingToken =
        losingAgent === first.agentId
          ? first.sessionToken
          : second.sessionToken;
      expect(() =>
        store!.acquireLease(resource, losingAgent, losingToken, 60),
      ).toThrow(CoordinationError);
      expect(winningLease.fencingToken).toBe(1);
    } finally {
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent job events into one global and per-job order", async () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    try {
      store = new CoordinationStore(database.path);
      const owner = store.registerAgent({
        runtime: "codex",
        sessionRef: "job-event-racer",
        workspace: workspace("repo_job_event_race", "wt_job_event_race"),
      });
      const job = store.createJob(owner.agentId, owner.sessionToken, {
        idempotencyKey: "create:job-event-race",
        kind: "implementation",
        displayName: "Concurrent event ordering",
      });
      store.close();
      store = undefined;

      const results = await runConcurrentStoreOperations([
        {
          kind: "job-event",
          databasePath: database.path,
          agentId: owner.agentId,
          sessionToken: owner.sessionToken,
          jobId: job.jobId,
          idempotencyKey: "event:race-a",
          summary: "First concurrent producer",
        },
        {
          kind: "job-event",
          databasePath: database.path,
          agentId: owner.agentId,
          sessionToken: owner.sessionToken,
          jobId: job.jobId,
          idempotencyKey: "event:race-b",
          summary: "Second concurrent producer",
        },
      ]);
      expect(results).toEqual([
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ ok: true }),
      ]);

      store = new CoordinationStore(database.path);
      const events = store.listJobEvents(job.jobId);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(new Set(events.map((event) => event.cursor)).size).toBe(3);
      expect(
        events
          .slice(1)
          .map((event) => event.summary)
          .sort(),
      ).toEqual(["First concurrent producer", "Second concurrent producer"]);
      expect(store.getJob(job.jobId)).toMatchObject({
        status: "running",
        lastEventSequence: 3,
        lastEventCursor: events[2]?.cursor,
      });
    } finally {
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("allows exactly one process to claim an integration request", async () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    try {
      store = new CoordinationStore(database.path);
      const first = store.registerAgent({
        runtime: "claude",
        sessionRef: "claim-racer-a",
        workspace: workspace("repo_claim_race", "wt_claim_a"),
      });
      const second = store.registerAgent({
        runtime: "codex",
        sessionRef: "claim-racer-b",
        workspace: workspace("repo_claim_race", "wt_claim_b"),
      });
      const targetOid = "a".repeat(40);
      const request = store.enqueueIntegration(
        {
          repositoryId: "repo_claim_race",
          sourceRef: "feature/race",
          sourceOid: "b".repeat(40),
          targetRef: "main",
          observedTargetOid: targetOid,
          requestedBy: first.agentId,
        },
        first.sessionToken,
      );
      store.close();
      store = undefined;

      const winner = expectOneWinner(
        await runConcurrentStoreOperations([
          {
            kind: "claim",
            databasePath: database.path,
            agentId: first.agentId,
            sessionToken: first.sessionToken,
            requestId: request.requestId,
            currentSourceOid: "b".repeat(40),
            currentTargetOid: targetOid,
          },
          {
            kind: "claim",
            databasePath: database.path,
            agentId: second.agentId,
            sessionToken: second.sessionToken,
            requestId: request.requestId,
            currentSourceOid: "b".repeat(40),
            currentTargetOid: targetOid,
          },
        ]),
      );

      store = new CoordinationStore(database.path);
      const winningClaim = winner.value as {
        claimedBy: string;
        leaseId: string;
        status: string;
      };
      expect(store.getIntegration(request.requestId)).toMatchObject({
        status: "claimed",
        claimedBy: winningClaim.claimedBy,
        leaseId: winningClaim.leaseId,
      });
    } finally {
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("rejects a stale token after another process rotates the session", async () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    let staleOperation:
      ReturnType<typeof startStaleMessageOperation> | undefined;
    try {
      store = new CoordinationStore(database.path);
      const sender = store.registerAgent({
        runtime: "codex",
        sessionRef: "rotation-race-sender",
        workspace: workspace("repo_rotation_race", "wt_rotation_sender"),
      });
      const recipient = store.registerAgent({
        runtime: "claude",
        sessionRef: "rotation-race-recipient",
        workspace: workspace("repo_rotation_race", "wt_rotation_recipient"),
      });
      store.close();
      store = undefined;

      staleOperation = startStaleMessageOperation({
        kind: "stale-send",
        databasePath: database.path,
        senderAgentId: sender.agentId,
        senderSessionToken: sender.sessionToken,
        recipientAgentId: recipient.agentId,
        body: "must not cross rotation",
      });
      // The worker performs the preflight check, emits `verified`, and then
      // waits for the second gate below. This models the exact window between
      // service-level validation and the protected SQLite transition.
      staleOperation.proceed();
      await staleOperation.verified;

      const rotator = new CoordinationStore(database.path);
      const reconnected = rotator.registerAgent({
        runtime: "codex",
        sessionRef: "rotation-race-sender",
        sessionToken: sender.sessionToken,
        workspace: workspace("repo_rotation_race", "wt_rotation_sender"),
      });
      rotator.close();

      staleOperation.proceed();
      const result = await staleOperation.completed;
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({
        name: "CoordinationError",
        code: "forbidden",
      });

      store = new CoordinationStore(database.path);
      expect(store.inbox(recipient.agentId, recipient.sessionToken)).toEqual(
        [],
      );
      expect(reconnected.sessionToken).not.toBe(sender.sessionToken);
    } finally {
      staleOperation?.dispose();
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });
});
