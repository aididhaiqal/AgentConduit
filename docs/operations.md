# Production workstation operations

This runbook applies to the supported production boundary: one broker on one
developer workstation, used by mutually trusted processes under one operating-
system account. For the supported single-owner, multiple-PC Hub/Node topology,
use [`multi-pc-operations.md`](multi-pc-operations.md). Neither profile is a
team, tenant, or shared-host service.

Examples use an installed `agentconduit-mcp` binary. From this source checkout,
replace it with `node apps/server/dist/main.js` after `pnpm build`.

## Initialize once

Choose private configuration and data directories outside every enrolled Git
workspace. On POSIX filesystems the directories must be owned by the current
user and grant no group or other access. WSL users should use the Linux
filesystem, not a Windows DrvFS path that cannot represent `0700`/`0600`.

```bash
mkdir -p "$HOME/.config/agentconduit" "$HOME/.local/state/agentconduit"
chmod 700 "$HOME/.config/agentconduit" "$HOME/.local/state/agentconduit"

agentconduit-mcp init \
  --config "$HOME/.config/agentconduit/config.json" \
  --data-dir "$HOME/.local/state/agentconduit" \
  --allowed-root "$HOME/code"
```

`init` refuses to overwrite a configuration, token, or database. It writes a
versioned configuration, a random bearer-token file, and a current database.
Its JSON response contains paths and health evidence but never the token.
Review the generated file against
[`examples/production/config.json`](../examples/production/config.json). Add
only canonical, narrow allowed roots; a filesystem root is rejected.

Before every service installation or upgrade:

```bash
agentconduit-mcp doctor \
  --config "$HOME/.config/agentconduit/config.json"
```

Doctor verifies configuration ownership/modes, allowed roots, current schema,
SQLite quick integrity, foreign keys, and journal mode. It does not prove that
Claude, Codex, or another runtime is connected.

## Serve and observe

```bash
agentconduit-mcp serve \
  --config "$HOME/.config/agentconduit/config.json"
```

Production accepts only numeric loopback hosts (`127.0.0.1` or `::1`) and
always requires the configured bearer token on `/mcp`. The process writes one
newline-delimited JSON record per event to stderr. Records include request IDs,
method, path, status, duration, lifecycle transitions, and safe errors. Token-
and secret-shaped fields and the configured bearer value are redacted. Logs may
still contain database paths, request timing, and opaque coordination IDs, so
protect and rotate them as developer operational data.

- `GET /livez` returns 200 when the HTTP process can answer.
- `GET /readyz` returns 200 only while the broker is not draining and the
  database passes current-schema and integrity checks.
- `GET /healthz` is a compatibility probe with fixed metadata.

Send `SIGTERM` or `SIGINT` for normal shutdown. The broker rejects new
connections, drains active HTTP work up to `http.shutdownTimeoutMs`, force-
closes remaining sockets, then closes SQLite. Do not use `SIGKILL` except when a
hung process exceeds the service manager's outer stop timeout.

The checked-in systemd user unit is an editable example, not an installed
service. Replace every path and review its sandbox against the enrolled roots
before enabling it.

## Back up

Create each backup at a new absolute path on a protected filesystem:

```bash
backup_dir="$HOME/.local/state/agentconduit/backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

agentconduit-mcp backup \
  --config "$HOME/.config/agentconduit/config.json" \
  --output "$backup_dir/coordination-2026-09-01T000000Z.db"
```

The online SQLite backup is written into a private unpredictable directory,
checked for integrity, foreign keys, and schema, then hard-linked into the new
destination without overwrite. A successful response says `status: verified`
and records the page count and schema version. Keep backups as sensitive data:
they contain absolute paths, plaintext coordination messages, and safe job
summaries.

Choose a retention schedule appropriate for the workstation. Always take a
fresh verified backup before an AgentConduit upgrade, before maintenance apply,
and before manual incident recovery. Copy backups to other storage only through
an operator-approved encrypted channel.

## Upgrade schema explicitly

Stop the broker before upgrade. First run the non-mutating preflight:

```bash
agentconduit-mcp migrate \
  --config "$HOME/.config/agentconduit/config.json"
```

If `migrationRequired` is true, apply only with a new backup path:

```bash
agentconduit-mcp migrate \
  --config "$HOME/.config/agentconduit/config.json" \
  --apply \
  --backup "$HOME/.local/state/agentconduit/backups/pre-schema-4-2026-09-01.db"
```

The migration command verifies and publishes the old-schema backup before
opening the normal ordered migration path. It refuses unknown, corrupt, newer,
or already-current schemas. `serve` and `doctor` never migrate implicitly; they
fail closed and identify the required version. After migration, rerun doctor
before starting the service.

## Reconcile stale sessions and retain history

Maintenance requires five explicit UTC cutoffs and previews by default. Pick a
stale cutoff substantially older than the heartbeat timeout and the longest
credible agent operation. Pick retention cutoffs according to the local audit
policy.

```bash
agentconduit-mcp maintenance \
  --config "$HOME/.config/agentconduit/config.json" \
  --stale-before 2026-08-25T00:00:00.000Z \
  --messages-before 2026-08-01T00:00:00.000Z \
  --integrations-before 2026-08-01T00:00:00.000Z \
  --jobs-before 2026-08-01T00:00:00.000Z \
  --audit-before 2026-08-01T00:00:00.000Z
```

Review every count and blocker, take a fresh backup, then repeat the exact
command with `--apply`. Preview executes the same transaction and rolls it back;
apply commits it. Maintenance:

- recovers already-expired leases and moves their claimed integrations to
  `needs_refresh` first;
- marks an old stale agent offline only when it has no remaining lease and no
  claimed integration;
- reports live or uncertain leases/claims as blockers and never force-releases
  them;
- deletes only acknowledged messages older than their acknowledgement cutoff,
  terminal integrations and terminal jobs older than their completion cutoffs,
  and audit events older than their creation cutoff; and
- retains unacknowledged messages plus queued, `needs_refresh`, and claimed
  integration requests, plus every non-terminal job (including stale jobs),
  regardless of age.

An offline or stale row is not proof that an external Git command never ran.
Inspect broker and Git state before reassigning a worktree or target ref.

## Restore and incident recovery

There is intentionally no in-place restore command. Restore is a high-impact
operator procedure:

1. Stop the broker and every stdio process using the same database.
2. Preserve the failed database, `-wal`, and `-shm` files together in a private
   quarantine directory; do not delete them.
3. Use a disposable private configuration that points at a copy of the selected
   backup and run `doctor`. Never test by overwriting the configured database.
4. Copy—not move—the verified backup to a new private database path and update
   the production configuration while the broker remains stopped. Keep the old
   path quarantined for rollback.
5. Run `doctor`, start the broker, check `/readyz`, and inspect agents, jobs,
   integrations, and Git refs before authorizing shared mutations.

Do not edit SQLite rows, lifecycle timestamps, lease IDs, or integration state
by hand. If broker state and Git disagree after a crash, preserve the claimed
or unresolved state and reconcile with the involved operator. Lease expiry,
stale presence, or an abandoned chat alone never proves an external mutation
is safe to repeat.

## Operational limits

This profile is one host and one user. SQLite is not a horizontal cluster, the
shared bearer is not user identity, HTTP limits are broker-wide rather than
per-principal, and timeouts cannot interrupt a synchronous Git inspection that
is already running. Do not expose this workstation listener through a proxy or
port forward. Cross-machine operation uses the separately authenticated Hub and
local Node boundary in the multi-PC runbook; multiple users, teams, tenants, and
Hub clustering remain unsupported.
