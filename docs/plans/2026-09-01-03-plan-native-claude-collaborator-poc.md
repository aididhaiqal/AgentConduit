# Native Codex `claude_collaborator` POC

**Goal:** Prove that Codex can spawn a named native subagent whose only tool
surface is a local AgentConduit stdio MCP runtime that asynchronously executes
Claude Code in the same disposable Git worktree.

**Why planning is required:** This crosses Codex and Claude provider runtimes,
starts local child processes, consumes explicitly authorized provider quota,
uses inherited workstation authentication, and must distinguish a native
Codex subagent from a nested long-running tool call without retaining prompts,
credentials, or raw model streams.

**Acceptance:** A retained fake-Claude test proves bounded start, wait,
completion, cancellation, and cleanup without provider use. A gated live
harness creates a temporary clean Git repository and temporary Codex home,
registers exactly one `claude_collaborator` custom agent, observes Codex's
native `spawnAgent` activity, observes that agent use the local async MCP
runtime, and receives one randomized marker produced by a locally executed
Claude process. The runtime starts in the fixture worktree, Git remains at the
same clean HEAD, every owned child exits, disposable authentication/config
state is removed, and retained evidence contains only redacted lifecycle
metadata, hashes, booleans, versions, and bounded diagnostics. Source and live
POC completion do not imply installation, commit, publication, or production
support.

### Outcome 1: Asynchronous local Claude runtime

- **Work:** Add one self-contained POC entrypoint whose internal stdio MCP mode
  exposes only `claude_start`, `claude_wait`, and `claude_cancel`. Launch Claude
  with stream JSON over stdin, no session persistence, no tools, an empty
  strict MCP configuration, `dontAsk`, a low budget cap, bounded output and
  wait durations, one active job, and deterministic termination. Never persist
  the prompt, credentials, raw stream, or full provider diagnostics.
- **Risks/open questions:** A killed direct Claude child is the process boundary
  this POC can prove; it is not a general process-supervision guarantee for
  arbitrary third-party launchers. Provider-native stream formats and flags are
  version-sensitive.
- **Verify:** `node --test poc/native-claude-collaborator-probe.test.mjs`

### Outcome 2: Native Codex subagent harness

- **Work:** In the same entrypoint's live mode, create a disposable clean Git
  fixture, temporary `CODEX_HOME`, and custom
  `agents/claude-collaborator.toml`. Start an ephemeral read-only Codex
  app-server thread with apps and plugins disabled and one allowed subagent;
  instruct the main agent to spawn exactly one `claude_collaborator`, wait for
  it, and return Claude's randomized marker. Observe the app-server's native
  collaboration item plus the local runtime/Claude lifecycle, compare the
  fixture HEAD and status before and after, stop owned processes, and retain
  only redacted evidence.
- **Risks/open questions:** Custom-agent configuration and app-server item
  shapes are Codex-version-sensitive. The result proves a disposable local
  shell on the tested client versions, not direct executable registration as a
  new built-in Codex agent type.
- **Verify:** `node poc/native-claude-collaborator-probe.mjs --dry-run` and
  `AGENTCONDUIT_RUN_NATIVE_CLAUDE_COLLABORATOR_POC=1 node poc/native-claude-collaborator-probe.mjs`

### Outcome 3: Reconciled evidence and completion review

- **Work:** Update the runtime capability record and canonical progress ledger
  from the actual diff and fresh fake/live evidence. Run the complete affected
  repository matrix, inspect retained evidence for redaction and lifecycle
  claims, review the implementation against the provider, process, Git, and
  cleanup boundaries, and resolve every supported Critical or Important
  finding before completion.
- **Verify:** `pnpm type:check`, `pnpm test`, `pnpm build`, `pnpm ci:check`,
  `pnpm format:check`, `pnpm skill:check`, `pnpm pack:check`, and
  `pnpm audit --audit-level=high`

## Authority, recovery, and stop conditions

- The user explicitly authorized this POC and its capped Codex and Claude
  provider usage. No commit, push, publication, installation, personal Codex
  agent/configuration change, or production runtime change is authorized.
- This repository has an unborn `main` branch and all existing product files
  are untracked. Git cannot create an isolated worktree without an unauthorized
  initial commit, so this dedicated checkout is the bounded implementation
  path. Preserve every existing file, add the POC without branch switching or
  cleanup, and never touch Atlas's separate `poc/` directory.
- Live mode is fail-closed behind
  `AGENTCONDUIT_RUN_NATIVE_CLAUDE_COLLABORATOR_POC=1`. It operates only in
  fresh `mkdtemp` directories, links rather than copies an existing Codex auth
  file when available, inherits Claude authentication without reading it, and
  caps provider budget and time. Cleanup may remove only the exact disposable
  runtime directory created by that run; redacted evidence is retained for
  inspection.
- Stop and report failure if the custom agent is not observed as a native
  `spawnAgent`, its MCP server does not start in the fixture cwd, Claude does
  not return the run-specific marker, any child cannot be confirmed closed,
  Git changes, the retained evidence contains a forbidden raw value, or a
  required provider/authentication boundary is unavailable. Do not substitute
  a direct main-thread CLI call or report a dry run/fake child as live proof.
