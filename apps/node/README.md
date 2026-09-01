# `@agentconduit/node`

AgentConduit Node runs on each enrolled PC. It exposes the provider-neutral MCP
surface on numeric loopback, discovers Git evidence under explicitly allowed
local roots, redacts paths before outbound HTTPS, and proxies durable
coordination to a self-hosted Hub.

Hub outages and credential revocation fail closed: the Node never manufactures
local merge authority. Cross-clone registration requires the repository's
explicit `.agentconduit/project.json`; a remote URL alone is insufficient.
The Node can serve authenticated Streamable HTTP or stdio, and its event stream
only wakes durable inbox/state polling.

Enrollment, allowed-root selection, MCP client configuration, service
lifecycle, revocation, and recovery are documented in the
[`multi-PC operations guide`](../../docs/multi-pc-operations.md). No package has
been published from this checkout.
