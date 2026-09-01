# Durable job-event protocol

**Goal:** Add a provider-neutral, durable job and progress-event protocol that
lets AgentConduit clients report, replay, and observe live work without treating
an abandoned session as indefinitely active.

**Why planning is required:** This changes the public MCP and Node/Hub
contracts, introduces a persistent schema migration, crosses local and remote
runtime boundaries, and handles potentially sensitive provider activity. The
protocol must remain replayable and useful without retaining prompts,
credentials, raw provider streams, or hidden reasoning.

**Acceptance:** A registered agent can idempotently create a job bound to its
server-observed repository and worktree, append bounded normalized events under
a validated lifecycle state machine, and read jobs or events through a stable
cursor. Events receive both a per-job sequence and the existing durable global
audit cursor. Non-terminal jobs derive `active` or `stale` from recent observed
activity and never auto-complete merely because a client disappeared. Local
MCP, the multi-PC Node/Hub protocol, Hub snapshots/SSE, and the authenticated
dashboard expose the same state. The native Claude collaborator POC translates
its bounded stream into the normalized event vocabulary and lets its Codex
subagent read progress without exposing the raw provider stream. Migration,
authorization, idempotency, concurrency, retention, pagination, redaction, and
UI contracts have retained automated coverage.

### Outcome 1: Provider-neutral durable job state

- **Work:** Extend `@agentconduit/core` with typed job, activity, and event
  records; a schema-v4 migration for jobs and ordered events; idempotent create
  and append operations; lifecycle transition validation; same-repository read
  authorization; global and per-job cursor ordering; derived stale activity;
  and terminal-job retention. Reuse the existing audit cursor and immediate
  transaction abstraction rather than adding a second wake-up sequence.
- **Risks/open questions:** A heartbeat proves only recent liveness, not useful
  progress. Stale jobs remain inspectable and recoverable; the store must not
  infer completion, cancellation, or safe cleanup from timeout alone. Event
  summaries are bounded operator-facing text and must never be populated from
  raw prompts, provider streams, credentials, or reasoning.
- **Verify:** `pnpm --filter @agentconduit/core test`

### Outcome 2: Local and multi-PC transport parity

- **Work:** Add thin MCP tools for create, emit, get, list, and event replay;
  extend the Node RPC types, validators, backend, Hub routing, snapshot
  pagination, and SSE wake-up path; and render job liveness and recent safe
  progress in the authenticated Hub dashboard. Keep the Hub audit stream as the
  push hint while cursor-based job reads remain authoritative.
- **Risks/open questions:** Remote payloads must not contain absolute local
  paths or session tokens. Snapshot and event pages must stay within existing
  record and byte budgets, and a fast producer must not make replay unbounded.
- **Verify:** `pnpm --filter @agentconduit/server test && pnpm --filter @agentconduit/hub test && pnpm --filter @agentconduit/node test`

### Outcome 3: Native Claude progress projection and client guidance

- **Work:** Extend the disposable native collaborator runtime with a bounded
  cursor-based progress read backed by normalized lifecycle events, update its
  custom-agent instructions to relay concise phase changes, and retain fake
  provider tests for ordering, redaction, waiting, terminal, and cancellation
  behavior. Update the shared coordination skill and runtime documentation with
  when to create a job, what constitutes heartbeat versus checkpoint, how to
  recover stale work, and which content must never enter event summaries.
- **Risks/open questions:** Codex officially exposes subagent-thread activity,
  but the MCP documentation does not guarantee host rendering of arbitrary MCP
  progress notifications. The authoritative path is therefore explicit
  cursor-based reads; native rendering remains a version-sensitive projection.
- **Verify:** `node --test poc/native-claude-collaborator-probe.test.mjs && pnpm skill:check`

### Outcome 4: Reconciled verification and completion review

- **Work:** Reconcile the canonical progress ledger from the final diff, run
  the complete affected repository matrix and package gates, inspect migration
  and dashboard behavior against the accepted contract, and resolve every
  supported Critical or Important review finding before completion.
- **Verify:** `pnpm type:check`, `pnpm test`, `pnpm build`, `pnpm ci:check`,
  `pnpm format:check`, `pnpm skill:check`, `pnpm pack:check`, and
  `pnpm audit --audit-level=high`

## Authority, recovery, and stop conditions

- The user authorized implementation and local verification of this protocol.
  No commit, push, publication, installation, personal agent configuration,
  provider-quota run, or operator deployment is authorized.
- This checkout has an unborn `main` and every project file is untracked. Git
  cannot create an isolated worktree without an unauthorized initial commit, so
  the existing dedicated checkout remains the bounded implementation path.
  Preserve every existing file and do not switch branches or clean the tree.
- Schema migration remains explicit in production and must retain the existing
  verified backup-before-migrate behavior. Stop if the live checkout identity
  changes, unrelated files appear, an existing schema cannot be upgraded
  additively, or correctness would require storing provider secrets or raw
  streams.
- Completion means source, retained tests, package checks, ledger reconciliation,
  and independent review are complete. It does not mean committed, published,
  deployed, installed, or operator-runtime verified.
