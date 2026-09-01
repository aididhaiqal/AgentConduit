# AgentConduit

AgentConduit is a provider-neutral coordination layer for coding agents and Git
workspaces.

It gives Claude, Codex, and other MCP-capable runtimes a shared place to:

- register the repository and worktree they are actually operating in;
- see live and stale agent presence;
- exchange durable, acknowledged messages;
- replay safe progress for delegated, resumable, or long-running jobs; and
- request exclusive leases for shared operations such as integrating a branch.

The project is intentionally not tied to Atlas, Claude, Codex, a particular
branch name, or a particular model provider.

## Status and supported topologies

The source implements two single-owner profiles:

- a production workstation broker for mutually trusted agents under one
  operating-system account; and
- a self-hosted multi-PC Hub with one outbound-authenticated, loopback-only
  Node on each trusted PC and one owner dashboard.

Both profiles use protected SQLite state, explicit schema migration, bounded
requests, structured redacted logs, health probes, graceful drain, and verified
backups. Durable job events carry only normalized operator-safe progress;
prompts, credentials, raw provider streams, and hidden reasoning do not belong
in the protocol. Multi-PC clones join one coordination scope only through an
explicit `.agentconduit/project.json`; the Hub never receives an absolute
workstation path and never executes Git. This checkout has not been committed,
published, installed as a service, deployed, or runtime-verified on an operator
machine.

Raw Git operations remain outside the broker. Integration leases prevent
compliant agents from racing; protected branches or a remote merge queue are
still required when bypass must be technically impossible. Multi-user, team,
tenant, hosted-control-plane, and horizontally replicated Hub operation are not
supported by V1.

## Topology

```text
one workstation
  Claude / Codex ── MCP ── loopback broker + SQLite

one owner, multiple PCs
  Claude / Codex ── MCP ── local Node ── HTTPS ── Hub + SQLite + dashboard
```

The executable in `apps/server` is only the broker launcher (and a stdio
compatibility bridge for clients that cannot use HTTP). The optional
`@agentconduit/bridge` package supervises one explicitly owned runtime
registration and provides heartbeat/inbox lifecycle handling; it is not a
second
coordination API: Claude, Codex, and other runtimes use the same standard MCP
tools, while the shared `agentconduit-coordination` skill teaches each runtime
when and how to call them.

See [`docs/progress.md`](docs/progress.md) and the governing plans under
[`docs/plans`](docs/plans/) for the current scope and evidence state.

Start with [`docs/getting-started.md`](docs/getting-started.md), then use the
[`operations runbook`](docs/operations.md) for service lifecycle, backup,
maintenance, upgrade, and recovery. The
[`multi-PC runbook`](docs/multi-pc-operations.md) covers Hub TLS, device
enrollment, Nodes, the dashboard, cross-clone identity, backup/restore, and
fail-closed recovery. The
[`distribution guide`](docs/distribution.md) separates source installation,
packaged artifacts, and public-release gates. The
[`threat model`](docs/threat-model.md) and [`security boundary`](docs/security.md)
state what the local controls do and do not protect.
