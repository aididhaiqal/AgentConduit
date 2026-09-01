# `@agentconduit/core`

This package contains AgentConduit's provider-neutral Git discovery, SQLite
persistence, presence, messaging, lease, and integration-queue primitives.

Most users should install `@agentconduit/server` and interact with AgentConduit
through standard MCP tools. The core package is published because the server
depends on it and because alternate transports can reuse the same coordination
semantics; its programmatic API remains pre-1.0.
