# `@agentconduit/server`

This package provides the AgentConduit MCP broker launcher and reusable MCP
transport modules. AgentConduit lets independent coding-agent runtimes
coordinate presence, durable messages, leases, and serialized Git integration
without embedding one model provider or repository convention.

The supported production deployment is one local workstation broker for one
operating-system user trust domain. After this package is published, install
the launcher with:

```bash
npm install --global @agentconduit/server
agentconduit-mcp --help
```

Initialize a protected configuration, then run one shared HTTP broker for all
local clients:

```bash
agentconduit-mcp init \
  --config /absolute/private/config.json \
  --data-dir /absolute/private/data \
  --allowed-root /absolute/workspaces
agentconduit-mcp doctor --config /absolute/private/config.json
agentconduit-mcp serve --config /absolute/private/config.json
```

The default MCP endpoint is `http://127.0.0.1:8787/mcp`. Do not bind the current
release beyond loopback. Stdio clients can run
`agentconduit-mcp --stdio --db /absolute/path/to/coordination.db`; every process
that must coordinate needs the same absolute database path.

`backup`, `migrate`, and `maintenance` are explicit operator commands. Migration
and maintenance preview by default; applying either requires `--apply`, and a
migration additionally requires a new verified backup path. See the operations
runbook before changing persistent state.

The package root exports production configuration/operations, the HTTP app,
MCP server factory, runtime lifecycle, and stdio bridge. The
`agentconduit-mcp` executable is the broker launcher, not a separate
coordination protocol.

## Configure MCP clients

Run one loopback HTTP broker for all clients that should coordinate. Configure
the endpoint `http://127.0.0.1:8787/mcp` and send
`Authorization: Bearer <AGENTCONDUIT_TOKEN>` from each HTTP client. Claude Code
and Codex can both use the same endpoint; the broker exposes provider-neutral
MCP tools, so no client-specific coordination API is required. Clients that
cannot use HTTP may run the stdio command above with the same absolute database
path.

The first `agent.register` call discovers the Git worktree from the server-side
path and returns a private per-agent `sessionToken`. Keep it in protected
runtime state and include it in later agent-scoped calls. A heartbeat must use
the exact registered worktree; switching worktrees requires a new registration.

The broker is intentionally loopback-only in this release. Keep the database
outside repositories, use a dedicated path, and do not place bearer or session
tokens in repository files, MCP configuration committed to Git, messages, or
logs. Leases serialize compliant clients but cannot block raw Git commands;
protected branches or a remote merge queue are required when bypasses must fail.

Install `@agentconduit/coordination-skill` separately to give Claude Code,
Codex, and other Agent Skills clients the shared workflow and recovery guidance.
