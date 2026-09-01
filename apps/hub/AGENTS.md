# AgentConduit Hub guide

## Verification first

- Type-check: `pnpm --filter @agentconduit/hub type:check`
- Tests: `pnpm --filter @agentconduit/hub test`
- Build: `pnpm --filter @agentconduit/hub build`
- Package manifest: `pnpm --filter @agentconduit/hub pack --dry-run --json`

## Conventions

- The Hub is a separate remote trust profile; never relax or remotely expose
  the workstation server's loopback-only production boundary.
- Authenticate owner and device routes independently. Browser mutations require
  an authenticated HttpOnly session, exact allowed origin, and CSRF token.
- Device enrollment codes and owner, device, and agent credentials never enter
  SQLite plaintext, logs, events, dashboard storage, URLs, or fixtures.
- Nodes attest Git facts discovered on their own machine. Persist server time,
  device provenance, and redacted device URIs; reject raw absolute paths.
- Dashboard controls may send owner messages, revoke devices, cancel only
  unclaimed integrations, and open reconciliation. Never add remote Git, shell,
  arbitrary filesystem, force-release, or force-complete actions.
- Server-sent events are a wake-up and visibility path. Durable database state
  and cursor replay remain authoritative after disconnects or restarts.
