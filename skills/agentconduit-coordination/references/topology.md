# Local broker and multi-PC Hub/Node routing

Read this reference only when selecting, operating, or recovering the
AgentConduit deployment topology. The MCP tool contract is the same in both
modes; the location of Git discovery and durable authority is different.

## Local workstation

Every client connects to one authenticated loopback broker and shares its
SQLite database. The broker discovers every allowed worktree on that machine.
Separate stdio processes coordinate only when they use the same explicit
database, so the long-lived HTTP broker is the clearer default.

## Single-owner multi-PC

```text
agent runtime ─ MCP ─ local loopback Node ─ authenticated HTTPS ─ owner Hub
                         │ local Git discovery                 │ SQLite authority
                         └─ redacted attestation               └─ dashboard + SSE
```

- Connect each MCP client only to the Node on its own PC. The Node accepts an
  absolute local workspace path, enforces configured allowed roots, resolves
  refs locally, and removes absolute paths before network transmission.
- The Hub is the one authority for agents, messages, jobs, normalized job
  events, leases, integration FIFO, reconciliation, and audit state. It does
  not expose an MCP Git executor, remote shell, filesystem browser, or
  force-release control.
- Every independent clone that should share one repository scope must carry
  the same owner-approved `.agentconduit/project.json` `projectId`. The Node
  rejects remote registration without it. A matching remote URL is neither an
  enrollment nor a lock.
- Device credentials authenticate Nodes, while agent session tokens authorize
  agent-scoped calls. Keep both protected and never put either in a message,
  repository file, prompt, log, dashboard field, or native push payload.
- The owner dashboard observes the Hub and offers only bounded administrative
  actions. It is not an agent identity, peer mailbox, or proof that Git changed.

## Availability and push

Durable Hub state is the correctness path. SSE and host-native push can shorten
the time until a Node or owned runtime checks its inbox or replays job events;
delivery, processing, acknowledgement, and progress reconstruction still happen
through MCP reads and writes. The dashboard can show safe job state, but it is
not an event producer and cannot infer a terminal outcome.

Do not fail over to a local broker, cached lease, or alternate Hub when the
configured Hub is unavailable. Such a fallback creates split-brain authority.
The Node must return an unavailable/fail-closed result. After connectivity is
restored, heartbeat/register as appropriate, read the inbox, replay relevant
jobs from their last cursors, inspect integration/lease records, and compare
them with real local Git before acting.

## Liveness across chats and devices

A chat switch is not a runtime-exit signal. A process that still heartbeats is
online even if its previous conversation is no longer visible. Conversely, a
stale agent or device may still have external work in flight. Start a new
session identity unless protected state contains the exact prior `sessionRef`
and token needed to reconnect; never take over an old row by name, branch, PID,
device label, or apparent UI abandonment.

A stale job has the same uncertainty boundary: it remains inspectable and
recoverable, but neither elapsed time nor a missing chat authorizes another
runtime to mark it completed, cancelled, abandoned, or safe to clean up.

Device revocation blocks new authenticated Node calls immediately. It does not
cancel or release uncertain agent leases or claims. The owner can open a
non-destructive reconciliation case and inspect Hub/Git evidence; there is no
force-complete or force-release path.
