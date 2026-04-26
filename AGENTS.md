# Claude-Terminal Agent Instructions

<!-- BEGIN:cross-agent-agent-rules -->
## Cross-Agent Compatibility

This repository is prepared for both Codex and Claude Code. Keep durable project instructions here in `AGENTS.md`; Claude loads `CLAUDE.md`, which should import this file with `@AGENTS.md`.

### Start Here
- [README.md](README.md) — README.
- [ARCHITECTURE.md](ARCHITECTURE.md) — architecture.
- [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) — agent guide.

### Common Commands
- Use the existing README and project files to identify the smallest relevant build or test command.

### Working Rules
- Keep changes small, reviewable, and tied to the requested behavior.
- Prefer existing architecture, naming, and helper patterns over new abstractions.
- Validate data at system boundaries instead of relying on guessed shapes.
- Update docs when behavior, commands, architecture, or setup changes.
- Run the narrowest relevant verification first, then broader checks when risk warrants it.
- If a command cannot run, record the blocker and the residual risk in the handoff.
<!-- END:cross-agent-agent-rules -->

## Notes

Add project-specific architecture, testing, release, and safety rules above or in linked docs as they become stable. Keep this file concise enough to fit comfortably in agent context.
