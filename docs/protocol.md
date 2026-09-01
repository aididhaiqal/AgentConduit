# AgentConduit v1 protocol

AgentConduit v1 is a provider-neutral MCP tool protocol over Streamable HTTP or
stdio. It is served either by the local workstation broker or by a loopback
Node that proxies durable operations to the single-owner Hub. Correctness relies
on durable polling and SQLite state; it does not require client-specific agent
APIs, push notifications, or shared chat history.
Agent-scoped state-changing operations use a per-agent session token returned by
`agent.register`. `workspace.register` is the deliberate pre-session exception:
it persists a server-discovered workspace snapshot and therefore has no
agent-session token field.

## Scope and guarantees

The active coordination store is authoritative for its own agent
registrations, messages, jobs and normalized progress events, leases, queue
order, and integration state
transitions. In the workstation profile, the broker independently resolves Git
facts from the supplied workspace path. In the multi-PC profile, the local Node
does that discovery under its allowed roots, strips absolute paths, and sends a
device-authenticated attestation to the Hub. The Hub records device provenance;
it does not claim to have inspected another PC directly.

The broker is not a Git proxy. It cannot stop a process from running raw Git,
does not perform a merge or push, and does not prove that a successful target
OID contains the requested source. Repositories that require enforcement still
need protected branches, required review, or a remote merge queue.

### Multi-PC authority boundary

Each MCP client connects only to its own PC's numeric-loopback Node. The Node
uses a separate revocable device credential over HTTPS to one Hub. Remote
workspace registration requires an explicit `.agentconduit/project.json`; the
Hub receives only device-scoped `device://` identifiers and an owner-configured
path label. Matching remote URLs alone never join independent clones.

Hub outage or device rejection returns unavailable/fail-closed results and
grants no local fallback lease. Server-sent events wake the Node to perform
durable reads; an event alone never acknowledges a message, proves job
progress, or authorizes a transition. The Node accepts no Hub-initiated shell,
Git, or filesystem action.

## Tool surface

| Area           | Tools                                                                                                                                                                       | Contract                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Service        | `server.info`                                                                                                                                                               | Protocol version, guarantees, explicit limitations, and the broker heartbeat freshness threshold.                                               |
| Git discovery  | `workspace.discover`, `workspace.register`, `workspace.list`                                                                                                                | Discover, persist, and list server-observed repository/worktree snapshots.                                                                      |
| Presence       | `agent.register`, `agent.heartbeat`, `agent.unregister`, `agent.list`                                                                                                       | Binds an agent session to a discovered worktree and exposes current or stale presence; `agent.list` can explicitly filter to fresh online rows. |
| Messaging      | `message.send`, `message.inbox`, `message.ack`                                                                                                                              | Durable targeted messages within one local repository scope. Polling is the portable delivery mechanism.                                        |
| Jobs           | `job.create`, `job.emit`, `job.get`, `job.list`, `job.events`                                                                                                               | Retry-safe jobs with normalized bounded progress, explicit terminal outcomes, and cursor replay.                                                |
| Generic leases | `lease.acquire`, `lease.renew`, `lease.release`                                                                                                                             | Exclusive expiring leases with monotonically increasing fencing tokens per resource.                                                            |
| Integration    | `integration.enqueue`, `integration.claim`, `integration.renew`, `integration.refresh`, `integration.complete`, `integration.cancel`, `integration.get`, `integration.list` | A FIFO queue and target-ref lease with source- and target-OID revalidation.                                                                     |

MCP hosts may display names such as `mcp__agentconduit__agent.register`; the
logical tool name remains the dotted suffix. `workspace.discover`,
`workspace.list`, `agent.list`, `integration.get`, `integration.list`, and
`server.info` are token-free inspection calls. The `heartbeatTimeoutMs` value
from `server.info` is the broker's authoritative presence freshness threshold;
a bridge that supports server calibration caps its local active view at this
value. `integration.get` and
`integration.list` may lazily recover expired claims, so they can write
integration, lease, and audit state even though callers do not need a session
token; MCP advertises them as not read-only for that reason.
`workspace.register` is also callable before an agent exists and does not
require a session token. `agent.list` accepts `activeOnly: true` when a caller
needs a routing view containing only rows whose server-computed status is
`online`; the default view retains `stale` rows so an operator can see that
ownership is unresolved. Every other agent-scoped operation carries the token
field shown by its tool schema; `message.inbox` is read-only in storage terms
but remains token-gated so only the addressed agent can read its messages.
All job tools are token-gated: only the owner may emit, while authenticated
agents in the same repository scope may read the job and its events.

## Git and agent identity

`workspace.discover` records the canonical worktree root, Git common directory,
per-worktree Git directory, normalized `origin`, branch or detached state, HEAD
OID, dirty state, and explicit upstream evidence. `upstream.status` is
`available` only when Git resolves the configured upstream and completes the
comparison; that state includes `ref`, `ahead`, and `behind`. `unavailable`
makes no synchronization claim. It has no `ref` when no upstream resolves and
may retain `ref` when configuration exists but the comparison failed. Never
interpret unavailable evidence as zero ahead and zero behind.

By default, `repositoryId` hashes both the normalized remote value (when
present) and the canonical Git common-directory path. A repository owner can
opt into a shared namespace by placing a JSON file with a validated `projectId`
at `.agentconduit/project.json`; when present, that project identity replaces
the local-path component. Therefore:

- linked worktrees in one clone share a repository ID;
- separate worktrees retain distinct worktree IDs;
- independent clones do not coordinate merely because their remote URLs match;
- independent clones with the same intentionally shared `projectId` do share a
  repository scope;
- a repository without an `origin` still receives a stable ID for that clone.

`projectId` is an explicit enrollment choice, not authentication. Keep the
file free of secrets and use the same value only for clones that should be able
to exchange messages and integration requests.

`agent.register` is idempotent for the same runtime, `sessionRef`, and
worktree. The raw `sessionRef` is not persisted; the store keeps a SHA-256
derived session key. An initial registration returns an opaque `sessionToken`.
To reconnect an existing session, the caller must supply its previous token in
the `sessionToken` field; a successful reconnect returns the same agent ID,
rotates the stored token hash, and immediately invalidates the old token. A
missing or mismatched token cannot take over an existing session. The current
token is required on subsequent agent-scoped calls and is never returned by
list/inspection tools. If `sessionRef` is omitted, registration creates a new
opaque session identity on each call.

An authenticated heartbeat must use the exact worktree that was registered.
Changing to a linked or other worktree requires a new registration; the broker
never silently rebinds an existing session to a different worktree.

If a supported v0 database upgrade leaves an existing row without a
`session_secret_hash`, that session is not resumable because ownership cannot
be established. The broker returns `forbidden`; explicitly re-enroll with a
new `sessionRef` instead of retrying the old tuple.

The current presence threshold is 90 seconds. Active registrations older than
that are `stale`; an explicit unregister removes them from `agent.list`.
Presence is advisory and does not release a lease.

## Messages

Messages are targeted to one registered agent, limited to agents currently in
the same repository scope, and limited to 32 KiB. The body is stored in
plaintext until the database is retired. `message.inbox` omits acknowledged
messages by default; it requires the recipient's valid session token even
though it does not mutate the database. Acknowledgement is durable and also
requires that token. `message.send` requires the sender's token. For HTTP,
the broker bearer token (when configured) authenticates the broker process at
the transport boundary; it is separate from the per-agent session token.

`correlationId` is optional application metadata. It helps recipients recognize
related or harmlessly duplicated sends, but the broker does not deduplicate on
it.

## Jobs and progress events

Create a job for delegated, externally running, resumable, or genuinely
long-running work—not for every command or routine step. `job.create` binds the
record to the authenticated owner's server-observed repository and worktree.
Its caller-issued `idempotencyKey` makes an uncertain creation retry-safe when
the exact input is reused; a different input under the same owner/key is a
conflict. Creation also appends the immutable first `created` event.

Only the owner can call `job.emit`. An authenticated peer in the same
repository can call `job.get`, `job.list`, or `job.events`, but it cannot alter
the history. Each event has a globally ordered audit `cursor` and a per-job
`sequence`; sequence 1 is `created`. A client reads `job.events` with the last
global cursor it processed and advances only through records actually
returned. Event append is retry-safe per job and `idempotencyKey` when every
field is identical.

```text
create                         -> queued
started | provider_ready |
working | checkpoint |
operation_started/finished    -> running
heartbeat                     -> unchanged status
waiting_for_input             -> waiting
completed                     -> succeeded
failed                        -> failed
cancelled                     -> cancelled
```

`succeeded`, `failed`, and `cancelled` are terminal. No later event is
accepted. `heartbeat` means only that the owner recently observed liveness; it
does not claim useful progress. `checkpoint` requires a meaningful bounded
summary. `active`, `stale`, and `terminal` are derived activity labels:
`stale` means no recent activity was observed, never that the job completed,
was cancelled, was abandoned, or is safe to replace or clean up. A timeout or
empty event page creates no event and no state transition.

`displayName`, `phase`, `summary`, and `operation` are bounded single-line
operator-facing fields. They must not contain prompts, credentials, session
tokens, raw provider streams, customer data, private logs, or hidden reasoning.
Messages remain the durable primitive for peer decisions, action requests,
blockers, and handoffs; job events are progress state and should not become
conversational chatter.

Maintenance retains every non-terminal job, including stale jobs. It may
delete only terminal jobs older than an explicit job completion cutoff; event
rows cascade with that terminal job. Retention never infers a missing terminal
outcome.

## Leases

A resource has at most one live lease. MCP calls default to a 300-second TTL
and accept at most 900 seconds. Reacquiring the same resource as its current
holder renews the existing lease; a new lease receives the next fencing token
for that resource.

Lease expiry removes broker authority but cannot undo or classify an external
operation. A heartbeat does not renew a lease. Callers must retain `leaseId`,
renew before `expiresAt`, and stop starting new shared mutations after expiry.
Use `lease.renew`/`lease.release` only for generic leases; integration claims
must use `integration.renew` and are released by integration completion or
cancellation.

## Integration state machine

```text
enqueue
  |
  v
queued ---------> claimed ---------> completed
  |                 |  \------------> failed
  |                 |  \------------> cancelled
  |                 |
  | target moved    | lease expiry or unregister
  v                 v
needs_refresh ------+
  |
  | refresh
  v
queued

queued or needs_refresh ------------> cancelled
```

An enqueue resolves both source and target refs to commit OIDs in the supplied
workspace. The broker canonicalizes a mutable target to a fully qualified
symbolic ref, so aliases such as `main` and `refs/heads/main` share one queue
and lease. Revision expressions, immutable OIDs, and non-mutable targets are
rejected. Queue order is per repository ID and canonical target-ref string. An
earlier request in `queued`, `needs_refresh`, or `claimed` state blocks later
claims for that target key.

Claim succeeds only when the request is `queued`, no earlier request blocks it,
and both source and target still resolve to the OIDs observed at enqueue time.
Either a source or target mismatch first persists `needs_refresh`, then returns
a conflict. Refresh re-resolves both refs and returns the request to `queued`;
only its requester or current claimant can refresh it.

Completion requires the claimant's unexpired lease. A claimant must use
`integration.renew` (not the generic lease tools) before the target-ref lease
expires; the response includes the current lease expiry and fencing token.
Renewal is claimant-only and does not re-resolve or mutate Git. For every outcome other
than `cancelled`—including `failed`—the caller must provide a `postTargetOid`
equal to the target ref's current broker-visible OID. Before recording a
`failed` outcome, verify that the target is not moving or that the authorized
operation is definitely stopped; report the verified current OID. If the Git
outcome is uncertain, preserve the claim and escalate for reconciliation
instead of releasing the queue. A `cancelled` completion may omit
`postTargetOid`; the dedicated `integration.cancel` transition also records
cancellation and releases the lease according to requester/claimant ownership.
Only the active claimant can cancel a `claimed` request; its requester can
cancel a `queued` or `needs_refresh` request. The broker currently validates the
reported current OID, not ancestry, fast-forward behavior, review, or remote
deployment state.

## Error model

Tool failures return a structured code and message:

- `invalid_input`: payload, path, ref, TTL, or OID validation failed;
- `not_found`: the current agent cannot see the requested active record;
- `conflict`: a lease, FIFO position, state, or observed source/target prevents
  the requested transition;
- `forbidden`: repository scope or record ownership does not match;
- `expired`: a required lease is no longer live;
- `git_error`: Git discovery or ref resolution failed;
- `storage_error`: an unexpected broker or SQLite operation failed.

A Node reports an unreachable Hub as `storage_error` with safe details such as
`reason: "hub_unavailable"` and `coordinated: false`. Treat that as proof that
the attempted call granted no new authority, not as proof that previously
durable authority disappeared. After an authentication rejection or device
revocation, stop Node-backed coordination and involve the owner.

After an uncertain state-changing call, read the affected resource before any
retry. See the shared skill's
[`recovery.md`](../skills/agentconduit-coordination/references/recovery.md).

For end-to-end call examples, including the canonical target-ref filter used by
`integration.list`, see [`workflow.md`](workflow.md).

## Transport behavior

The HTTP endpoint is stateless per MCP request. Every agent-scoped
state-changing tool takes an explicit `agentId` and matching `sessionToken`;
there is no connection-bound agent identity in v1. `message.inbox` also takes
the token to protect recipient data, while initial `agent.register` and
`workspace.register` are the only session-token-free write paths. The HTTP
`Authorization: Bearer` value, when configured, authenticates access to the
broker process and does not replace the per-agent token. Stdio has no HTTP
bearer layer; its boundary is the operating-system process identity and
permissions on the shared SQLite database. Notifications are not required for
correctness. Clients should register once, keep both credentials private,
heartbeat while active, and poll inbox and queue state at task boundaries.

The Hub's Node protocol returns `workspace.list`, `agent.list`,
`message.inbox`, `job.list`, `job.events`, and `integration.list` as
`{ items, nextCursor? }` pages. The Hub fixes both the record count and
serialized response-byte budget; callers continue with the opaque cursor until
it is absent. The packaged Node drains collection pages behind ordinary MCP
tools. For `job.events` it stops at the caller's requested limit and never
chases a fast producer without a bound. The local MCP contract exposes the
durable numeric global event cursor as `afterCursor`; the Node translates that
start position into bounded Hub pages. Owner dashboard snapshots use the same
bounded cursor principle and include safe job summaries.

Job audit events wake Hub SSE consumers and carry only normalized safe
phase/summary/operation metadata. SSE remains a hint: after a hint, reconnect,
bounded wait, or uncertain response, clients reconstruct progress with
`job.get` and `job.events` from their last cursor.

Independent clones enrolled with the same `projectId` share one active-store
namespace, but each integration operation still resolves refs in the local
workspace supplied to that caller's broker or Node. In Hub mode the stored
workspace is a device-provenanced attestation, not a Hub-side path. The
namespace is not an authoritative remote-ref lock; safe cross-clone integration
requires a shared authoritative clone or a repository-approved remote
synchronization/merge queue immediately before the mutation.
