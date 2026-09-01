# Security and trust boundaries

AgentConduit V1 supports one owner in either of two production profiles:

- one loopback-only workstation broker for mutually trusted processes under one
  operating-system account; or
- one self-hosted HTTPS Hub with an outbound-authenticated, loopback-only Node
  on each trusted owner PC.

Neither profile is a sandbox against malicious code already running as the
trusted OS user. The multi-PC profile is not a multiple-user, team, tenant,
public control-plane, or horizontally replicated service.

## Workstation profile

- Production accepts only numeric loopback addresses and requires a protected
  bearer-token file plus at least one canonical, non-root allowed Git directory.
- `/mcp` always requires the process bearer. `/livez`, `/readyz`, and the
  compatibility `/healthz` expose fixed metadata; readiness also checks schema
  and database integrity.
- Streamable HTTP uses the bearer at the process boundary. Agent-scoped calls
  additionally use the private session token returned by `agent.register`.
- Stdio has no HTTP bearer boundary and relies on the OS process identity and
  protected access to the same SQLite database.
- Production configuration, token, database directories, files, sidecars, and
  backups must be owner-private on POSIX.

Do not proxy, port-forward, or otherwise expose the workstation listener. A
bearer token does not turn that path-discovering local broker into a safe remote
service.

## Multi-PC Hub and Node profile

```text
local MCP client -- local bearer --> numeric-loopback Node
                                       |
                                       | device bearer over HTTPS
                                       v
browser -- owner session/CSRF --> Hub + SQLite
```

- The Hub uses either direct TLS or numeric loopback behind an HTTPS reverse
  proxy. Its configured `publicBaseUrl` is an HTTPS origin and is the exact
  browser host/origin boundary. Plain remote HTTP is rejected.
- Loopback-proxy mode accepts one overwritten `X-Forwarded-For` client address
  only from the numeric-loopback proxy peer. Direct-TLS mode ignores forwarding
  headers. Login and enrollment attempt windows are isolated by that validated
  address and retained in a bounded TTL/LRU map.
- A random owner token stays in a protected Hub file. Browser login compares it
  without persisting it in the database, then issues a short-lived `Secure`,
  `HttpOnly`, same-site session. Browser mutations require exact origin and a
  session-bound CSRF token. Owner bearer automation is bounded to the same
  explicit admin routes.
- One-time device enrollment codes expire after ten minutes and are stored only
  as hashes. A successful enrollment returns one random device credential;
  SQLite retains only its hash. Revocation rejects new calls immediately.
- Every Node uses a distinct device credential for outbound Hub RPC and a
  separate random local bearer for its numeric-loopback MCP listener. Neither
  credential replaces an agent's session token.
- A Node performs canonical allowed-root and Git discovery locally, then
  transforms the snapshot before network I/O. The Hub receives a configured
  path label and device-scoped `device://` identifiers, never an absolute local
  path or Git directory.
- Multi-PC workspaces require `.agentconduit/project.json`. The Node refuses to
  attest a repository without it. Matching remote URLs alone do not join clones.
- The Hub never initiates a connection to a Node and exposes no remote shell,
  remote Git, arbitrary filesystem, force-release, or force-complete operation.
- Server-sent events contain audit envelopes and act only as wake-up hints.
  Nodes resume from protected cursors and read durable state before acting or
  acknowledging anything. Replay has hard event/byte limits, waits for network
  backpressure, and emits a reset-to-snapshot/latest-cursor envelope rather
  than queueing an unbounded history.
- Node list/inbox operations and dashboard snapshots use server-controlled
  cursor pages with hard record and serialized-byte budgets. Nodes and the
  dashboard drain those pages before presenting the current durable view.

An enrolled device is a trusted owner PC: it may register its own agents and
read owner-wide routing state through the Node protocol. V1 does not isolate one
enrolled PC from another as separate users or tenants.

## Session and authority controls

The workstation or Node-local process bearer authenticates access to MCP, not a
particular human or pre-existing runtime. `agent.register` returns an opaque
per-agent `sessionToken`; agent-scoped mutations and `message.inbox` require the
matching token. SQLite stores only its hash, and list/inspection calls never
return it.

Reconnecting the same runtime, stable `sessionRef`, and worktree requires the
prior session token. A successful reconnect rotates the token and immediately
invalidates the old one. Heartbeats remain bound to the exact registered
worktree. A client with only the process bearer can register a new agent but
cannot take over an existing protected session.

The optional bridge keeps its session token in memory and writes only a
token-free ownership marker. A marker, PID, window, branch, cwd, native-agent
listing, or chat state is diagnostic evidence only. It cannot reclaim a session
or release authority. Databases upgraded from a pre-token schema may contain an
unrecoverable row with no token hash; use a new session identity rather than
silently taking it over.

Hub outage, device revocation, stale presence, lease expiry, and an abandoned
chat never prove that an external Git operation stopped. They grant no fallback
authority. Preserve uncertain claims and reconcile durable Hub state with the
real process and Git/provider evidence.

## Allowed roots and Git boundary

The workstation broker and each Node canonicalize `workspacePath`, enforce
realpath containment under explicit non-root roots, and use fixed Git argument
lists. Nodes never accept a Hub-supplied path. Keep each allowed root narrow and
trusted, and keep databases, token files, and private configuration outside
enrolled repositories and sync folders.

Leases and integration queues govern compliant MCP clients only. They cannot
block a terminal, IDE, hook, raw Git command, or another broker from mutating a
ref. Protected branches, required review, or an authoritative remote merge
queue are still required where bypass must technically fail.

## Explicit project identity is not authentication

Local repository identity normally includes the canonical Git common-directory
path, so independent clones remain separate. Multi-PC clones join a namespace
only by carrying the same explicit `.agentconduit/project.json` `projectId`.
That value is non-secret and anyone who learns it can construct the same hash;
it grants no Hub access by itself. Hub access comes from device enrollment,
while per-agent actions remain session-token-bound.

The namespace is also not an authoritative remote-ref lock. Each Node sees Git
facts only in its local clone. Safe cross-clone integration still needs one
authoritative clone or a repository-approved provider merge queue immediately
before mutation.

## Stored data and privacy

The workstation database contains absolute paths plus normalized Git and
coordination metadata. The Hub database instead contains device-scoped path
labels/URIs, device health and provenance, normalized Git metadata, agent and
message state, leases, integration results, reconciliation cases, and cursor-
addressed audit history. Both store plaintext message bodies and result notes.
Backups contain the same data.

Raw registration `sessionRef` values are SHA-256-derived into session keys.
Owner, device, process, and agent token plaintext is not stored in SQLite. A
normalized Git remote removes common user-info, query, and fragment material,
but secret-bearing remote URLs remain unsupported. Never send credentials,
private prompts, customer data, raw logs, or production records in messages,
path labels, reconciliation reasons, or result notes.

The authenticated dashboard intentionally shows coordination metadata and
message bodies to the owner. It uses safe text insertion, local static assets,
no third-party CDN, and no telemetry. Protect browser sessions, screenshots,
logs, backups, and exported diagnostics as owner operational data.

The workstation maintenance command supports preview-first retention. The Hub
V1 operator surface preserves its durable audit and unresolved coordination
state; backup/restore and schema migration are explicit. Neither profile prunes
unacknowledged messages or resolves uncertain authority merely because it is
old.

## Credential lifecycle

- `agentconduit-mcp init` creates the workstation bearer. Rotating it requires
  restarting the broker and its HTTP clients; V1 has no overlap window.
- `agentconduit-hub init` creates the owner token. Treat replacement as an
  incident procedure that invalidates browser and automation access; no casual
  dashboard rotation control exists.
- `agentconduit-hub enroll-device` prints a one-time code only to its explicit
  output. Transfer it through an encrypted owner-approved channel and retire
  both protected copies after successful Node `doctor`.
- Device revocation is immediate for new calls and irreversible for that device
  identity. It deliberately does not release leases or claims. Re-enrollment
  creates a new identity and requires reconciliation of the old one.
- Each Node's device token and local MCP bearer stay in separate protected
  files. Never clone a Node configuration between PCs.
- Each agent session token stays in protected runtime state and is passed only
  in its documented field. Reconnection rotates it; discard the old value.

Native Windows ACL equivalence is not yet implemented or verified. POSIX
ownership/mode checks are enforced; WSL production state should remain on its
Linux filesystem. Windows-native production remains an explicit limitation
until owner/private ACL enforcement has retained native evidence.

## Expansion gate

The supported cross-machine product is one owner with trusted PCs. Supporting
multiple people, teams, tenants, an untrusted shared Hub, or a managed service
would additionally require user identity, RBAC, tenant-bound project
enrollment, per-principal quotas, credential rotation/recovery, stronger device
attestation, tenant-isolated audit/retention and backups, abuse controls,
horizontal persistence/availability design, and a separate threat-model review.
Do not infer those properties from the single-owner Hub.
