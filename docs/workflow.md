# Coordination workflow

This is the provider-neutral operating recipe for Claude Code, Codex, and any
other MCP client connected to the same AgentConduit broker. The examples show
the logical `tools/call` name and arguments; an MCP host may add its own server
prefix in the UI. Values containing `…` are illustrative placeholders; replace
them with the exact IDs and OIDs returned by the broker or Git.

`agent.register` returns a private `sessionToken`. Include that token in every
subsequent state-changing call for the same agent. Read-only discovery and list
tools generally do not need it; `message.inbox` remains token-gated to protect
recipient data. Never place the token in a message or repository file.

In the multi-PC topology, “broker” below means the one durable Hub reached
through the caller's local Node. Continue to pass the absolute local
`workspacePath` to MCP: the Node discovers it locally and replaces every path
with a device-scoped attestation before HTTPS. The Hub and dashboard must never
receive that absolute path. Hub outage or device revocation stops this workflow;
do not substitute a local broker or cached claim.

## Register the actual worktree

Call `agent.register` before editing or coordinating shared work. Use the
absolute path of the worktree in which the client is running:

```json
{
  "name": "agent.register",
  "arguments": {
    "runtime": "codex",
    "workspacePath": "/worktrees/payments-codex",
    "sessionRef": "codex-session-2026-08-31",
    "displayName": "Codex payments",
    "capabilities": ["messages", "integration"]
  }
}
```

The response contains an opaque `agentId`, a private `sessionToken`, and a
server-discovered Git snapshot:

```json
{
  "agentId": "agt_…",
  "sessionToken": "acs_…",
  "workspace": {
    "repositoryId": "repo_…",
    "worktreeId": "wt_…",
    "branch": "feature/payments",
    "headOid": "…",
    "dirty": false,
    "upstream": {
      "status": "available",
      "ref": "origin/feature/payments",
      "ahead": 1,
      "behind": 0
    }
  }
}
```

When `upstream.status` is `unavailable`, the snapshot makes no synchronized
state claim. The broker omits `ahead` and `behind`; it may still return `ref`
when Git found configured upstream metadata but could not compare it to HEAD.

Keep the `agentId`, private `sessionToken`, and `repositoryId` for this
session. Do not substitute a thread ID, branch name, or guessed path. If the
client exposes a stable non-secret session identifier, reuse it after
reconnecting so registration is idempotent; a reconnect returns a fresh token,
so discard the old one.

Immediately inspect peers and pending handoffs:

```json
{
  "name": "agent.list",
  "arguments": { "repositoryId": "repo_…" }
}
```

When choosing a recipient or deciding whether a worktree is currently occupied,
request the explicit fresh-presence view and still compare the returned
`worktreeId`/resource facts:

```json
{
  "name": "agent.list",
  "arguments": { "repositoryId": "repo_…", "activeOnly": true }
}
```

An omitted or stale row is not proof that its process is gone. Do not delete a
stale registration or release its claim without reconciling the broker and the
real runtime/Git state.

In Hub mode, compare device provenance and the device-scoped `worktreeId` as
well as repository identity. Never match agents across PCs by display name,
branch, or a native client session list.

```json
{
  "name": "message.inbox",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…"
  }
}
```

To persist a workspace independently of an agent session, call
`workspace.register` with its path. Use `workspace.list` to inspect snapshots
already known to the broker:

```json
{
  "name": "workspace.register",
  "arguments": { "workspacePath": "/worktrees/payments-codex" }
}
```

```json
{
  "name": "workspace.list",
  "arguments": { "repositoryId": "repo_…" }
}
```

## Maintain presence

Call `agent.heartbeat` at task boundaries, before and after a long operation,
and periodically while a runtime remains active:

```json
{
  "name": "agent.heartbeat",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "workspacePath": "/worktrees/payments-codex"
  }
}
```

The returned snapshot is fresh Git evidence. A `stale` peer may still be
running or may have stopped without unregistering; presence alone does not
release a lease or make a target safe to mutate.

## Track durable delegated or long-running work

Use a job when work runs outside the current turn, is delegated to another
runtime, must survive reconnects, or needs progress visibility from another PC.
Do not create one for every command or short local step. Creation is retry-safe
when the exact input reuses one stable idempotency key:

```json
{
  "name": "job.create",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "idempotencyKey": "payments-review-17:create",
    "kind": "delegated_review",
    "displayName": "Review payments integration",
    "correlationId": "payments-review-17"
  }
}
```

The broker appends `created` automatically. Only the owner emits subsequent
events. Use one stable key per semantic event and reuse it only for an exact
retry:

```json
{
  "name": "job.emit",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "jobId": "job_…",
    "idempotencyKey": "payments-review-17:started",
    "type": "started",
    "phase": "review",
    "summary": "Review started against the observed source revision."
  }
}
```

Emit `heartbeat` only to record observed liveness; it says nothing about useful
progress. Emit `checkpoint` only with a bounded, meaningful resume summary:

```json
{
  "name": "job.emit",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "jobId": "job_…",
    "idempotencyKey": "payments-review-17:checkpoint:1",
    "type": "checkpoint",
    "phase": "verification",
    "summary": "Focused payment tests passed; cross-service checks remain."
  }
}
```

Never put prompts, credentials, session tokens, raw provider streams, customer
data, private logs, or hidden reasoning in a display name or event field.
Progress fields are one-line operator-safe state, not a peer conversation.

After a push hint, reconnect, bounded wait, suspected lost response, or
handoff, replay from the last global cursor actually processed:

```json
{
  "name": "job.events",
  "arguments": {
    "agentId": "agt_peer…",
    "sessionToken": "acs_peer…",
    "jobId": "job_…",
    "afterCursor": 418,
    "limit": 100
  }
}
```

Authenticated same-repository peers can also call `job.get` and `job.list`.
Only the owner can emit. An empty page or derived `stale` activity does not
prove completion, cancellation, abandonment, or cleanup authority. Send a
durable message when a peer decision or action is required. Emit `completed`,
`failed`, or `cancelled` only when the actual outcome is known; `completed`
produces terminal job status `succeeded`.

## Exchange a durable handoff

Find the recipient's `agentId` from `agent.list`, then send a concise message:

```json
{
  "name": "message.send",
  "arguments": {
    "senderAgentId": "agt_claude…",
    "senderSessionToken": "acs_claude…",
    "recipientAgentId": "agt_codex…",
    "body": "Payments slice is ready for review. Source refs: feature/payments; current HEAD: 0123…; intended target: refs/heads/main. Please enqueue integration after checks.",
    "correlationId": "payments-handoff-17"
  }
}
```

The recipient polls its inbox, processes the message, and acknowledges it:

```json
{
  "name": "message.ack",
  "arguments": {
    "agentId": "agt_codex…",
    "sessionToken": "acs_codex…",
    "messageId": "msg_…"
  }
}
```

Acknowledgement removes the message from the default inbox; it is not a
delivery receipt for any Git operation. The session token authenticates the
sender or recipient even though the HTTP endpoint itself is stateless. A
correlation ID helps humans and clients recognize related messages but is not
broker-side deduplication.

## Reserve an unrelated shared resource

For a shared operation that is not an integration request, acquire a narrow
lease with a stable resource name:

```json
{
  "name": "lease.acquire",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "resource": "review:repo_…:pull:17",
    "ttlSeconds": 300
  }
}
```

Retain the returned `leaseId`, `fencingToken`, and `expiresAt`. Renew before
expiry and release after the operation:

```json
{
  "name": "lease.renew",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "leaseId": "lea_…",
    "ttlSeconds": 300
  }
}
```

```json
{
  "name": "lease.release",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "leaseId": "lea_…"
  }
}
```

Do not use a generic lease as a substitute for the integration queue's
target-ref lease. `integration.claim`, `integration.renew`, completion, and
cancellation own that lease lifecycle.

## Serialize a Git integration

The queue prevents two compliant agents from taking the same target-ref turn.
It does not perform the Git operation or authorize a merge.

### Request a turn

After heartbeat and inbox checks, enqueue source and target refs from the
registered worktree. The broker canonicalizes a mutable target to a fully
qualified direct branch ref, so `main` and `refs/heads/main` use one queue key;
use the fully qualified form in handoff messages for clarity. Revision
expressions and immutable/non-branch targets are rejected:

```json
{
  "name": "integration.enqueue",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "workspacePath": "/worktrees/payments-codex",
    "sourceRef": "refs/heads/feature/payments",
    "targetRef": "refs/heads/main"
  }
}
```

The broker resolves both refs and stores their OIDs. Save the returned
`requestId` and canonical `targetRef`. While waiting, inspect
`integration.get` or `integration.list`; when using `integration.list`'s
optional `targetRef` filter, pass that returned fully qualified value (for
example, `refs/heads/main`). The service canonicalizes simple branch aliases
for this filter too, but the returned direct form avoids ambiguity. Requests
in `queued`, `needs_refresh`, or `claimed` state retain their FIFO position for
the exact repository and canonical target-ref pair.

### Claim only your turn

```json
{
  "name": "integration.claim",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "requestId": "int_…",
    "workspacePath": "/worktrees/payments-codex"
  }
}
```

Claim succeeds only if the request is first in its queue and both the source and
target still have their observed OIDs. It returns `status: "claimed"` and the
expiring lease's `leaseId`, `expiresAt`, and `fencingToken`.
Start no target-ref mutation before this response.

If the authorized operation may outlast the lease, renew it before expiry:

```json
{
  "name": "integration.renew",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "requestId": "int_…",
    "workspacePath": "/worktrees/payments-codex",
    "ttlSeconds": 300
  }
}
```

Only the active claimant can renew the integration lease. Do not call the
generic `lease.renew` tool with an integration lease ID; that tool intentionally
rejects the reserved `git:` namespace. Renewal does not re-resolve Git or
change queue order.

### Perform and record the authorized operation

Immediately re-read the source and target refs and follow the repository's review, test,
merge, rebase, and push policy. AgentConduit does not run those commands. If
either ref moved, the claim fails or the request becomes `needs_refresh`:

```json
{
  "name": "integration.refresh",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "requestId": "int_…",
    "workspacePath": "/worktrees/payments-codex"
  }
}
```

Reconcile source and target before refreshing. Do not blindly retry a merge or
invent a target OID.

For every non-cancelled outcome, report the actual current target OID in
`postTargetOid`—including a `failed` outcome after verifying that no uncertain
Git operation can still move the target. A successful authorized operation can
be recorded as follows:

```json
{
  "name": "integration.complete",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…",
    "requestId": "int_…",
    "workspacePath": "/worktrees/payments-codex",
    "outcome": "merged",
    "postTargetOid": "…",
    "note": "Reviewed and pushed through the repository's protected-branch workflow."
  }
}
```

Use `outcome: "rebased"` or `"squashed"` when that is the actual operation. If
the outcome is uncertain, preserve the claim and escalate rather than inventing
an OID or releasing the queue. A `cancelled` completion may omit
`postTargetOid`; as the requester, use `integration.cancel` with your session
token for a queued or `needs_refresh` request that will not be attempted. Only
the active claimant may cancel a `claimed` request while a Git operation may
still be in flight; the requester cannot revoke another agent's claim.
Completion and cancellation release the integration lease atomically. Do not
release it a second time.

## Cross-runtime handoff example

Claude and Codex do not need a proprietary model-to-model API. They connect as
two MCP clients to the same broker:

```text
Claude: register → create job → emit safe progress → send decision handoff
Codex:  register → inbox/ack → replay job events → enqueue/claim integration
Claude: inbox/ack → inspect result → emit explicit terminal job event
```

The message body is durable until acknowledgement, so a client restart does
not erase a handoff. The job history is durable cursor-based progress, so a
push hint or chat switch does not erase or complete it. Both agents must still
heartbeat and re-read Git state; the broker is a coordination bus, not a
substitute for human or repository policy.

## End or recover a session

At a normal end, send the handoff, process pending inbox messages, emit a
terminal event for each owned job whose outcome is actually known, and call
`agent.unregister` with the current session token:

```json
{
  "name": "agent.unregister",
  "arguments": {
    "agentId": "agt_…",
    "sessionToken": "acs_…"
  }
}
```

A clean unregister returns this agent's claimed integration requests to
`needs_refresh` and releases its leases. It does not alter Git or delete
messages, and it does not infer a job outcome; a later reconnect must use the
prior token once, receive the rotated token, and discard the old value.

For a timeout, restart, lease expiry, target move, or uncertain tool response,
read [`../skills/agentconduit-coordination/references/recovery.md`](../skills/agentconduit-coordination/references/recovery.md)
before retrying. Read broker state and actual Git state first; never repeat a
state-changing Git operation merely because its MCP response was lost.
