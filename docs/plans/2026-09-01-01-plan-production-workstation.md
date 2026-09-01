# AgentConduit production workstation hardening

**Goal:** Turn the proven local v1 into a production-grade workstation daemon
that safely coordinates local coding-agent runtimes and Git worktrees for one
developer trust domain.

**Why planning is required:** This changes security defaults, operational
behavior, persistent-state maintenance, and the published runtime contract.

**Acceptance:** From a clean installation, an operator can initialize and
validate a production configuration, run an authenticated loopback-only broker
against explicitly allowed Git roots, observe liveness/readiness and structured
redacted request logs, restart it without losing coordination state, create and
verify a consistent database backup, and preview/apply bounded retention and
stale-session reconciliation without releasing live or uncertain coordination
authority. Retained tests, package checks, a repository security scan, and an
independent final review pass. Source implementation does not imply commit,
publication, deployment, or runtime verification on an operator machine.

### Outcome 1: Fail-closed production configuration and lifecycle

- **Work:** Add a versioned production configuration and operator CLI around
  the existing server. Production startup requires an absolute database path,
  a protected bearer-token file, at least one canonical allowed Git root, and
  a loopback bind. Add initialization and doctor flows, POSIX permission checks
  where the platform exposes them, explicit development/stdio compatibility,
  and deterministic configuration errors that never echo credentials.
- **Risks/open questions:** The accepted boundary is one workstation and one
  operating-system user trust domain. A central multi-machine coordinator needs
  a separate authenticated workspace-agent protocol and remains outside this
  milestone under AC-OB-002. License selection, repository metadata, commit,
  publication, and deployment remain external delivery decisions.
- **Verify:** `pnpm --filter @agentconduit/server test` and
  `pnpm --filter @agentconduit/server type:check`

### Outcome 2: Bounded and observable HTTP operation

- **Work:** Add server-generated request IDs, structured secret-safe logs,
  liveness and dependency-aware readiness endpoints, security headers,
  authenticated MCP rate/concurrency limits, bounded socket timeouts, and
  graceful drain on termination. Keep the MCP transport stateless and preserve
  durable inbox polling as the correctness path. Reject unsafe remote exposure
  instead of implying that a local bearer token is remote authentication.
- **Risks/open questions:** These controls protect a single local daemon from
  faulty or noisy clients; they are not multi-tenant quotas, TLS, OIDC, or HA.
- **Verify:** `pnpm --filter @agentconduit/server test` and a packaged
  process-level shutdown/readiness smoke test retained in the server suite.

### Outcome 3: Recoverable persistence and safe maintenance

- **Work:** Add database integrity/foreign-key health checks, verified online
  backup to a new destination, production migration preflight, and an operator
  maintenance plan/apply workflow. Reconcile only sufficiently old stale agents
  that hold no live lease or claimed integration; report live/uncertain blockers
  without force-releasing them. Prune only explicitly bounded acknowledged or
  terminal history, retain unacknowledged messages and unresolved requests, and
  make dry-run the default.
- **Risks/open questions:** SQLite remains the supported single-process,
  single-host store. Horizontal scaling, PostgreSQL, encryption-at-rest key
  management, and automated destructive restore are outside this workstation
  topology. Restore stays an explicit stop/verify/quarantine/operator procedure.
- **Verify:** `pnpm --filter @agentconduit/core test` plus server CLI tests for
  doctor, backup verification, dry-run parity, and blocked reconciliation.

### Outcome 4: Reproducible product packaging and operations

- **Work:** Add CI for the supported Node/pnpm toolchain, a repository-native
  coordination-skill validator, production configuration and service examples,
  threat/operations/backup/upgrade documentation, and clean-package smoke
  checks. Update the shared skill and distribution docs only where the new
  production contract changes operator or agent behavior.
- **Risks/open questions:** A public release still needs an owner-selected
  license, canonical repository metadata, package-scope ownership, signing or
  provenance configuration, and explicit publish authorization.
- **Verify:** `pnpm type:check`, `pnpm test`, `pnpm build`, `pnpm ci:check`,
  `pnpm format:check`, `pnpm skill:check`, `pnpm pack:check`, and
  `pnpm audit --audit-level=high`

### Outcome 5: Security and completion gate

- **Work:** Review the complete production-hardening range against the local
  threat model, run a repository security scan, resolve supported blocking
  findings, and obtain an independent final review. Reconcile the canonical
  progress record from fresh evidence and keep implemented, tested, packed,
  committed, published, deployed, and runtime-verified states distinct.
- **Verify:** The complete verification matrix in Outcome 4, the security scan
  report, and an independent review verdict with no supported Critical or
  Important findings.

## Authority, recovery, and stop conditions

- The user authorized source implementation of the production workstation
  milestone. No commit, remote configuration, push, package publication,
  service installation, deployment, or mutation of an existing operator
  database is authorized by this plan.
- Tests and smoke checks use disposable temporary directories and databases.
  Backup tests never overwrite an existing destination. Restore documentation
  requires the daemon to stop, a verified backup, and quarantine of the old
  database before any replacement.
- Stop rather than weaken the contract if production startup cannot prove its
  configuration, filesystem boundary, credential protection, database health,
  or allowed-root containment. Maintenance stops on live/uncertain leases and
  claimed integrations; age alone never authorizes takeover or release.
