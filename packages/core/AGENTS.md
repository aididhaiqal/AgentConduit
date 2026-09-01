# AgentConduit core guide

## Verification first

- Type-check: `pnpm --filter @agentconduit/core type:check`
- Tests: `pnpm --filter @agentconduit/core test`
- Build: `pnpm --filter @agentconduit/core build`

## Conventions

- Keep the core provider-neutral and independent of MCP transport packages.
- Git identity and workspace facts are discovered from the server-side path;
  do not trust client-supplied repository or HEAD assertions in service code.
- SQLite state transitions that coordinate agents use immediate transactions;
  normalize retryable `SQLITE_BUSY`/`SQLITE_LOCKED` contention as structured
  coordination conflicts.
- Keep credentials out of records and audit metadata. Session tokens are
  returned only at registration and persisted only as hashes.
- Raw Git operations remain outside the store; integration methods coordinate
  and verify observations but do not execute merges or pushes.
- Production schema changes are explicit and backup-before-migrate; serving may
  validate the current version but must never auto-migrate it.
- Retention may delete only acknowledged messages, terminal integrations, and
  old audit history. Stale-agent reconciliation must recover expired leases
  first and preserve every remaining lease or claimed integration as a blocker.
