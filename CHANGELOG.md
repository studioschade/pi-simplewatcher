# Changelog

All notable changes to this project will be documented here. This project uses
Semantic Versioning.

## [0.1.0] - 2026-08-02

Initial public plugin release.

### Added
- Pi extension that watches files/directories and injects new content into the session.
- Active/passive reaction modes per watch target.
- File tailing and flat directory inbox catch-up.
- Passive boot backlog and replay-free re-arm across model changes.
- Default active watch for `$HOME/Agents/_bus/inbox/<agent>` with env override.
- `SIMPLEWATCHER_MAX_BYTES` payload cap to protect the context window.
- Pi package layout (`package.json`, `pi.extensions`, `src/index.ts`), README, GPLv3 license, self-test, and CI.
