# AgentConduit single-owner multi-PC Hub

**Goal:** Extend AgentConduit with a self-hosted Hub, authenticated outbound
Nodes, and a live web dashboard so one person can coordinate agents and Git
workspaces safely across several PCs.

**Why planning is required:** This introduces a remote trust boundary, device
credentials, a versioned cross-machine protocol, browser authentication,
persistent schema changes, and safety-sensitive administrative controls.

**Acceptance:** From disposable installations, at least two independently
enrolled Nodes can join clones carrying the same explicit AgentConduit project
identity, expose locally discovered and centrally redacted Git facts, register
independent coding-agent sessions, exchange and acknowledge durable messages,
and contend for one global FIFO integration lease with exactly one winner. A
signed-in owner can observe live/replayable device, agent, workspace, message,
lease, queue, reconciliation, and audit state in a responsive dashboard and can
send an operator message, revoke a device, cancel only an unclaimed integration
request, and open a non-destructive reconciliation case. Disconnect, expiry,
revocation, Hub outage, and uncertain external Git state fail closed. Retained
tests and the full repository verification matrix pass. Source implementation
does not imply commit, publication, installation, deployment, or operator-PC
runtime verification.

### Outcome 1: Remote authority model and durable state

- **Work:** Extend the provider-neutral core with ordered schema evolution and
  durable single-owner device enrollment, hashed revocable device credentials,
  device health/presence, workspace-to-device provenance, operator messages,
  reconciliation cases, and cursor-addressable audit events. Preserve the
  existing coordination store as the one authority for messages, leases, and
  integration queue transitions. Remote workspaces require an explicit
  `.agentconduit/project.json` identity, receive server timestamps, and persist
  only device-scoped redacted paths rather than client absolute paths.
- **Risks/open questions:** An enrolled device is trusted to report the Git
  facts it discovers locally; the Hub cannot independently inspect another
  machine. Device revocation stops new authenticated calls but never silently
  releases existing or uncertain integration authority.
- **Verify:** `pnpm --filter @agentconduit/core test` and
  `pnpm --filter @agentconduit/core type:check`

### Outcome 2: Authenticated Hub protocol and safe controls

- **Work:** Add a separately packaged Hub with protected initialization,
  single-owner bootstrap authentication, short-lived HttpOnly browser sessions
  with origin/CSRF enforcement, one-time expiring device enrollment, a bounded
  versioned Node RPC surface, durable server-sent event replay, readiness,
  structured redacted logs, and graceful drain. Production operation requires
  either direct TLS or a loopback reverse-proxy boundary; development HTTP is
  explicit and loopback-only. Implement only the approved controls: operator
  message send, device revoke, unclaimed-request cancel, and non-destructive
  reconciliation start.
- **Risks/open questions:** V1 has one owner and one Hub process backed by
  SQLite; multi-user tenancy, RBAC, horizontal availability, and an external
  identity provider are not implied. The owner bootstrap token is a protected
  local secret and is exchanged only over the configured HTTPS boundary.
- **Verify:** `pnpm --filter @agentconduit/hub test` and
  `pnpm --filter @agentconduit/hub type:check`

### Outcome 3: Outbound local Node and shared MCP contract

- **Work:** Generalize the existing MCP transport over one coordination-backend
  interface, then add a Node that discovers Git only on its own PC, enforces
  allowed roots, transforms snapshots into device-scoped attestations, and
  proxies all durable coordination operations to the Hub. The Node enrolls once,
  stores credentials privately, serves MCP only on numeric loopback, maintains
  device health and an outbound replayable event stream, and reports Hub
  uncertainty as unavailable rather than granting local merge authority.
- **Risks/open questions:** Provider-native Claude/Codex steering remains an
  optional locally owned wake-up adapter; Hub-to-Node push is a hint and durable
  inbox reads remain authoritative. No Hub or dashboard endpoint may execute Git,
  browse arbitrary paths, or open a remote shell.
- **Verify:** `pnpm --filter @agentconduit/node test`,
  `pnpm --filter @agentconduit/server test`, and their type-checks

### Outcome 4: Live web operations dashboard

- **Work:** Ship the dashboard as Hub-owned static assets with an intentional
  railway-interlocking visual language: device stations, live signal states,
  and integration lanes that encode real coordination state. Provide overview,
  devices, agents/workspaces, integration queue, messages, reconciliation, and
  audit views; accessible forms for approved controls; truthful loading, empty,
  stale, revoked, and error states; responsive keyboard operation; reduced
  motion; and no dependency on third-party CDNs or telemetry.
- **Risks/open questions:** The dashboard deliberately exposes coordination
  metadata and message bodies to the authenticated owner. It never receives
  provider credentials, session tokens, prompts, or raw local filesystem paths.
- **Verify:** Hub UI contract tests, an automated browser-sized static/accessibility
  smoke check where available, and manual screenshot critique against desktop
  and narrow layouts

### Outcome 5: Cross-PC behavior, packaging, and operator guidance

- **Work:** Add a disposable two-Node end-to-end harness proving independent
  clone enrollment, central presence, message acknowledgement, event replay,
  FIFO contention, stale/revoked-device behavior, and safe dashboard controls.
  Package Hub and Node artifacts, update the provider-neutral coordination
  skill for Hub/Node routing and outage behavior, and document deployment,
  TLS, enrollment, backup/restore, upgrades, recovery, privacy, and protected
  branch/remote merge-queue enforcement.
- **Risks/open questions:** Raw Git bypass remains outside advisory leases. A
  remote Git provider merge queue is still required wherever bypass must be
  technically prevented. Public release inputs and real deployment remain
  owner-controlled external actions.
- **Verify:** `pnpm type:check`, `pnpm test`, `pnpm build`, `pnpm ci:check`,
  `pnpm format:check`, `pnpm skill:check`, `pnpm pack:check`, and
  `pnpm audit --audit-level=high`

### Outcome 6: Security and completion review

- **Work:** Reconcile the remote threat model and canonical progress record
  against the final diff, run the explicit high-risk verification gate, review
  the complete implementation for authentication, authorization, privacy,
  replay, stale authority, and package-boundary failures, and resolve every
  supported Critical or Important finding before completion.
- **Verify:** The complete Outcome 5 matrix plus a final review verdict with no
  supported Critical or Important findings

## Authority, recovery, and stop conditions

- The user authorized source implementation of the single-owner, self-hosted,
  multi-PC Hub/Node/dashboard milestone with the four named safe controls. No
  commit, remote configuration, push, publication, service installation,
  deployment, real device enrollment, or mutation of an operator database is
  authorized.
- The current repository has an unborn `main` branch and all completed product
  files are untracked, so a separate Git worktree cannot be created without an
  unauthorized first commit. This dedicated checkout is the implementation
  boundary; preserve every existing file and do not switch branches or clean it.
- Tests use disposable repositories, credentials, ports, and databases. Never
  emit raw owner/device/session tokens, provider credentials, local absolute
  paths, prompts, or customer data into retained fixtures, logs, or snapshots.
- Stop rather than weaken the contract when the Hub cannot prove owner/device
  authentication, production TLS or loopback-proxy placement, database health,
  event replay bounds, local allowed-root containment, or the claimant's fresh
  worktree/ref evidence. Revocation, staleness, elapsed time, and dashboard
  intent alone never release a live or uncertain lease.
