# Connect multiple coding agents

This guide connects Claude Code, Codex, or another MCP client to one local
AgentConduit broker. For one owner coordinating independently cloned
repositories across several PCs, use the same client and skill workflow through
a local Node and follow [`multi-pc-operations.md`](multi-pc-operations.md).
AgentConduit is provider- and repository-neutral; there is no Atlas-specific
registration.

## 1. Build and initialize one broker

Requirements are Git, Node.js 22.20 or later, and pnpm 11.7.

From the AgentConduit source checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
```

No npm artifact has been published from this checkout. After an authorized
release, the equivalent packaged launcher is installed with
`npm install --global @agentconduit/server`. See
[`distribution.md`](distribution.md) for artifact contents and release gates.

Create private configuration and data directories on a filesystem that
supports owner-only permissions. Choose one or more narrow directory roots
that contain the Git worktrees this broker may inspect. Do not enroll `/` or a
whole drive. Initialize once; the command creates a random bearer-token file
and a current SQLite database without printing the token:

```bash
mkdir -p "$HOME/.config/agentconduit" "$HOME/.local/state/agentconduit"
chmod 700 "$HOME/.config/agentconduit" "$HOME/.local/state/agentconduit"

node apps/server/dist/main.js init \
  --config "$HOME/.config/agentconduit/config.json" \
  --data-dir "$HOME/.local/state/agentconduit" \
  --allowed-root "$HOME/code"

node apps/server/dist/main.js doctor \
  --config "$HOME/.config/agentconduit/config.json"
node apps/server/dist/main.js serve \
  --config "$HOME/.config/agentconduit/config.json"
```

The default endpoint is `http://127.0.0.1:8787/mcp`. Keep one broker running
for all local clients that must coordinate. `/livez` proves the HTTP process
is alive; `/readyz` additionally checks database integrity and schema state.
Both expose only fixed service metadata. The legacy `/healthz` compatibility
probe remains available.

HTTP clients need the token contents in an environment variable, but the
production broker reads the token directly from its protected file. For an
interactive shell that launches a client:

```bash
export AGENTCONDUIT_TOKEN="$(tr -d '\r\n' < "$HOME/.config/agentconduit/token")"
```

Do not print the variable, put it in shell history, or commit it. Prefer a
service manager and a client secret loader for routine use. See
[`operations.md`](operations.md) and the checked-in service/config examples.

Do not bind or proxy the workstation broker beyond loopback. A bearer token
protects the HTTP process, while per-agent session tokens authorize
agent-scoped calls. Cross-machine use requires the separately packaged Hub and
outbound Node, not a remote bind of this server. See
[`security.md`](security.md).

## 2. Configure each MCP client

### Codex

Copy the table from [`examples/codex/config.toml`](../examples/codex/config.toml)
into `.codex/config.toml` in a trusted project, or into the user's Codex
`config.toml`. Launch Codex from an environment containing
`AGENTCONDUIT_TOKEN`.

Codex supports both Streamable HTTP and stdio MCP servers. The shared HTTP
endpoint is the preferred AgentConduit topology because every client clearly
uses the same long-lived broker and database.

### Claude Code

Copy [`examples/claude/.mcp.json`](../examples/claude/.mcp.json) to `.mcp.json`
at the root of the repository whose team should share the configuration.
Launch Claude Code from an environment containing `AGENTCONDUIT_TOKEN`, then
review and approve the project MCP server when Claude asks.

The explicit `"type": "http"` is required for a URL-based Claude Code MCP
entry. Environment expansion supplies the bearer token without committing it.

### Other MCP clients

Configure a Streamable HTTP MCP endpoint at
`http://127.0.0.1:8787/mcp` and send
`Authorization: Bearer <AGENTCONDUIT_TOKEN>`. Tool names and payloads are
provider-neutral; see [`protocol.md`](protocol.md) and the concrete
[`workflow.md`](workflow.md) recipes.

### Session registration and tokens

The first `agent.register` call discovers the client's actual Git worktree and
returns an `agentId`, a private per-agent `sessionToken`, and the observed
workspace snapshot. Keep the token in the client's protected runtime state and
pass it in every subsequent agent-scoped state-changing call (and in
`message.inbox`, which is token-gated to protect the recipient). Do not put it
in a message, repository file, config example, or log. A reconnect using the
same runtime, stable `sessionRef`, and worktree must include the previous token;
the successful response returns the same agent ID and a fresh token, which
immediately invalidates the old one.

If an agent has not started yet, `workspace.register` can persist a
server-discovered workspace snapshot without an agent token. `workspace.list`
returns snapshots already known to the broker. These workspace tools do not
replace `agent.register`; they are useful for enrollment and inspection before
an agent session exists.

## 3. Install the shared skill

The source skill at
[`skills/agentconduit-coordination`](../skills/agentconduit-coordination/SKILL.md)
uses the open Agent Skills `SKILL.md` format and contains no provider-specific
frontmatter.

For repository-scoped use, place or symlink the same skill directory at:

- `.agents/skills/agentconduit-coordination` for Codex;
- `.claude/skills/agentconduit-coordination` for Claude Code.

Both clients support symlinked skill directories. A repository can therefore
keep the canonical skill under `skills/` and expose it to both discovery paths
without maintaining two copies. Copying the directory is the portable fallback
where symlinks are unavailable.

For personal use across repositories, install a copy under
`$HOME/.agents/skills/` for Codex and `$HOME/.claude/skills/` for Claude Code.
Client-specific installation paths are only discovery adapters; the skill
content and MCP protocol remain shared.

The skill is also independently packable as
`@agentconduit/coordination-skill`, so a future release can distribute the same
directory without coupling it to the broker executable. Nothing has been
published from this checkout yet; packaged installation commands are in
[`distribution.md`](distribution.md).

## 4. Verify coordination

In each client, confirm that the AgentConduit MCP server is connected. Then ask
the client to use the `agentconduit-coordination` skill. A useful smoke test is:

1. register Claude and Codex from different worktrees in the same local clone;
2. compare their `agent.list` results for the returned repository ID;
3. send a message in one client, read and acknowledge it in the other;
4. enqueue two integration requests for the same target ref and confirm only
   the first request can be claimed.

## Optional bridge supervisor

For a runtime wrapper or local automation that owns a provider process/thread,
install `@agentconduit/bridge` and construct `BridgeSupervisor` around the same
MCP endpoint. The bridge registers the absolute worktree, heartbeats, and polls
the durable inbox. A supplied runtime adapter may provide a native wake-up
hint, but it must never acknowledge a message on the adapter's behalf.

The bridge intentionally creates a new session reference for every new
instance. Reconnection is possible only when protected runtime state supplies
the exact previous session reference and session token. If a process or chat
is abandoned, the broker keeps its row as `stale` after the heartbeat timeout;
that row remains visible for reconciliation, while `agent.list` with
`activeOnly: true` excludes it from fresh routing decisions. The bridge never
uses a PID, branch, cwd, or ownership marker to reclaim the old identity.
When the MCP client supports `server.info`, the bridge reads the broker's
`heartbeatTimeoutMs` before registering and caps its local `snapshot().active`
view to that server value, preventing a longer local timeout from claiming
freshness after the broker has already marked the row stale. A bridge-owned
runtime that is still alive and heartbeating is intentionally online; a chat
UI change alone cannot prove that its process stopped, so call `stop()` or
`notifyRuntimeExit()` when the owner knows the runtime has ended.

Linked worktrees share a repository ID because they share a Git common
directory. Independent clones intentionally receive different repository IDs
even when their `origin` URLs match, unless the owner explicitly enrolls them
with the same project identity. To opt in, create this small file at the root
of every clone that should coordinate:

```json
{
  "projectId": "acme-payments"
}
```

The file is read by server-side Git discovery at
`.agentconduit/project.json`. `projectId` is a coordination namespace, not a
secret or proof of repository ownership; choose a stable value only when the
clones are intentionally operated by the same trusted team. The broker hashes
the value before exposing `repositoryId`. Do not put credentials or customer
data in the file.

## Stdio compatibility mode

`agentconduit-mcp --stdio` is available for MCP clients that cannot use
Streamable HTTP. Each stdio client starts another server process, so every
process must receive the same absolute `AGENTCONDUIT_DB` path to coordinate.
Do not rely on the default relative database path across different clients.
Stdio does not use the HTTP `AGENTCONDUIT_TOKEN`; the operating-system process
identity and permissions on the shared database are its security boundary.
The per-agent `sessionToken` returned by `agent.register` is still required for
agent-scoped calls. The checked-in client examples use the clearer single-broker
HTTP topology.

The production form is
`agentconduit-mcp serve --config /absolute/config.json --stdio`; it applies the
same protected database, allowed-root, schema, and session rules but has no
HTTP bearer boundary. Development `--db` and environment flags remain
available for tests and disposable local experiments; they are not the
fail-closed production profile.

## Multi-PC client endpoint

On a PC enrolled with the Hub, clients use the same MCP configuration shape but
connect to the local Node at `http://127.0.0.1:8788/mcp` with the bearer from
the Node's protected `local-token` file. The Node performs Git discovery on that
PC and sends only device-scoped, redacted attestations to the Hub. It never
falls back to the workstation broker when the Hub is unavailable.

Every independently cloned repository that should share cross-PC coordination
must carry the same owner-approved `.agentconduit/project.json`. The matching
project ID is a namespace, not authentication or a remote-ref lock. Enrollment,
TLS, service lifecycle, verification, backup, revocation, and recovery are in
the [`multi-PC runbook`](multi-pc-operations.md).
