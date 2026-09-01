# `@agentconduit/hub`

The AgentConduit Hub is the self-hosted, single-owner authority for multiple
authenticated PCs. It stores cross-device coordination state and serves the
owner dashboard. Each PC connects through `@agentconduit/node`; the Hub never
receives an arbitrary filesystem path and never executes Git or shell commands.

Production initialization, TLS/reverse-proxy placement, enrollment, backup,
schema migration, dashboard login, revocation, and recovery guidance is in the
[`multi-PC operations guide`](../../docs/multi-pc-operations.md). The Hub
supports either direct TLS or a numeric-loopback listener behind an HTTPS
reverse proxy. Plain remote HTTP and proxying the workstation broker are not
supported.

The owner token stays in a protected local file. Device credentials are
one-time-enrolled, hashed at rest, and independently revocable. Browser
mutations use an HttpOnly session, exact-origin enforcement, and CSRF. Durable
database reads remain authoritative after SSE disconnect or bounded replay.
Node collection RPC and owner snapshots use cursor pages with hard record and
byte budgets. Oversized SSE history resets clients to an authoritative
snapshot/latest cursor, and stream writes honor network backpressure.

No package has been published from this checkout.
