# `@agentconduit/coordination-skill`

This package distributes one provider-neutral Agent Skills directory for
AgentConduit. The skill teaches MCP-capable coding agents when to register,
exchange messages, use leases, serialize Git integration, route through a
single-owner Hub/Node topology, and recover from uncertain outcomes. It
contains no broker executable and grants no permission to merge or bypass
repository policy.

After installing or unpacking the package, expose its directory under the
skill-discovery path used by the client:

- Codex: `.agents/skills/agentconduit-coordination` or the corresponding
  personal `.agents/skills` directory;
- Claude Code: `.claude/skills/agentconduit-coordination` or the corresponding
  personal `.claude/skills` directory.

A symlink keeps both clients on the same installed copy. Copying the complete
directory is the portable fallback. See the AgentConduit
`docs/getting-started.md` guide for source-checkout and packaged installation
examples.
