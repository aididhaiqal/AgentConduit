import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationError } from "../src/errors.js";
import { CoordinationService } from "../src/service.js";
import { CoordinationStore } from "../src/store.js";
import { git, makeGitRepository } from "./helpers.js";

describe("CoordinationService session and integration boundaries", () => {
  it("issues a private session token and rotates it on reconnect", () => {
    const service = new CoordinationService();
    const repository = makeGitRepository();
    try {
      const first = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "stable-session",
      });
      expect(first.sessionToken).toMatch(/^acs_[0-9a-f]{64}$/);
      expect(
        service.heartbeat(first.agentId, first.sessionToken, repository).status,
      ).toBe("online");

      expect(() =>
        service.register({
          runtime: "codex",
          workspacePath: repository,
          sessionRef: "stable-session",
        }),
      ).toThrow(CoordinationError);
      const reconnected = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "stable-session",
        sessionToken: first.sessionToken,
      });
      expect(reconnected.agentId).toBe(first.agentId);
      expect(reconnected.sessionToken).not.toBe(first.sessionToken);
      expect(() =>
        service.heartbeat(first.agentId, first.sessionToken, repository),
      ).toThrow(CoordinationError);
      expect(
        service.heartbeat(
          reconnected.agentId,
          reconnected.sessionToken,
          repository,
        ).status,
      ).toBe("online");
    } finally {
      service.close();
    }
  });

  it("makes unregister safe to retry after the session is already offline", () => {
    const service = new CoordinationService();
    const repository = makeGitRepository();
    try {
      const agent = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "retry-unregister",
      });

      service.unregister(agent.agentId, agent.sessionToken);

      expect(() =>
        service.unregister(agent.agentId, agent.sessionToken),
      ).not.toThrow();
      expect(
        service
          .listAgents(undefined, true)
          .find((entry) => entry.agentId === agent.agentId),
      ).toMatchObject({ status: "offline" });
    } finally {
      service.close();
    }
  });

  it("canonicalizes target aliases into one FIFO queue and protects active claims", () => {
    const repository = makeGitRepository();
    git(repository, ["checkout", "-qb", "feature/one"]);
    git(repository, ["commit", "--allow-empty", "-qm", "feature one"]);
    git(repository, ["checkout", "main"]);
    const service = new CoordinationService({ store: new CoordinationStore() });
    try {
      const requester = service.register({
        runtime: "claude-code",
        workspacePath: repository,
        sessionRef: "requester",
      });
      const claimant = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "claimant",
      });
      const first = service.enqueueIntegration(
        requester.agentId,
        requester.sessionToken,
        repository,
        "feature/one",
        "main",
      );
      const second = service.enqueueIntegration(
        requester.agentId,
        requester.sessionToken,
        repository,
        "feature/one",
        "refs/heads/main",
      );
      expect(first.targetRef).toBe("refs/heads/main");
      expect(second.targetRef).toBe(first.targetRef);

      const claimed = service.claimIntegration(
        claimant.agentId,
        claimant.sessionToken,
        first.requestId,
        repository,
      );
      expect(claimed.claimedBy).toBe(claimant.agentId);
      expect(() =>
        service.cancelIntegration(
          requester.agentId,
          requester.sessionToken,
          first.requestId,
        ),
      ).toThrow(CoordinationError);
      const cancelled = service.cancelIntegration(
        claimant.agentId,
        claimant.sessionToken,
        first.requestId,
      );
      expect(cancelled.status).toBe("cancelled");
    } finally {
      service.close();
    }
  });

  it("requires the source ref to remain current before claiming integration", () => {
    const repository = makeGitRepository();
    git(repository, ["checkout", "-qb", "feature/source-refresh"]);
    git(repository, ["commit", "--allow-empty", "-qm", "source v1"]);
    git(repository, ["checkout", "main"]);
    const service = new CoordinationService();
    try {
      const agent = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "source-refresh-agent",
      });
      const request = service.enqueueIntegration(
        agent.agentId,
        agent.sessionToken,
        repository,
        "feature/source-refresh",
        "main",
      );

      git(repository, ["checkout", "feature/source-refresh"]);
      git(repository, ["commit", "--allow-empty", "-qm", "source v2"]);
      git(repository, ["checkout", "main"]);

      expect(() =>
        service.claimIntegration(
          agent.agentId,
          agent.sessionToken,
          request.requestId,
          repository,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "conflict",
          details: expect.objectContaining({
            expectedSourceOid: request.sourceOid,
          }),
        }),
      );
      expect(service.getIntegration(request.requestId).status).toBe(
        "needs_refresh",
      );
    } finally {
      service.close();
    }
  });

  it("renews an integration lease only for its active claimant", () => {
    const repository = makeGitRepository();
    git(repository, ["checkout", "-qb", "feature/renew"]);
    git(repository, ["commit", "--allow-empty", "-qm", "feature renew"]);
    git(repository, ["checkout", "main"]);
    const service = new CoordinationService();
    try {
      const claimant = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "renew-claimant",
      });
      const other = service.register({
        runtime: "claude-code",
        workspacePath: repository,
        sessionRef: "renew-other",
      });
      const request = service.enqueueIntegration(
        claimant.agentId,
        claimant.sessionToken,
        repository,
        "feature/renew",
        "main",
      );
      const claimed = service.claimIntegration(
        claimant.agentId,
        claimant.sessionToken,
        request.requestId,
        repository,
      );
      const expiry = Date.parse(claimed.lease?.expiresAt ?? "");
      const renewed = service.renewIntegration(
        claimant.agentId,
        claimant.sessionToken,
        request.requestId,
        repository,
        900,
      );
      expect(renewed.status).toBe("claimed");
      expect(Date.parse(renewed.lease?.expiresAt ?? "")).toBeGreaterThan(
        expiry,
      );
      expect(() =>
        service.renewIntegration(
          other.agentId,
          other.sessionToken,
          request.requestId,
          repository,
          60,
        ),
      ).toThrow(CoordinationError);
      expect(() =>
        service.renewIntegration(
          claimant.agentId,
          "acs_" + "0".repeat(64),
          request.requestId,
          repository,
          60,
        ),
      ).toThrow(CoordinationError);
    } finally {
      service.close();
    }
  });

  it("enforces configured Git discovery roots", () => {
    const repository = makeGitRepository();
    const service = new CoordinationService({ allowedRoots: [repository] });
    try {
      expect(service.discover(repository).rootPath).toBe(repository);
      expect(() => service.discover("/tmp")).toThrow(CoordinationError);
    } finally {
      service.close();
    }
  });

  it("does not let a heartbeat move an agent session into another repository", () => {
    const repository = makeGitRepository();
    const unrelatedRepository = makeGitRepository();
    const service = new CoordinationService();
    try {
      const agent = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "one-repository-session",
      });

      expect(() =>
        service.heartbeat(
          agent.agentId,
          agent.sessionToken,
          unrelatedRepository,
        ),
      ).toThrow(CoordinationError);
      expect(
        service.listAgents().find((entry) => entry.agentId === agent.agentId),
      ).toMatchObject({
        workspace: { repositoryId: agent.workspace.repositoryId },
      });
    } finally {
      service.close();
    }
  });

  it("does not let a heartbeat move an agent session into a linked worktree", () => {
    const repository = makeGitRepository();
    const linkedWorktree = mkdtempSync(
      join(tmpdir(), "agentconduit-heartbeat-worktree-"),
    );
    rmSync(linkedWorktree, { recursive: true });
    git(repository, [
      "worktree",
      "add",
      "-b",
      "linked-heartbeat",
      linkedWorktree,
    ]);
    const service = new CoordinationService();
    try {
      const agent = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "stable-linked-session",
      });

      expect(() =>
        service.heartbeat(agent.agentId, agent.sessionToken, linkedWorktree),
      ).toThrow(CoordinationError);
      expect(
        service.listAgents().find((entry) => entry.agentId === agent.agentId),
      ).toMatchObject({
        workspace: { worktreeId: agent.workspace.worktreeId },
      });
      expect(() =>
        service.register({
          runtime: "codex",
          workspacePath: repository,
          sessionRef: "stable-linked-session",
        }),
      ).toThrow(CoordinationError);
    } finally {
      service.close();
      git(repository, ["worktree", "remove", "--force", linkedWorktree]);
    }
  });

  it("rejects an agent from another repository claiming an integration", () => {
    const requesterRepository = makeGitRepository();
    const unrelatedRepository = makeGitRepository();
    git(requesterRepository, ["checkout", "-qb", "feature/one"]);
    git(requesterRepository, ["commit", "--allow-empty", "-qm", "feature one"]);
    git(requesterRepository, ["checkout", "main"]);
    const service = new CoordinationService();
    try {
      const requester = service.register({
        runtime: "claude-code",
        workspacePath: requesterRepository,
        sessionRef: "requester",
      });
      const unrelatedAgent = service.register({
        runtime: "codex",
        workspacePath: unrelatedRepository,
        sessionRef: "unrelated",
      });
      const request = service.enqueueIntegration(
        requester.agentId,
        requester.sessionToken,
        requesterRepository,
        "feature/one",
        "main",
      );
      const claimed = service.claimIntegration(
        requester.agentId,
        requester.sessionToken,
        request.requestId,
        requesterRepository,
      );

      expect(() =>
        service.claimIntegration(
          unrelatedAgent.agentId,
          unrelatedAgent.sessionToken,
          request.requestId,
          requesterRepository,
        ),
      ).toThrow(CoordinationError);
      expect(() =>
        service.refreshIntegration(
          unrelatedAgent.agentId,
          unrelatedAgent.sessionToken,
          claimed.requestId,
          requesterRepository,
        ),
      ).toThrow(CoordinationError);
      expect(() =>
        service.completeIntegration(
          unrelatedAgent.agentId,
          unrelatedAgent.sessionToken,
          claimed.requestId,
          requesterRepository,
          { outcome: "failed", postTargetOid: claimed.observedTargetOid },
        ),
      ).toThrow(CoordinationError);
      expect(() =>
        service.cancelIntegration(
          unrelatedAgent.agentId,
          unrelatedAgent.sessionToken,
          claimed.requestId,
        ),
      ).toThrow(CoordinationError);
    } finally {
      service.close();
    }
  });

  it("requires integration transitions from the agent's registered worktree", () => {
    const repository = makeGitRepository();
    const linkedWorktree = mkdtempSync(
      join(tmpdir(), "agentconduit-worktree-"),
    );
    rmSync(linkedWorktree, { recursive: true });
    git(repository, ["checkout", "-qb", "feature/one"]);
    git(repository, ["commit", "--allow-empty", "-qm", "feature one"]);
    git(repository, ["checkout", "main"]);
    git(repository, [
      "worktree",
      "add",
      "-qb",
      "feature/linked",
      linkedWorktree,
    ]);
    const service = new CoordinationService();
    try {
      const agent = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "primary-worktree",
      });
      const request = service.enqueueIntegration(
        agent.agentId,
        agent.sessionToken,
        repository,
        "feature/one",
        "main",
      );

      expect(() =>
        service.claimIntegration(
          agent.agentId,
          agent.sessionToken,
          request.requestId,
          linkedWorktree,
        ),
      ).toThrow(CoordinationError);
    } finally {
      service.close();
      git(repository, ["worktree", "remove", "--force", linkedWorktree]);
    }
  });

  it("exposes authenticated same-repository job creation, progress, and replay", () => {
    const repository = makeGitRepository();
    const unrelatedRepository = makeGitRepository();
    const service = new CoordinationService({ jobActivityTimeoutMs: 1_000 });
    try {
      const owner = service.register({
        runtime: "codex",
        workspacePath: repository,
        sessionRef: "job-owner",
      });
      const peer = service.register({
        runtime: "claude-code",
        workspacePath: repository,
        sessionRef: "job-peer",
      });
      const outsider = service.register({
        runtime: "codex",
        workspacePath: unrelatedRepository,
        sessionRef: "job-outsider",
      });

      const job = service.createJob(owner.agentId, owner.sessionToken, {
        idempotencyKey: "create:service-job",
        kind: "analysis",
        displayName: "Service job",
      });
      const progress = service.emitJobEvent(
        owner.agentId,
        owner.sessionToken,
        job.jobId,
        {
          idempotencyKey: "event:service-progress",
          type: "checkpoint",
          summary: "The service boundary is covered",
        },
      );

      expect(
        service.getJob(peer.agentId, peer.sessionToken, job.jobId),
      ).toMatchObject({
        status: "running",
        lastEventCursor: progress.cursor,
      });
      expect(
        service.listJobs(peer.agentId, peer.sessionToken, {
          statuses: ["running"],
        }),
      ).toHaveLength(1);
      expect(
        service.jobEvents(
          peer.agentId,
          peer.sessionToken,
          job.jobId,
          job.lastEventCursor,
        ),
      ).toEqual([progress]);
      expect(() =>
        service.getJob(outsider.agentId, outsider.sessionToken, job.jobId),
      ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    } finally {
      service.close();
    }
  });
});
