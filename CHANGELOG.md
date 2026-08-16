# Changelog

All notable changes to this project will be documented here. This project uses
Semantic Versioning.

## [0.3.0] - 2026-08-16

### Added
- **Master on/off switch: `/simplewatcher disable` / `/simplewatcher enable`
  (`off`/`on` also accepted).** `disable` stops every live watch, refuses new
  ones for the rest of the session, and persists to the global config
  (`"enabled": false` at the top level of `~/.pi/agent/simplewatcher.json`) so a
  fresh session starts disabled too — the bundled inbox default and all
  persisted watches stay disarmed until `enable` re-arms them identically to a
  fresh `session_start`. Mirrors simplesay's `/simplesay disable`: silence the
  extension without uninstalling it. Bare `/simplewatcher` now reports DISABLED
  when off. Per-watch `enabled` still applies on top — a watch must be both
  master-enabled and per-watch-enabled to arm.

## README hero (2026-08-02)

- **New `assets/readme/hero.svg`** — the real differentiator (injects new file
  content into the live session the moment it lands, vs. a manual inbox check
  where a message sits unread until the next human prompt) as a before/after
  timeline, not a mockup screenshot. Same layout system and near-black canvas
  as the simplesay/simplecontext heroes so the studioschade repos read as
  siblings; distinct teal→blue accent for the watcher/monitor identity.
- Verified by rendering (inkscape PNG, 1200px) and visual inspection; wired
  into the top of the README as a centered hero block. Approved by Allen
  2026-08-02 before push.

## [0.2.2] - 2026-08-02

### Changed
- GitHub repository renamed to `studioschade/pi-simplewatcher`; package metadata and install docs updated.

## [0.2.1] - 2026-08-02

### Changed
- Renamed the npm package to `pi-simplewatcher`; npm rejected `simplewatcher` as too similar to the existing `simple-watcher` package. GitHub repo stays `studioschade/simplewatcher`.

## [0.2.0] - 2026-08-02

### Added
- Persistent watches via `--persist` (project `.pi/simplewatcher.json`) and `--persist --global` (`~/.pi/agent/simplewatcher.json`).
- `/simplewatcher persisted` to list saved watches and config paths.
- `/simplewatcher remove <path>` now stops the live watch and forgets persisted entries for the same resolved path.
- Unknown `--flags` are rejected instead of being folded into the watch path.

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
