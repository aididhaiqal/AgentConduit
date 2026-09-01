# `@agentconduit/bridge`

`@agentconduit/bridge` is the provider-neutral local runtime supervisor for
AgentConduit. It owns the lifecycle around one MCP registration:

```text
register → heartbeat → durable inbox polling → optional owned-runtime push
         → explicit recipient acknowledgement → unregister
```

The package does not launch Claude, Codex, or another paid provider. A caller
may supply an `OwnedRuntimeAdapter` for a process or thread it created. That
adapter can wake the runtime after a durable message is written, but the
recipient still has to read and acknowledge the message through AgentConduit.

On startup, the MCP client reads `server.info` when available and uses the
broker-reported `heartbeatTimeoutMs` to cap local active-status freshness. If
the configured heartbeat interval is too slow for the broker's threshold,
startup fails closed rather than advertising an optimistic presence view.

## Abandoned sessions are fail-closed

The broker's `online` status requires a recent heartbeat. A bridge that exits
unexpectedly leaves its row visible as `stale` after the broker timeout; it is
not silently considered active, and its leases or integration claims are not
released merely because presence became stale. A fresh bridge session gets a
new session reference unless it is explicitly given the old session reference
and the old private session token. The token is never written to the optional
ownership file.

Ownership files are diagnostics only. They are not proof that a process is
alive and are never used to reclaim a broker identity or delete a stale claim.
After a fail-closed runtime/broker error, `stop()` preserves the broker row and
marks the snapshot as degraded; use `stop({ forceUnregister: true })` only after
reconciling any external Git operation and leases.

## Library sketch

```ts
import {
  BridgeSupervisor,
  connectMcpAgentConduitClient,
} from "@agentconduit/bridge";

const client = await connectMcpAgentConduitClient({
  transport: "http",
  url: "http://127.0.0.1:8787/mcp",
  bearerToken: process.env.AGENTCONDUIT_TOKEN,
});

const bridge = new BridgeSupervisor({
  client,
  registration: {
    runtime: "my-runtime",
    workspacePath: "/absolute/path/to/worktree",
    sessionRef: "my-chat",
  },
  onMessage: async (message) => {
    // Process and verify the untrusted body through the host's normal router.
    console.error(`received ${message.messageId}`);
    return "defer";
  },
  onPrivateRegistration: async (registration) => {
    // Store registration.sessionToken only in an OS secret store or protected
    // runtime memory. Never print it or put it in a repository file.
    await saveInProtectedRuntimeState(registration.sessionToken);
  },
  ownsClient: true,
});

await bridge.start();
// `bridge.snapshot()` never exposes the private session token.
```

For a resumable session, provide the exact `sessionRef` and the prior token in
protected runtime state. `onPrivateRegistration` is the opt-in handoff for
capturing the newly issued/rotated token; do not put that token in a command
argument, ordinary file, message, prompt, or log.

The `agentconduit-bridge` executable is a minimal headless supervisor for
diagnostics. It polls without acknowledging messages because it has no host
router or provider adapter of its own; use the library when a runtime should
process or push messages.
