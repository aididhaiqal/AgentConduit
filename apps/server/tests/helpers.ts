import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeGitRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentconduit-mcp-"));
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, [
    "config",
    "user.email",
    "agentconduit-tests@example.invalid",
  ]);
  git(directory, ["config", "user.name", "AgentConduit Tests"]);
  writeFileSync(join(directory, "README.md"), "initial\n");
  git(directory, ["add", "README.md"]);
  git(directory, ["commit", "-qm", "initial"]);
  return directory;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
