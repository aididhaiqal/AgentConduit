# AgentConduit recovery

Read the current broker state and the actual Git state before choosing a
recovery action. A timeout or disconnected client does not establish whether a
state-changing call succeeded.

## Hub outage, Node revocation, or event replay reset

- `hub_unavailable` with `coordinated=false` means no new authority was
  granted. Do not use cached queue/lease state, start a local broker, or repeat
  an external Git mutation. If the task may touch shared state, stop.
- Once the Hub is reachable, use the existing protected Node credential,
  heartbeat, reconnect/register the agent with its prior protected session
  state when available, then read inbox, peers, leases, and integration records
  before comparing real local refs. Restore observation before choosing a
  transition.
- A `forbidden` device response may mean revocation or credential mismatch.
  Stop Node-backed coordination and involve the owner. Re-enrollment creates a
  new device identity; it does not inherit or release the old device's uncertain
  agent authority.
- A stale or revoked device never proves its processes stopped or its Git
  operation did not happen. Preserve live/uncertain leases and claims and open
  an owner reconciliation case rather than force-releasing them.
- An SSE replay reset moves only the wake-up cursor. Pruned or oversized replay
  may reset directly to the Hub's latest cursor and require a fresh snapshot;
  it does not lose the authoritative inbox, queue, lease, or snapshot records.
  Drain those durable paged reads normally, then replay relevant `job.events`
  from each last known job cursor. Never synthesize acknowledgements or job
  progress from audit events.

## Registration or runtime restart

- Call `agent.register` again with the same runtime, stable `sessionRef`, and
  worktree path, and include the prior token in the `sessionToken` field.
  AgentConduit returns the same registration for that tuple, including after a
  clean unregister, but returns a fresh `sessionToken`. A missing or mismatched
  prior token cannot reconnect the existing session. Replace the old token
  everywhere before making another state-changing call; the old token is
  invalid immediately after the successful reconnect.
- If no stable `sessionRef` was supplied originally, register a new agent and
  use messages to identify the replacement. Do not guess the old `agentId`.
- If registration reports `legacy_session_without_token`, the database was
  upgraded from a pre-token schema and the old identity cannot be safely
  resumed. Choose a new unique `sessionRef` to re-enroll; never retry the old
  tuple without a broker-issued token.
- Read `message.inbox` with the new token, then `agent.list` and relevant
  `integration.get` records before resuming work.

## Target moved or request needs refresh

- `integration.claim` changes a request to `needs_refresh` when the target OID
  differs from the one observed at enqueue or the last refresh.
- A `needs_refresh` request retains its FIFO position and blocks later requests
  for the same repository and target ref.
- The requester should promptly reconcile with the current target and call
  `integration.refresh` with its session token, or call `integration.cancel` if
  the work will not continue. A target ref is canonicalized by the broker;
  use the returned fully qualified direct ref in subsequent notes.
- Other agents should message the requester rather than bypassing it. A
  requester cannot cancel another agent's active `claimed` request; only the
  claimant can cancel while that lease is live.

## Lease expired

- While a claim is active, renew its target-ref lease with `integration.renew`
  (including the claimant's session token, request ID, and registered
  workspace path) before `expiresAt`; the generic `lease.renew` tool cannot
  renew an integration lease.
- An expired integration claim returns to `needs_refresh` when AgentConduit
  next recovers expired leases. The requester must refresh it before another
  claim.
- Stop starting new shared mutations after expiry. Inspect whether an external
  Git operation was already started or completed; expiry does not roll it back.
- If Git changed but the broker could not record completion, do not claim and
  run the same operation again. Report the exact Git and broker states for
  human reconciliation. The current protocol has no administrative force-
  complete transition.

## Uncertain enqueue, message, or completion

- For an uncertain enqueue, use `integration.list` scoped by repository and
  the returned canonical `targetRef` (for example, `refs/heads/main`) and
  inspect requester/source details before creating another request. The
  service canonicalizes simple branch aliases for this read-only filter too;
  use the fully qualified value in logs and recovery notes.
- For an uncertain message, check `message.inbox` only when operating as the
  recipient and authenticate with its session token. Otherwise resend only
  when duplication is harmless and reuse a meaningful `correlationId`.
- For an uncertain completion, call `integration.get` and inspect the actual
  target ref. If it is still `claimed`, the lease remains valid, and the target
  is at the intended OID, retry `integration.complete` with the claimant's
  session token and the verified current OID in `postTargetOid` for every
  non-cancelled outcome, including `failed`. If any condition is false, stop
  and reconcile instead of inventing an OID or outcome.

## Uncertain job event, timeout, or stale job

- After an uncertain `job.create`, call `job.list` with the owner filter and
  inspect the intended safe identity before retrying. Reusing the same
  idempotency key and exact input is safe; changing input under that key is a
  conflict.
- After an uncertain `job.emit`, call `job.get` and replay `job.events` from
  the prior cursor. If the event is absent, the owner may retry the exact event
  with the same idempotency key. Never change an uncertain retry into a
  different lifecycle transition.
- A bounded wait or empty event page proves only that no matching event was
  returned in that interval. It does not prove completion, cancellation,
  abandonment, provider failure, or safe cleanup.
- A non-terminal job whose derived activity is `stale` remains durable and
  inspectable. Only its authenticated owner can append its outcome. A peer that
  needs action sends a durable message or starts an explicitly authorized
  replacement job with a new identity; it does not take over the stale row.
- After reconnect or Hub restoration, read the job record and resume event
  replay from the last retained global cursor before emitting again. Push and
  SSE are wake-up hints, not the job history.
- Maintenance deletes only terminal jobs older than the explicit job cutoff;
  every non-terminal job is retained regardless of age. Never request a
  terminal event merely to make retention cleanup possible.

## Agent disappeared while holding a claim

- A clean `agent.unregister` returns its claimed request to `needs_refresh` and
  releases its leases; authenticate with that agent's session token.
- Without a clean unregister, wait for lease expiry and inspect the external
  Git state. A stale presence indicator alone does not release a lease.
- Do not use the requester's credentials to cancel a live claim held by another
  agent. Wait for the claimant to stop/cancel or for lease expiry recovery.
- A permanently orphaned earlier request can block its target queue. The
  owner may cancel it only while it remains unclaimed. A claimed or otherwise
  uncertain external operation has no administrator force-complete or
  force-release transition; preserve the database and escalate rather than
  editing SQLite directly.
- An operator may run AgentConduit maintenance after an explicit age cutoff.
  That workflow recovers already-expired leases, but it refuses to reconcile a
  stale agent that still has any lease or claimed integration. Agents must not
  request maintenance as a shortcut, interpret `offline` as proof that Git was
  untouched, or bypass the remaining queue. Inspect the real Git state and the
  retained request before accepting a handoff.

## Safe retry rule

Read operations are safe to repeat. For state-changing operations, first read
the resource and determine whether the intended transition already occurred.
Never use a blind retry loop around Git integration, completion, cancellation,
acknowledgement, job creation/event emission, or lease release.
