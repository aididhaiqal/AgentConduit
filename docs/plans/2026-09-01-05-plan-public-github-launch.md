# Public GitHub launch and product README

**Goal:** Present AgentConduit clearly to public users, establish its chosen
open-source identity, and publish the verified source to the owner's canonical
public GitHub repository.

**Why planning is required:** This changes the project's public narrative and
package metadata, requires a consequential license decision, and creates and
pushes to a public external repository.

**Acceptance:** The root README explains the real coordination problem,
provider-neutral design, local and multi-PC topology, safety boundaries,
job-event model, current maturity, and a verified quick start without claiming
unproven deployment or package publication. It opens with a source-controlled
hero, a restrained evidence-backed badge row, and Mermaid diagrams that make
the topology, FIFO integration handoff, and job lifecycle understandable at a
glance, including why push wakes clients while durable reads remain
authoritative. The owner-selected license and canonical repository metadata
agree across all publishable artifacts. The public
`aididhaiqal/AgentConduit` repository contains the exact reviewed local `main`
commit, renders the README, and reports a green source-publication check.

### Outcome 1: Public product narrative

- **Work:** Replace the compact root README with a welcoming product front door
  that starts from the real multi-agent merge collision, explains why native
  runtime messaging is insufficient across providers, shows the architecture
  and durable coordination model, distinguishes liveness from progress and
  completion, presents supported topologies and packages, and links readers to
  accurate setup, operations, protocol, security, and distribution guidance.
  Give that narrative a source-controlled vector hero, truthful badge row,
  compact capability strip, and Mermaid views of deployment topology, ordered
  integration authority, job/event semantics, and push hints versus durable
  recovery.
- **Risks/open questions:** Keep the core narrative universal rather than
  Atlas-, Claude-, or Codex-specific. Do not describe local tests as an operator
  deployment, raw Git advisory coordination as hard enforcement, or unshipped
  npm packages as installable releases.
- **Verify:** `pnpm format:check`, SVG structure and dimensions, Mermaid block
  structure, and a bounded link/claim inspection against the governing docs.

### Outcome 2: Public release identity

- **Work:** The owner selected MIT on 2026-09-02. Add its canonical text and
  make the root and six publishable package manifests agree on the license,
  repository, homepage, and issue-tracker metadata. Set an accurate GitHub
  description and bounded discovery topics; do not publish npm artifacts or
  create a release.
- **Risks/open questions:** The MIT choice does not establish repository or npm
  scope ownership, signing, provenance, or package publication; those remain
  distinct gates.
- **Verify:** `pnpm type:check`, `pnpm test`, `pnpm build`, `pnpm ci:check`,
  `pnpm format:check`, `pnpm skill:check`, `pnpm pack:check`, and
  `pnpm audit --audit-level=high` from the exact release candidate.

### Outcome 3: Public source publication

- **Work:** Commit the reviewed README, license, metadata, plan, and reconciled
  ledger; create the public `aididhaiqal/AgentConduit` repository; add it as
  `origin`; push `main`; and verify the remote branch and rendered repository
  identity. Preserve the local commit if any remote step fails.
- **Risks/open questions:** Stop on GitHub authentication drift, repository-name
  collision, unexpected tracked secrets, mismatched remote revision, or an
  unresolved license. If repository creation succeeds but push or verification
  fails, do not delete or recreate it automatically; report the exact partial
  state for safe recovery.
- **Verify:** `git status --short --branch`, `git ls-remote origin refs/heads/main`,
  and `gh repo view aididhaiqal/AgentConduit` plus the resulting GitHub Actions
  run for the pushed commit.

## Authority and stopping conditions

- The user authorized a public GitHub repository and source push after the
  public README is prepared. This does not authorize npm publication, a GitHub
  Release, service installation, deployment, personal agent configuration, or
  a live provider/quota run.
- The owner selected MIT for this source release. Changing that license remains
  an owner decision and is outside this launch execution.
- Completion keeps source-implemented, locally verified, committed, pushed,
  published as source, packaged, npm-published, deployed, and operator-runtime
  verified as separate evidence states.
