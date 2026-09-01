# AgentConduit Engineering Guide

AgentConduit is a provider-neutral coordination layer for coding agents and Git
workspaces. The MCP server is the user-facing integration surface; the core
package owns persistence, Git discovery, identity, messaging, and leases.

## Verification first

- Install: `pnpm install --frozen-lockfile`
- Type-check: `pnpm type:check`
- Tests: `pnpm test`
- Build: `pnpm build`
- CI dependencies: `pnpm ci:check`
- Formatting: `pnpm format:check`
- Skill contract: `pnpm skill:check`
- Package manifests: `pnpm pack:check`

Run the narrowest affected package checks first, then the root checks before
reporting completion. A passing type-check does not prove MCP transport or Git
runtime behavior; keep those evidence states separate.

## Conventions

- Keep the protocol provider-neutral. Do not hard-code Claude, Codex, Atlas, or
  any one model vendor into core domain types.
- Treat Git facts as server-discovered evidence. Never trust a client assertion
  about repository, worktree, branch, or HEAD when the server can inspect it.
- Use server-generated opaque identifiers and server time for registrations,
  messages, and leases. Never persist prompts, credentials, or raw session
  secrets.
- State-changing operations must be idempotent where practical and must
  re-discover the relevant Git state before mutating coordination state.
- The broker is advisory for ordinary agent work but authoritative for its own
  leases and queue transitions. Raw Git remains outside the broker unless an
  explicitly enabled integration executor is added later.
- Keep the Streamable HTTP server and stdio bridge thin; business rules belong
  in `packages/core` so every transport has identical semantics.
- Production serving must remain loopback-only, require current schema state,
  run with private file creation, and drain listeners before closing SQLite.
- Maintenance previews must be non-mutating and use the exact same transition
  logic as apply. Never force-release live or uncertain coordination authority.
- New directory-rooted projects must add this guide and the one-line
  `CLAUDE.md` shim in the same change.

## Security boundary

The default server binds to loopback. Any non-local deployment requires explicit
authentication and allowed-root configuration. Git command execution uses fixed
argument lists and canonicalized paths; do not add an arbitrary shell tool.
