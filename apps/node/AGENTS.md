# AgentConduit Node guide

## Verification first

- Type-check: `pnpm --filter @agentconduit/node type:check`
- Tests: `pnpm --filter @agentconduit/node test`
- Build: `pnpm --filter @agentconduit/node build`
- Package manifest: `pnpm --filter @agentconduit/node pack --dry-run --json`

## Conventions

- Discover Git only on the local machine through `@agentconduit/core` and an
  explicit allowed-root policy. Transform snapshots before network I/O; no
  absolute path, Git directory, credential, or session token may enter logs.
- Production MCP serving remains numeric-loopback-only with its own local
  bearer token. Hub authentication uses a separate revocable device token.
- Multi-PC workspaces require an explicit `.agentconduit/project.json` identity;
  never infer cross-clone authority from a remote URL alone.
- Hub uncertainty fails closed. Do not grant, cache, or emulate a lease while
  disconnected; durable Hub state and inbox reads remain authoritative.
- Server-sent events are wake-up hints. Resume from the protected cursor and
  tolerate replay; never acknowledge an agent message from a push event alone.
- The Node executes bounded local Git discovery and ref resolution only for an
  MCP caller's allowed workspace. It never accepts remote shell, arbitrary
  filesystem, or Hub-initiated Git mutation instructions.
