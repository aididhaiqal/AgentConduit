# Single-owner multi-PC operations

This runbook operates the supported cross-machine topology: one owner, one
self-hosted Hub process and SQLite database, and one outbound-authenticated Node
on each trusted PC. It is not a team service, hosted control plane, remote shell,
or multi-tenant system.

```text
Claude / Codex / another MCP client
              |
              v
     local authenticated Node ---- HTTPS ----> one owner Hub + SQLite
              |                                      |
       local Git discovery                      web dashboard
```

The Hub is authoritative for durable messages, presence, jobs and normalized
progress events, leases, the global integration FIFO, reconciliation cases,
and audit events. A Node is authoritative only for bounded Git discovery on its
own PC. Server-sent events are wake-up hints; every correctness decision is
read back from durable Hub state.

Examples use installed `agentconduit-hub` and `agentconduit-node` binaries. From
this source checkout after `pnpm build`, replace them with
`node apps/hub/dist/main.js` and `node apps/node/dist/main.js`.

## Before installation

- Install Git and Node.js 22.20 or later on every PC.
- Put Hub and Node configuration/state on owner-private local filesystems. On
  POSIX, directories must be owned by the service user and mode `0700`; files
  must be regular, non-symlink files with mode `0600`. WSL users should use the
  Linux filesystem rather than DrvFS for these files.
- Choose one stable HTTPS origin such as `https://conduit.example.net`. It must
  resolve to the Hub and must not contain a path, query, fragment, or embedded
  credential.
- Choose narrow allowed roots on each PC. A Node can inspect every Git checkout
  below an allowed root; never enroll `/`, a whole drive, a secrets directory,
  or an untrusted shared mount.
- Decide which repositories may coordinate across clones. Each such repository
  needs the same explicit `.agentconduit/project.json` in every clone.

The Hub owner token, Node device tokens, Node-local MCP tokens, agent session
tokens, and one-time enrollment codes are credentials. Never put them in Git,
shell profiles, URLs, logs, messages, screenshots, or synced folders.

## 1. Initialize the Hub

Create private directories on the Hub host:

```bash
mkdir -p "$HOME/.config/agentconduit-hub" \
  "$HOME/.local/state/agentconduit-hub/backups"
chmod 700 "$HOME/.config/agentconduit-hub" \
  "$HOME/.local/state/agentconduit-hub" \
  "$HOME/.local/state/agentconduit-hub/backups"
```

### Recommended: TLS at a loopback reverse proxy

Initialize the Hub with its public HTTPS origin. The Hub itself binds only to
numeric loopback on port 8790; the reverse proxy owns the certificate and
public listener.

```bash
agentconduit-hub init \
  --config "$HOME/.config/agentconduit-hub/config.json" \
  --data-dir "$HOME/.local/state/agentconduit-hub" \
  --public-base-url "https://conduit.example.net"

agentconduit-hub doctor \
  --config "$HOME/.config/agentconduit-hub/config.json"
```

Use the bounded Caddy example at
[`examples/caddy/Caddyfile`](../examples/caddy/Caddyfile), or configure an
equivalent HTTPS reverse proxy. Preserve the original `Host` header. Do not
rewrite the origin or expose the Hub's loopback port through a tunnel. Overwrite
`X-Forwarded-For` with exactly the connecting client's IP; never pass through a
client-supplied chain. The Hub trusts that header only in loopback-proxy mode
and only when the immediate peer is numeric loopback. Direct-TLS mode ignores
all forwarding headers. The proxy and Hub should run on the same host or inside
one equally trusted private runtime boundary.

### Alternative: direct TLS

Direct TLS is supported when the Hub process must own the HTTPS listener. The
certificate must cover the configured public origin. The certificate and
private-key paths are resolved during initialization; the private key must be
owner-private.

```bash
agentconduit-hub init \
  --config "$HOME/.config/agentconduit-hub/config.json" \
  --data-dir "$HOME/.local/state/agentconduit-hub" \
  --public-base-url "https://conduit.example.net:8790" \
  --direct-tls \
  --host 0.0.0.0 \
  --port 8790 \
  --tls-cert /absolute/path/to/fullchain.pem \
  --tls-key /absolute/private/path/to/privkey.pem
```

Prefer a stable certificate-renewal path. The Hub reads the certificate at
startup; restart it after certificate replacement. Never use plain HTTP across
a LAN or the Internet. Development-only insecure loopback support exists in
tests and is not a production mode.

Initialization refuses to overwrite the configuration, owner-token file, or
database. Its JSON summary contains paths and transport settings but never the
owner token. `serve` and `doctor` require the current database schema and never
migrate implicitly.

## 2. Start and inspect the Hub

```bash
agentconduit-hub serve \
  --config "$HOME/.config/agentconduit-hub/config.json"
```

For a persistent user service, adapt
[`examples/systemd/agentconduit-hub.service`](../examples/systemd/agentconduit-hub.service).
Replace the executable path, review its filesystem sandbox, then install it as
`$HOME/.config/systemd/user/agentconduit-hub.service`:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agentconduit-hub.service
systemctl --user status agentconduit-hub.service
```

The reverse proxy should not report the service healthy unless
`https://conduit.example.net/readyz` returns 200. `/livez` proves only that the
listener can answer; `/readyz` also checks drain and database health. Both
return fixed service metadata and require no credential.

Open the HTTPS origin in a browser. Paste the owner token from the protected
Hub `owner-token` file into the login form using a trusted local secret-reading
workflow. The browser receives a short-lived `Secure`, `HttpOnly`, same-site
session cookie; the token is not retained in browser storage. Mutations require
the exact configured origin and a session-bound CSRF token.

The dashboard intentionally exposes coordination metadata and message bodies
to the authenticated owner. It also shows safe job identity, liveness, status,
and recent normalized progress; it never receives prompts or raw provider
streams and cannot emit a job outcome. Its only controls are:

- send an operator message to an agent;
- revoke a device;
- cancel an integration request only while it is unclaimed; and
- open a non-destructive reconciliation case.

It cannot execute Git, open a shell, browse files, force-release a lease, or
force-complete an integration.

## 3. Give a repository an explicit cross-clone identity

At the repository root, create and normally commit this non-secret file so all
intended clones receive the same identity:

```json
{
  "projectId": "acme-payments"
}
```

The path must be exactly `.agentconduit/project.json`. `projectId` is 1-128
characters, starts with an ASCII letter or digit, and otherwise uses only
letters, digits, `.`, `_`, `:`, or `-`. The file and its parent may not be
symlinks.

A matching project ID creates one Hub coordination namespace; it is not a
credential, proof of repository ownership, or remote-ref lock. A matching Git
remote without this file does not join independent clones. Where raw Git bypass
must be technically prevented, also use protected branches, required review,
or the Git provider's authoritative merge queue.

## 4. Enroll one PC

On the Hub host, create a one-time enrollment. It expires after ten minutes and
cannot be reused:

```bash
agentconduit-hub enroll-device \
  --config "$HOME/.config/agentconduit-hub/config.json" \
  --name "Studio PC" \
  > "$HOME/.local/state/agentconduit-hub/studio-enrollment.json"
chmod 600 "$HOME/.local/state/agentconduit-hub/studio-enrollment.json"
```

The JSON includes the one-time `enrollmentCode` but never the owner token.
Transfer only that code to the intended PC through an owner-approved encrypted
channel and write the raw code, with no JSON wrapper, to a new mode-`0600` file.
Do not pass it on the command line or place it in a URL.

On the PC, create private destinations and enroll:

```bash
mkdir -p "$HOME/.config/agentconduit-node" \
  "$HOME/.local/state/agentconduit-node"
chmod 700 "$HOME/.config/agentconduit-node" \
  "$HOME/.local/state/agentconduit-node"
chmod 600 "$HOME/.config/agentconduit-node/enrollment-code"

agentconduit-node enroll \
  --config "$HOME/.config/agentconduit-node/config.json" \
  --state-dir "$HOME/.local/state/agentconduit-node" \
  --hub "https://conduit.example.net" \
  --enrollment-code-file "$HOME/.config/agentconduit-node/enrollment-code" \
  --name "Studio PC" \
  --allowed-root "$HOME/code" \
  --path-label "$HOME/code=studio-workspaces"

agentconduit-node doctor \
  --config "$HOME/.config/agentconduit-node/config.json"
```

Node validates all local destination paths before consuming the remote
one-time code. Successful enrollment writes a protected device token, a
separate protected local MCP bearer token, an event cursor, and a versioned
configuration without printing any token. Remove the transferred enrollment
file and the Hub-side enrollment JSON using the platform's secure secret-file
retirement policy after `doctor` succeeds.

Repeat this step with a new enrollment for every PC. Never copy one Node
configuration or device token to another machine.

## 5. Start the Node and connect local MCP clients

Start one Node per PC:

```bash
agentconduit-node serve \
  --config "$HOME/.config/agentconduit-node/config.json"
```

The default endpoint is `http://127.0.0.1:8788/mcp`. It is always numeric-
loopback-only and requires the token from the Node's protected `local-token`
file. The Node makes outbound HTTPS calls to the Hub and never accepts inbound
Hub connections.

Adapt
[`examples/systemd/agentconduit-node.service`](../examples/systemd/agentconduit-node.service)
for a persistent user service. Review `ProtectHome` and `ReadOnlyPaths` against
the exact allowed roots before enabling it.

Configure Claude, Codex, and other MCP clients exactly as in the local examples,
but use port 8788 and load the local Node token rather than the workstation
broker token. A client that only supports stdio can launch:

```bash
agentconduit-node stdio \
  --config "$HOME/.config/agentconduit-node/config.json"
```

The stdio process still maintains the device heartbeat and event stream, and
all durable calls still go to the Hub. Do not run a local workstation broker as
a fallback for the same project: that would create split-brain authority.

After each client registers, keep its returned agent `sessionToken` in protected
runtime state. The local Node bearer authenticates access to the process; it
does not replace per-agent authorization.

## 6. Verify cross-PC coordination

From two independently cloned repositories carrying the same project ID:

1. Register one agent through each local Node and confirm both return the same
   `repositoryId` but different device-scoped `worktreeId` values.
2. Check `agent.list` through both Nodes and verify both live agents appear.
3. Send a message from one agent, read it through the other Node, acknowledge
   it, and verify the default inbox no longer returns it.
4. Create a job from one agent, emit safe progress, and replay its events from
   a cursor through the other Node. Verify the owner dashboard shows the job
   without an absolute path, prompt, credential, or raw provider content.
5. Enqueue two requests for the same canonical target branch. The earlier
   request must be the only claim winner; the later claim must return a
   conflict while preserving FIFO state.
6. Open the dashboard and verify that paths appear only as configured labels
   and `device://...` identifiers. An absolute path from either PC must never
   appear in Hub state, dashboard responses, audit events, or Hub logs.

Do not begin the Git mutation merely because a dashboard signal is green.
Follow the coordination skill: refresh Git evidence immediately before the
operation, retain the live claim and fencing token, and use the repository's
normal authorization and protected-branch policy.

## Backup, migration, and restore

Create each Hub backup at a new absolute path while the database is healthy:

```bash
agentconduit-hub backup \
  --config "$HOME/.config/agentconduit-hub/config.json" \
  --destination "$HOME/.local/state/agentconduit-hub/backups/hub-2026-09-01T000000Z.db"
```

The command uses SQLite's online backup path, refuses overwrite, and verifies
schema, integrity, and foreign keys before reporting success. Backups contain
plaintext coordination messages, safe job summaries, and metadata; protect and
encrypt them like the live database. Back up before every upgrade and before
manual recovery.

Stop the Hub before a schema upgrade. Preview first:

```bash
agentconduit-hub migrate \
  --config "$HOME/.config/agentconduit-hub/config.json"
```

If `migrationRequired` is true, apply only with a new backup path:

```bash
agentconduit-hub migrate \
  --config "$HOME/.config/agentconduit-hub/config.json" \
  --apply \
  --backup "$HOME/.local/state/agentconduit-hub/backups/pre-schema-4.db"
```

Then run `doctor`, start the Hub, check `/readyz`, start or restart Nodes, and
run `agent.list`, `job.list`, and `integration.list` before allowing a shared
mutation.

There is intentionally no in-place restore command:

1. Stop the Hub and keep Nodes stopped or failing closed.
2. Preserve the database plus any `-wal` and `-shm` files together in a private
   quarantine directory; do not delete or edit them.
3. Point a disposable private Hub configuration at a copy of the selected
   backup and run `doctor` against the copy.
4. Copy the verified backup to a new private database path and update the
   stopped Hub configuration. Keep the old database quarantined for rollback.
5. Run `doctor`, start the Hub, verify readiness, then inspect devices, agents,
   jobs, leases, integrations, reconciliations, audit history, and the real Git
   refs.
6. Resume Nodes only after unresolved authority has been reconciled.

Never repair a Hub by editing SQLite rows, timestamps, lease IDs, device
credentials, event cursors, or integration states by hand.

## Outage, revocation, stale sessions, and reconciliation

### Hub or network outage

The Node reports Hub-backed calls unavailable and grants no new lease or
integration authority. Its readiness becomes unhealthy after the heartbeat
freshness window. Existing uncertain claims remain authoritative in durable Hub
state; neither a cached response nor a local broker may replace them. When the
Hub returns, let the Node reconnect, replay from its protected audit cursor,
read the relevant inbox/lease/integration records, and replay each relevant job
from its last durable job-event cursor before resuming.

### Device revocation

Revocation rejects new calls using that device credential immediately. Stop and
disable the Node service on that PC. Revocation deliberately does not release
its agents' leases or claimed integrations. Open a reconciliation case and
inspect both Hub state and the affected repositories. Re-enrollment creates a
new device identity; it does not inherit or silently resolve the old device's
authority.

### Abandoned or replaced chats

A chat switch, closed UI, missing native-agent listing, old heartbeat, or
elapsed lease time does not prove that a process or Git mutation stopped. New
sessions register with new identities unless they possess the exact protected
reconnection token. Stale rows remain visible, are excluded by
`agent.list(activeOnly=true)`, and retain unresolved authority for operator
inspection.

A stale non-terminal job likewise remains visible and recoverable. It is not
automatically abandoned, cancelled, reassigned, or eligible for retention
cleanup. A timeout or missing chat cannot supply its terminal outcome.

### Event cursor reset

If retained audit history no longer contains the Node's cursor, the Hub sends a
reset hint. The Node advances its wake-up cursor and performs durable reads. A
cursor reset never acknowledges a message, changes a lease, completes an
integration, emits job progress, or proves an external operation's outcome.
Job progress is reconstructed separately with `job.events` from the last
cursor held for that job.

### Non-destructive reconciliation

Use the dashboard to open a case for the affected agent. A case snapshots its
known lease and claimed-integration IDs for investigation; it does not mutate
them. Compare Hub records, the real process state on the owning PC, local and
remote Git refs, and repository-provider evidence. Preserve uncertainty until
the normal authenticated claimant can complete/cancel or an explicitly
authorized future recovery mechanism exists. V1 has no force-release or
force-complete control.

## Routine lifecycle and upgrade order

- Monitor Hub and Node service restarts, `/readyz`, Node `doctor`, device and
  job freshness, reconciliation cases, and backup verification. Protect
  structured logs because opaque IDs, timing, path labels, job summaries, and
  message metadata can still be sensitive.
- Gracefully stop Nodes before the Hub for planned maintenance. Start and verify
  the Hub first, then Nodes, then MCP clients.
- Upgrade compatible package versions together. Run the repository's package
  smoke and release checks before rollout; a locally built artifact is not a
  published or production-verified release.
- Take a verified Hub backup, stop the Hub, preview/apply any schema migration,
  run `doctor`, restart the Hub, then update one Node at a time.
- After rollback or restore, distrust cached liveness and re-read every
  unresolved integration and lease before resuming shared work.

## Supported and unsupported boundaries

Supported V1 is one owner operating several trusted PCs against one Hub. It
does not provide multiple users, teams, tenant isolation, RBAC, OIDC, horizontal
Hub replicas, automatic failover, remote Git execution, remote filesystem
browsing, or an authoritative remote-ref lock. SQLite remains a single-process
store. Public hosting, service installation, DNS/certificate changes, real
enrollment, and operator database mutation are deployment actions and require
separate authorization from source implementation.
