# AgentConduit repository-tool guide

## Verification first

- Skill validation: `pnpm skill:check`
- CI action pins: `pnpm ci:check`
- Root formatting: `pnpm format:check`

## Conventions

- Keep repository checks deterministic, cross-platform Node programs without
  undeclared global dependencies. Network-dependent supply-chain checks must be
  explicit and fail with a clear command-level error.
- Resolve every input path explicitly and fail closed for malformed or missing
  artifacts; checks must not rewrite the files they validate. Executable CI
  dependencies must use full commit SHAs or container-image digests.
- A new executable check belongs in a root package script and in CI in the same
  change.
