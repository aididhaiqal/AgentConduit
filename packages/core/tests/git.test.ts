import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoordinationError } from "../src/errors.js";
import {
  canonicalizeGitRef,
  discoverGitWorkspace,
  resolveGitRef,
} from "../src/git.js";
import { makeGitRepository, git } from "./helpers.js";

describe("Git workspace discovery", () => {
  it("registers a real repository and reports its worktree facts", () => {
    const repository = makeGitRepository();
    const snapshot = discoverGitWorkspace(repository);

    expect(snapshot.repositoryId).toMatch(/^repo_[0-9a-f]{32}$/);
    expect(snapshot.worktreeId).toMatch(/^wt_[0-9a-f]{32}$/);
    expect(snapshot.rootPath).toBe(repository);
    expect(snapshot.commonGitDir).toBe(snapshot.gitDir);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.upstream).toEqual({ status: "unavailable" });
    expect(snapshot.isBare).toBe(false);
  });

  it("reports the configured upstream ref and real ahead/behind counts", () => {
    const repository = makeGitRepository();
    const baseOid = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["branch", "upstream", baseOid]);
    git(repository, ["branch", "--set-upstream-to=upstream", "main"]);
    git(repository, ["commit", "--allow-empty", "-qm", "local change"]);
    const treeOid = git(repository, ["rev-parse", `${baseOid}^{tree}`]);
    const upstreamOid = git(repository, [
      "commit-tree",
      treeOid,
      "-p",
      baseOid,
      "-m",
      "upstream change",
    ]);
    git(repository, ["update-ref", "refs/heads/upstream", upstreamOid]);

    const snapshot = discoverGitWorkspace(repository);

    expect(snapshot.upstream).toEqual({
      status: "available",
      ref: "upstream",
      ahead: 1,
      behind: 1,
    });
  });

  it("retains a configured ref without claiming synchronization when comparison fails", () => {
    const repository = makeGitRepository();
    git(repository, ["config", "branch.main.remote", "."]);
    git(repository, [
      "config",
      "branch.main.merge",
      "refs/heads/missing-upstream",
    ]);

    const snapshot = discoverGitWorkspace(repository);

    expect(snapshot.upstream).toEqual({
      status: "unavailable",
      ref: "missing-upstream",
    });
  });

  it("marks untracked and modified files dirty and resolves refs safely", () => {
    const repository = makeGitRepository();
    const initial = resolveGitRef(repository, "main");
    expect(initial).toMatch(/^[0-9a-f]{40}$/);
    git(repository, ["checkout", "-qb", "feature/demo"]);
    git(repository, ["commit", "--allow-empty", "-qm", "feature"]);
    const feature = resolveGitRef(repository, "feature/demo");
    expect(feature).not.toBe(initial);

    const snapshot = discoverGitWorkspace(repository);
    expect(snapshot.branch).toBe("feature/demo");
    expect(snapshot.dirty).toBe(false);
    expect(() => resolveGitRef(repository, "main;touch /tmp/unsafe")).toThrow();
    expect(() => resolveGitRef(repository, "--help")).toThrow(
      CoordinationError,
    );
    expect(canonicalizeGitRef(repository, "main")).toBe("refs/heads/main");
  });

  it("removes query and fragment material from a normalized remote", () => {
    const repository = makeGitRepository();
    git(repository, [
      "remote",
      "add",
      "origin",
      "https://user:secret@example.invalid/acme/payments.git?token=leak#fragment",
    ]);

    const snapshot = discoverGitWorkspace(repository);
    expect(snapshot.remoteUrl).toBe("example.invalid/acme/payments");
    expect(snapshot.remoteUrl).not.toContain("secret");
    expect(snapshot.remoteUrl).not.toContain("token");
  });

  it("omits local filesystem remotes from repository metadata", () => {
    const repository = makeGitRepository();
    git(repository, ["remote", "add", "origin", "/private/local/origin.git"]);
    expect(discoverGitWorkspace(repository).remoteUrl).toBeUndefined();

    git(repository, [
      "remote",
      "set-url",
      "origin",
      "file:///private/local/origin.git",
    ]);
    expect(discoverGitWorkspace(repository).remoteUrl).toBeUndefined();
  });

  it("accepts only direct local branch refs as integration targets", () => {
    const repository = makeGitRepository();
    git(repository, ["update-ref", "refs/notes/commits", "main"]);

    expect(canonicalizeGitRef(repository, "main")).toBe("refs/heads/main");
    expect(canonicalizeGitRef(repository, "refs/heads/main")).toBe(
      "refs/heads/main",
    );
    expect(() => canonicalizeGitRef(repository, "HEAD")).toThrow(
      CoordinationError,
    );
    expect(() => canonicalizeGitRef(repository, "main^")).toThrow(
      CoordinationError,
    );
    expect(() => canonicalizeGitRef(repository, "refs/tags/v1")).toThrow(
      CoordinationError,
    );
    expect(() => canonicalizeGitRef(repository, "refs/notes/commits")).toThrow(
      CoordinationError,
    );
  });

  it("uses an explicit project identity for intentionally shared independent clones", () => {
    const repository = makeGitRepository();
    mkdirSync(join(repository, ".agentconduit"));
    writeFileSync(
      join(repository, ".agentconduit", "project.json"),
      '{"projectId":"shared-payments"}\n',
    );

    const snapshot = discoverGitWorkspace(repository);
    expect(snapshot.projectId).toBe("shared-payments");
    expect(snapshot.repositoryId).toMatch(/^repo_[0-9a-f]{32}$/);

    writeFileSync(
      join(repository, ".agentconduit", "project.json"),
      "not-json\n",
    );
    expect(() => discoverGitWorkspace(repository)).toThrow(CoordinationError);
  });

  it("rejects workspaces outside configured allowed roots", () => {
    const repository = makeGitRepository();
    const parent = join(repository, "..");
    expect(() =>
      discoverGitWorkspace(repository, { allowedRoots: [parent] }),
    ).not.toThrow();
    expect(() =>
      discoverGitWorkspace(repository, {
        allowedRoots: [join(repository, "..", "missing")],
      }),
    ).toThrow(CoordinationError);
  });

  it("rejects a nested allowed path when its Git root escapes that root", () => {
    const repository = makeGitRepository();
    const nestedPath = join(repository, "nested");
    mkdirSync(nestedPath);

    expect(() =>
      discoverGitWorkspace(nestedPath, { allowedRoots: [nestedPath] }),
    ).toThrow(CoordinationError);
  });
});
