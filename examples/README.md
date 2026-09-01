# MCP client examples

These are project-scoped examples for clients connecting to one already-running
AgentConduit Streamable HTTP broker.

- [`codex/config.toml`](codex/config.toml) is a table to copy into a trusted
  project's `.codex/config.toml`.
- [`claude/.mcp.json`](claude/.mcp.json) can be copied to a project's root as
  `.mcp.json`; Claude Code asks the user to approve a project server before it
  connects.
- [`production/config.json`](production/config.json) documents every production
  configuration field. Generate the real file with `agentconduit-mcp init`
  instead of copying placeholder paths.
- [`systemd/agentconduit.service`](systemd/agentconduit.service) is a hardened
  user-service starting point. Replace the executable path and review the
  filesystem sandbox against the configured allowed roots before installation.
- [`systemd/agentconduit-hub.service`](systemd/agentconduit-hub.service) and
  [`systemd/agentconduit-node.service`](systemd/agentconduit-node.service) are
  separate user-service starting points for the single-owner multi-PC topology.
- [`caddy/Caddyfile`](caddy/Caddyfile) terminates public HTTPS in front of a Hub
  that remains bound to numeric loopback. Replace its hostname before use.

The client examples expect the broker at `http://127.0.0.1:8787/mcp` and read the same
HTTP process bearer token from the `AGENTCONDUIT_TOKEN` environment variable.
The examples contain no secret. After connecting, each runtime must call
`agent.register`, retain the returned private `sessionToken`, and pass it in
the documented agent-scoped calls; the HTTP bearer token does not replace that
per-agent token.

`workspace.register` may persist a server-discovered workspace before an agent
session exists, and `workspace.list` reads snapshots known to the broker. The
normal coordination flow still begins with `agent.register` so presence and
message identity are bound to the actual worktree.

Independent clones normally receive separate repository scopes. To intentionally
enroll clones into one scope, commit a `.agentconduit/project.json` file in each
clone with the same owner-chosen `projectId`, for example:

```json
{
  "projectId": "acme-payments"
}
```

This is a namespace label, not authentication; use it only for clones operated
by the same trusted team and keep credentials out of the file.

These files configure MCP connectivity only. Install the shared
[`agentconduit-coordination`](../skills/agentconduit-coordination/SKILL.md)
skill separately so each runtime follows the registration, messaging, lease,
and integration workflow. For production stdio, give each process the same
protected `--config` path; development compatibility mode instead requires the
same absolute `AGENTCONDUIT_DB`. Stdio has no HTTP bearer boundary. The
per-agent `sessionToken` remains required after registration.

For a multi-PC Node, change the client URL to
`http://127.0.0.1:8788/mcp` and load `AGENTCONDUIT_TOKEN` from that PC's
protected Node `local-token` file. Do not expose either loopback MCP endpoint.
Follow [`docs/multi-pc-operations.md`](../docs/multi-pc-operations.md) rather
than installing these examples verbatim.
