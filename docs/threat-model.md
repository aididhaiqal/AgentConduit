# Single-owner AgentConduit threat model

## Scope and security objective

AgentConduit supports one owner coordinating trusted coding-agent processes on
one workstation or across several trusted PCs through one self-hosted Hub. The
objective is to prevent accidental cross-agent races, credential disclosure
through AgentConduit, unsafe workspace discovery, silent schema changes,
split-brain coordination, and loss of recoverable authority state.

It is not a sandbox against malicious code already running as the trusted OS
user. It cannot enforce Git behavior outside its protocol. Multiple users,
teams, tenants, hostile shared hosting, managed SaaS, Hub clustering, and
authoritative remote-ref locking are out of scope.

## Assets

- Hub owner token and browser sessions;
- enrollment codes, per-device credentials, and Node-local MCP bearers;
- per-agent session tokens;
- absolute local repository/worktree paths and locally observed Git facts;
- redacted Hub workspace labels, device provenance, health, and Git facts;
- plaintext messages, reconciliation reasons, and integration result notes;
- live leases, fencing tokens, FIFO position, and unresolved claims;
- SQLite databases, sidecars, backups, audit history, event cursors,
  configuration, certificates/private keys, and logs; and
- owner/repository authority to merge, push, deploy, or mutate external state.

## Trust boundaries and entry points

```text
workstation profile
  trusted OS user
    ├─ MCP clients ─ bearer-authenticated loopback HTTP ─┐
    ├─ stdio clients ─ process/filesystem permissions ───┤ broker + SQLite
    └─ Git roots ─ canonical containment/fixed Git args ─┘

multi-PC profile
  trusted PC A                                  trusted Hub host
    MCP client ─ local bearer ─ loopback Node ─ HTTPS/device bearer ─┐
    Git roots ─ local discovery/redaction ────── attestations ────────┤
                                                                     ├─ Hub + SQLite
  trusted PC B ─ same independent boundaries ────────────────────────┤
  owner browser ─ HTTPS ─ owner session + origin/CSRF ────────────────┘
```

The TLS reverse proxy, when used, is inside the trusted Hub-host boundary. It
must preserve the configured host and overwrite `X-Forwarded-For` with one
client IP. The Hub accepts that address only from its numeric-loopback peer;
direct TLS ignores forwarding headers. An enrolled Node is a trusted owner
device, not an isolated tenant. MCP messages and peer instructions remain
untrusted coordination input. No AgentConduit credential grants repository,
merge, push, deployment, production-data, or provider authorization.

## Threats, controls, and residual risk

| Threat                                                              | Implemented controls                                                                                                                                                                                                      | Residual risk / operator control                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workstation listener exposed remotely                               | Production broker accepts numeric loopback only, requires bearer authentication, and validates Host                                                                                                                       | Same-user code can reach loopback; never proxy or port-forward the workstation broker                                                                                                   |
| Hub traffic interception or origin confusion                        | Production Hub requires an HTTPS public origin; direct TLS or loopback reverse-proxy mode; exact Host/origin checks; secure cookies and HSTS                                                                              | DNS, CA, proxy, and certificate renewal remain operator infrastructure; protect the proxy and restart direct TLS after renewal                                                          |
| Owner token theft or browser request forgery                        | Owner token is file-backed and absent from SQLite/logs; constant-time comparison; short-lived HttpOnly same-site cookie; exact-origin CSRF on mutations; per-client bounded login attempts behind the validated proxy hop | A compromised owner browser/OS can act as the owner and read message content; protect the endpoint, browser profile, and token file                                                     |
| Enrollment interception or reuse                                    | Random one-time code, ten-minute expiry, hash at rest, per-client bounded enrollment attempts behind the validated proxy hop, POST body rather than URL, atomic consume                                                   | Anyone holding an unused code during its lifetime can enroll as that trusted PC; transfer it over an encrypted owner-approved channel and retire copies                                 |
| Device credential theft                                             | Random per-device token, hash at rest, independent identity and revocation, TLS transport, recursive log redaction                                                                                                        | A stolen live token can act as that trusted owner device and read owner-wide routing state; revoke, stop the Node, and reconcile existing authority                                     |
| Node-local bearer theft                                             | Random protected file, numeric-loopback listener, Host and bounded HTTP controls, separate device/session credentials                                                                                                     | Same-user local malware can access loopback or readable process state; Node is not a local sandbox                                                                                      |
| Session takeover after abandonment                                  | Stable tuple reconnection requires the previous agent token and rotates it; hashes at rest; stale rows remain visible; future timestamps are not fresh                                                                    | A stolen live session token can act as that agent; abandoned UI state is not proof of process or Git inactivity                                                                         |
| Local path or secret leakage to Hub                                 | Realpath containment, local-only Git discovery, mandatory explicit project ID, pre-network attestation, device-scoped URIs/path labels, bounded schemas, redacted logs                                                    | A configured label, branch, normalized remote, message, or result note may still be sensitive; choose labels carefully and never place credentials in Git remotes or messages           |
| Hub causes local code or filesystem execution                       | Node RPC has a fixed operation schema; Node derives paths from local MCP input; no Hub-initiated RPC, shell, filesystem browse, or Git mutation                                                                           | A malicious local MCP client inside an allowed root can request bounded Git discovery available to that OS user                                                                         |
| Malicious or compromised enrolled Node lies about Git               | Device provenance is persisted; attestation schema and project-derived repository ID are validated; every agent operation remains device/session-bound                                                                    | The Hub cannot independently inspect another PC; treat enrolled PCs as trusted and use provider/authoritative-clone evidence before mutation                                            |
| Cross-clone identity spoofing                                       | Multi-PC Node requires explicit validated `projectId`; Hub access still requires an enrolled device; workspaces retain device provenance                                                                                  | `projectId` is public namespace data, not authentication or a remote-ref lock; use protected branches or a provider merge queue for enforcement                                         |
| Concurrent integration, ABA, or FIFO bypass                         | Durable FIFO, canonical target refs, source/target OID evidence, renewable target lease, fencing token, claimant/session/device binding                                                                                   | Raw Git, IDEs, hooks, another Hub, and unsynchronized clones can bypass advisory state; enforce protected provider workflows where required                                             |
| Hub outage or Node fallback creates split brain                     | Node returns fail-closed unavailable results; readiness tracks heartbeat freshness; no local cached lease or broker failover; durable Hub remains authoritative                                                           | Availability is single-Hub; the owner must restore service and reread state rather than continue coordinated mutation offline                                                           |
| Revocation, staleness, expiry, or cursor reset releases uncertainty | Revocation rejects new calls but preserves claims; stale rows remain visible; expiry requires refresh; SSE only wakes durable reads; reconciliation is non-destructive                                                    | AgentConduit cannot roll back or prove an external Git process outcome; inspect real processes, Git refs, and provider evidence                                                         |
| SSE loss, duplication, replay, pruning, or slow consumers           | Monotonic durable audit cursor, gap-free subscribe-before-replay, record/byte replay caps, reset-to-snapshot envelopes, network backpressure, protected Node cursor, idempotent durable reads                             | Push does not guarantee model-turn delivery and may be delayed; inbox/state polling remains the correctness path                                                                        |
| Dashboard XSS, clickjacking, or unsafe control expansion            | Local static assets, no CDN/telemetry, restrictive CSP, frame denial, safe text insertion, exact four bounded controls, server-side authorization                                                                         | Authenticated message content is intentionally displayed; future UI changes must preserve escaping, CSP, and control bounds                                                             |
| Database corruption or unsafe upgrade                               | Current-schema startup, quick/foreign-key checks, ordered explicit migrations, preview, verified non-overwriting backup-before-migrate                                                                                    | Storage/host failure and operator replacement remain possible; keep protected encrypted backups and test restore on copies                                                              |
| Destructive or fabricated recovery                                  | No force-release/force-complete, no in-place restore, non-destructive reconciliation, preserved claims, explicit backup paths                                                                                             | Recovery can require human investigation and downtime; do not edit SQLite authority rows by hand                                                                                        |
| Request/resource exhaustion                                         | Body, connection, request, socket, rate, and shutdown bounds; capped responses/events/log values                                                                                                                          | Limits are process- or source-IP-wide, not tenant quotas; an enrolled or same-user client can still degrade a single process                                                            |
| Symlink or permission substitution                                  | Config/token/database parents and files are bounded regular non-symlinks; POSIX owner/private checks; non-overwriting initialization                                                                                      | Native Windows ACL equivalence is not verified; WSL production state belongs on the Linux filesystem                                                                                    |
| Supply-chain substitution                                           | Frozen lockfile, pinned tool versions, immutable CI reference checks, package-content smoke, dependency audit, no CDN dashboard code                                                                                      | In-repository CI checks run after checkout/bootstrap; hosted release needs protected workflow review, externally enforced action policy, signing/provenance, and authorized publication |

## Security invariants

1. The workstation broker and every Node MCP listener remain numeric-loopback-
   only; cross-machine traffic terminates only at the Hub HTTPS boundary.
2. The Hub never receives an absolute Node path and never requests local shell,
   arbitrary filesystem, or Git mutation execution.
3. Owner, enrollment, device, local bearer, and agent credentials never enter
   SQLite plaintext, list responses, audit metadata, structured logs, examples,
   URLs, peer messages, or dashboard storage.
4. Local Git facts are discovered under explicit allowed roots. Remote Hub
   attestations are device-provenanced and are never misrepresented as
   independently server-observed facts.
5. A cross-PC repository has an explicit project ID. That namespace does not
   authenticate a device or become an authoritative remote-ref lock.
6. No target mutation is coordinated without the live FIFO claim, fencing
   token, fresh local ref evidence, and repository authorization. AgentConduit
   itself never performs the mutation.
7. Hub outage, device revocation, stale presence, lease expiry, PID, path label,
   branch, UI/chat state, SSE event, or dashboard intent alone never releases or
   completes uncertain authority.
8. SSE and provider-native push are hints. Durable Hub reads and explicit
   acknowledgements/transitions are the correctness path.
9. Serving never creates or migrates an absent/old production database;
   previews do not mutate; backups are verified and never overwritten.
10. Implemented, tested, packed, published, deployed, and runtime-verified
    remain separate claims.

## Expansion boundary

The Hub solves one person's multiple-PC problem. Multiple users or tenants need
a different identity and authorization model, tenant-bound project enrollment,
per-principal quotas, device attestation and recovery, isolated audit/retention
and backups, abuse response, horizontally available persistence, and a fresh
threat-model/adversarial review. Those properties are not implied by HTTPS or
device tokens.
