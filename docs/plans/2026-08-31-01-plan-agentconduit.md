# AgentConduit universal coordination MCP

**Goal:** Provide a provider-neutral MCP coordination layer for Claude, Codex,
and other coding agents working in Git repositories and worktrees.

**Why planning is required:** This is a cross-runtime, persistent, security-
sensitive project with resumable protocol and state-machine work.

**Acceptance:** A local broker can independently discover and register a real
Git worktree, expose live agent presence and durable messages through MCP, and
serialize integration leases with restart-safe persistence and race tests. The
source-complete boundary is local v1; remote authentication, raw-Git
enforcement, and deployment are explicit follow-up obligations.

### Outcome 1: Shared coordination core

- **Work:** Implement a TypeScript/Node core backed by SQLite. Discover canonical
  Git root/common directory, remote identity, worktree, branch, HEAD, and dirty
  state server-side. Add agent registration/heartbeat, inbox/ack messaging,
  lease acquisition/renewal/release, and audit-safe state transitions.
- **Risks/open questions:** Cross-machine authentication and raw-Git enforcement
  remain explicit follow-up boundaries.
- **Evidence:** Source complete; core type-check, build, and 5-file / 44-test
  suite pass, including schema-v2 migration, explicit upstream-evidence,
  worktree/session-boundary, and retry-safe unregister regressions.
- **Verify:** `pnpm --filter @agentconduit/core type:check`,
  `pnpm --filter @agentconduit/core test`, and `pnpm --filter @agentconduit/core build`

### Outcome 2: MCP transports

- **Work:** Expose the core through the official MCP TypeScript SDK over local
  Streamable HTTP, with a stdio bridge for clients that only configure commands.
  Keep transport handlers thin and validate all tool inputs.
- **Risks/open questions:** Client notification support differs; correctness
  relies on durable polling tools. Stdio relies on operating-system database
  permissions rather than HTTP bearer authentication.
- **Evidence:** Source complete; server type-check, build, and 4-file / 16-test
  suite pass, including two-client linked-worktree coordination, real
  Streamable HTTP, structured MCP output, and process-level stdio lifecycle
  tests.
- **Verify:** `pnpm --filter @agentconduit/server type:check`,
  `pnpm --filter @agentconduit/server test`, and `pnpm --filter @agentconduit/server build`

### Outcome 3: Universal workflow packaging

- **Work:** Add provider-neutral skill instructions plus Codex and Claude
  configuration examples. Document installation, identity privacy, local
  security, and recovery behavior.
- **Risks/open questions:** Client-specific skill packaging may need thin
  adapters; one directory is not claimed to be natively accepted by every
  client.
- **Evidence:** Source skill and examples complete; skill validator,
  formatting, and JSON/TOML checks pass.
- **Verify:** `python3 /mnt/c/Users/aidid/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/agentconduit-coordination` and `pnpm format:check`

### Outcome 4: Integration arbitration

- **Work:** Add FIFO integration requests scoped to a canonical direct branch
  ref, claimant-only renewable leases with fencing tokens, invalidate stale base
  observations, and record completion/cancellation. Do not enable autonomous
  merge execution; the queue coordinates the turn while Git remains an external
  operation.
- **Risks/open questions:** Protected remote branches remain necessary against
  agents that bypass MCP; independent clone namespaces are not authoritative
  remote-ref locks.
- **Evidence:** Source complete; queue, expiry, renewal, cancellation,
  restart, stale-source/target, two-process race, and failure tests pass.
- **Verify:** `pnpm --filter @agentconduit/core test` and
  `pnpm --filter @agentconduit/server test`

### Outcome 5: Runtime push capability POC

- **Work:** Retain explicitly opt-in, disposable Claude Code
  `--input-format stream-json` active- and idle-turn probes and a capability
  matrix alongside the Codex app-server evidence. Record event ordering and
  runtime versions without persisting prompts, credentials, or live-session
  identifiers. Keep durable AgentConduit inbox polling as the correctness path;
  classify provider-native push as an optional adapter capability rather than
  changing the provider-neutral protocol.
- **Risks/open questions:** The Claude stream is bridge-owned and process-level;
  it does not establish control of an arbitrary interactive/Desktop session or
  the undocumented `messaging_socket_path` protocol. Codex app-server APIs are
  experimental and version-specific. Live probes require authenticated client
  credentials and can incur provider usage, so they are never CI defaults.
- **Evidence:** Retained Claude Code 2.1.250 active-turn stream probe rerun with
  `claude-opus-5[1m]` and an idle-turn probe with the same client/model (both
  acknowledged push and exited cleanly), plus the Codex CLI 0.146.0 app-server
  probe; no repository or live session mutated.
- **Verify:** Run the opt-in Claude probe described in
  `docs/runtime-push.md`; inspect its timestamped event ledger and ensure the
  capability matrix remains consistent with the observed runtime versions.

### Outcome 6: Live dual-runtime broker interoperability POC

- **Work:** Exercise the real Claude Code and Codex MCP clients against one
  temporary AgentConduit broker and disposable linked Git worktrees. Prove
  server-side registration, durable cross-runtime send/read/ack, and competing
  integration requests. Keep runtime-issued session tokens in memory only and
  reject any client approval or Git operation outside the disposable fixture.
- **Risks/open questions:** Codex app-server elicitation is experimental and
  version-specific. The harness owns both processes, so it cannot establish
  addressability of an arbitrary already-open Desktop session. Raw Git remains
  outside the broker.
- **Evidence:** Clean run on 2026-08-31 with Claude Code 2.1.250 and Codex CLI
  0.146.0: both MCP registrations were visible in one repository scope with
  distinct worktrees; Claude sent `AGENTCONDUIT_E2E_MESSAGE_7C2B`; Codex read
  and acknowledged it; the broker observed `acknowledgedAt`; and two real-Git
  integration requests yielded one lease winner and one conflict. Redacted
  evidence is retained under the path printed by the harness and the temporary
  runtime root was removed.
- **Verify:**
  `AGENTCONDUIT_RUN_DUAL_RUNTIME_POC=1 node poc/dual-runtime-broker-push-probe.mjs`
  after `pnpm build`; inspect `summary.json` and the redacted event ledger.
  This live check is never a CI default because it uses authenticated provider
  clients and account quota.

### Outcome 7: Full-router coordination skill

- **Work:** Turn the proven protocol into one provider-neutral skill that
  routes task phases through AgentConduit: activation and no-op criteria,
  server-observed registration, peer/inbox inspection, communication decision
  rules, heartbeats, narrow leases, FIFO integration, optional owned-runtime
  push hints, completion handoffs, and recovery. Keep the host's full-router,
  authorization, worktree, review, and delivery skills authoritative; the
  coordination skill must never grant merge or push authority. Keep detailed
  routing and message templates in packaged references rather than duplicating
  provider-specific skills.
- **Risks/open questions:** Skill instructions can cause coordination writes or
  message noise if triggers are too broad; they must no-op for unrelated work,
  never disclose tokens or prompts, and preserve durable inbox polling when a
  native push adapter is unavailable. Client discovery paths remain adapters,
  not separate skill implementations.
- **Evidence:** One provider-neutral `SKILL.md` plus packaged routing,
  full-router, and recovery references pass the skill validator, a relative
  Markdown-link check, the package dry-run manifest check, and formatting; the
  existing core/server and live interoperability evidence remains unchanged.
- **Verify:**
  `python3 /mnt/c/Users/aidid/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/agentconduit-coordination`,
  a reference-link/package manifest check, and `pnpm format:check`; the root
  type-check, test, build, and pack checks should remain green after skill-only
  edits.

### Outcome 8: Provider-neutral bridge and abandoned-session safety

- **Work:** Add a reusable local bridge/supervisor that connects to the
  AgentConduit MCP tools, registers the exact worktree, maintains heartbeats,
  polls the durable inbox, and exposes durable sends. Keep session tokens in
  memory only; a fresh bridge session must not take over an older registration
  without the prior token. Record only protected, non-secret ownership
  metadata for diagnostics. Support an explicitly owned runtime adapter as an
  optional push hint, while leaving inbox polling and recipient acknowledgement
  authoritative. Stop processing on broker disconnect, token loss, runtime
  death, or uncertain acknowledgement, and add deterministic tests for stale
  presence, graceful unregister, crash-like abandonment, reconnect rules, and
  broker-timeout calibration.
- **Risks/open questions:** Provider-native adapters remain opt-in and
  capability-specific; the bridge must never launch a paid provider process or
  infer liveness from a PID, branch, cwd, or displayed session name. Stale
  broker rows are retained for audit and are not blindly deleted or treated as
  free ownership. A bridge-owned process that continues to heartbeat is online
  by evidence; a chat UI moving to a new conversation cannot by itself signal
  that process abandonment.
- **Evidence:** Source complete; bridge type-check and 3-file / 33-test suite
  pass, including stale-session, broker-timeout calibration,
  startup/runtime-exit cancellation,
  in-flight shutdown-race, ownership-write ordering, callback re-entrancy,
  native-push, and uncertain-acknowledgement regressions; root checks pass.
- **Verify:** `pnpm --filter @agentconduit/bridge type:check`,
  `pnpm --filter @agentconduit/bridge test`, `pnpm type:check`,
  `pnpm test`, `pnpm build`, `pnpm format:check`, and `pnpm pack:check`.

## Final evidence and delivery state

- `pnpm install --frozen-lockfile --prefer-offline` — passed.
- `pnpm type:check` — passed.
- `pnpm build` — passed.
- `pnpm format:check` — passed.
- Core suite — 5 files / 44 tests passed.
- Server suite — 4 files / 16 tests passed.
- Bridge suite — 3 files / 33 tests passed.
- Skill validation — passed with `python3`.
- `pnpm pack:check` — passed for all four publishable artifacts.
- Coordination skill reference-link and package-manifest checks — passed;
  `SKILL.md`, `references/routing.md`, `references/fullrouter.md`, and
  `references/recovery.md` are included in the dry-run manifest.
- Structured MCP output, case-insensitive bearer parsing, and accurate
  read/write tool annotations are covered by server regressions.
- Disposable dual-runtime broker POC — passed on 2026-08-31 with Claude Code
  2.1.250 and Codex CLI 0.146.0; all registration, durable message
  acknowledgement, and lease-contention acceptance flags were true.
- Git checkout — initialized on `main`, with no commit or remote yet. Commit,
  remote configuration, push, and deployment require explicit authorization.
