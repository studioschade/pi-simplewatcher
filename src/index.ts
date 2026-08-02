import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// simplewatcher — generic file/directory watcher that injects new content
// into the pi session as it appears, so the agent can react without waiting
// for the next user prompt.
//
// Two reaction modes per target:
//   - "active"  — triggers an immediate turn even while idle (the agent can
//                 speak/act purely because the watched path changed).
//   - "passive" — queued as context; surfaces at the agent's next natural
//                 turn instead of interrupting anything. Never speaks
//                 unprompted.
//
// File targets are tailed: only content appended since the watch started is
// injected (log-style). Directory targets are watched flat (one level, no
// recursion): every file present when the watch starts, plus anything
// created afterward, is treated as "new" and injected once — this is a
// deliberate backlog catch-up so pending items aren't missed just because
// the watch started after they arrived.

type Mode = "active" | "passive";

interface WatchTarget {
  targetPath: string;
  mode: Mode;
  isDir: boolean;
  watcher: fs.FSWatcher;
  debounce?: NodeJS.Timeout;
  // file mode
  offset?: number;
  // dir mode
  seen?: Set<string>;
}

const DEBOUNCE_MS = 200;
// Hard ceiling on injected payload size so a watched file/log can't dump an
// unbounded blob into the context window. Override with SIMPLEWATCHER_MAX_BYTES.
const MAX_INJECT_BYTES = Number(process.env.SIMPLEWATCHER_MAX_BYTES ?? 32 * 1024);

export default function (pi: ExtensionAPI) {
  const targets = new Map<string, WatchTarget>();

  function inject(targetPath: string, mode: Mode, label: string, content: string) {
    if (!content.trim()) return;
    const totalBytes = Buffer.byteLength(content, "utf8");
    let payload = content;
    if (Number.isFinite(MAX_INJECT_BYTES) && MAX_INJECT_BYTES > 0 && totalBytes > MAX_INJECT_BYTES) {
      payload = `${Buffer.from(content, "utf8").subarray(0, MAX_INJECT_BYTES).toString("utf8")}\n\n[simplewatcher: truncated ${label} — ${totalBytes} bytes total, injected first ${MAX_INJECT_BYTES}]`;
    }
    pi.sendMessage(
      {
        customType: "simplewatcher",
        content: `[simplewatcher: ${label} changed]\n\n${payload}`,
        display: true,
      },
      {
        deliverAs: "steer",
        triggerTurn: mode === "active",
      },
    );
  }

  function readAppended(targetPath: string, t: WatchTarget) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(targetPath);
    } catch {
      return;
    }
    let offset = t.offset ?? 0;
    if (stat.size < offset) offset = 0; // truncated/rotated — start over
    if (stat.size <= offset) return;

    const fd = fs.openSync(targetPath, "r");
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    try {
      fs.readSync(fd, buf, 0, len, offset);
    } finally {
      fs.closeSync(fd);
    }
    t.offset = stat.size;
    inject(targetPath, t.mode, targetPath, buf.toString("utf8"));
  }

  function scanDir(targetPath: string, t: WatchTarget, modeOverride?: Mode) {
    let files: string[];
    try {
      files = fs.readdirSync(targetPath);
    } catch {
      return;
    }
    const seen = t.seen ?? new Set<string>();
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      const full = path.join(targetPath, f);
      let content: string;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue; // e.g. archived/moved between readdir and read
      }
      inject(targetPath, modeOverride ?? t.mode, f, content);
    }
    t.seen = seen;
  }

  function scheduleDebounced(targetPath: string, run: () => void) {
    const t = targets.get(targetPath);
    if (!t) return;
    if (t.debounce) clearTimeout(t.debounce);
    t.debounce = setTimeout(run, DEBOUNCE_MS);
  }

  function addWatch(targetPath: string, mode: Mode, ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }) {
    const resolved = path.resolve(targetPath);
    const existing = targets.get(resolved);
    // Carry already-injected state across a RE-ARM of the same path. Dropping it
    // replays the entire backlog, because `session_start` fires again on a MODEL
    // CHANGE — so switching models re-injected every pending file a second time.
    // (sovereign, 2026-07-27: axiom's 23 stale bus messages were injected on boot
    // and again the moment Allen switched models. Each replay is ~23 turn-triggering
    // steers, which starves the prompt bar — submit clears the box and nothing
    // appears to happen. Diagnosed as a "lockup"; it is a turn storm.)
    let carriedSeen: Set<string> | undefined;
    let carriedOffset: number | undefined;
    if (existing) {
      carriedSeen = existing.seen;
      carriedOffset = existing.offset;
      try {
        existing.watcher.close();
      } catch {
        // ignore
      }
      if (existing.debounce) clearTimeout(existing.debounce);
      targets.delete(resolved);
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      ctx.ui.notify(`simplewatcher: path does not exist: ${resolved}`, "error");
      return;
    }

    const isDir = stat.isDirectory();
    const watcher = fs.watch(resolved, () => {
      scheduleDebounced(resolved, () => {
        const t = targets.get(resolved);
        if (!t) return;
        if (t.isDir) scanDir(resolved, t);
        else readAppended(resolved, t);
      });
    });
    // An unhandled FSWatcher "error" event throws; report it instead.
    watcher.on("error", (err) => ctx.ui.notify(`simplewatcher: watch error on ${resolved}: ${err.message}`, "error"));

    const target: WatchTarget = {
      targetPath: resolved,
      mode,
      isDir,
      watcher,
      // file mode: resume where the previous watch left off; otherwise start from
      // the current end (tail), not a full replay
      offset: isDir ? undefined : (carriedOffset ?? stat.size),
      seen: isDir ? (carriedSeen ?? new Set<string>()) : undefined,
    };
    targets.set(resolved, target);

    if (isDir) {
      // Catch-up is PASSIVE regardless of the target's mode. Files that were
      // already sitting there are a backlog, not events: surfacing them as
      // context at the next natural turn is the whole point, whereas firing one
      // turn per pending file means the session spends minutes acting on stale
      // work before it will look at what the user just typed. New arrivals
      // (fs.watch, above) still honour `mode` — that's the live-injection
      // feature, and it is untouched.
      scanDir(resolved, target, "passive");
    }

    ctx.ui.notify(`simplewatcher: watching ${resolved} (${isDir ? "dir" : "file"}, ${mode})`, "info");
  }

  function removeWatch(targetPath: string, ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }) {
    const resolved = path.resolve(targetPath);
    const t = targets.get(resolved);
    if (!t) {
      ctx.ui.notify(`simplewatcher: not watching ${resolved}`, "warning");
      return;
    }
    try {
      t.watcher.close();
    } catch {
      // ignore
    }
    if (t.debounce) clearTimeout(t.debounce);
    targets.delete(resolved);
    ctx.ui.notify(`simplewatcher: stopped watching ${resolved}`, "info");
  }

  function stopAll() {
    for (const t of targets.values()) {
      try {
        t.watcher.close();
      } catch {
        // ignore
      }
      if (t.debounce) clearTimeout(t.debounce);
    }
    targets.clear();
  }

  // Default: watch this agent's bus inbox in active mode from the moment a
  // session starts, so replies surface immediately instead of sitting unread
  // until someone remembers to run `agent-inbox`. The agent name is
  // parameterized now (SIMPLEWATCHER_AGENT, then PI_AGENT/AGENT_NAME), with a
  // fabricant fallback so this repo remains the canonical source and sibling
  // agents can replace their patched copies with a symlink/env override.
  pi.on("session_start", async (_event, ctx) => {
    const agent = process.env.SIMPLEWATCHER_AGENT ?? process.env.PI_AGENT ?? process.env.AGENT_NAME ?? "fabricant";
    const busInbox = path.join(process.env.HOME ?? "", "Agents", "_bus", "inbox", agent);
    if (fs.existsSync(busInbox)) {
      addWatch(busInbox, "active", ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    stopAll();
  });

  pi.registerCommand("simplewatcher", {
    description: "Watch a file or directory, injecting new content into context. /simplewatcher <path> [--active|--passive], /simplewatcher remove <path>, /simplewatcher (list)",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();

      if (!trimmed) {
        if (targets.size === 0) {
          ctx.ui.notify("simplewatcher: no active watches", "info");
          return;
        }
        const lines = [...targets.values()].map(
          (t) => `${t.targetPath} (${t.isDir ? "dir" : "file"}, ${t.mode})`,
        );
        ctx.ui.notify(`simplewatcher watching:\n${lines.join("\n")}`, "info");
        return;
      }

      const removeMatch = /^remove\s+(.+)$/.exec(trimmed);
      if (removeMatch) {
        removeWatch(removeMatch[1].trim(), ctx);
        return;
      }

      const parts = trimmed.split(/\s+/);
      let mode: Mode = "passive";
      const pathParts: string[] = [];
      for (const p of parts) {
        if (p === "--active") mode = "active";
        else if (p === "--passive") mode = "passive";
        else pathParts.push(p);
      }
      const targetPath = pathParts.join(" ");
      if (!targetPath) {
        ctx.ui.notify("simplewatcher: usage: /simplewatcher <path> [--active|--passive]", "error");
        return;
      }
      addWatch(targetPath, mode, ctx);
    },
  });
}
