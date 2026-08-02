# simplewatcher

A small [pi](https://github.com/earendil-works/pi-coding-agent) extension that
watches files and directories and injects new content into the current session
as it appears. It exists so an agent does not have to wait for the next human
prompt to notice that something changed on disk.

The main way we use it: **monitoring file-based inboxes used for agent-to-agent
communication.** A watcher can sit on an inbox directory and surface incoming
message files immediately, so replies, handoffs, and watcher notifications do
not sit unread until somebody remembers to run a manual inbox check.

## What it does

- **File targets are tailed, log-style.** Only bytes appended after the watch
  starts are injected, not the whole file.
- **Directory targets are watched flat, one level deep.** Files already present
  when the watch starts are caught up once as backlog; files created afterward
  are treated as new arrivals.
- **Boot backlog is passive.** Existing inbox files are injected as context for
  the next natural turn, not as one interrupting turn per stale file.
- **Re-arms do not replay.** If the watch is rebuilt — for example because
  `session_start` fires again on a model change — already-seen directory files
  and the file tail offset are carried across the re-arm.
- **New arrivals keep their mode.** A live file landing in an active watched
  inbox still triggers an immediate turn; passive watches only queue context.
- **Payloads are capped.** Injected content is limited by
  `SIMPLEWATCHER_MAX_BYTES` so a watched file/log cannot dump an unbounded blob
  into the context window.

## Reaction modes

Each watch target has one mode:

| Mode | Behavior |
|---|---|
| `active` | Inject and trigger an immediate turn, even while idle. Use for inboxes where a new file means “handle this now.” |
| `passive` | Inject as queued context only. It surfaces at the next natural turn and never speaks/acts unprompted. |

Default for manual watches is `passive`. The bundled session-start inbox watch
uses `active`, because incoming agent messages are meant to be seen promptly.

## Commands

| Command | Effect |
|---|---|
| `/simplewatcher` | List current watches |
| `/simplewatcher <path>` | Add/replace a passive watch |
| `/simplewatcher <path> --active` | Add/replace an active watch |
| `/simplewatcher <path> --passive` | Add/replace a passive watch explicitly |
| `/simplewatcher remove <path>` | Stop watching a path |

Examples:

```text
/simplewatcher ~/Agents/_bus/inbox/fabricant --active
/simplewatcher /var/log/myapp.log --passive
/simplewatcher remove ~/Agents/_bus/inbox/fabricant
/simplewatcher
```

## Bundled default: agent inbox monitor

On `session_start`, the extension arms one default watch:

```text
$HOME/Agents/_bus/inbox/<agent>   (active mode)
```

The agent name is resolved in this order:

1. `SIMPLEWATCHER_AGENT`
2. `PI_AGENT`
3. `AGENT_NAME`
4. fallback: `fabricant`

That fallback keeps this repo compatible with its original home while letting
sibling agents use the canonical source via an env override instead of keeping
a patched fork.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `SIMPLEWATCHER_AGENT` | `fabricant` fallback | Agent name used for the default `$HOME/Agents/_bus/inbox/<agent>` watch. |
| `PI_AGENT` / `AGENT_NAME` | — | Fallback agent-name sources if `SIMPLEWATCHER_AGENT` is unset. |
| `SIMPLEWATCHER_MAX_BYTES` | `32768` | Maximum injected payload bytes. Larger content is truncated with a marker. |

## Use with agent comms

In our setup, agents communicate by dropping message files into a local bus
inbox or by having another comms layer materialize messages there. `simplewatcher`
is the piece that makes those files visible to a live session immediately.

Important boundary: the watcher only **surfaces** content. It does not grant
authority. A bus/inbox message is still data, not permission to spend money,
publish outward, change another agent’s territory, or bypass the receiving
agent’s own guardrails.

## Safety / behavior notes

- Watch trusted paths. Active mode can wake the agent and start a turn from
  file content alone.
- Large injections are truncated by `SIMPLEWATCHER_MAX_BYTES`; tune it rather
  than disabling the cap unless you really mean it.
- Directory mode is intentionally flat and inbox-like. It is not a recursive
  file-sync or build watcher.
- If a watched path disappears or errors, the extension reports a watch error
  instead of throwing an unhandled watcher error.
- Empty injections are ignored: whitespace-only file content does not send a
  steer by itself.

## Requirements

- Node.js 22+ recommended for the standalone regression/import path.
- [pi](https://github.com/earendil-works/pi-coding-agent)
- No runtime npm dependencies; only `node:fs` and `node:path`.

## Development

Source of truth for this project is `index.ts` in this repo. Keep the deployed
pi extension copy in sync when changing behavior.

Useful manual smoke checks:

- Watch a temp directory in passive mode, add a file, confirm it queues without
  triggering a turn.
- Watch an inbox in active mode, add a file, confirm it triggers a turn once.
- Re-arm the same watch and confirm no backlog replay.
- Write a file larger than `SIMPLEWATCHER_MAX_BYTES` and confirm the injection
  is truncated with a marker.

## License

GNU General Public License v3.0 only — see [LICENSE](./LICENSE).

Copyright (C) 2026 the simplewatcher contributors.
