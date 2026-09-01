import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CoordinationError } from "./errors.js";
import type { GitUpstreamEvidence, GitWorkspaceSnapshot } from "./model.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const PROJECT_CONFIG_MAX_BYTES = 16 * 1024;
const SAFE_REF_PATTERN = /^[A-Za-z0-9_./:@+\-^~{}]+$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface GitDiscoveryOptions {
  /** Canonical directories within which Git workspaces may be inspected. */
  allowedRoots?: readonly string[];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable repository scope used by explicitly enrolled independent clones. */
export function repositoryIdForProjectId(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new CoordinationError(
      "invalid_input",
      "AgentConduit projectId is invalid",
    );
  }
  return `repo_${digest(`project\0${projectId}`).slice(0, 32)}`;
}

function canonicalDirectory(inputPath: string): string {
  if (!inputPath || inputPath.length > 4096) {
    throw new CoordinationError(
      "invalid_input",
      "workspacePath must be a non-empty path",
    );
  }
  const candidate = resolve(inputPath);
  try {
    const stat = statSync(candidate);
    if (!stat.isDirectory()) {
      throw new CoordinationError(
        "invalid_input",
        "workspacePath must refer to a directory",
      );
    }
    return realpathSync(candidate);
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError(
      "invalid_input",
      `Workspace directory is not accessible: ${candidate}`,
    );
  }
}

function assertAllowedRoot(
  cwd: string,
  allowedRoots: readonly string[] | undefined,
): void {
  if (!allowedRoots || allowedRoots.length === 0) return;
  const permitted = allowedRoots.map((root) => {
    const candidate = resolve(root);
    try {
      const stat = statSync(candidate);
      if (!stat.isDirectory()) {
        throw new CoordinationError(
          "invalid_input",
          `Allowed root is not a directory: ${candidate}`,
        );
      }
      return realpathSync(candidate);
    } catch (error) {
      if (error instanceof CoordinationError) throw error;
      throw new CoordinationError(
        "invalid_input",
        `Allowed root is not accessible: ${candidate}`,
      );
    }
  });
  const inside = permitted.some((root) => {
    const remainder = relative(root, cwd);
    return (
      remainder === "" ||
      (remainder !== ".." &&
        !remainder.startsWith(`..${sep}`) &&
        !isAbsolute(remainder))
    );
  });
  if (!inside) {
    throw new CoordinationError(
      "forbidden",
      `Workspace is outside the configured allowed roots: ${cwd}`,
    );
  }
}

/** Validate a Git revision expression before passing it as a single argument. */
export function assertSafeGitRef(ref: string): void {
  if (
    !ref ||
    ref.length > 512 ||
    ref.startsWith("-") ||
    !SAFE_REF_PATTERN.test(ref)
  ) {
    throw new CoordinationError(
      "invalid_input",
      "Git ref contains unsupported characters",
    );
  }
}

function readProjectId(rootPath: string): string | undefined {
  const configDirectory = join(rootPath, ".agentconduit");
  const configPath = join(rootPath, ".agentconduit", "project.json");
  if (!existsSync(configPath)) return undefined;
  let raw: string;
  try {
    if (
      lstatSync(configDirectory).isSymbolicLink() ||
      lstatSync(configPath).isSymbolicLink()
    ) {
      throw new CoordinationError(
        "invalid_input",
        "AgentConduit project configuration may not use symlinks",
      );
    }
    const stat = statSync(configPath);
    if (!stat.isFile() || stat.size > PROJECT_CONFIG_MAX_BYTES) {
      throw new CoordinationError(
        "invalid_input",
        "AgentConduit project configuration is invalid",
      );
    }
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError(
      "invalid_input",
      "AgentConduit project configuration is not readable",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoordinationError(
      "invalid_input",
      "AgentConduit project configuration is not valid JSON",
    );
  }
  if (!parsed || typeof parsed !== "object" || !("projectId" in parsed)) {
    throw new CoordinationError(
      "invalid_input",
      "AgentConduit project configuration requires projectId",
    );
  }
  const projectId = (parsed as { projectId?: unknown }).projectId;
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new CoordinationError(
      "invalid_input",
      "AgentConduit projectId is invalid",
    );
  }
  return projectId;
}

function runGit(
  cwd: string,
  args: string[],
  allowFailure = false,
): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    const detail =
      error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
    throw new CoordinationError(
      "git_error",
      `Git discovery failed in ${cwd}: ${detail}`,
    );
  }
}

function resolveGitPath(cwd: string, value: string): string {
  return realpathSync(isAbsolute(value) ? value : resolve(cwd, value));
}

function normalizeRemote(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let remote = value.trim();
  if (!remote) return undefined;
  // Local filesystem remotes are useful for Git but are not portable
  // repository identity and must never become cross-machine metadata.
  if (
    remote.startsWith("/") ||
    remote.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(remote) ||
    /^file:/i.test(remote)
  ) {
    return undefined;
  }
  // Query strings and fragments are not repository identity and frequently
  // carry access tokens in HTTPS-style remotes. Remove them before retaining
  // the normalized value in workspace metadata or hashing it into identity.
  remote = remote.replace(/[?#].*$/, "");
  if (remote.startsWith("git@")) remote = remote.slice(4);
  remote = remote.replace(/^https?:\/\//i, "");
  remote = remote.replace(/^ssh:\/\//i, "");
  remote = remote.replace(/^[^/@]+@/, "");
  remote = remote.replace(/\/$/, "").replace(/\.git$/i, "");
  return remote.toLowerCase();
}

interface PorcelainWorktree {
  path: string;
  gitDir?: string;
  headOid?: string;
  branch?: string;
}

function parseWorktrees(output: string): PorcelainWorktree[] {
  const records: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.headOid = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (line.startsWith("gitdir ")) {
      current.gitDir = line.slice("gitdir ".length);
    }
  }
  if (current) records.push(current);
  return records;
}

function observeUpstream(
  cwd: string,
  branch: string | undefined,
): GitUpstreamEvidence {
  if (!branch) return { status: "unavailable" };
  const ref = runGit(
    cwd,
    ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`],
    true,
  );
  if (!ref) return { status: "unavailable" };
  const result = runGit(
    cwd,
    ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    true,
  );
  if (!result) return { status: "unavailable", ref };
  const match = /^(\d+)\s+(\d+)$/.exec(result);
  if (!match) return { status: "unavailable", ref };
  const behind = Number.parseInt(match[1]!, 10);
  const ahead = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    return { status: "unavailable", ref };
  }
  return {
    status: "available",
    ref,
    ahead,
    behind,
  };
}

export function resolveGitRef(
  workspacePath: string,
  ref: string,
  options: GitDiscoveryOptions = {},
): string {
  const cwd = canonicalDirectory(workspacePath);
  assertAllowedRoot(cwd, options.allowedRoots);
  assertSafeGitRef(ref);
  const oid = runGit(cwd, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (!oid || !/^[0-9a-f]{40,64}$/i.test(oid)) {
    throw new CoordinationError(
      "git_error",
      `Git ref could not be resolved: ${ref}`,
    );
  }
  return oid;
}

/**
 * Resolve a mutable Git ref to its fully qualified name. Integration targets
 * use this form so aliases such as `main` and `refs/heads/main` share one
 * queue and one lease resource.
 */
export function canonicalizeGitRef(
  workspacePath: string,
  ref: string,
  options: GitDiscoveryOptions = {},
): string {
  const cwd = canonicalDirectory(workspacePath);
  assertAllowedRoot(cwd, options.allowedRoots);
  assertSafeGitRef(ref);
  if (ref === "HEAD" || ref === "@" || /[\^~{}]|@\{/.test(ref)) {
    throw new CoordinationError(
      "invalid_input",
      `Integration target must be a direct local branch ref: ${ref}`,
    );
  }
  const symbolic = runGit(
    cwd,
    ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", ref],
    true,
  );
  if (
    !symbolic ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._@+\/-]*$/.test(symbolic)
  ) {
    throw new CoordinationError(
      "invalid_input",
      `Integration target must be a direct local branch ref: ${ref}`,
    );
  }
  return symbolic;
}

export function discoverGitWorkspace(
  workspacePath: string,
  options: GitDiscoveryOptions = {},
): GitWorkspaceSnapshot {
  const cwd = canonicalDirectory(workspacePath);
  assertAllowedRoot(cwd, options.allowedRoots);
  const isBare =
    runGit(cwd, ["rev-parse", "--is-bare-repository"], true) === "true";
  const rootPath = isBare ? cwd : runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!rootPath)
    throw new CoordinationError(
      "git_error",
      "Git root could not be determined",
    );
  const canonicalRoot = realpathSync(rootPath);
  // A caller may point inside an allowed directory that belongs to a Git
  // repository rooted outside that directory. The Git root is the workspace
  // authority persisted and later used for ref resolution, so it must satisfy
  // the same containment policy as the supplied path.
  assertAllowedRoot(canonicalRoot, options.allowedRoots);
  const commonGitDirValue = runGit(cwd, ["rev-parse", "--git-common-dir"]);
  const gitDirValue = runGit(cwd, ["rev-parse", "--git-dir"]);
  if (!commonGitDirValue || !gitDirValue) {
    throw new CoordinationError(
      "git_error",
      "Git directory could not be determined",
    );
  }
  const commonGitDir = resolveGitPath(cwd, commonGitDirValue);
  const gitDir = resolveGitPath(cwd, gitDirValue);
  const projectId = readProjectId(canonicalRoot);
  const remoteUrl = normalizeRemote(
    runGit(cwd, ["remote", "get-url", "origin"], true),
  );
  const headOid = runGit(cwd, ["rev-parse", "HEAD"]);
  if (!headOid)
    throw new CoordinationError(
      "git_error",
      "Git HEAD could not be determined",
    );
  const branchValue = runGit(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true,
  );
  const status = runGit(cwd, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const worktreeRecords = parseWorktrees(
    runGit(cwd, ["worktree", "list", "--porcelain"], true) ?? "",
  );
  const matchingRecord = worktreeRecords.find((record) => {
    try {
      return realpathSync(record.path) === canonicalRoot;
    } catch {
      return false;
    }
  });
  const repositoryId = projectId
    ? repositoryIdForProjectId(projectId)
    : `repo_${digest(`${remoteUrl ?? "local"}\0${commonGitDir}`).slice(0, 32)}`;
  const worktreeKey = `${repositoryId}\0${gitDir}\0${canonicalRoot}`;
  const worktreeId = `wt_${digest(worktreeKey).slice(0, 32)}`;
  const branch = branchValue ?? matchingRecord?.branch;
  const upstream = observeUpstream(cwd, branch);
  const snapshot: GitWorkspaceSnapshot = {
    repositoryId,
    ...(projectId ? { projectId } : {}),
    worktreeId,
    rootPath: canonicalRoot,
    commonGitDir,
    gitDir,
    headOid,
    dirty: Boolean(status),
    upstream,
    isBare,
    observedAt: new Date().toISOString(),
  };
  if (remoteUrl) snapshot.remoteUrl = remoteUrl;
  if (branch) snapshot.branch = branch;
  return snapshot;
}
