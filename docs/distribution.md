# Distribution and release boundary

AgentConduit has six independently packable artifacts:

| Package                            | Purpose                                                          | Consumer                                              |
| ---------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| `@agentconduit/core`               | Git discovery, SQLite state, messaging, and lease semantics      | The broker and alternate transport implementers       |
| `@agentconduit/server`             | `agentconduit-mcp` launcher plus reusable MCP HTTP/stdio modules | Operators and MCP client integrations                 |
| `@agentconduit/bridge`             | Provider-neutral heartbeat/inbox supervisor and MCP client       | Runtime wrappers that explicitly own a process/thread |
| `@agentconduit/hub`                | Single-owner multi-PC authority and web dashboard                | The owner's self-hosted Hub                           |
| `@agentconduit/node`               | Outbound device agent and local MCP endpoint                     | Each trusted owner PC                                 |
| `@agentconduit/coordination-skill` | Provider-neutral `SKILL.md` and recovery guidance                | Codex, Claude Code, and other Agent Skills clients    |

The server executable is the broker launcher. The optional bridge executable
is a headless lifecycle supervisor; coordination remains an MCP tool surface,
and provider-specific runtime behavior remains an explicitly supplied adapter
rather than a competing command-line workflow.

## Install from this source checkout

Requirements are Git, Node.js 22.20 or later, and pnpm 11.7.

```bash
pnpm install --frozen-lockfile
pnpm build
node apps/server/dist/main.js init \
  --config /absolute/private/config.json \
  --data-dir /absolute/private/data \
  --allowed-root /absolute/workspaces
node apps/server/dist/main.js serve --config /absolute/private/config.json
```

For single-owner multi-PC operation, initialize the Hub and enroll each Node
from the same build. Do not expose the workstation server remotely:

```bash
node apps/hub/dist/main.js init \
  --config /absolute/private/hub-config.json \
  --data-dir /absolute/private/hub-data \
  --public-base-url https://conduit.example.net
node apps/hub/dist/main.js serve --config /absolute/private/hub-config.json

node apps/node/dist/main.js enroll \
  --config /absolute/private/node-config.json \
  --state-dir /absolute/private/node-state \
  --hub https://conduit.example.net \
  --enrollment-code-file /absolute/private/enrollment-code \
  --name "Studio PC" \
  --allowed-root /absolute/workspaces
node apps/node/dist/main.js serve --config /absolute/private/node-config.json
```

The production TLS, enrollment, service, backup, migration, and recovery
sequence is in [`multi-pc-operations.md`](multi-pc-operations.md).

The canonical skill directory in a source checkout is
`skills/agentconduit-coordination`. Symlink or copy that complete directory to
the client's repository-scoped or personal skill-discovery path as described
in `getting-started.md`.

## Install published artifacts

No package has been published from the current checkout. After an authorized
release publishes the scoped packages, an operator can install the broker with:

```bash
npm install --global @agentconduit/server
agentconduit-mcp --help
```

Install `@agentconduit/hub` only on the Hub host and
`@agentconduit/node` on each enrolled PC:

```bash
npm install --global @agentconduit/hub
npm install --global @agentconduit/node
agentconduit-hub --help
agentconduit-node --help
```

Install the skill data package once, then expose that installed directory to
each client's discovery path:

```bash
npm install --global @agentconduit/coordination-skill
skill_source="$(npm root --global)/@agentconduit/coordination-skill"
mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
ln -s "$skill_source" "$HOME/.agents/skills/agentconduit-coordination"
ln -s "$skill_source" "$HOME/.claude/skills/agentconduit-coordination"
```

Use a copy instead of a symlink on platforms or filesystems where symlinks are
not appropriate. A repository-scoped install uses the same package directory
under `.agents/skills` and `.claude/skills`.

## Verify package contents

Run the full project checks, then inspect dry-run tarball manifests:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm type:check
pnpm ci:check
pnpm format:check
pnpm skill:check
pnpm pack:check
pnpm audit --audit-level=high
```

The server tarball contains compiled `dist` files, its package metadata and
README; source, tests, agent guides, and TypeScript build metadata are excluded.
The bridge tarball contains its compiled `dist` files, package metadata, and
README; it does not contain provider credentials, session tokens, or runtime
process state.
The Hub tarball contains its compiled server, bundled static dashboard assets,
package metadata, and README. The Node tarball contains its compiled launcher,
package metadata, and README. Neither tarball contains an initialized database,
configuration, certificate, owner token, device token, local bearer, event
cursor, or enrollment code.
The skill tarball contains `SKILL.md`, its references, package metadata, and
README.

`pnpm ci:check` structurally parses every workflow, follows referenced local
reusable workflows and composite actions, and fails closed on missing,
escaping, or cyclic local references. External actions and reusable workflows
must end in a full 40-hex commit SHA; Docker actions, job containers, and
service containers must use `sha256` image digests. Its retained fixtures cover
quoted keys and flow mappings so equivalent YAML spellings cannot bypass the
check.

This is a repository regression check, not a pre-execution security boundary:
the workflow's checkout and tool-bootstrap steps necessarily run before a
checker stored in the checkout. A hosted repository must separately require
full-SHA action pinning where the GitHub plan supports it, protect workflow and
local-action changes through review, and make the independent policy/check a
required merge gate. Do not treat an in-workflow pass as proof that an unsafe
bootstrap reference could not already have executed.

## Public-release gates

Packing is local and does not publish anything. Publishing is an explicit
external mutation and must be authorized separately. Before a public release:

1. choose and add the project's license, then declare that same license in all
   publishable package manifests;
2. create or select the canonical repository and add accurate `repository`,
   `homepage`, and issue-tracker metadata instead of guessing a URL;
3. confirm ownership of the `@agentconduit` package scope;
4. run the retained tests plus `pnpm pack:check` from the exact release commit;
5. review the immutable CI action revisions; enable externally enforced action
   pinning and protected review/branch requirements; and configure package
   provenance/signing plus least-privilege publish credentials;
6. publish `@agentconduit/core` before the matching server and Hub versions,
   publish `@agentconduit/server` and `@agentconduit/hub` before the matching
   Node, then publish the bridge and skill artifacts;
7. install the packed or published artifacts in a clean directory, initialize a
   disposable production configuration, and run doctor, backup, migration
   preflight, maintenance preview, HTTP readiness/shutdown, stdio, Hub dashboard
   asset, two-Node cross-clone, and real MCP coordination smoke checks before
   describing the release as usable.

Source implemented, packed, published, deployed, and production-verified are
separate evidence states.
