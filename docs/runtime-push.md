# Runtime push capability probe

AgentConduit keeps durable inbox polling as its correctness path. The MCP
protocol does not promise that a server notification wakes a model, and the
host APIs that can steer a model are provider-specific. This page records the
small, disposable experiments that were run against the installed clients and
the retained Claude probe that can be rerun after a client upgrade.

## Capability matrix

The words **owned** and **active** are important. Each positive result below
used a fresh process whose controller created (and therefore owned) the thread
or stream. It does not demonstrate control of an already-open Desktop or
interactive session.

| Capability                                                | Codex CLI 0.146.0 app-server                                                                                                                          | Claude Code 2.1.250 `--print --input-format stream-json`                                                                                                                                      | Ordinary MCP notification                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Deliver a message to an owned active turn                 | **Verified.** `turn/steer` with the exact active `turnId` was accepted; the model returned `ACTIVE_OBSERVED: ACTIVE_STEER_B751A20`.                   | **Verified.** A second valid JSONL user line was written to the owned process while its MCP tool was blocked; after the tool returned, Claude incorporated it and returned `ACTIVE_PUSH_ACK`. | Not a model-turn API.                             |
| Wake an owned idle turn                                   | **Verified with an explicit host adapter.** `thread/inject_items` alone did not start a turn; a subsequent `turn/start` observed the injected marker. | **Verified (owned stream).** After the first result, a second JSONL line sent during an idle gap started a second turn and Claude returned `IDLE_PUSH_ACK`.                                   | **Not verified.**                                 |
| Append context without starting a turn                    | **Verified** with Codex `thread/inject_items` (experimental, version-sensitive).                                                                      | Not applicable to the tested stream interface.                                                                                                                                                | Not applicable.                                   |
| Deliver while disconnected                                | Use AgentConduit durable inbox polling.                                                                                                               | Use AgentConduit durable inbox polling.                                                                                                                                                       | Notification may be lost or consumed by the host. |
| Address an arbitrary existing Desktop/interactive session | **Not verified.** The app-server process owned the tested thread.                                                                                     | **Not verified.** The harness owns the Claude subprocess's stdin.                                                                                                                             | No supported addressability contract.             |
| Native/private IPC                                        | Codex app-server methods are experimental and version-specific.                                                                                       | A disposable authenticated probe accepted the undocumented pipe's `auth` and `user` frames, but no model-visible delivery was observed. Do not depend on this protocol.                       | N/A                                               |

### What the standard MCP test means

The probe server emitted an unsolicited `notifications/message` after the MCP
connection initialized. In the Claude run, the timestamped server log places
that send before the model invoked the probe tool; it therefore is not an
active-call ordering test. In the tested Claude and Codex CLI configurations,
the model did not report seeing the marker. A transport-level send is not
evidence of model wake-up or of a delivered handoff. Keep the message in
AgentConduit's durable inbox and acknowledge it only after the recipient has
read it through MCP.

## Dual-runtime broker acceptance probe

[`poc/dual-runtime-broker-push-probe.mjs`](../poc/dual-runtime-broker-push-probe.mjs)
is the disposable end-to-end check for the shared coordination boundary. It
starts one loopback broker, creates a temporary Git repository with a linked
worktree, and owns one Claude Code stream process and one Codex app-server
process. It does not use a real checkout, branch, remote, credential file, or
merge operation.

The clean run on 2026-08-31 completed with:

- Claude Code 2.1.250 and Codex CLI 0.146.0 both connected to the same MCP
  broker and completed real `agent.register` calls;
- server-side Git discovery reported one repository scope and two distinct
  worktree IDs;
- Claude completed `message.send`, the coordinator observed the message
  pending, and Codex completed `message.inbox` followed by `message.ack`;
- the broker reported a non-null acknowledgement timestamp; and
- two real-Git integration requests for the same `main` target produced one
  lease winner and one `conflict`.

The redacted evidence directory printed by that run was
`/mnt/c/Users/aidid/AppData/Local/Temp/agentconduit-dual-runtime-lPGi3k`.
Its `summary.json` reports every acceptance flag as `true`; the temporary
runtime root was removed during teardown. The evidence records hashes and
metadata only—never session tokens, bearer tokens, prompts, or raw model
output.

Codex 0.146.0 emits an `mcpServer/elicitation/request` before a mutating MCP
tool call. The harness answers the empty, form-mode request for the temporary
`agentconduit` server with the MCP-shaped response
`{"action":"accept","content":{}}` and declines requests that do not match
that disposable shape. This is a version-sensitive app-server adapter detail,
not part of AgentConduit’s provider-neutral protocol.

To rerun the check after building (it consumes the configured client quotas):

```bash
AGENTCONDUIT_RUN_DUAL_RUNTIME_POC=1 \
  node poc/dual-runtime-broker-push-probe.mjs
```

The live harness owns both client processes, so this result proves cross-runtime
MCP registration and durable acknowledgement only for those owned processes. It
does not prove that a broker can steer an arbitrary already-open Claude or Codex
Desktop session; keep durable inbox polling as the correctness path.

## Native Codex `claude_collaborator` POC

[`poc/native-claude-collaborator-probe.mjs`](../poc/native-claude-collaborator-probe.mjs)
proves a different boundary from provider-native push: Codex itself creates a
named native subagent. That subagent has one configured MCP server: a local
AgentConduit stdio runtime whose enabled MCP tools asynchronously own a Claude
Code child. Its read-only sandbox and instructions prohibit other tool use,
and the retained live transcript verifies the two MCP calls recorded below.
The current source additionally exposes `claude_events`, a bounded
cursor-based projection of normalized safe progress; that later projection has
fake-provider coverage but has not been rerun against provider quota.
The custom-agent configuration follows the official Codex
[multi-agent](https://developers.openai.com/codex/multi-agent) and
[configuration reference](https://developers.openai.com/codex/config-reference)
contracts; it exists only inside the probe's temporary `CODEX_HOME`.

The corrected live run on 2026-09-01 completed with:

- Codex CLI 0.146.0 using `gpt-5.6-luna` completed exactly one native
  `spawnAgent` from the parent thread. A subsequent `thread/read` bound the one
  receiver to role `claude_collaborator` and to the same disposable Git
  worktree;
- only that receiver thread completed the local `claude_start` and
  `claude_wait` MCP calls;
- Claude Code 2.1.250 using `claude-haiku-4-5-20251001` launched in 32 ms in
  that worktree, under a USD 0.10 maximum budget, and returned the randomized
  marker;
- Claude's initialization advertised zero built-in tools and zero MCP servers,
  its stream emitted zero tool uses, and its direct child closed;
- the parent turn completed and its final answer equalled the marker exactly;
- the fixture remained at the same clean Git HEAD; and
- Codex, the runtime MCP process, and Claude were confirmed closed before the
  disposable runtime state was removed. The runtime captured Claude's Linux
  process start tick and command-line hash so failure cleanup can reject PID
  reuse and terminate only the recorded direct child.

The retained redacted evidence is
`/mnt/c/Users/aidid/AppData/Local/Temp/agentconduit-native-claude-evidence-fSZ9WK`.
An explicit scan found no raw marker, prompt, credential or authentication
path, token pattern, or local absolute path. The three files retain only
lifecycle metadata, hashes, booleans, counts, versions, and model names.

The fake-provider lane now retains twelve tests. In addition to prompt
start/wait, cancellation, exact completed-turn selection, native
role/thread/MCP correlation, early-failure process discovery, signalling
failure, Linux/WSL admission, and fail-closed capability drift, it verifies a
global event cursor, per-job sequence, bounded pagination, empty waits without
fabricated progress, safe redaction, and explicit completed/failed/cancelled
events. The temporary collaborator reads `claude_events` from its last cursor
between bounded waits and preserves the exact final Claude result behavior.
To inspect or rerun the fake lane without starting a provider:

```bash
node poc/native-claude-collaborator-probe.mjs --dry-run

# Explicitly consumes the configured Codex and Claude quotas.
AGENTCONDUIT_RUN_NATIVE_CLAUDE_COLLABORATOR_POC=1 \
  node poc/native-claude-collaborator-probe.mjs
```

Live execution is currently Linux/WSL-only because exact runtime-process
identity is verified through `/proc`. This proves that a native Codex custom
agent can act as a thin shell over a local Claude runtime. It does not register
Claude as a new Codex built-in agent type, install a personal agent, provide a
general third-party process supervisor, or make this experimental adapter a
production support boundary.

## Retained Claude stream probe

[`poc/claude-stream-push-probe.mjs`](../poc/claude-stream-push-probe.mjs) is a
deliberately opt-in harness. It starts a Claude Code child with:

- an empty temporary working directory and temporary settings/MCP config
  snapshots (the child receives them as inline JSON so WSL and native Windows
  paths do not cross a filesystem boundary);
- in active mode, only the embedded, bounded MCP wait tool is enabled (built-in
  tools are disabled); idle mode uses an empty MCP configuration to isolate
  stream turn lifecycle;
- `--print --input-format stream-json --output-format stream-json --verbose`;
- `--no-session-persistence` and a bounded `--max-budget-usd` (default `0.25`);
- no resume/continue/session attachment flags.

The harness sends only JSON objects of the form below to stdin, one complete
line at a time. It never writes timestamps, shell diagnostics, or log text to
that pipe.

```json
{ "type": "user", "message": { "role": "user", "content": "..." } }
```

In active mode, when the output stream contains a `tool_use` for the probe tool,
the harness writes a second JSONL user message immediately. Success requires
Claude to initialize the configured MCP server, the tool-use event to be
observed, the second line to be accepted before a result, the final result to
be exactly `ACTIVE_PUSH_ACK`, and the child to exit cleanly. In idle mode, the
harness waits for a first result exactly equal to `FIRST_TURN_DONE`, keeps stdin
open for the configured gap, then writes a second line and requires a second
result exactly equal to `IDLE_PUSH_ACK`. A timeout, malformed output, early
close, non-zero exit, or missing acknowledgement is reported as failure (an
early close in idle mode is evidence that idle wake is unsupported).

The harness retains a fresh directory under the operating system temporary
directory and prints its path. It contains:

| File                                      | Contents                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `events.jsonl`                            | Timestamped, redacted lifecycle/event metadata.                                                                                      |
| `inputs.jsonl`                            | Timestamp, label, byte count, and SHA-256 of each JSONL line; prompt text is not stored.                                             |
| `probe-events.jsonl`                      | Timestamped MCP probe initialization/tool/notification events.                                                                       |
| `summary.json`                            | Machine-readable success result, client version/model, exit status, and evidence paths.                                              |
| `config/mcp.json`, `config/settings.json` | Disposable snapshots of the inline MCP command and empty settings passed to the child; the child does not read these files directly. |

No raw model stream, prompt, credential, session identifier, or authentication
file is copied into the evidence directory. The child inherits the caller's
existing authentication only; the harness never reads, copies, or symlinks a
credential file. Treat any diagnostics emitted by a locally installed client
as sensitive and remove the temporary evidence directory when it is no longer
needed.

### Run it (explicit API opt-in)

From this checkout, after installing dependencies and authenticating Claude
Code in the normal way:

```bash
pnpm install --frozen-lockfile
AGENTCONDUIT_RUN_CLAUDE_POC=1 \
  AGENTCONDUIT_CLAUDE_BUDGET_USD=0.25 \
  node poc/claude-stream-push-probe.mjs

# Idle-turn wake-up mode
AGENTCONDUIT_RUN_CLAUDE_POC=1 \
  AGENTCONDUIT_CLAUDE_BUDGET_USD=0.25 \
  AGENTCONDUIT_CLAUDE_POC_IDLE_DELAY_MS=2000 \
  node poc/claude-stream-push-probe.mjs --idle
```

The first variable is mandatory; without it the script refuses to launch a
client. To inspect the launch shape without an API call:

```bash
node poc/claude-stream-push-probe.mjs --dry-run
node poc/claude-stream-push-probe.mjs --help
```

Useful controls are `AGENTCONDUIT_CLAUDE_COMMAND`,
`AGENTCONDUIT_CLAUDE_MODEL`, `AGENTCONDUIT_CLAUDE_ARGS_JSON` (safe option-only
arguments), `AGENTCONDUIT_CLAUDE_POC_MODE`,
`AGENTCONDUIT_CLAUDE_POC_TIMEOUT_MS`,
`AGENTCONDUIT_CLAUDE_POC_STARTUP_MS`,
`AGENTCONDUIT_CLAUDE_POC_TOOL_DELAY_MS`,
`AGENTCONDUIT_CLAUDE_POC_IDLE_DELAY_MS`,
`AGENTCONDUIT_CLAUDE_POC_SHUTDOWN_MS`, and
`AGENTCONDUIT_CLAUDE_POC_EVIDENCE_PARENT`. The MCP child launcher can be
overridden with `AGENTCONDUIT_CLAUDE_POC_MCP_COMMAND` and its JSON argument
array when Claude and this checkout run on different operating systems (for
example, a Windows Claude process launching `wsl.exe node ...`). Keep those
arguments free of secrets.

The default command uses the installed `claude` executable and does not pass a
positional prompt; all user input comes through the validated stream. The
temporary cwd is not a repository and the built-in command/edit tools are
disabled, but the API call still consumes account quota. Use a low budget and
do not point the probe at a real worktree.

## Recorded evidence

The matrix is based on disposable runs made outside this repository:

- Codex CLI 0.146.0 app-server: idle `thread/inject_items` plus explicit
  `turn/start`, active `turn/steer`, and the expected post-completion rejection.
- Claude Code 2.1.250 standard MCP notification: the server send completed,
  but the model reported the marker was not observed.
- Claude Code 2.1.250 stream-json active-turn run: a second JSONL line was
  written during the blocked tool call and the model returned
  `ACTIVE_PUSH_ACK`.
- The retained harness was rerun on 2026-08-31 with
  `claude-opus-5[1m]` (Claude Code 2.1.250): MCP connected, the tool-use and
  push ordering were observed, the acknowledgement was returned, and the
  child exited 0. An earlier same-day run used
  `claude-haiku-4-5-20251001`; both runs were bridge-owned stream processes.
- The same harness was rerun in idle mode on 2026-08-31 with
  `claude-opus-5[1m]` (Claude Code 2.1.250): the first result preceded the
  two-second idle gap, the second JSONL line was accepted, Claude returned
  `IDLE_PUSH_ACK`, and the child exited 0. The idle run used no MCP tools so
  stream lifecycle was isolated.
- Claude native messaging-pipe attempt: authenticated transport frames were
  accepted, but model delivery was not proven.

The retained Claude harness prints its fresh evidence directory; it is the
portable way to obtain current event files. Historical raw streams, where
captured for diagnosis, can contain prompts or runtime identifiers and must
remain local and be treated as sensitive. Evidence is tied to the exact client
versions above; rerun after upgrading Claude Code, Codex, the MCP SDK, or the
host adapter.

## Adapter rule

Provider-native push is an optional delivery hint, not a replacement for the
AgentConduit protocol:

1. Persist the AgentConduit message first.
2. If a bridge owns an active Codex turn, try `turn/steer`; if it owns an idle
   Codex thread, use `turn/start` (and `thread/inject_items` only for context).
3. If a bridge owns a Claude stream process, write one valid stream-JSON user
   line while that process is alive.
4. If the host is idle, disconnected, or the native operation is rejected,
   leave the message in the durable inbox for polling.
5. Do not mark the broker message acknowledged merely because a host accepted
   bytes or an experimental RPC. The recipient runtime must read and
   acknowledge it through MCP.

Never infer ownership from a cwd, branch name, or a displayed session label.
Bind an adapter explicitly to the host process/thread it created and retain the
provider version and capability result. A process-level success here cannot
be generalized to Claude Desktop, an arbitrary interactive terminal, or the
undocumented native messaging pipe.
