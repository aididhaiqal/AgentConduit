# AgentConduit bridge guide

## Verification first

- Type-check: `pnpm --filter @agentconduit/bridge type:check`
- Tests: `pnpm --filter @agentconduit/bridge test`
- Build: `pnpm --filter @agentconduit/bridge build`
- Package manifest: `pnpm --filter @agentconduit/bridge pack --dry-run --json`

## Conventions

- The bridge is a provider-neutral supervisor, not a provider implementation.
  Provider-native push adapters must be explicitly supplied by a caller that
  owns the runtime process or thread; the bridge never launches a paid provider
  by default.
- Durable AgentConduit inbox polling and recipient acknowledgement are the
  correctness path. A push adapter is only a wake-up hint and must never cause
  an acknowledgement by itself.
- Session tokens stay in memory. A new bridge without the prior token creates a
  fresh session reference; it never takes over an old registration based on a
  PID, cwd, branch, display name, or ownership marker.
- Ownership files contain only protected, non-secret diagnostics. Do not add
  raw tokens, prompts, provider streams, or credentials to them or to tests.
- Broker or runtime uncertainty is fail-closed: stop polling and preserve the
  broker's stale/lease state for explicit reconciliation.
