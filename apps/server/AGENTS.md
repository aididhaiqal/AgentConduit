# AgentConduit MCP server guide

## Verification first

- Type-check: `pnpm --filter @agentconduit/server type:check`
- Tests: `pnpm --filter @agentconduit/server test`
- Build: `pnpm --filter @agentconduit/server build`
- Package manifest: `pnpm --filter @agentconduit/server pack --dry-run --json`
- Production smoke: the launcher suite covers init, doctor, backup, migration
  preflight, maintenance preview, readiness, and graceful SIGTERM drain.

## Conventions

- Keep MCP handlers thin. Put authorization, Git discovery, persistence, and
  state-machine rules in `@agentconduit/core` so HTTP and stdio behave alike.
- Validate every tool payload with Zod and return structured coordination
  errors; never expose session secrets or raw stack traces through MCP.
- HTTP v1 is loopback-only. A bearer token protects `/mcp` when configured;
  per-agent session tokens remain required for agent-scoped operations.
- The stdio bridge must exit cleanly on stdin EOF/close and termination signals,
  and must use an explicit absolute shared database path.
- Production commands use a versioned protected JSON configuration. Keep
  credentials out of output and structured logs, require explicit apply flags
  for persistent maintenance/migration, and keep development flags visibly
  separate from the production profile.
