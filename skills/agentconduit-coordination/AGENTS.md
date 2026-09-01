# AgentConduit coordination skill guide

## Verification first

- Validate: `python3 /mnt/c/Users/aidid/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/agentconduit-coordination`
- Package manifest: `pnpm --filter @agentconduit/coordination-skill pack --dry-run --json`
- Formatting: `pnpm format:check`

## Conventions

- Keep one provider-neutral `SKILL.md`; client paths are discovery adapters,
  not separate Claude or Codex skill implementations.
- Never let the skill grant merge authority or imply that an advisory lease can
  prevent raw Git operations.
- Keep recovery details in `references/recovery.md` and package every referenced
  file with the skill.
